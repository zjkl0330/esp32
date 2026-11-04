// relay-node.mjs —— Cloudflare DO (worker/src/Relay.ts) 的 Node 等价中继。
// 逻辑一致：配对 / 双向转发 / 手动 WOL 信令（含默认 MAC）/ /panel 页面 / /status
//          + v2 控制面：hello / hb 转发 Manager、/_call 下发工具调用、result 回流。
// 用途：在没有 workerd 的环境里对本项目做端到端真实验证。
import http from 'node:http';
import { WebSocketServer } from 'ws';
import {
  decode,
  decodeCtrl,
  encodeClose,
  encodeCtrl,
  encodeWol,
  FrameType,
} from './protocol.mjs';

const tunnels = new Map();
const TOOL_CH_BASE = 192;
const TOOL_CH_MAX = 255;
const DEFAULT_CALL_TIMEOUT = 20000;
// 与 Relay.ts 的 ESP_STALE_MS 一致：设备心跳 20s 一次，30s = 允许漏一拍。
// 半开的 TCP 连接 readyState 仍是 OPEN，不检查就会白等满 20 秒超时。
const ESP_STALE_MS = 30000;

/** Manager 的地址；createRelay 时可覆盖（e2e 用它接真实 Manager 等价服务） */
let managerBase = '';

/** e2e 里 Manager 的端口要等 relay 起来后才能确定，所以留一个 setter */
export function setManagerBase(u) {
  managerBase = (u || '').replace(/\/+$/, '');
}

function getTunnel(name) {
  let t = tunnels.get(name);
  if (!t) {
    t = { esp32: null, users: [], pending: new Map(), toolCh: new Map() };
    tunnels.set(name, t);
  }
  return t;
}

function addChannel(c, ch) {
  if (!c.channels.includes(ch)) c.channels.push(ch);
}
function removeChannel(c, ch) {
  c.channels = c.channels.filter((x) => x !== ch);
}

