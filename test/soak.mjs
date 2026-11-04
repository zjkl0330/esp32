#!/usr/bin/env node
/**
 * soak.mjs —— 线上出口稳定性压测（真板子、真网络、真生产路径）
 *
 * prod-verify 回答的是"能不能跑通"，这个脚本回答的是另外三个问题：
 *   1. 连续调用之后 heap 是回到原位，还是每次掉一点往下走（泄漏）
 *   2. 边界输入（撞体积上限 / 域名不存在 / 黑洞 IP / 并发撞车）会不会把设备打挂
 *   3. 压测过程中设备有没有偷偷重启（up 归零、firstSeen 变化、静默超时）
 *
 * 刻意不开串口：生产环境没人读串口。开了串口固件的 logf() 就不会丢日志，
 * 测的就不是生产条件了。全部通过 HTTP 观测。
 *
 * 用法：
 *   ADMIN_TOKEN=xxx node test/soak.mjs            # 场景 + 负载
 *   ADMIN_TOKEN=xxx node test/soak.mjs scenarios  # 只跑边界场景
 *   ADMIN_TOKEN=xxx node test/soak.mjs load       # 只跑连续负载
 *   ADMIN_TOKEN=xxx node test/soak.mjs watch 300  # 只看 300 秒（不发起任何调用）
 *
 * 环境变量：
 *   EXIT_BASE   默认 https://exit.example.com
 *   ADMIN_TOKEN 面板口令，必填
 */

import fs from 'node:fs';
import path from 'node:path';

const BASE = (process.env.EXIT_BASE || 'https://exit.example.com').replace(/\/+$/, '');
const ADMIN = process.env.ADMIN_TOKEN || '';
const OUT_DIR = path.join(import.meta.dirname, '.soak');
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
const OUT_FILE = path.join(OUT_DIR, `run-${RUN_ID}.jsonl`);

if (!ADMIN) {
  console.error('缺少 ADMIN_TOKEN 环境变量');
  process.exit(2);
}
fs.mkdirSync(OUT_DIR, { recursive: true });
const jsonl = fs.createWriteStream(OUT_FILE, { flags: 'a' });

function record(kind, obj) {
  jsonl.write(JSON.stringify({ t: Date.now(), kind, ...obj }) + '\n');
}

let COOKIE = '';

