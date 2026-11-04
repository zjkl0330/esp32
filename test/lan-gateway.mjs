// lan-gateway.mjs —— 让真实 ESP32-C6 连进来的本地网关（不碰生产环境）
//
// 起三个东西：
//   :8787  0.0.0.0  Node 等价中继（板子连这里，走明文 ws://）
//   :8788  127.0.0.1 Manager（面板数据来源）
//   :8790  0.0.0.0  面板 /admin + 对外接口 /api/fetch
//
// 为什么要有这个：Worker 还没部署、或者不想为了调试固件去动生产隧道时，
// 板子需要一个能连的地方。这条链路除了 TLS 换成了明文，其余握手/帧/JSON
// 与生产完全一致 —— 同一个 relay-node.mjs、同一个 manager-node.mjs、
// 同一份 security.ts 校验逻辑。
//
// 鉴权行为与生产一致（fail-closed）：本地默认 ADMIN_TOKEN=dev 只是为了让
// 双击就能用，不等于生产可以留空。
//
// 用法：
//   node test/lan-gateway.mjs
//   ADMIN_TOKEN=xxx CLIENT_KEYS='[{"name":"rin","key":"sk_dev"}]' node test/lan-gateway.mjs
// 固件：把 ESP32_C6_Exit.ino 里 TEST_MODE 置 1，WS_HOST 改成这台电脑的局域网 IP
import http from 'node:http';
import os from 'node:os';
import { adminPage, loginPage, setupPage } from '../worker/src/panel.ts';
import {
  checkTarget,
  deriveSession,
  hostAllowed,
  matchClientKey,
  parseClientKeys,
  safeEqual,
} from '../worker/src/security.ts';
import { createManager } from './manager-node.mjs';
import { createRelay } from './relay-node.mjs';

const RELAY_PORT = Number(process.env.RELAY_PORT || 8787);
const MGR_PORT = Number(process.env.MGR_PORT || 8788);
const PANEL_PORT = Number(process.env.PANEL_PORT || 8790);

// 本地默认口令给个 dev，纯粹为了「双击就能打开看」。
// 生产必须显式配 —— index.ts 在没配时是直接拒绝的。
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'dev';
const TUNNEL_TOKEN = process.env.TUNNEL_TOKEN || '';
const CLIENT_KEYS_RAW = process.env.CLIENT_KEYS || '';
const clientKeys = parseClientKeys(CLIENT_KEYS_RAW);

// ── Manager
const mgr = createManager({
  relayBase: `http://127.0.0.1:${RELAY_PORT}`,
  ttl: 50_000,
  clientKeys,
  adminToken: ADMIN_TOKEN,
  tunnelToken: TUNNEL_TOKEN,
});
await new Promise((r) => mgr.server.listen(MGR_PORT, '127.0.0.1', r));

// ── Relay（绑 0.0.0.0，板子才连得进来）
const relay = createRelay({ managerBase: `http://127.0.0.1:${MGR_PORT}` });
await new Promise((r) => relay.server.listen(RELAY_PORT, '0.0.0.0', r));

const SESSION = await deriveSession(ADMIN_TOKEN);

function cookieToken(req) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === 'adm') return decodeURIComponent(rest.join('='));
  }
  return null;
}

