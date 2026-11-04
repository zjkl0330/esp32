// test/prod-verify.mjs —— 生产环境的端到端验收（打真实域名，走真实 wss）。
//
// 与 e2e.mjs 的分工：
//   e2e.mjs      验逻辑，在本机用 Node 等价层跑，不需要硬件和网络
//   这个脚本     验现实，打 https://exit.example.com，走 Cloudflare + 真板子 + 真 TLS
//
// 用法：
//   ADMIN_TOKEN=xxx CLIENT_KEY=sk_main_xxx node test/prod-verify.mjs
//   （两个值都不写进代码，避免跟着仓库跑出去）
import process from 'node:process';

const BASE = process.env.EXIT_BASE || 'https://exit.example.com';
const ADMIN = process.env.ADMIN_TOKEN || '';
const KEY = process.env.CLIENT_KEY || '';

let pass = 0;
let fail = 0;
/** 登录后拿到的会话 Cookie（不是口令，是 HMAC 派生值） */
let COOKIE = '';
const failures = [];
function ok(name, cond, extra) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  ✗ ${name}${extra ? '  → ' + extra : ''}`);
  }
}
function section(t) {
  console.log(`\n${t}`);
}

async function j(method, path, opts = {}) {
  const r = await fetch(BASE + path, {
    method,
    headers: opts.headers || {},
    body: opts.body,
    redirect: 'manual',
  });
  const text = await r.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {}
  return { status: r.status, text, json: parsed, headers: r.headers };
}

// ═══════════════ 1. 基础可达性
section('基础可达性');
const health = await j('GET', '/health');
ok(`/health 200（${BASE}）`, health.status === 200 && health.json?.ok === true, `status=${health.status}`);
ok(
  '/health 不泄露内部信息（不含节点数/版本）',
  health.text.length < 40,
  `实际返回 ${health.text.length} 字符`
);

// ═══════════════ 2. 鉴权（fail-closed）
section('鉴权');
const adminNo = await j('GET', '/admin');
ok('/admin 无口令 → 401', adminNo.status === 401, `status=${adminNo.status}`);

// 这次改动的核心：口令只走 POST body。URL 里带口令的旧链接必须彻底失效，
// 不能只验证"新路能走通"——老后门要确认真的关上了。
const legacy = await j('GET', `/admin?token=${encodeURIComponent(ADMIN || 'anything')}`);
ok('URL 带口令不再能进面板 → 401', legacy.status === 401, `status=${legacy.status}`);
ok(
  '并明确提示「口令不能放网址里」',
  /不能再放在网址里/.test(legacy.text),
  legacy.text.slice(0, 80)
);

const badLogin = await j('POST', '/admin/login', {
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ token: 'definitely-wrong' }).toString(),
});
ok('错口令登录 → 401', badLogin.status === 401, `status=${badLogin.status}`);
ok('/admin 错口令返回的是登录页（不是报错栈）', /面板口令|口令不对/.test(badLogin.text), badLogin.text.slice(0, 60));

if (ADMIN) {
  const good = await j('POST', '/admin/login', {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: ADMIN }).toString(),
  });
  const sc = good.headers.get('set-cookie') || '';
  COOKIE = sc.split(';')[0];
  ok(
    '正确口令登录 → 303 并下发会话 Cookie',
    good.status === 303 && COOKIE.startsWith('adm='),
    `status=${good.status}`
  );
  ok('Cookie 是 HttpOnly', /HttpOnly/i.test(sc), sc.slice(0, 60));
  ok('Cookie 里存的不是口令本身（是 HMAC 派生值）', COOKIE !== `adm=${ADMIN}`);

  const adminPage = await j('GET', '/admin', { headers: { cookie: COOKIE } });
  ok('带会话 Cookie 可进面板 → 200', adminPage.status === 200, `status=${adminPage.status}`);
  const snap = await j('GET', '/admin/api/snapshot', { headers: { authorization: `Bearer ${ADMIN}` } });
  ok('快照接口可读', snap.status === 200 && Array.isArray(snap.json?.nodes));
  if (snap.json) {
    const sec = snap.json.security || {};
    ok(
      `三项密钥都已启用（面板${sec.adminTokenSet ? '✓' : '✗'} 设备${sec.tunnelTokenSet ? '✓' : '✗'} 对外${sec.clientKeys}把）`,
      sec.adminTokenSet === true && sec.tunnelTokenSet === true && sec.clientKeys > 0
    );
  }

  // 设备是否连上
  section('设备连接（wss + token）');
  let nodes = [];
  const deadline = Date.now() + 90_000;
  process.stdout.write('  等待板子通过 wss 连上来');
  while (Date.now() < deadline) {
    const s = await j('GET', '/admin/api/snapshot', { headers: { authorization: `Bearer ${ADMIN}` } });
    nodes = s.json?.nodes || [];
    if (nodes.some((n) => n.online)) break;
    process.stdout.write('.');
    await new Promise((r) => setTimeout(r, 3000));
  }
  process.stdout.write('\n');
  const online = nodes.filter((n) => n.online);
  ok(
    `板子已在线（${online.map((n) => n.nodeId).join(',') || '无'}）`,
    online.length > 0,
    nodes.length ? `共 ${nodes.length} 台，全部离线` : '一条记录都没有'
  );
  if (online.length) {
    const n = online[0];
    ok(`上报了固件版本（${n.fw}）`, !!n.fw);
    ok(`上报了工具表（${(n.tools || []).join(',')}）`, (n.tools || []).length > 0);
    ok(`heap 健康（${Math.round((n.heap || 0) / 1024)}KB > 100KB）`, (n.heap || 0) > 100 * 1024);
  }

  // 工具栏按钮用的接口
  section('控制面下发（面板按钮走的就是这个）');
  const netCall = await j('POST', '/admin/api/call', {
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ADMIN}` },
    body: JSON.stringify({ tool: 'net_info', args: {}, timeoutMs: 25000 }),
  });
  ok(
    `net_info 成功（${netCall.json?.meta?.ms ?? '—'}ms）`,
    netCall.json?.ok === true,
    JSON.stringify(netCall.json).slice(0, 120)
  );
}

