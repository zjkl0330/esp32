// Manager.ts —— 控制面 Durable Object（全局单实例）。
//
// 职责边界（与数据面 Relay 严格分开）：
//   · 这里只存「谁在线、能干什么、干了什么」，一个字节的业务数据都不经过它
//   · 真正的字节转发在 Relay，Manager 通过 DO-to-DO fetch 借它下发任务
//
// 为什么控制面要单实例：节点表是全局决策依据（选哪个节点接活），分散到多个实例
// 立刻出现"两边都以为自己是唯一"的分裂。规模上限就是「家里几台设备」，够用。
//
// 存储策略（2026-10-25 改过一次，原因写在下面）：
//   · 节点表 + lastSeen  → storage 持久化，心跳每次都写
//   · 今日统计（调用数/成功率/耗时） → storage 持久化，每次调用都写
//   · 趋势序列 / 任务明细 → 只留内存（面板是实时视图，重建可接受）
//
// 为什么把心跳也落盘（原来注释写的是"一天几千次写，纯属白烧额度"，这个判断错了）：
//   DO 空闲十几秒就会被回收。设备心跳 20s 一次，正好卡在驱逐边缘 ——
//   实测连续三次采样拿到 false / true / false，静默值 1359s、1542s 都精确指向
//   设备 hello 的那一刻，因为只有 hello 会 persist。也就是说每两次心跳之间
//   DO 都可能被回收，恢复后 lastSeen 退回 hello 时间，一算就超过 50s 的 TTL。
//   后果不是"面板数字难看"，是 /api/fetch 真的会返回 503 no_available_node，
//   家里板子好好活着却调不通。
//   代价换算：20s 一次写 = 4320 次/天，对 DO 配额是九牛一毛；
//   拿这一点写入换"不再假离线"，怎么算都值。

// 带 .ts 后缀：Node 的 strip-only 类型擦除不做扩展名补全，
// 不写后缀 test/manager-evict.mjs 就没法直接 import 本文件。
import { encodeCtrl, type CtrlMsg, type ResultMeta } from './protocol.ts';
import { generateClientKey, parseClientKeys, type ClientKey } from './security.ts';

interface Env {
  Relay: DurableObjectNamespace;
  TUNNEL_TOKEN?: string;
  /** 与 index.ts 同源，配额上限从这里读，避免两处各写一份数字 */
  CLIENT_KEYS?: string;
  /** 只为在面板上显示「口令是否已设」，不读值本身 */
  ADMIN_TOKEN?: string;
}

/**
 * 单个客户端 key 当天的用量。
 *
 * 为什么要按天重置而不是滑动窗口：给其他项目用时，对方要能看懂规则
 * ——「今天还剩多少」比「过去 60 秒内还剩多少」好解释得多。
 * 代价是零点会有一次突发，对家用出口来说无所谓。
 */
interface QuotaUsage {
  calls: number;
  bytes: number;
}

export interface NodeEntry {
  nodeId: string;
  /** 该节点挂在哪个 tunnel 上，下发任务时用它找 Relay 实例 */
  tunnel: string;
  model?: string;
  fw?: string;
  /** 设备自报支持的工具；面板据此禁用不支持的按钮，而不是等调用失败 */
  tools: string[];
  ip?: string;
  /** 设备上报的并发上限（固件按自身 heap 预算给出） */
  capacity: number;
  firstSeen: number;
  lastSeen: number;
  /** 最近一次心跳数值，可能过期（靠 lastSeen 判定） */
  heap?: number;
  rssi?: number;
  uptime?: number;
  conns?: number;
  /** 累计统计，用于面板的"今日"一栏 */
  totalCalls: number;
  totalErrors: number;
}

export interface TaskRecord {
  id: string;
  nodeId: string;
  tool: string;
  /** 请求参数摘要（只留可展示的短字段，不整包塞） */
  brief: string;
  startedAt: number;
  ms?: number;
  ok: boolean | null;
  err?: string;
  bytes?: number;
  status?: number;
  /** 由哪把客户端 key 发起；面板按钮发起时为 undefined */
  via?: string;
}

interface Series {
  heap: number[];
  rssi: number[];
}

