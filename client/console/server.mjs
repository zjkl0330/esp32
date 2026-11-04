// server.mjs —— 「ESP32 WOL + 内网穿透」统一 Web 控制台（本地服务）。
//
//   运行：node console/server.mjs
//   打开：http://localhost:8787/          （本机 / 局域网）
//         在手机存一份自包含页面：http://<本机局域网IP>:8787/remote.html
//
// 提供：
//   · 静态 UI（GET / 或 /remote.html，注入运行时 config，但不含任何 token）
//   · REST API（见下）——隧道管理与 WOL 代理
//   · TunnelManager：把本地端口映射成「隧道 -> 局域网目标」并常驻
//
// 环境变量：
//   PORT / CONSOLE_PORT   本地监听端口（默认 8787）
//   WORKER_BASE           Worker 公网地址（默认 https://tunnel.example.com）
//   TUNNEL_NAME           隧道名（默认 wol）
//   TUNNEL_TOKEN          Worker 鉴权 token（服务器侧用，绝不下发前端）
//   CONSOLE_TOKEN         可选：给本控制台自己的 API 加鉴权
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { TunnelManager } from './tunnel-manager.mjs';
import { getStatus, sendWol } from './worker-api.mjs';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || process.env.CONSOLE_PORT || 8787);
const WORKER_BASE = (process.env.WORKER_BASE || 'https://tunnel.example.com').replace(/\/+$/, '');
const TUNNEL_NAME = process.env.TUNNEL_NAME || 'wol';
const CONSOLE_TOKEN = process.env.CONSOLE_TOKEN || '';

// worker token：优先 env；允许页面通过 /api/session 在内存里补设（不落盘）
let workerToken = process.env.TUNNEL_TOKEN || '';

const MANAGER_FILE = process.env.CONSOLE_STATE || path.join(__dirname, 'tunnels.json');
const INDEX_PATH = path.join(__dirname, 'public', 'index.html');

const manager = new TunnelManager({
  workerBase: WORKER_BASE,
  tunnel: TUNNEL_NAME,
  token: workerToken,
  file: MANAGER_FILE,
});
manager.startAutostart();

// 每次隧道状态变化把最新 token 同步给管理器
function syncToken() { manager.token = workerToken; }

