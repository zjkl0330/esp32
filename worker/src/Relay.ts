import {
  decode,
  decodeCtrl,
  encodeClose,
  encodeCtrl,
  encodeWol,
  FrameType,
  type ResultMeta,
} from './protocol';

interface Attachment {
  role: 'esp32' | 'user';
  channels?: number[];
  /** 本条连接所属 tunnel，控制消息转发给 Manager 时要用 */
  tunnel?: string;
  /** ESP32 在 hello 里自报的节点 id */
  nodeId?: string;
  /**
   * 最近一次收到该设备控制消息的时刻。
   * 存在 attachment 里而不是实例字段上 —— DO 会休眠，实例字段会被清空，
   * 而 attachment 跟着 WebSocket 一起活下来。
   */
  lastMsgAt?: number;
}

interface Env {
  TUNNEL_TOKEN?: string;
  Manager: DurableObjectNamespace;
}

/** 一次工具调用的等待态：收 DATA 块，等 result 消息 */
interface Pending {
  ch: number;
  chunks: Uint8Array[];
  resolve: (r: { ok: boolean; err?: string; meta?: ResultMeta }) => void;
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };
/** 工具调用用的通道号从这一段往上取，避开用户通道（一般 0~10） */
const TOOL_CH_BASE = 192;
const TOOL_CH_MAX = 255;
/**
 * 工具调用超时。
 * 必须大于固件的 MAX_TOTAL_FETCH_MS(20s) —— 固件的总预算就是它自己
 * 的天花板，Worker 这层要更宽裕，否则设备还在传最后几个字节，
 * 这边已经 504 了，设备那边还占着通道。
 */
const DEFAULT_CALL_TIMEOUT = 30_000;

/**
 * 设备「哑掉」的判定线：超过这么久没收到任何控制消息，就不再往这条连接下发。
 *
 * 为什么需要它：TCP 半开时 socket 的 readyState 仍然是 OPEN，send() 也返回成功，
 * 但数据石沉大海 —— 调用方会白等满 20 秒超时。实测就撞到过这种情况（板子上电
 * 重启后旧连接残留）。设备心跳是 20s 一次，所以 30s = 允许漏一拍。
 * 与其让调用方等 20 秒拿一个 timeout，不如立刻回 503 说清原因。
 */
const ESP_STALE_MS = 30_000;