const SERIES_MAX = 40;
const TASKS_MAX = 60;
/** 心跳 TTL：2.5 倍心跳间隔。设备心跳 20s → 50s 判离线 */
export const HEARTBEAT_TTL_MS = 50_000;
/**
 * 恢复宽限。DO 被回收后重建，恢复的 lastSeen 是最后一次落盘的值。
 * 心跳已落盘的话最多落后 20s，理论上够用；但如果驱逐恰好发生在两次心跳
 * 之间 + 设备那条心跳因为网络抖动迟到，就会擦边误判。
 * 给 30s：够等到下一轮心跳，又不至于把真死的设备一直说成活的
 * （真死了调用会被 Relay 的 stale 判定拦下，不会白等）。
 */
const RESURRECT_GRACE_MS = 30_000;
const DEFAULT_CAPACITY = 2;

/** 当天的调用统计。持久化，避免 DO 回收后「今日干了 N 件」凭空归零 */
interface DayStats {
  day: string;
  calls: number;
  ok: number;
  err: number;
  /** 耗时累加，均耗时用它除以 calls 算，避免只存平均值的精度漂移 */
  msSum: number;
  lastOkAt: number | null;
  lastOkMs: number | null;
}

function emptyStats(day: string): DayStats {
  return { day, calls: 0, ok: 0, err: 0, msSum: 0, lastOkAt: null, lastOkMs: null };
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

/** 按北京时间切日，避免晚上 8 点就"跨天"重置配额 */
export function dayKey(now = Date.now()): string {
  return new Date(now + 8 * 3600_000).toISOString().slice(0, 10);
}

function push(arr: number[], v: number) {
  arr.push(v);
  if (arr.length > SERIES_MAX) arr.shift();
}

function briefOf(tool: string, args: Record<string, unknown>): string {
  const host = typeof args.host === 'string' ? args.host : '';
  const path = typeof args.path === 'string' ? args.path : '';
  if (host) return path ? `${host}${path}` : host;
  return tool;
}

export class Manager {
  private nodes = new Map<string, NodeEntry>();
  private tasks: TaskRecord[] = [];
  private series = new Map<string, Series>();
  /** 正在执行的调用 id → 任务记录下标，用于 result 回来时补全 */
  private inflight = new Map<string, string>();
  /** 客户端 key 当天用量：name → {calls, bytes} */
  private quotas = new Map<string, QuotaUsage>();
  /** 当天的日期串，跨天时整表重置 */
  private quotaDay = '';
  /** 今日调用统计（持久化，见 DayStats 注释） */
  private dayStats: DayStats = emptyStats('');
  /** 本实例从 storage 恢复出来的时刻。>0 表示"刚被唤醒，还没收到过心跳" */
  private revivedAt = 0;
  /** key 名 → 上限，构造时从 CLIENT_KEYS 解析 */
  private keyLimits = new Map<string, { dayCalls?: number; dayBytes?: number }>();
  /**
   * 对外接出密钥表。存在 storage 里，不是 secret ——
   * secret 是只写不可读的，面板上要能「显示密钥 / 新增 / 吊销」就必须有个可读可写的地方。
   * 代价是密钥明文落在 DO 存储里（这本来就是面板要显示的东西），
   * 换来的是改完立即生效，不用重新 put secret、不用重部署。
   */
  private clientKeys: ClientKey[] = [];

  private ctx: DurableObjectState;
  private env: Env;

  constructor(ctx: DurableObjectState, env: Env) {
    // 不用 TS 的 parameter property 语法糖：Node 的 strip-only 类型擦除不支持它，
    // 而 test/manager-evict.mjs 需要直接 import 这个文件来测「驱逐后重建」。
    // 写成显式赋值，行为完全一样，但源码能被 node 直接跑。
    this.ctx = ctx;
    this.env = env;
    this.ctx.blockConcurrencyWhile(async () => {
      const saved = await this.ctx.storage.get<Record<string, NodeEntry>>('nodes');
      if (saved) {
        for (const [k, v] of Object.entries(saved)) {
          this.nodes.set(k, { ...v, conns: 0 });
        }
      }
      const q = await this.ctx.storage.get<{ day: string; usage: Record<string, QuotaUsage> }>('quota');
      if (q && q.day === dayKey()) {
        this.quotaDay = q.day;
        for (const [name, u] of Object.entries(q.usage)) this.quotas.set(name, u);
      } else {
        this.quotaDay = dayKey();
      }
      const st = await this.ctx.storage.get<DayStats>('stats');
      this.dayStats = st && st.day === dayKey() ? st : emptyStats(dayKey());

      // 密钥表：storage 为准，secret 只在第一次当种子用。
      // 这样「面板上新增一把钥匙」立刻生效，不用重新 put secret。
      // 反过来，DO 存储被清空时会自动回落到 secret 的内容，不会变成一把都没了。
      const savedKeys = await this.ctx.storage.get<ClientKey[]>('clientKeys');
      if (savedKeys && savedKeys.length) {
        this.clientKeys = savedKeys;
      } else {
        const seed = parseClientKeys(env.CLIENT_KEYS);
        this.clientKeys = seed;
        if (seed.length) await this.ctx.storage.put('clientKeys', seed);
      }
      this.refreshKeyLimits();

      // 恢复出来的节点若 lastSeen 已过期，先别判死：设备多半活着，
      // 只是 DO 在两次心跳之间被回收了。记下唤醒时刻，宽限期内仍算在线。
      this.revivedAt = [...this.nodes.values()].some((n) => Date.now() - n.lastSeen > HEARTBEAT_TTL_MS)
        ? Date.now()
        : 0;
    });
  }

  private async persist() {
    const obj: Record<string, NodeEntry> = {};
    for (const [k, v] of this.nodes) obj[k] = v;
    await this.ctx.storage.put('nodes', obj);
  }

  private async persistQuota() {
    const usage: Record<string, QuotaUsage> = {};
    for (const [k, v] of this.quotas) usage[k] = v;
    await this.ctx.storage.put('quota', { day: this.quotaDay, usage });
  }

  // ── 对外接出密钥表 ──────────────────────────────────────────────
  // 密钥表和配额上限必须同源：以前上限是从 secret 解析的、密钥是另一份，
  // 两处各改各的，改到一半就不一致了。现在统一以这张表为准。

  /** 从密钥表重算每把 key 的配额上限 */
  private refreshKeyLimits() {
    this.keyLimits.clear();
    for (const k of this.clientKeys) {
      this.keyLimits.set(k.name, { dayCalls: k.dayCalls, dayBytes: k.dayBytes });
    }
  }

  /** 列出全部密钥（含明文）。只给管理路径用。 */
  listClientKeys(): ClientKey[] {
    return this.clientKeys.map((k) => ({ ...k, hosts: k.hosts ? [...k.hosts] : undefined }));
  }

  /**
   * 新增或更新一把密钥。name 是主键：同名视为更新。
   * 不传 key 就沿用原来的；原来也没有就自动生成一把。
   */
  async upsertClientKey(input: {
    name?: string;
    key?: string;
    dayCalls?: number;
    dayBytes?: number;
    hosts?: string[];
  }): Promise<{ ok: boolean; error?: string; key?: ClientKey }> {
    const name = String(input.name ?? '').trim();
    if (!name) return { ok: false, error: 'name_required' };
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) {
      return { ok: false, error: 'bad_name' };
    }

    const idx = this.clientKeys.findIndex((k) => k.name === name);
    const prev = idx >= 0 ? this.clientKeys[idx] : null;

    let key = String(input.key ?? '').trim();
    if (!key) key = prev?.key ?? generateClientKey(name);
    if (key.length < 8 || key.length > 200) return { ok: false, error: 'bad_key' };
    // 同一把 key 不能挂在两个名字下 —— 否则「撤一把」会连带影响另一把
    if (this.clientKeys.some((k) => k.key === key && k.name !== name)) {
      return { ok: false, error: 'duplicate_key' };
    }

    const entry: ClientKey = {
      name,
      key,
      dayCalls: typeof input.dayCalls === 'number' && input.dayCalls > 0 ? input.dayCalls : undefined,
      dayBytes: typeof input.dayBytes === 'number' && input.dayBytes > 0 ? input.dayBytes : undefined,
      hosts: Array.isArray(input.hosts)
        ? input.hosts.map((h) => String(h).trim()).filter(Boolean)
        : undefined,
    };
    if (entry.hosts && !entry.hosts.length) entry.hosts = undefined;

    if (idx >= 0) this.clientKeys[idx] = entry;
    else this.clientKeys.push(entry);

    await this.persistClientKeys();
    return { ok: true, key: entry };
  }

  /** 吊销一把密钥。返回是否真的删掉了（不存在算 false）。 */
  async deleteClientKey(name: string): Promise<boolean> {
    const before = this.clientKeys.length;
    this.clientKeys = this.clientKeys.filter((k) => k.name !== name);
    if (this.clientKeys.length === before) return false;
    await this.persistClientKeys();
    return true;
  }

  private async persistClientKeys() {
    await this.ctx.storage.put('clientKeys', this.clientKeys);
    this.refreshKeyLimits();
  }

  /** 跨天检查：读路径上做，不靠 alarm */
  private rollover() {
    const d = dayKey();
    if (d !== this.quotaDay) {
      this.quotaDay = d;
      this.quotas.clear();
    }
  }

  private usageOf(name: string): QuotaUsage {
    this.rollover();
    let u = this.quotas.get(name);
    if (!u) {
      u = { calls: 0, bytes: 0 };
      this.quotas.set(name, u);
    }
    return u;
  }

  /** 检查是否还有额度。返回 null 表示放行，否则返回拒绝原因 */
  private checkQuota(name: string, wantBytes: number): { blocked: string; detail: string } | null {
    const lim = this.keyLimits.get(name);
    if (!lim) return null; // 没登记上限 = 不限（密钥本身已在入口校验过）
    const u = this.usageOf(name);
    if (lim.dayCalls !== undefined && u.calls >= lim.dayCalls) {
      return { blocked: 'quota_calls', detail: `今日调用已达上限 ${lim.dayCalls} 次` };
    }
    if (lim.dayBytes !== undefined && u.bytes + wantBytes > lim.dayBytes) {
      return {
        blocked: 'quota_bytes',
        detail: `今日流量将超出上限 ${lim.dayBytes} 字节（已用 ${u.bytes}）`,
      };
    }
    return null;
  }

  private bumpQuota(name: string, bytes: number) {
    const u = this.usageOf(name);
    u.calls += 1;
    u.bytes += bytes;
  }

  /** 今日统计的当前值，顺手处理跨天 */
  private statsOf(): DayStats {
    const d = dayKey();
    if (this.dayStats.day !== d) this.dayStats = emptyStats(d);
    return this.dayStats;
  }

  /** 记一次真正下发过的调用（配额拒绝和"没设备"不算干活） */
  private async bumpStats(ok: boolean, ms: number) {
    const s = this.statsOf();
    s.calls += 1;
    s.msSum += ms;
    if (ok) {
      s.ok += 1;
      s.lastOkAt = Date.now();
      s.lastOkMs = ms;
    } else {
      s.err += 1;
    }
    // 每次调用都落盘，不节流：用户在面板上看到的"今天"必须和实际一致，
    // 宁可多写几次也不要让数字在 DO 回收后跳变。
    await this.ctx.storage.put('stats', s);
  }

  private seriesOf(nodeId: string): Series {
    let s = this.series.get(nodeId);
    if (!s) {
      s = { heap: [], rssi: [] };
      this.series.set(nodeId, s);
    }
    return s;
  }

  /** 读路径判离线：不依赖 alarm，不会有"闹钟没响导致永远在线"的坑 */
  private isOnline(n: NodeEntry, now = Date.now()): boolean {
    if (now - n.lastSeen <= HEARTBEAT_TTL_MS) return true;
    // 刚从 storage 恢复出来的那一下：lastSeen 还停在最后一次落盘的时刻，
    // 不代表设备死了，只代表 DO 在两次心跳之间睡了一觉。
    // 宽限期内仍算在线，等下一轮心跳把 lastSeen 补上；真死了也还有
    // Relay 的 stale 判定兜着，不会让人白等。
    return this.revivedAt > 0 && now - this.revivedAt <= RESURRECT_GRACE_MS;
  }

  private view(n: NodeEntry) {
    const now = Date.now();
    const online = this.isOnline(n, now);
    const s = this.series.get(n.nodeId);
    return {
      ...n,
      online,
      /** 距上次心跳的秒数，离线时面板直接展示这个比展示时间戳更有用 */
      silentFor: Math.round((now - n.lastSeen) / 1000),
      uptime: n.uptime,
      heapSeries: s?.heap ?? [],
      rssiSeries: s?.rssi ?? [],
    };
  }

  private pickNode(tool: string): NodeEntry | null {
    const now = Date.now();
    const alive = [...this.nodes.values()].filter(
      (n) => this.isOnline(n, now) && (n.tools.length === 0 || n.tools.includes(tool))
    );
    if (!alive.length) return null;
    // 最闲优先；同负载按 lastSeen 轮转，避免总压同一台
    alive.sort((a, b) => (a.conns ?? 0) - (b.conns ?? 0) || a.lastSeen - b.lastSeen);
    const free = alive.find((n) => (n.conns ?? 0) < n.capacity);
    return free ?? alive[0];
  }

  private async callRelay(n: NodeEntry, tool: string, args: Record<string, unknown>, timeoutMs: number) {
    const stub = this.env.Relay.get(this.env.Relay.idFromName(n.tunnel));
    const key = this.env.TUNNEL_TOKEN ?? '';
    // ?tunnel= 只为 Node 等价实现（一个进程里跑多 tunnel 时靠它路由）；
    // 真实 DO 实例本身就绑定了 tunnel，会忽略这个参数。
    // ?node= 让 Relay 把调用精确投给 pickNode() 选中的那台；
    // 不传的话 Relay 只会挑「最后接入的那条」，多设备时等于轮流被无视。
    const res = await stub.fetch(
      new Request(
        `https://relay.invalid/_call?tunnel=${encodeURIComponent(n.tunnel)}&node=${encodeURIComponent(n.nodeId)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-internal': key },
          body: JSON.stringify({ tool, args, timeoutMs }),
        }
      )
    );
    return res;
  }

  /**
   * 往设备的 WS 塞一条控制帧。
   *
   * 和 callRelay 的区别：工具调用要等设备回 result，说话对象是「设备上有没有这个工具」；
   * 控制帧是「立刻做一件事、不等结果」（目前只有 OTA 触发）。OTA 下载会堵住设备的
   * loop() 几十秒，走工具调用只会拿到 504 —— 那不是失败，是我们在等一个不该等的结果。
   */
  private async pushToNode(n: NodeEntry, msg: Record<string, unknown>): Promise<boolean> {
    const stub = this.env.Relay.get(this.env.Relay.idFromName(n.tunnel));
    const key = this.env.TUNNEL_TOKEN ?? '';
    const res = await stub.fetch(
      new Request(
        `https://relay.invalid/_push?tunnel=${encodeURIComponent(n.tunnel)}&node=${encodeURIComponent(n.nodeId)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-internal': key },
          body: JSON.stringify(msg),
        }
      )
    );
    const j = (await res.json().catch(() => ({}))) as { ok?: boolean; err?: string };
    if (!j.ok) throw new Error(j.err ?? `relay ${res.status}`);
    return true;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // ── 对外接出密钥表
    // 只有 Worker 内部调得到：DO 的路由不对外暴露，外部请求必须先过
    // Worker 的 adminOk 鉴权才会被转发到这里。
    if (url.pathname === '/clientkeys') {
      if (request.method === 'GET') {
        return new Response(JSON.stringify({ keys: this.listClientKeys() }), {
          headers: JSON_HEADERS,
        });
      }
      if (request.method === 'POST') {
        const body = (await request.json().catch(() => ({}))) as {
          name?: string;
          key?: string;
          dayCalls?: number;
          dayBytes?: number;
          hosts?: string[];
        };
        const r = await this.upsertClientKey(body);
        return new Response(JSON.stringify(r), {
          status: r.ok ? 200 : 400,
          headers: JSON_HEADERS,
        });
      }
    }
    if (url.pathname.startsWith('/clientkeys/') && request.method === 'DELETE') {
      const name = decodeURIComponent(url.pathname.slice('/clientkeys/'.length));
      const ok = await this.deleteClientKey(name);
      return new Response(JSON.stringify({ ok, name }), {
        status: ok ? 200 : 404,
        headers: JSON_HEADERS,
      });
    }

    // ── 设备注册（由 Relay 收到 hello 后转发过来，设备本身不需要多发一次 HTTP）
    if (url.pathname === '/hello' && request.method === 'POST') {
      const b = (await request.json()) as Partial<NodeEntry> & { nodeId?: string };
      if (!b.nodeId) return new Response('{"error":"nodeId required"}', { status: 400, headers: JSON_HEADERS });
      const now = Date.now();
      const prev = this.nodes.get(b.nodeId);
      const entry: NodeEntry = {
        nodeId: b.nodeId,
        tunnel: b.tunnel ?? 'wol',
        model: b.model,
        fw: b.fw,
        tools: Array.isArray(b.tools) ? b.tools : [],
        ip: b.ip,
        capacity: typeof b.capacity === 'number' && b.capacity > 0 ? b.capacity : DEFAULT_CAPACITY,
        firstSeen: prev?.firstSeen ?? now,
        lastSeen: now,
        heap: b.heap,
        rssi: b.rssi,
        uptime: b.uptime,
        conns: b.conns ?? 0,
        totalCalls: prev?.totalCalls ?? 0,
        totalErrors: prev?.totalErrors ?? 0,
      };
      this.nodes.set(entry.nodeId, entry);
      await this.persist();
      return new Response(JSON.stringify({ ok: true, nodeId: entry.nodeId }), { headers: JSON_HEADERS });
    }

    // ── 心跳：更新内存 + 落盘（必须落，见文件头关于假离线的说明）
    if (url.pathname === '/hb' && request.method === 'POST') {
      const b = (await request.json()) as {
        nodeId?: string;
        heap?: number;
        rssi?: number;
        up?: number;
        conns?: number;
        fw?: string;
      };
      const n = b.nodeId ? this.nodes.get(b.nodeId) : undefined;
      if (!n) return new Response('{"error":"unknown node"}', { status: 404, headers: JSON_HEADERS });
      n.lastSeen = Date.now();
      if (typeof b.heap === 'number') n.heap = b.heap;
      if (typeof b.rssi === 'number') n.rssi = b.rssi;
      if (typeof b.up === 'number') n.uptime = b.up;
      if (typeof b.conns === 'number') n.conns = b.conns;
      if (b.fw) n.fw = b.fw;
      const s = this.seriesOf(n.nodeId);
      if (typeof b.heap === 'number') push(s.heap, b.heap);
      if (typeof b.rssi === 'number') push(s.rssi, b.rssi);
      // 收到心跳 = 已经确认这个实例活着且是热的，恢复宽限不再需要
      this.revivedAt = 0;
      // 落盘 lastSeen。这一步是「不再假离线」的唯一保证：
      // 不写的话，驱逐后恢复出的 lastSeen 会退回上一次 hello（可能是几十分钟前）。
      await this.persist();
      return new Response('{"ok":true}', { headers: JSON_HEADERS });
    }

    // ── 让设备立刻查一次固件更新（面板按钮）
    if (url.pathname === '/ota' && request.method === 'POST') {
      const b = (await request.json().catch(() => ({}))) as { force?: boolean };
      const now = Date.now();
      const targets = [...this.nodes.values()].filter((n) => this.isOnline(n, now));
      if (!targets.length) {
        return new Response(JSON.stringify({ ok: false, error: 'no_online_node' }), {
          status: 503,
          headers: JSON_HEADERS,
        });
      }
      const results: Array<{ nodeId: string; fw?: string; ok: boolean; err?: string }> = [];
      for (const n of targets) {
        try {
          await this.pushToNode(n, { t: 'ota', force: !!b.force });
          results.push({ nodeId: n.nodeId, fw: n.fw, ok: true });
        } catch (e) {
          results.push({
            nodeId: n.nodeId,
            fw: n.fw,
            ok: false,
            err: e instanceof Error ? e.message : String(e),
          });
        }
      }
      return new Response(JSON.stringify({ ok: results.some((r) => r.ok), results }), {
        headers: JSON_HEADERS,
      });
    }

    // ── 下发一次工具调用
    if (url.pathname === '/call' && request.method === 'POST') {
      const b = (await request.json()) as {
        nodeId?: string;
        tool?: string;
        args?: Record<string, unknown>;
        timeoutMs?: number;
        /** 由哪把客户端 key 发起（/api/fetch 路径才有），用于配额与审计 */
        clientKey?: string;
      };
      const tool = b.tool ?? '';
      if (!tool) return new Response('{"error":"tool required"}', { status: 400, headers: JSON_HEADERS });

      // 配额在选节点之前检查：额度用完了就不该再去打扰设备，
      // 否则等于用你家带宽去探测"我还能不能干活"。
      if (b.clientKey) {
        const maxBytes = Number((b.args ?? {}).maxBytes ?? 0) || 0;
        const blocked = this.checkQuota(b.clientKey, maxBytes);
        if (blocked) {
          return new Response(
            JSON.stringify({ ok: false, error: blocked.blocked, detail: blocked.detail }),
            { status: 429, headers: JSON_HEADERS }
          );
        }
      }

      const node = b.nodeId ? this.nodes.get(b.nodeId) : this.pickNode(tool);
      if (!node) {
        // pickNode 已经把「在线但没有一台支持这个工具」也归到 null 上了，
        // 但这两个原因对排查的含义完全不同：前者是「设备不支持」，后者是「设备忙/离线」。
        // 混在一起回 no_available_node 会让人去查在线状态，其实该去查工具表。
        const now = Date.now();
        const online = [...this.nodes.values()].filter((n) => this.isOnline(n, now));
        if (online.length && !online.some((n) => n.tools.length === 0 || n.tools.includes(tool))) {
          return new Response(
            JSON.stringify({
              error: 'tool_not_supported',
              tool,
              onlineNodes: online.map((n) => n.nodeId),
              offeredTools: [...new Set(online.flatMap((n) => n.tools))],
            }),
            { status: 400, headers: JSON_HEADERS }
          );
        }
        return new Response(JSON.stringify({ error: 'no_available_node', tool }), {
          status: 503,
          headers: JSON_HEADERS,
        });
      }
      if (!this.isOnline(node)) {
        return new Response(JSON.stringify({ error: 'node_offline', nodeId: node.nodeId }), {
          status: 503,
          headers: JSON_HEADERS,
        });
      }
      if (node.tools.length && !node.tools.includes(tool)) {
        return new Response(
          JSON.stringify({ error: 'tool_not_supported', nodeId: node.nodeId, tool, tools: node.tools }),
          { status: 400, headers: JSON_HEADERS }
        );
      }

      const args = b.args ?? {};
      const startedAt = Date.now();
      const taskId = `t${startedAt.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
      const rec: TaskRecord = {
        id: taskId,
        nodeId: node.nodeId,
        tool,
        brief: briefOf(tool, args),
        startedAt,
        ok: null,
        via: b.clientKey,
      };
      this.tasks.unshift(rec);
      if (this.tasks.length > TASKS_MAX) this.tasks.pop();
      node.totalCalls++;

      let body: string;
      let statusCode = 502;
      try {
        const res = await this.callRelay(node, tool, args, b.timeoutMs ?? 30_000);
        statusCode = res.status;
        body = await res.text();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        rec.ok = false;
        rec.err = msg;
        rec.ms = Date.now() - startedAt;
        node.totalErrors++;
        if (b.clientKey) {
          this.bumpQuota(b.clientKey, 0);
          await this.persistQuota();
        }
        // 下发失败也是"干过一件活"，面板上的今日计数要算上，
        // 否则用户看到「今日 0 件」而实际一直在报错，会以为是面板坏了。
        await this.bumpStats(false, rec.ms);
        return new Response(JSON.stringify({ error: 'relay_failed', detail: msg }), {
          status: 502,
          headers: JSON_HEADERS,
        });
      }

      let parsed: {
        ok?: boolean;
        err?: string;
        meta?: ResultMeta;
        data?: string;
        bytes?: number;
      } = {};
      try {
        parsed = JSON.parse(body);
      } catch {
        rec.ok = false;
        rec.err = 'relay 返回非 JSON';
        rec.ms = Date.now() - startedAt;
        node.totalErrors++;
        await this.bumpStats(false, rec.ms);
        return new Response(body, { status: statusCode, headers: JSON_HEADERS });
      }

      rec.ok = parsed.ok === true;
      rec.err = parsed.err;
      rec.ms = Date.now() - startedAt;
      rec.bytes = parsed.meta?.bytes ?? parsed.bytes;
      rec.status = parsed.meta?.status;
      if (!rec.ok) node.totalErrors++;
      if (b.clientKey) {
        this.bumpQuota(b.clientKey, rec.bytes ?? 0);
        await this.persistQuota();
      }
      await this.bumpStats(rec.ok, rec.ms ?? 0);
      this.inflight.delete(taskId);
      return new Response(body, { status: statusCode, headers: JSON_HEADERS });
    }

    // ── 客户端额度查询（/api/me 转发到这里）
    // 让调用方自己能看到「今天还剩多少」，比让人猜或直接撞 429 友好得多
    if (url.pathname === '/quota') {
      this.rollover();
      const name = url.searchParams.get('name') ?? '';
      const lim = this.keyLimits.get(name) ?? {};
      const u = this.quotas.get(name) ?? { calls: 0, bytes: 0 };
      return new Response(
        JSON.stringify({
          key: name,
          day: this.quotaDay,
          calls: u.calls,
          bytes: u.bytes,
          limit: {
            dayCalls: lim.dayCalls ?? null,
            dayBytes: lim.dayBytes ?? null,
          },
          remaining: {
            dayCalls: lim.dayCalls === undefined ? null : Math.max(0, lim.dayCalls - u.calls),
            dayBytes: lim.dayBytes === undefined ? null : Math.max(0, lim.dayBytes - u.bytes),
          },
        }),
        { headers: JSON_HEADERS }
      );
    }

    // ── 面板数据快照
    if (url.pathname === '/snapshot') {
      const now = Date.now();
      this.rollover();
      const list = [...this.nodes.values()].map((n) => this.view(n));
      const online = list.filter((n) => n.online);
      // 「今天」的统计来自持久化的 dayStats，而不是从 tasks 明细里数。
      // tasks 是内存数组，DO 一回收就没了 —— 之前面板上「今日 0 件」就是这么来的。
      const ds = this.statsOf();
      const decided = ds.ok + ds.err;
      const avgMs = ds.calls ? Math.round(ds.msSum / ds.calls) : 0;

      // 各把 key 的额度：面板上要能一眼看出「谁在用、用掉多少」
      const keys = [...this.keyLimits.entries()].map(([name, lim]) => {
        const u = this.quotas.get(name) ?? { calls: 0, bytes: 0 };
        return {
          name,
          calls: u.calls,
          bytes: u.bytes,
          dayCalls: lim.dayCalls ?? null,
          dayBytes: lim.dayBytes ?? null,
        };
      });

      return new Response(
        JSON.stringify({
          now,
          nodes: list.sort((a, b) => Number(b.online) - Number(a.online) || a.nodeId.localeCompare(b.nodeId)),
          tasks: this.tasks.slice(0, 30),
          keys,
          stats: {
            nodesTotal: list.length,
            nodesOnline: online.length,
            totalConn: list.reduce((a, n) => a + (n.online ? n.conns ?? 0 : 0), 0),
            todayCalls: ds.calls,
            todayOk: ds.ok,
            todayErr: ds.err,
            successRate: decided ? Math.round((ds.ok / decided) * 100) : null,
            avgMs,
            heapMin: online.length ? Math.min(...online.map((n) => n.heap ?? Infinity)) : null,
            lastOkAt: ds.lastOkAt,
            lastOkMs: ds.lastOkMs,
          },
          heartbeatTtlMs: HEARTBEAT_TTL_MS,
          // 面板要能自己回答「我现在是不是在裸奔」。
          // 只回布尔，不回任何密钥内容。
          security: {
            adminTokenSet: !!this.env.ADMIN_TOKEN,
            tunnelTokenSet: !!this.env.TUNNEL_TOKEN,
            clientKeys: this.keyLimits.size,
          },
        }),
        { headers: { ...JSON_HEADERS, 'cache-control': 'no-store' } }
      );
    }

    if (url.pathname === '/nodes') {
      return new Response(JSON.stringify([...this.nodes.values()].map((n) => this.view(n))), {
        headers: JSON_HEADERS,
      });
    }

    if (url.pathname === '/ping') {
      return new Response(encodeCtrl({ t: 'pong', id: 'manager' } as CtrlMsg), {
        headers: JSON_HEADERS,
      });
    }

    return new Response(JSON.stringify({ error: 'not_found', path: url.pathname }), {
      status: 404,
      headers: JSON_HEADERS,
    });
  }
}

export const MANAGER_SINGLETON = 'global';