// ---------- 工具 ----------
function sendJson(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'connection': 'close',
  });
  res.end(body);
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  const body = Buffer.from(text, 'utf8');
  res.writeHead(status, { 'content-type': type, 'content-length': body.length, 'connection': 'close' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

// 本控制台自身 API 的鉴权（可选）。与 Worker 一致：Bearer 或 ?token=
function consoleAuthed(req, u) {
  if (!CONSOLE_TOKEN) return true;
  const h = req.headers['authorization'] || '';
  if (h === `Bearer ${CONSOLE_TOKEN}`) return true;
  if (u.searchParams.get('token') === CONSOLE_TOKEN) return true;
  return false;
}

// ---------- 静态页：注入 config（关键：不含 token）----------
function renderPage(mode, req) {
  let html;
  try {
    html = fs.readFileSync(INDEX_PATH, 'utf8');
  } catch (e) {
    return `控制台页面缺失: ${e.message}`;
  }
  const cfg = {
    mode,                       // 'http' = 同源 fetch；'remote' = 浏览器帧隧道
    workerBase: WORKER_BASE,
    tunnel: TUNNEL_NAME,
    // remote 模式下手机需要知道控制台在局域网里的地址；用下载时的 Host 头推断
    consoleHost: mode === 'remote' ? (req.headers.host || '') : '',
    authRequired: !!CONSOLE_TOKEN,
    hasWorkerToken: !!workerToken,
  };
  const inject = `<script>window.__CFG__=${JSON.stringify(cfg)};</script>`;
  return html.includes('<!--__CFG__-->')
    ? html.replace('<!--__CFG__-->', inject)
    : html.replace('</head>', `${inject}</head>`);
}

// ---------- 路由 ----------
async function handleApi(req, res, u) {
  if (!consoleAuthed(req, u)) return sendJson(res, 401, { error: 'unauthorized' });

  const p = u.pathname;
  const method = req.method || 'GET';

  // GET /api/config
  if (p === '/api/config' && method === 'GET') {
    return sendJson(res, 200, {
      workerBase: WORKER_BASE,
      tunnel: TUNNEL_NAME,
      authRequired: !!CONSOLE_TOKEN,
      hasWorkerToken: !!workerToken,
    });
  }

  // POST /api/session  { workerToken }  仅存内存
  if (p === '/api/session' && method === 'POST') {
    const body = await readBody(req);
    if (typeof body.workerToken === 'string') {
      workerToken = body.workerToken.trim();
      syncToken();
    }
    return sendJson(res, 200, { hasWorkerToken: !!workerToken });
  }

  // GET /api/status
  if (p === '/api/status' && method === 'GET') {
    syncToken();
    const r = await getStatus({ base: WORKER_BASE, tunnel: TUNNEL_NAME, token: workerToken });
    return sendJson(res, r.ok ? 200 : (r.status || 502), r);
  }

  // POST /api/wol  { mac? }
  if (p === '/api/wol' && method === 'POST') {
    syncToken();
    const body = await readBody(req);
    const r = await sendWol({ base: WORKER_BASE, tunnel: TUNNEL_NAME, token: workerToken, mac: body.mac });
    return sendJson(res, 200, r); // 业务失败也回 200，前端看 r.ok
  }

  // GET /api/tunnels
  if (p === '/api/tunnels' && method === 'GET') {
    return sendJson(res, 200, { tunnels: manager.list() });
  }

  // POST /api/tunnels
  if (p === '/api/tunnels' && method === 'POST') {
    const body = await readBody(req);
    try {
      const t = manager.add(body);
      return sendJson(res, 201, { ok: true, tunnel: manager.list().find((x) => x.id === t.id) });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message });
    }
  }

  // /api/tunnels/:id 及其动作
  const m = p.match(/^\/api\/tunnels\/([^/]+)(?:\/(start|stop))?$/);
  if (m) {
    const id = decodeURIComponent(m[1]);
    const action = m[2];
    if (!manager.get(id)) return sendJson(res, 404, { ok: false, error: '映射不存在' });

    if (method === 'DELETE' && !action) {
      manager.remove(id);
      return sendJson(res, 200, { ok: true });
    }
    if (method === 'POST' && action === 'start') {
      manager.start(id);
      return sendJson(res, 200, { ok: true });
    }
    if (method === 'POST' && action === 'stop') {
      await manager.stop(id);
      return sendJson(res, 200, { ok: true });
    }
    if (method === 'PATCH' && !action) {
      const body = await readBody(req);
      try {
        const t = manager.update(id, body);
        return sendJson(res, 200, { ok: true, tunnel: manager.list().find((x) => x.id === t.id) });
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: e.message });
      }
    }
  }

  return sendJson(res, 404, { error: 'not found' });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (u.pathname.startsWith('/api/')) {
    try { return await handleApi(req, res, u); }
    catch (e) { return sendJson(res, 500, { error: e?.message ?? String(e) }); }
  }

  // 页面
  if (u.pathname === '/' || u.pathname === '/index.html') {
    return sendText(res, 200, renderPage('http', req), 'text/html; charset=utf-8');
  }
  if (u.pathname === '/remote.html') {
    // 手机存下来用：mode=remote，浏览器走帧隧道
    return sendText(res, 200, renderPage('remote', req), 'text/html; charset=utf-8');
  }

  return sendText(res, 404, 'not found');
});

server.listen(PORT, '0.0.0.0', () => {
  const hasTok = workerToken ? '已配置' : '未配置（若 Worker 开了鉴权会 401）';
  console.log('');
  console.log('  ESP32 WOL + 内网穿透 · 统一控制台');
  console.log('  ─────────────────────────────────────');
  console.log(`  本机访问   http://localhost:${PORT}/`);
  console.log(`  手机外网   http://<本机局域网IP>:${PORT}/remote.html  （存一次即可）`);
  console.log(`  Worker     ${WORKER_BASE}  (tunnel=${TUNNEL_NAME})`);
  console.log(`  Worker token  ${hasTok}`);
  console.log(`  控制台鉴权     ${CONSOLE_TOKEN ? '已开启 (CONSOLE_TOKEN)' : '未开启'}`);
  console.log('');
});