async function adminOk(req) {
  if (!ADMIN_TOKEN) return false;
  const h = req.headers.authorization || '';
  const bt = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (bt && (await safeEqual(bt, ADMIN_TOKEN))) return true;
  // 不接受 ?token= —— 与线上 Worker 保持一致，否则本地测出来的"能用"是假的
  const c = cookieToken(req);
  if (c && (await safeEqual(c, SESSION))) return true;
  return false;
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

async function readRaw(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

// ── 对外抓取 API（与 index.ts 的 /api/fetch 同语义，本地实现一遍只为能真跑）
async function handleApiFetch(req, res, url) {
  if (!clientKeys.length) {
    return sendJson(res, 503, {
      error: 'no_client_keys',
      detail: 'CLIENT_KEYS 未配置（本地可以这样起：CLIENT_KEYS=\'[{"name":"rin","key":"sk_dev"}]\'）',
    });
  }
  const h = req.headers.authorization || '';
  const bt = h.startsWith('Bearer ') ? h.slice(7) : '';
  const presented = bt || url.searchParams.get('key') || '';
  const key = await matchClientKey(clientKeys, presented);
  if (!key) return sendJson(res, 401, { error: 'unauthorized' });

  let payload = {};
  if (req.method === 'GET') {
    payload.url = url.searchParams.get('url') || '';
    if (url.searchParams.get('json')) payload.json = true;
  } else {
    const body = await readRaw(req);
    try {
      payload = body ? JSON.parse(body.toString('utf8')) : {};
    } catch {
      return sendJson(res, 400, { error: 'invalid_json' });
    }
  }
  if (!payload.url) return sendJson(res, 400, { error: 'url required' });

  let target;
  try {
    target = new URL(payload.url);
  } catch {
    return sendJson(res, 400, { error: 'bad_url' });
  }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    return sendJson(res, 400, { error: 'bad_scheme' });
  }

  const chk = checkTarget(target.hostname);
  if (!chk.ok) {
    return sendJson(res, 403, { error: 'target_blocked', reason: chk.reason, host: target.hostname });
  }
  if (!hostAllowed(target.hostname, key.hosts)) {
    return sendJson(res, 403, { error: 'host_not_allowed', host: target.hostname, allow: key.hosts });
  }

  const includePort = target.port && target.port !== '80' && target.port !== '443';
  const r = await fetch(`http://127.0.0.1:${MGR_PORT}/call`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tool: target.protocol === 'https:' ? 'https_fetch' : 'http_get',
      args: {
        host: includePort ? `${target.hostname}:${target.port}` : target.hostname,
        path: target.pathname + target.search,
        tls: target.protocol === 'https:',
        maxBytes: payload.maxBytes,
      },
      timeoutMs: payload.timeoutMs ?? 20_000,
      clientKey: key.name,
    }),
  });
  const text = await r.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return sendJson(res, 502, { error: 'relay_bad_json', raw: text.slice(0, 200) });
  }

  const metaHeaders = {
    'x-exit-ms': String(parsed.meta?.ms ?? ''),
    'x-exit-bytes': String(parsed.meta?.bytes ?? ''),
    'x-exit-key': key.name,
  };

  if (parsed.ok !== true) {
    res.writeHead(r.status === 200 ? 502 : r.status, {
      'content-type': 'application/json; charset=utf-8',
      ...metaHeaders,
    });
    return res.end(JSON.stringify({ error: parsed.error ?? parsed.err, meta: parsed.meta }));
  }

  const bytes = parsed.data ? Buffer.from(parsed.data, 'base64') : Buffer.alloc(0);
  if (payload.json) {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', ...metaHeaders });
    return res.end(
      JSON.stringify({
        ok: true,
        status: parsed.meta?.status ?? null,
        bytes: bytes.length,
        ms: parsed.meta?.ms ?? null,
        redirects: parsed.meta?.redirects ?? 0,
        via: key.name,
        encoding: 'base64',
        data: parsed.data ?? '',
        text: bytes.length <= 262144 ? bytes.toString('utf8') : null,
      })
    );
  }
  res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store', ...metaHeaders });
  res.end(bytes);
}