async function login() {
  // 口令走 POST body，不进 URL —— Worker 侧已经不再接受 ?token=
  const r = await fetch(`${BASE}/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: ADMIN }).toString(),
    redirect: 'manual',
  });
  const sc = r.headers.get('set-cookie');
  if (!sc) throw new Error(`登录失败，HTTP ${r.status}，没拿到 cookie`);
  COOKIE = sc.split(';')[0];
}

/** 下发一次工具调用，返回 { http, ms, ok, err, bytes, status, err_short } */
async function call(tool, args = {}, timeoutMs = 25000) {
  const t0 = Date.now();
  let http = 0;
  let raw = '';
  try {
    const r = await fetch(`${BASE}/admin/api/call`, {
      method: 'POST',
      headers: { cookie: COOKIE, 'content-type': 'application/json' },
      body: JSON.stringify({ tool, args, timeoutMs }),
    });
    http = r.status;
    raw = await r.text();
  } catch (e) {
    return { http: 0, ms: Date.now() - t0, ok: false, err: `网络层: ${e.message}`, bytes: 0 };
  }
  let j = null;
  try {
    j = JSON.parse(raw);
  } catch {}
  const ms = Date.now() - t0;
  const out = {
    http,
    ms,
    ok: j?.ok === true,
    bytes: j?.meta?.bytes ?? 0,
    status: j?.meta?.status ?? 0,
    redirects: j?.meta?.redirects ?? 0,
    err: j?.ok === true ? '' : (j?.err || j?.error || raw.slice(0, 120) || 'unknown'),
  };
  record('call', { tool, args, ...out });
  return out;
}

async function snap() {
  try {
    const r = await fetch(`${BASE}/admin/api/snapshot`, {
      headers: { cookie: COOKIE },
      cache: 'no-store',
    });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// 后台采样器：heap 只有心跳（20s）才更新，所以 5s 采一次就够抓趋势
// ─────────────────────────────────────────────────────────────
const samples = [];
let sampler = null;
function startSampler() {
  sampler = setInterval(async () => {
    const s = await snap();
    if (!s) return;
    const n = s.nodes?.[0];
    const row = {
      at: Date.now(),
      online: !!n?.online,
      heap: n?.heap ?? null,
      rssi: n?.rssi ?? null,
      silentFor: n?.silentFor ?? null,
      up: n?.uptime ?? null,
      firstSeen: n?.firstSeen ?? null,
      todayCalls: s.stats?.todayCalls ?? null,
      successRate: s.stats?.successRate ?? null,
    };
    samples.push(row);
    record('sample', row);
  }, 5000);
}
function stopSampler() {
  if (sampler) clearInterval(sampler);
  sampler = null;
}

/** 从采样序列里找设备重启的证据：up 变小、firstSeen 变化 */
function restarts() {
  const hits = [];
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1];
    const b = samples[i];
    if (a.up != null && b.up != null && b.up < a.up - 5) {
      hits.push({ at: b.at, from: a.up, to: b.up, why: 'up 归零（设备重启或重连）' });
    }
    if (a.firstSeen && b.firstSeen && b.firstSeen !== a.firstSeen) {
      hits.push({ at: b.at, why: 'firstSeen 变化（被视为新连接）' });
    }
  }
  return hits;
}

// ─────────────────────────────────────────────────────────────
// 场景集：每个都带"想验证什么"，不然跑完只是一堆数字
// ─────────────────────────────────────────────────────────────
const SCENARIOS = [
  {
    name: '基线·小文件',
    why: '十次小抓取后 heap 应回原位，否则就是每调一次漏一点',
    n: 10,
    gap: 400,
    tool: 'https_fetch',
    args: { host: 'www.baidu.com', path: '/robots.txt' },
  },
  {
    name: '撞体积上限',
    why: 'QQ 首页远超 128KB，应 truncated 而不是把设备撑爆',
    n: 3,
    gap: 1500,
    tool: 'https_fetch',
    args: { host: 'www.qq.com', path: '/', maxBytes: 200000 },
  },
  {
    name: '明文 HTTP + 跳转',
    why: 'http 地址应吃到 302 并跟随，redirects 应 > 0',
    n: 3,
    gap: 800,
    tool: 'http_get',
    args: { host: 'www.baidu.com', path: '/' },
  },
  {
    name: '域名不存在',
    why: 'DNS 失败要干净报错，不能卡到 15s 预算耗尽',
    n: 2,
    gap: 800,
    tool: 'https_fetch',
    args: { host: 'no-such-host.invalid', path: '/' },
  },
  {
    name: '黑洞 IP 超时',
    why: '192.0.2.1 永不应答，应在 6s 单跳超时内返回而不是拖满 15s',
    n: 2,
    gap: 800,
    tool: 'http_get',
    args: { url: 'http://192.0.2.1/', timeoutMs: 8000 },
  },
  {
    name: 'DNS 工具',
    why: '纯本地查询，应稳定微秒级',
    n: 5,
    gap: 200,
    tool: 'dns_lookup',
    args: { host: 'www.baidu.com' },
  },
  {
    name: '网络信息',
    why: '读自身状态，不该有任何失败',
    n: 5,
    gap: 200,
    tool: 'net_info',
    args: {},
  },
];

function fmtMs(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}
function pad(s, n) {
  const str = String(s);
  // 中文按 2 列宽算，不然表格会歪
  const w = [...str].reduce((a, c) => a + (c.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
  return str + ' '.repeat(Math.max(0, n - w));
}

async function runScenarios() {
  console.log('\n【边界场景】\n');
  const results = [];
  for (const sc of SCENARIOS) {
    const list = [];
    for (let i = 0; i < sc.n; i++) {
      const r = await call(sc.tool, sc.args);
      list.push(r);
      if (sc.gap) await new Promise((res) => setTimeout(res, sc.gap));
    }
    const ok = list.filter((r) => r.ok).length;
    const avg = Math.round(list.reduce((a, r) => a + r.ms, 0) / list.length);
    const bytes = list.reduce((a, r) => a + r.bytes, 0);
    const errs = [...new Set(list.filter((r) => !r.ok).map((r) => r.err))];
    results.push({ name: sc.name, why: sc.why, n: sc.n, ok, avg, bytes, errs, list });
    console.log(
      `  ${pad(sc.name, 22)} ${pad(`${ok}/${sc.n} 成功`, 12)} ${pad(`均 ${fmtMs(avg)}`, 12)} ${pad(`${bytes}B`, 10)}` +
        (errs.length ? `  ← ${errs.join(' | ')}` : '')
    );
  }
  return results;
}

/**
 * 连续负载：小文件为主、定期掺一个大文件。
 * 判断标准不是"全成功"，而是 heap 曲线有没有系统性下台阶。
 */
async function runLoad(total = 120, gap = 250) {
  console.log(`\n【连续负载】${total} 次，间隔 ${gap}ms\n`);
  const list = [];
  const bar = 20;
  for (let i = 0; i < total; i++) {
    const big = i > 0 && i % 20 === 0;
    const r = big
      ? await call('https_fetch', { host: 'www.qq.com', path: '/', maxBytes: 200000 })
      : await call('https_fetch', { host: 'www.baidu.com', path: '/robots.txt' });
    list.push(r);
    if (i % 5 === 0 || i === total - 1) {
      const done = Math.round(((i + 1) / total) * bar);
      process.stdout.write(`\r  [${'#'.repeat(done)}${'.'.repeat(bar - done)}] ${i + 1}/${total}`);
    }
    if (gap) await new Promise((res) => setTimeout(res, gap));
  }
  process.stdout.write('\n');
  const ok = list.filter((r) => r.ok).length;
  const avg = Math.round(list.reduce((a, r) => a + r.ms, 0) / list.length);
  const errs = [...new Set(list.filter((r) => !r.ok).map((r) => r.err))];
  console.log(`  成功 ${ok}/${total} · 均 ${fmtMs(avg)} · 总流量 ${list.reduce((a, r) => a + r.bytes, 0)}B`);
  if (errs.length) console.log(`  失败类型：${errs.join(' | ')}`);
  return { total, ok, avg, errs, list };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 静置探针。
 *
 * 为什么不能直接拿压测过程中的 heap 采样算斜率：抓取瞬间 TLS 上下文要吃掉
 * 20~25KB，采样点落在"正在抓"还是"闲着"上，差值比泄漏量本身大十倍，
 * 算出来的斜率纯属噪声（上一版就出现过 +28291 B/分钟这种数字）。
 *
 * 所以判断泄漏只能比"闲置时的堆"，而且要让心跳跑够两轮（20s×2）确保
 * 拿到的不是木乃伊数据。
 */
async function idleProbe(label, settleSec = 45) {
  process.stdout.write(`  ${label}：静置 ${settleSec}s 等心跳刷新`);
  await sleep(settleSec * 1000);
  const vals = [];
  for (let i = 0; i < 3; i++) {
    process.stdout.write('.');
    const s = await snap();
    const h = s?.nodes?.[0]?.heap;
    if (typeof h === 'number') vals.push(h);
    await sleep(8000);
  }
  process.stdout.write('\n');
  if (!vals.length) return null;
  vals.sort((a, b) => a - b);
  return { label, median: vals[Math.floor(vals.length / 2)], vals };
}

function heapCurve() {
  const hs = samples.filter((s) => s.heap != null);
  if (hs.length < 4) return;
  const min = Math.min(...hs.map((s) => s.heap));
  const max = Math.max(...hs.map((s) => s.heap));
  const H = 6;
  const grid = Array.from({ length: H }, () => Array(hs.length).fill(' '));
  const span = Math.max(1, max - min);
  hs.forEach((s, i) => {
    const y = H - 1 - Math.round(((s.heap - min) / span) * (H - 1));
    grid[y][i] = '*';
  });
  console.log('\n【压测期间 heap 波动】');
  console.log(`  ${max}B`);
  grid.forEach((row) => console.log('  |' + row.join('')));
  console.log(`  ${min}B  (${hs.length} 点 / ${Math.round((hs[hs.length - 1].at - hs[0].at) / 1000)}s)`);
  console.log(`  波动幅度 ${max - min} B —— 这是 TLS 上下文的瞬时占用，不是泄漏`);
}

/** 用两次静置的净变化判定泄漏 */
function heapVerdict(before, after, calls) {
  console.log('\n【泄漏判定】（静置态对比，排除抓取瞬时占用）');
  if (!before || !after) {
    console.log('  ! 静置探针没拿到数据，无法判定');
    return { verdict: 'unknown', delta: null };
  }
  const delta = after.median - before.median;
  console.log(`  压测前静置 ${before.median} B  →  压测后静置 ${after.median} B`);
  console.log(`  ${calls} 次调用净变化 ${delta >= 0 ? '+' : ''}${delta} B（每次合 ${(delta / Math.max(1, calls)).toFixed(1)} B）`);

  // 阈值：单次净漏 < 8B 判为碎片噪声；8~64B 需要更长观测；> 64B 是真漏
  const perCall = delta / Math.max(1, calls);
  let verdict;
  if (perCall < -64) {
    verdict = `⚠ 每次调用净漏 ${Math.abs(perCall).toFixed(0)}B —— 真泄漏，一天按 2000 次算要掉 ${((Math.abs(perCall) * 2000) / 1024).toFixed(0)}KB`;
  } else if (perCall < -8) {
    verdict = `△ 每次净漏 ${Math.abs(perCall).toFixed(1)}B，量级太小分不清是碎片还是泄漏，需要几小时观测`;
  } else {
    verdict = `✓ 基本无泄漏（每次 ${perCall >= 0 ? '+' : ''}${perCall.toFixed(1)}B）`;
  }
  console.log(`  判定：${verdict}`);
  return { verdict, delta, perCall: Math.round(perCall * 10) / 10 };
}

async function main() {
  const mode = process.argv[2] || 'all';
  console.log(`出口稳定性压测  ${BASE}`);
  console.log(`记录 → ${OUT_FILE}`);
  await login();
  console.log('登录 ok');

  const before = await snap();
  if (!before?.nodes?.length) throw new Error('拿不到节点信息');
  const b = before.nodes[0];
  console.log(
    `设备 ${b.nodeId} fw${b.fw} 在线=${b.online} heap=${b.heap} up=${b.uptime}s 已静默 ${b.silentFor}s\n`
  );
  record('begin', { base: BASE, mode, node: b });

  if (mode === 'watch') {
    const secs = Number(process.argv[3] || 300);
    console.log(`被动观察 ${secs}s（不发起任何调用）...`);
    startSampler();
    await sleep(secs * 1000);
    stopSampler();
    heapCurve();
    reportRestarts();
    return finish();
  }

  // 判断泄漏必须比静置态，所以压测前后各探一次
  const heapBefore = await idleProbe('压测前基线');
  startSampler();
  await sleep(2000);

  let sc = null;
  let ld = null;
  if (mode === 'all' || mode === 'scenarios') sc = await runScenarios();
  if (mode === 'all' || mode === 'load') ld = await runLoad(mode === 'load' ? 120 : 100);

  stopSampler();
  const calls = (sc ? sc.reduce((a, r) => a + r.n, 0) : 0) + (ld ? ld.total : 0);
  const heapAfter = await idleProbe('压测后静置');
  const heap = heapVerdict(heapBefore, heapAfter, calls);
  heapCurve();
  reportRestarts();

  const after = await snap();
  const a = after?.nodes?.[0];
  console.log('\n【设备终态】');
  console.log(`  在线=${a?.online} heap=${a?.heap} rssi=${a?.rssi} up=${a?.uptime}s 静默${a?.silentFor}s`);
  console.log(`  今日 ${after?.stats?.todayCalls} 件 · 成功率 ${after?.stats?.successRate ?? '—'}% · 均 ${after?.stats?.avgMs ?? 0}ms`);

  record('end', { node: a, stats: after?.stats, heap });

  // ── 总结论
  console.log('\n════════ 结论 ════════');
  const problems = [];
  const notes = [];
  if (a && !a.online) problems.push('压测结束时设备已离线');
  if (heap?.perCall != null && heap.perCall < -64) problems.push(`每次调用净漏 ${Math.abs(heap.perCall)}B`);
  else if (heap?.perCall != null && heap.perCall < -8) notes.push(`每次净漏 ${Math.abs(heap.perCall)}B，量级需长跑才能定论`);
  if (sc) {
    for (const r of sc) {
      // 「域名不存在」和「黑洞超时」本来就该失败，不算问题
      const expectFail = r.name === '域名不存在' || r.name === '黑洞 IP 超时';
      if (!expectFail && r.ok < r.n) problems.push(`${r.name} 有 ${r.n - r.ok} 次失败：${r.errs.join(',')}`);
      if (expectFail && r.ok > 0) problems.push(`${r.name} 反而成功了，预期失败`);
    }
    // 静默截断：单次字节数撞到 128KB 上限，但上层收不到任何标记
    const t = sc.find((r) => r.name === '撞体积上限');
    if (t) {
      const maxBytes = Math.max(...t.list.map((x) => x.bytes));
      const hitCap = maxBytes >= 131072 * 0.95;
      const flagged = t.list.some((x) => (x.err || '').includes('truncated'));
      if (hitCap && !flagged) {
        problems.push(
          `静默截断：单次收到 ${maxBytes}B（上限 131072B）已撞顶，但 result 里没有 truncated 标记 —— 上层会把半截内容当完整的用`
        );
      }
    }
    const hole = sc.find((r) => r.name === '黑洞 IP 超时');
    if (hole && hole.avg > 12000) problems.push(`黑洞超时耗时 ${hole.avg}ms，超过 12s 预算`);
    const dns = sc.find((r) => r.name === '域名不存在');
    if (dns && dns.avg > 3000) notes.push(`域名不存在要花 ${dns.avg}ms 才报错，DNS 失败路径偏慢`);
  }
  if (ld && ld.ok < ld.total) problems.push(`连续负载失败 ${ld.total - ld.ok}/${ld.total}`);
  if (problems.length) {
    problems.forEach((p) => console.log(`  ✗ ${p}`));
  } else {
    console.log('  ✓ 没有发现稳定性问题');
  }
  if (notes.length) {
    console.log('\n  （存疑，不阻塞）');
    notes.forEach((p) => console.log(`  · ${p}`));
  }
  return finish();
}

function reportRestarts() {
  const rs = restarts();
  console.log('\n【连接中断】');
  if (!rs.length) {
    console.log('  压测期间 up 连续增长，没有重连也没有重启');
  } else {
    rs.forEach((r) => console.log(`  ⚠ ${new Date(r.at).toLocaleTimeString('zh-CN')} ${r.why}${r.from ? `（${r.from}s → ${r.to}s）` : ''}`));
  }
}

function finish() {
  jsonl.end();
  console.log(`\n原始数据 ${OUT_FILE}`);
  process.exit(0);
}

main().catch((e) => {
  console.error('压测中断：', e.message);
  record('fatal', { err: e.message });
  jsonl.end();
  process.exit(1);
});