async function forwardToManager(path, body) {
  if (!managerBase) return;
  try {
    await fetch(managerBase + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    console.log('[manager] ' + path + ' 失败: ' + e.message);
  }
}

function onCtrl(tunnelName, conn, raw) {
  if (conn.role !== 'esp32') return;
  const msg = decodeCtrl(raw);
  if (!msg) return;
  // 只有文本帧算「设备还活着」的证据，DATA 帧不参与（见 Relay.ts 同名注释）
  conn.ws.lastMsgAt = Date.now();
  const t = getTunnel(tunnelName);

  if (msg.t === 'hello') {
    conn.nodeId = msg.node;
    forwardToManager('/hello', {
      nodeId: msg.node,
      tunnel: tunnelName,
      model: msg.model,
      fw: msg.fw,
      tools: msg.tools || [],
      capacity: msg.capacity,
      heap: msg.heap,
      rssi: msg.rssi,
      ip: msg.ip,
    });
    return;
  }
  if (msg.t === 'hb') {
    if (!conn.nodeId) return;
    forwardToManager('/hb', {
      nodeId: conn.nodeId,
      heap: msg.heap,
      rssi: msg.rssi,
      up: msg.up,
      conns: msg.conns,
      fw: msg.fw,
    });
    return;
  }
  if (msg.t === 'result') {
    const p = t.pending.get(msg.id);
    if (p) p.resolve({ ok: msg.ok, err: msg.err, meta: msg.meta });
  }
}

function handleFrame(tunnelName, conn, data) {
  // 文本帧 = 控制消息；二进制 = 数据面（与 Relay.ts 的分流规则一致）
  if (typeof data === 'string') {
    onCtrl(tunnelName, conn, data);
    return;
  }
  const buf = data instanceof ArrayBuffer
    ? data
    : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  const frame = decode(buf);
  const t = tunnels.get(tunnelName);
  if (conn.role === 'esp32') {
    if (frame.type === FrameType.DATA && t.toolCh.has(frame.channel)) {
      const id = t.toolCh.get(frame.channel);
      t.pending.get(id)?.chunks.push(frame.payload);
      return;
    }
    if (frame.type === FrameType.CLOSE && t.toolCh.has(frame.channel)) return;
    if (frame.type === FrameType.OPEN_OK || frame.type === FrameType.DATA || frame.type === FrameType.CLOSE) {
      const u = t.users.find((x) => x.channels.includes(frame.channel));
      if (u) {
        u.ws.send(buf);
        if (frame.type === FrameType.CLOSE) removeChannel(u, frame.channel);
      }
    }
  } else {
    const esp = t.esp32;
    if (frame.type === FrameType.OPEN) {
      if (!esp) {
        conn.ws.send(encodeClose(frame.channel));
        return;
      }
      addChannel(conn, frame.channel);
      esp.send(buf);
    } else if (frame.type === FrameType.DATA || frame.type === FrameType.CLOSE) {
      if (esp) esp.send(buf);
      if (frame.type === FrameType.CLOSE) removeChannel(conn, frame.channel);
    }
  }
}

function toBase64(u) {
  return Buffer.from(u).toString('base64');
}

/** /_call：推送 CALL → 收 DATA 块 → 等 RESULT（与 Relay.handleCall 等价） */
async function handleCall(tunnelName, body) {
  const t = getTunnel(tunnelName);
  if (!t.esp32) return { code: 503, payload: { ok: false, err: 'esp32 offline' } };

  // 半开连接：连着但设备早就不在了。直接回 503 说清楚，别让调用方等满超时。
  const silentMs = Date.now() - (t.esp32.lastMsgAt || 0);
  if (silentMs > ESP_STALE_MS) {
    return {
      code: 503,
      payload: { ok: false, err: 'esp32_stale', silentMs, threshold: ESP_STALE_MS },
    };
  }

  let ch = null;
  for (let i = TOOL_CH_BASE; i <= TOOL_CH_MAX; i++) {
    if (!t.toolCh.has(i)) {
      ch = i;
      break;
    }
  }
  if (ch === null) return { code: 503, payload: { ok: false, err: 'no_free_tool_channel' } };

  const id = 'c' + Date.now().toString(36) + Math.floor(Math.random() * 46656).toString(36);
  const timeoutMs = body.timeoutMs || DEFAULT_CALL_TIMEOUT;
  const started = Date.now();

  let settle = () => {};
  const wait = new Promise((res) => {
    settle = res;
  });
  t.pending.set(id, { ch, chunks: [], resolve: settle });
  t.toolCh.set(ch, id);
  t.esp32.send(encodeCtrl({ t: 'call', id, tool: body.tool, args: body.args || {}, ch }));

  const timer = setTimeout(() => {
    const p = t.pending.get(id);
    if (p) {
      t.pending.delete(id);
      t.toolCh.delete(ch);
      p.resolve({ ok: false, err: 'timeout after ' + timeoutMs + 'ms' });
    }
  }, timeoutMs);

  const r = await wait;
  clearTimeout(timer);
  const p = t.pending.get(id);
  const chunks = p?.chunks || [];
  t.pending.delete(id);
  t.toolCh.delete(ch);

  const merged = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  const DATA_LIMIT = 512 * 1024;
  const payload = {
    ok: r.ok,
    err: r.err,
    meta: {
      ...(r.meta || {}),
      bytes: r.meta?.bytes ?? merged.length,
      ms: r.meta?.ms ?? Date.now() - started,
    },
    bytes: merged.length,
  };
  if (merged.length <= DATA_LIMIT) payload.data = toBase64(merged);
  else payload.note = 'body omitted (' + merged.length + ' bytes)';
  return { code: 200, payload };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const parts = [];
    req.on('data', (d) => parts.push(d));
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
}

const PANEL = (tunnel) => `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>远程唤醒</title></head>
<body><h1>远程唤醒电脑</h1>
<button onclick="wake('')">一键唤醒（默认 MAC）</button>
<script>async function wake(m){const r=await fetch('/wol/${tunnel}'+(m?'/'+m:''));alert(await r.text());}</script>
</body></html>`;

export function createRelay(opts = {}) {
  if (opts.managerBase) managerBase = opts.managerBase;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const tunnel = url.pathname.split('/').filter(Boolean)[1] || '';

    if (url.pathname === '/_call' && req.method === 'POST') {
      const tn = url.searchParams.get('tunnel') || tunnel || 'wol';
      let body = {};
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end('{"ok":false,"err":"bad json"}');
        return;
      }
      const r = await handleCall(tn, body);
      res.writeHead(r.code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(r.payload));
      return;
    }

    if (url.pathname.startsWith('/panel/')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PANEL(tunnel));
      return;
    }

    const wol = url.pathname.match(/^\/wol\/[^/]+(?:\/([0-9a-fA-F]{2}([:-][0-9a-fA-F]{2}){5}))?$/);
    if (wol) {
      const mac = wol[1];
      const t = tunnels.get(tunnel);
      if (t?.esp32) {
        t.esp32.send(encodeWol(mac));
        res.writeHead(200);
        res.end(mac ? `wol sent (${mac})` : 'wol sent (default mac)');
      } else {
        res.writeHead(503);
        res.end('esp32 offline');
      }
      return;
    }

    if (url.pathname.startsWith('/status')) {
      const t = tunnels.get(tunnel);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ esp32: !!t?.esp32, users: t?.users.length ?? 0, nodeRelay: true, tunnel }));
      return;
    }

    res.writeHead(426);
    res.end('expected websocket');
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const m = url.pathname.match(/^\/ws\/([^/]+)\/(esp32|user)$/);
    if (!m) {
      socket.destroy();
      return;
    }
    const [, tunnelName, role] = m;
    wss.handleUpgrade(req, socket, head, (ws) => {
      const t = getTunnel(tunnelName);
      const conn = { ws, role, channels: [] };
      if (role === 'esp32') {
        t.esp32 = ws;
        ws.lastMsgAt = Date.now();   // 连接建立即视为「刚有过交集」
      } else t.users.push(conn);
      // isBinary=false 是文本帧（控制消息），必须按字符串交下去：
      // 否则 Buffer 会被当成二进制帧 decode，首字节 0x7B('{') 直接抛未知类型
      ws.on('message', (data, isBinary) =>
        handleFrame(tunnelName, conn, isBinary ? data : data.toString())
      );
      ws.on('close', () => {
        if (role === 'esp32') {
          // 只有「当前这条」才清引用：设备断线重连时，旧连接的 close 事件
          // 可能晚于新连接建立才到，无脑置 null 会把刚连上的那条也抹掉，
          // 于是一路 503 esp32 offline —— 明明设备活得好好的。
          if (t.esp32 === ws) t.esp32 = null;
          for (const u of t.users) u.ws.send(encodeClose(0));
        } else {
          t.users = t.users.filter((x) => x !== conn);
        }
      });
    });
  });

  return { server, wss, tunnels };
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  const PORT = Number(process.env.RELAY_PORT || 8787);
  const { server } = createRelay();
  server.listen(PORT, '127.0.0.1', () => console.log(`[relay-node] listening on :${PORT}`));
}