// ── 面板
const panel = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');

  if (url.pathname === '/health') {
    return sendJson(res, 200, { ok: true });
  }

  if (url.pathname === '/admin/login' && req.method === 'POST') {
    if (!ADMIN_TOKEN) {
      res.writeHead(503, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(setupPage('ADMIN_TOKEN'));
    }
    const body = await readRaw(req);
    // readRaw 回的是 Buffer，直接塞给 URLSearchParams 会报
    // "Each query pair must be an iterable" —— 必须先转字符串
    const token = new URLSearchParams(body ? body.toString('utf8') : '').get('token') || '';
    if (!(await safeEqual(token, ADMIN_TOKEN))) {
      res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(loginPage('口令不对，再试一次'));
    }
    // 本地是 http，不能加 Secure，否则浏览器直接不存这个 Cookie
    res.writeHead(303, {
      location: '/admin',
      'set-cookie': `adm=${SESSION}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800`,
    });
    return res.end();
  }

  if (url.pathname === '/' || url.pathname === '/admin' || url.pathname === '/admin/') {
    if (!ADMIN_TOKEN) {
      res.writeHead(503, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(setupPage('ADMIN_TOKEN'));
    }
    if (!(await adminOk(req))) {
      const hint = url.searchParams.has('token')
        ? '口令不能再放在网址里了，请在下面输入框重新登录'
        : undefined;
      res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(loginPage(hint));
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(adminPage());
  }

  if (url.pathname.startsWith('/admin/api/')) {
    if (!(await adminOk(req))) return sendJson(res, 401, { error: 'unauthorized' });
    const sub = url.pathname.slice('/admin/api'.length);
    // 必须原样转发 method 与 body：面板的命令台是 POST /admin/api/call，
    // 用裸 fetch(url) 会降级成 GET → Manager 的 POST 路由不匹配 → 404。
    const body = await readRaw(req);
    const r = await fetch(`http://127.0.0.1:${MGR_PORT}${sub}${url.search}`, {
      method: req.method,
      headers: { 'content-type': req.headers['content-type'] || 'application/json' },
      body,
    });
    const text = await r.text();
    res.writeHead(r.status, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(text);
  }

  if (url.pathname === '/api/fetch' || url.pathname === '/api/me') {
    if (url.pathname === '/api/me') {
      const h = req.headers.authorization || '';
      const bt = h.startsWith('Bearer ') ? h.slice(7) : '';
      const key = await matchClientKey(clientKeys, bt || url.searchParams.get('key') || '');
      if (!key) return sendJson(res, 401, { error: 'unauthorized' });
      const r = await fetch(`http://127.0.0.1:${MGR_PORT}/quota?name=${encodeURIComponent(key.name)}`);
      res.writeHead(r.status, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(await r.text());
    }
    return handleApiFetch(req, res, url);
  }

  res.writeHead(404);
  res.end('not found');
});
await new Promise((r) => panel.listen(PANEL_PORT, '0.0.0.0', r));

function lanIp() {
  // 只挑能代表「板子看得见的那个网段」的地址。
  // 这台机器上还有一张 VPN 网卡（172.30.x.x），直接取第一个非内网地址会拿到它，
  // 板子根本连不上 —— 所以按优先级挑：192.168 > 10. > 其它，且排除 172.16/12。
  const all = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family !== 'IPv4' || ni.internal) continue;
      if (ni.address.startsWith('169.254.')) continue;
      all.push({ name, ip: ni.address });
    }
  }
  const isVpn = (ip) => {
    const [a, b] = ip.split('.').map(Number);
    return a === 172 && b >= 16 && b <= 31;
  };
  const score = (ip) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : isVpn(ip) ? 9 : 2);
  all.sort((x, y) => score(x.ip) - score(y.ip));
  return all[0]?.ip ?? '127.0.0.1';
}

const IP = lanIp();
console.log('');
console.log('  ┌─ 板子要连的地址 ────────────────────────────');
console.log(`  │ ws://${IP}:${RELAY_PORT}/ws/wol/esp32`);
console.log('  ├─ 面板 ─────────────────────────────────────');
console.log(`  │ http://127.0.0.1:${PANEL_PORT}/admin   （口令：ADMIN_TOKEN 那个值，填在表单里；不再支持 ?token=）`);
console.log('  ├─ 对外接口（给别的项目调）──────────────────');
if (clientKeys.length) {
  for (const k of clientKeys) {
    const lim = [
      k.dayCalls ? `${k.dayCalls} 次/天` : '次数不限',
      k.dayBytes ? `${Math.round(k.dayBytes / 1048576)}MB/天` : '流量不限',
    ].join(' · ');
    console.log(`  │ ${k.name.padEnd(10)} key=${k.key}   ${lim}`);
  }
} else {
  console.log('  │ 未配置。CLIENT_KEYS=\'[{"name":"rin","key":"sk_dev"}]\' node test/lan-gateway.mjs');
}
console.log(`  │ curl -H "Authorization: Bearer <key>" \\`);
console.log(`  │   "http://127.0.0.1:${PANEL_PORT}/api/fetch?url=https://www.baidu.com"`);
console.log('  └─────────────────────────────────────────────');
console.log('');
console.log('[gateway] 等待设备连接…（板子上电后会自己连上来）');

// 设备掉线只是数据问题，不该把网关带崩
process.on('uncaughtException', (e) => console.error('[gateway] uncaught:', e?.message || e));