// ═══════════════ 3. 对外接口
if (KEY) {
  section('对外抓取 API');
  const noKey = await j('GET', '/api/fetch?url=https://www.baidu.com');
  ok('无 key → 401', noKey.status === 401, `status=${noKey.status}`);

  const badKey = await j('GET', '/api/fetch?url=https://www.baidu.com', {
    headers: { authorization: 'Bearer sk_not_a_real_key' },
  });
  ok('错 key → 401', badKey.status === 401, `status=${badKey.status}`);

  const real = await j('GET', '/api/fetch?url=https://www.baidu.com', {
    headers: { authorization: `Bearer ${KEY}` },
  });
  if (real.status === 200) {
    ok(`抓取成功（${real.text.length} 字符，${real.headers.get('x-exit-ms')}ms）`, real.text.length > 0);
    ok(`响应头带发起方标识（${real.headers.get('x-exit-key')}）`, !!real.headers.get('x-exit-key'));
  } else {
    ok('抓取成功', false, `status=${real.status} ${real.text.slice(0, 120)}`);
  }

  section('SSRF 防护（线上真实拦截）');
  for (const [url, label] of [
    ['http://192.168.1.1', '你家路由器'],
    ['http://127.0.0.1/', '回环'],
    ['http://169.254.169.254/latest/meta-data/', '云元数据'],
    ['http://2130706433/', '十进制伪装的 127.0.0.1'],
    ['http://localhost:8080/', 'localhost'],
  ]) {
    const r = await j('GET', `/api/fetch?url=${encodeURIComponent(url)}`, {
      headers: { authorization: `Bearer ${KEY}` },
    });
    ok(`拦 ${label}（${r.status} ${r.json?.reason || r.json?.error || ''}）`, r.status === 403);
  }

  section('额度');
  const me = await j('GET', '/api/me', { headers: { authorization: `Bearer ${KEY}` } });
  ok(
    `额度可查（已用 ${me.json?.calls}/${me.json?.limit?.dayCalls} 次）`,
    me.status === 200 && typeof me.json?.calls === 'number'
  );
} else {
  console.log('\n（未提供 CLIENT_KEY，跳过对外接口验证）');
}
if (!ADMIN) console.log('\n（未提供 ADMIN_TOKEN，跳过面板与设备验证）');

// ═══════════════ 汇总
console.log(`\n${'─'.repeat(56)}`);
if (fail === 0) {
  console.log(`${pass} passed, 0 failed`);
  process.exit(0);
} else {
  console.log(`${pass} passed, ${fail} failed`);
  for (const f of failures) console.log(`  失败: ${f}`);
  process.exit(1);
}