/** 分块 btoa：一次性 spread 上万个参数会爆调用栈 */
function toBase64(u: Uint8Array): string {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < u.length; i += CHUNK) {
    s += String.fromCharCode(...u.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

/**
 * Durable Object：公网 WebSocket 中继枢纽。
 * 同一 tunnel 名的所有连接被路由到同一 DO 实例，
 * ESP32（role=esp32）与用户（role=user）在此配对并双向转发。
 *
 * 额外能力：手动发送 Wake-on-LAN
 *   GET /wol/<tunnel>            用 ESP32 固件里的默认 MAC 发魔术包
 *   GET /wol/<tunnel>/<mac>      指定 MAC 发魔术包
 *   GET /panel/<tunnel>          手机可用的操作页（状态 + 一键唤醒按钮）
 */
export class Relay {
  /** callId → 等待态。只在一次调用存活期内有效（最长 20s），不跨休眠。 */
  private pending = new Map<string, Pending>();
  /** 通道号 → callId，用于把 DATA 块分流到正确的调用 */
  private toolChannels = new Map<number, string>();

  constructor(private ctx: DurableObjectState, private env: Env) {}

  private allocToolChannel(): number | null {
    for (let ch = TOOL_CH_BASE; ch <= TOOL_CH_MAX; ch++) {
      if (!this.toolChannels.has(ch)) return ch;
    }
    return null;
  }

  /** 把 hello / hb 转给 Manager。失败只记日志，绝不影响数据面转发。 */
  private async forwardToManager(path: string, body: unknown) {
    try {
      const stub = this.env.Manager.get(this.env.Manager.idFromName('global'));
      await stub.fetch(
        new Request(`https://manager.invalid${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      );
    } catch (e) {
      console.log(`[manager] ${path} 失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * 取一条可用的设备连接。
   *
   * - 传 nodeId：只认 nodeId 匹配的那条。多个设备共用一个 tunnel 时，Manager
   *   按 pickNode() 选好的节点必须能准确落到对应连接上，否则「最闲优先」是假的。
   * - 不传：退回「最新接入的 OPEN 连接」，兼容单设备场景与 WOL 这类无节点语义的调用。
   *
   * ⚠️ 不能取 list[0]：getWebSockets() 的返回顺序不保证，且可能残留已经
   * 关闭（ESP32 掉电/复位时没有 FIN）的连接 —— 往这种连接 send() 会静默丢失，
   * 表现为「/wol 返回 200 说 sent 了，但板子一个字都收不到」。
   */
  private esp32(nodeId?: string): WebSocket | null {
    const list = this.ctx.getWebSockets('esp32');
    const states = list.map((w) => w.readyState);
    for (let i = list.length - 1; i >= 0; i--) {
      const w = list[i];
      if (w.readyState !== WebSocket.OPEN) continue;
      if (nodeId) {
        const a = w.deserializeAttachment() as Attachment | undefined;
        // 还没发过 hello 的连接没有 nodeId，无法确认身份，跳过
        if (a?.nodeId !== nodeId) continue;
      }
      console.log(
        `[esp32] 命中连接 idx=${i}/${list.length} states=[${states}]${nodeId ? ` node=${nodeId}` : ''}`
      );
      return w;
    }
    console.log(
      `[esp32] 无可用连接 count=${list.length} states=[${states}] OPEN=${WebSocket.OPEN}` +
        (nodeId ? ` want=${nodeId}` : '')
    );
    return null;
  }

  private users(): WebSocket[] {
    return this.ctx.getWebSockets('user');
  }

  private findUserByChannel(channel: number): WebSocket | null {
    for (const u of this.users()) {
      const a = u.deserializeAttachment() as Attachment | undefined;
      if (a && a.channels && a.channels.includes(channel)) return u;
    }
    return null;
  }

  private addChannel(ws: WebSocket, channel: number) {
    const a = (ws.deserializeAttachment() as Attachment) || { role: 'user', channels: [] };
    a.channels = a.channels || [];
    if (!a.channels.includes(channel)) a.channels.push(channel);
    ws.serializeAttachment(a);
  }

  private removeChannel(ws: WebSocket, channel: number) {
    const a = ws.deserializeAttachment() as Attachment | undefined;
    if (!a || !a.channels) return;
    a.channels = a.channels.filter((c) => c !== channel);
    ws.serializeAttachment(a);
  }

  /** tunnel 名 = 路径第三段；/status/<tunnel>、/panel/<tunnel>、/wol/<tunnel> 都是它 */
  private tunnelOf(url: URL): string {
    const parts = url.pathname.split('/').filter(Boolean);
    return parts[1] ?? '';
  }

  private authorized(request: Request, url: URL): boolean {
    const want = this.env?.TUNNEL_TOKEN;
    if (!want) return true;                       // 未配置 = 不鉴权（本地调试）
    const h = request.headers.get('Authorization') ?? '';
    if (h === `Bearer ${want}`) return true;
    if (url.searchParams.get('token') === want) return true;
    return false;
  }

  private panelHtml(tunnel: string, mac: string): string {
    return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>远程唤醒 - ${tunnel}</title>
<style>
body{font-family:system-ui,-apple-system,"Microsoft YaHei",sans-serif;background:#f2f3f5;
 margin:0;padding:18px;color:#222}
.card{background:#fff;border-radius:12px;padding:20px;margin:0 auto 14px;max-width:460px;
 box-shadow:0 1px 4px rgba(0,0,0,.08)}
h1{font-size:19px;margin:0 0 14px}
.row{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #f0f0f0;font-size:15px}
.row:last-child{border:0}.k{color:#888}.v{font-weight:600}
button{font-size:18px;padding:16px;border:0;border-radius:10px;width:100%;color:#fff;
 cursor:pointer;font-weight:700;background:#e74c3c}
button:disabled{background:#ccc}
input{width:100%;box-sizing:border-box;font-size:16px;padding:11px;border:1px solid #ddd;
 border-radius:8px;margin-bottom:10px}
.ok{color:#0a0a}.no{color:#c00;font-weight:600}
#msg{text-align:center;font-size:14px;padding-top:10px;min-height:20px;color:#0a0}
</style></head><body>
<div class="card">
  <h1>远程唤醒电脑</h1>
  <div class="row"><span class="k">隧道</span><span class="v">${tunnel}</span></div>
  <div class="row"><span class="k">ESP32 在线</span><span class="v" id="st">查询中…</span></div>
  <div class="row"><span class="k">默认 MAC</span><span class="v">${mac}</span></div>
</div>
<div class="card">
  <button id="b1" onclick="wake('')">一键唤醒（默认 MAC）</button>
  <div id="msg"></div>
</div>
<div class="card">
  <h1>唤醒指定设备</h1>
  <input id="mac" placeholder="AA:BB:CC:DD:EE:FF" value="">
  <button style="background:#0066cc" onclick="wake(document.getElementById('mac').value)">发送魔术包</button>
</div>
<script>
const TUNNEL=${JSON.stringify(tunnel)};
const TOKEN=new URLSearchParams(location.search).get('token');
function api(path){return TOKEN?(path+ (path.includes('?')?'&':'?') +'token='+encodeURIComponent(TOKEN)):path;}
async function refresh(){
  try{
    const r=await fetch(api('/status/'+TUNNEL));
    const d=await r.json();
    const el=document.getElementById('st');
    el.textContent = d.esp32 ? '在线' : '离线';
    el.className = 'v ' + (d.esp32?'ok':'no');
    document.getElementById('b1').disabled = !d.esp32;
  }catch(e){
    document.getElementById('st').textContent='未知';
  }
}
async function wake(mac){
  const url = '/wol/'+TUNNEL+(mac?('/'+encodeURIComponent(mac.trim())):'');
  const r = await fetch(api(url));
  const t = await r.text();
  document.getElementById('msg').textContent =
    r.ok ? ('已发送：'+t) : ('失败：'+t);
  refresh();
}
refresh(); setInterval(refresh, 5000);
</script>
</body></html>`;
  }

  /**
   * 一次工具调用：推送 CALL → 收 DATA 块 → 等 RESULT。
   *
   * 为什么不改成 HTTP 长轮询：ESP32 本来就已经有一条常驻 WS 连在这里，
   * 再开一路长轮询等于同一份 TLS 握手干两遍，C6 那点 heap 经不起。
   * 这里直接复用数据面连接下发控制消息。
   */
  private async handleCall(request: Request): Promise<Response> {
    let b: { tool?: string; args?: Record<string, unknown>; timeoutMs?: number };
    try {
      b = (await request.json()) as typeof b;
    } catch {
      return new Response(JSON.stringify({ ok: false, err: 'bad json' }), {
        status: 400,
        headers: JSON_HEADERS,
      });
    }
    const tool = b.tool ?? '';
    if (!tool) {
      return new Response(JSON.stringify({ ok: false, err: 'tool required' }), {
        status: 400,
        headers: JSON_HEADERS,
      });
    }

    // Manager 通过 ?node= 指定具体设备（pickNode 选出来的那台）；
    // 不带则退回「最新接入」，兼容单设备场景
    const wantNode = new URL(request.url).searchParams.get('node') ?? undefined;
    const esp = this.esp32(wantNode);
    if (!esp) {
      return new Response(JSON.stringify({ ok: false, err: wantNode ? 'node_offline' : 'esp32 offline', nodeId: wantNode }), {
        status: 503,
        headers: JSON_HEADERS,
      });
    }

    // 半开连接：连接看着是 OPEN，但设备早就不在那儿了。
    // 不检查的话这里会白等满 timeoutMs 才回一个语焉不详的 timeout。
    const espAtt = esp.deserializeAttachment() as Attachment | undefined;
    const silentMs = Date.now() - (espAtt?.lastMsgAt ?? 0);
    if (silentMs > ESP_STALE_MS) {
      return new Response(
        JSON.stringify({ ok: false, err: 'esp32_stale', silentMs, threshold: ESP_STALE_MS }),
        { status: 503, headers: JSON_HEADERS }
      );
    }

    const ch = this.allocToolChannel();
    if (ch === null) {
      return new Response(JSON.stringify({ ok: false, err: 'no_free_tool_channel' }), {
        status: 503,
        headers: JSON_HEADERS,
      });
    }

    const id = `c${Date.now().toString(36)}${Math.floor(Math.random() * 46656).toString(36)}`;
    const timeoutMs = b.timeoutMs ?? DEFAULT_CALL_TIMEOUT;
    const started = Date.now();

    let settle: (r: { ok: boolean; err?: string; meta?: ResultMeta }) => void = () => {};
    const wait = new Promise<{ ok: boolean; err?: string; meta?: ResultMeta }>((res) => {
      settle = res;
    });
    this.pending.set(id, { ch, chunks: [], resolve: settle });
    this.toolChannels.set(ch, id);

    esp.send(encodeCtrl({ t: 'call', id, tool, args: b.args ?? {}, ch }));

    const timer = setTimeout(() => {
      const p = this.pending.get(id);
      if (p) {
        this.pending.delete(id);
        this.toolChannels.delete(ch);
        p.resolve({ ok: false, err: `timeout after ${timeoutMs}ms` });
      }
    }, timeoutMs);

    const r = await wait;
    clearTimeout(timer);

    const p = this.pending.get(id);
    const chunks = p?.chunks ?? [];
    this.pending.delete(id);
    this.toolChannels.delete(ch);

    const total = chunks.reduce((a, c) => a + c.length, 0);
    const merged = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      merged.set(c, off);
      off += c.length;
    }

    // 超过 512KB 不塞回 HTTP 响应：这类大对象该走 R2，而不是让 Worker 中转
    const DATA_LIMIT = 512 * 1024;
    const payload: Record<string, unknown> = {
      ok: r.ok,
      err: r.err,
      meta: {
        ...r.meta,
        bytes: r.meta?.bytes ?? total,
        ms: r.meta?.ms ?? Date.now() - started,
      },
      bytes: total,
    };
    if (total <= DATA_LIMIT) payload.data = toBase64(merged);
    else payload.note = `body omitted (${total} bytes > ${DATA_LIMIT})`;

    return new Response(JSON.stringify(payload), {
      headers: { ...JSON_HEADERS, 'cache-control': 'no-store' },
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // 内部路由：仅 Manager 调用（DO-to-DO）。未配置 TUNNEL_TOKEN 时两边都是空串，
    // 等同现有"不鉴权"模式；生产环境必须配 token，否则外部可借此让设备发请求。
    if (url.pathname === '/_call') {
      const key = this.env.TUNNEL_TOKEN ?? '';
      if ((request.headers.get('x-internal') ?? '') !== key) {
        return new Response(JSON.stringify({ ok: false, err: 'internal only' }), {
          status: 403,
          headers: JSON_HEADERS,
        });
      }
      if (request.method !== 'POST') {
        return new Response(JSON.stringify({ ok: false, err: 'method not allowed' }), {
          status: 405,
          headers: JSON_HEADERS,
        });
      }
      return this.handleCall(request);
    }

    // 内部路由：往设备塞一条控制帧（目前只有 OTA 触发）。
    // 和 /_call 分开是因为语义不同：这条不等回执，发出去就返回。
    if (url.pathname === '/_push') {
      const key = this.env.TUNNEL_TOKEN ?? '';
      if ((request.headers.get('x-internal') ?? '') !== key) {
        return new Response(JSON.stringify({ ok: false, err: 'internal only' }), {
          status: 403,
          headers: JSON_HEADERS,
        });
      }
      if (request.method !== 'POST') {
        return new Response(JSON.stringify({ ok: false, err: 'method not allowed' }), {
          status: 405,
          headers: JSON_HEADERS,
        });
      }
      const esp = this.esp32(url.searchParams.get('node') ?? undefined);
      if (!esp) {
        return new Response(JSON.stringify({ ok: false, err: 'esp_offline' }), {
          status: 503,
          headers: JSON_HEADERS,
        });
      }
      const msg = await request.text();
      if (!msg) {
        return new Response(JSON.stringify({ ok: false, err: 'empty' }), {
          status: 400,
          headers: JSON_HEADERS,
        });
      }
      esp.send(msg);
      return new Response(JSON.stringify({ ok: true }), { headers: JSON_HEADERS });
    }

    if (!this.authorized(request, url)) {
      return new Response('unauthorized', { status: 401 });
    }

    // 手机操作页
    if (url.pathname.startsWith('/panel/')) {
      const tunnel = this.tunnelOf(url);
      return new Response(this.panelHtml(tunnel, 'AA:BB:CC:DD:EE:FF'), {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }

    // 手动发送 WOL：/wol/<tunnel> 或 /wol/<tunnel>/<mac>
    const wolMatch = url.pathname.match(
      /^\/wol\/[^/]+(?:\/([0-9a-fA-F]{2}([:-][0-9a-fA-F]{2}){5}))?$/
    );
    if (wolMatch) {
      const mac = wolMatch[1];            // undefined = 用 ESP32 固件默认 MAC
      const esp = this.esp32();
      if (!esp) {
        return new Response('esp32 offline', { status: 503 });
      }
      esp.send(encodeWol(mac));
      return new Response(mac ? `wol sent (${mac})` : 'wol sent (default mac)');
    }

    // 状态看板：/status/<tunnel>
    if (url.pathname.startsWith('/status')) {
      const espList = this.ctx.getWebSockets('esp32');
      return new Response(
        JSON.stringify({
          esp32: !!this.esp32(),
          esp32Count: espList.length,
          esp32States: espList.map((w) => w.readyState),
          esp32Nodes: espList.map(
            (w) => (w.deserializeAttachment() as Attachment | undefined)?.nodeId ?? null
          ),
          wsOpenConst: WebSocket.OPEN,
          users: this.users().length,
          hibernatable: true,
          tunnel: this.tunnelOf(url),
        }),
        { headers: JSON_HEADERS }
      );
    }

    // WebSocket 升级
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket upgrade', { status: 426 });
    }

    const role: 'esp32' | 'user' = url.pathname.includes('/esp32') ? 'esp32' : 'user';
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as unknown as [WebSocket, WebSocket];
    server.binaryType = 'arraybuffer';
    // ⚠️ 这里绝对不能「踢掉所有旧 esp32 连接」。
    // 多设备（C6 + D0WD）共用一个 tunnel 时那样会互相踢：A 连上踢 B，B 重连踢 A，
    // 无限循环，两台都表现为「连上 7 秒就断、每 14 秒重连一次」。
    // 僵尸连接的清理改在 hello 里做 —— 那时才知道 nodeId，能只踢「同一个 nodeId 的旧连接」。
    this.ctx.acceptWebSocket(server, [role]);
    server.serializeAttachment({ role, channels: [], tunnel: this.tunnelOf(url) } as Attachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** 控制消息处理：只有 ESP32 会发，用户端发控制消息一律忽略 */
  private async onCtrl(ws: WebSocket, att: Attachment | undefined, raw: string) {
    if (att?.role !== 'esp32') return;
    const msg = decodeCtrl(raw);
    if (!msg) return;

    // 只有文本帧（hello/hb/result/pong）算「设备还活着」的证据。
    // DATA 帧不参与判定 —— 一次 128KB 的抓取会发 128 个 DATA 帧，
    // 每次都重写 attachment 纯属浪费。
    ws.serializeAttachment({ ...att, lastMsgAt: Date.now() } as Attachment);

    if (msg.t === 'hello') {
      ws.serializeAttachment({
        role: 'esp32',
        channels: att.channels ?? [],
        tunnel: att.tunnel ?? 'wol',
        nodeId: msg.node,
        lastMsgAt: Date.now(), // 别丢掉，否则下一次 /_call 会误判成 stale
      } as Attachment);
      // 同一 nodeId 重连时清掉旧连接（掉电/断网没有 FIN，僵尸连接会越积越多，
      // 转发挑中死连接就全丢包）。只踢 nodeId 相同的 —— 别的节点必须留着。
      for (const other of this.ctx.getWebSockets('esp32')) {
        if (other === ws) continue;
        const oa = other.deserializeAttachment() as Attachment | undefined;
        if (oa?.nodeId && oa.nodeId === msg.node) {
          try {
            other.close(1000, 'replaced by same nodeId');
            console.log(`[hello] 踢掉同 nodeId 旧连接 node=${msg.node}`);
          } catch {
            /* ignore */
          }
        }
      }
      console.log(
        `[hello] node=${msg.node} model=${msg.model ?? '?'} fw=${msg.fw ?? '?'} tools=${(msg.tools ?? []).length} heap=${msg.heap ?? '?'}`
      );
      await this.forwardToManager('/hello', {
        nodeId: msg.node,
        tunnel: att.tunnel ?? 'wol',
        model: msg.model,
        fw: msg.fw,
        tools: msg.tools ?? [],
        capacity: msg.capacity,
        heap: msg.heap,
        rssi: msg.rssi,
        ip: msg.ip,
      });
      return;
    }

    if (msg.t === 'hb') {
      if (!att.nodeId) return;
      await this.forwardToManager('/hb', {
        nodeId: att.nodeId,
        heap: msg.heap,
        rssi: msg.rssi,
        up: msg.up,
        conns: msg.conns,
        fw: msg.fw,
      });
      return;
    }

    if (msg.t === 'result') {
      const p = this.pending.get(msg.id);
      // 超时后才到的 result 直接丢：此时 HTTP 响应早就发出去了
      if (!p) return;
      p.resolve({ ok: msg.ok, err: msg.err, meta: msg.meta });
    }
  }

  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string) {
    const att = ws.deserializeAttachment() as Attachment | undefined;

    // 文本帧 = 控制消息（JSON）；二进制帧 = 数据面（保持原样，不动）
    if (typeof message === 'string') {
      await this.onCtrl(ws, att, message);
      return;
    }

    let frame;
    try {
      frame = decode(message);
    } catch {
      return;
    }
    const role = att?.role;

    if (role === 'esp32') {
      // 工具调用的结果体：属于 pending 的 DATA 先截下来，不进用户转发逻辑
      if (frame.type === FrameType.DATA && this.toolChannels.has(frame.channel)) {
        const id = this.toolChannels.get(frame.channel);
        if (id) this.pending.get(id)?.chunks.push(frame.payload);
        return;
      }
      if (frame.type === FrameType.CLOSE && this.toolChannels.has(frame.channel)) {
        return; // 收尾交给 result 消息，CLOSE 本身不带语义
      }
      // 来自 ESP32：路由回对应的 user
      if (
        frame.type === FrameType.OPEN_OK ||
        frame.type === FrameType.DATA ||
        frame.type === FrameType.CLOSE
      ) {
        const u = this.findUserByChannel(frame.channel);
        if (u) {
          u.send(message);
          if (frame.type === FrameType.CLOSE) this.removeChannel(u, frame.channel);
        }
      }
    } else {
      // 来自 user：转发给 ESP32
      const esp = this.esp32();
      const ch = 'channel' in frame ? frame.channel : -1;
      console.log(
        `[msg] role=user frame=0x${frame.type.toString(16)} ch=${ch} esp32=${!!esp}`
      );
      if (frame.type === FrameType.OPEN) {
        if (!esp) {
          ws.send(encodeClose(frame.channel));
          return;
        }
        this.addChannel(ws, frame.channel);
        esp.send(message);
      } else if (frame.type === FrameType.DATA || frame.type === FrameType.CLOSE) {
        if (esp) esp.send(message);
        if (frame.type === FrameType.CLOSE) this.removeChannel(ws, frame.channel);
      }
      // user 不应发送 OPEN_OK / WOL
    }
  }

  async webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean) {
    const role = (ws.deserializeAttachment() as Attachment)?.role;
    if (role === 'user') {
      const a = ws.deserializeAttachment() as Attachment | undefined;
      const channels = a?.channels || [];
      const esp = this.esp32();
      for (const ch of channels) {
        if (esp) esp.send(encodeClose(ch));
      }
    } else if (role === 'esp32') {
      // ESP32 掉线：通知所有 user 关闭它们的通道
      for (const u of this.users()) {
        const a = u.deserializeAttachment() as Attachment | undefined;
        for (const ch of a?.channels || []) {
          u.send(encodeClose(ch));
        }
      }
    }
  }

  async webSocketError(ws: WebSocket, _error: unknown) {
    await this.webSocketClose(ws, 1011, 'error', false);
  }
}
