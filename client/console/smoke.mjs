// smoke.mjs —— 本地冒烟测试：不依赖真实 ESP32 / Worker。
// 用 Node 等价中继 + 模拟 ESP32 + 回显服务，验证控制台的隧道引擎与 API 是否真能转发。
// 运行：node console/smoke.mjs
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { WebSocket } from 'ws';
import { createRelay } from '../test/relay-node.mjs';
import { startMockEsp32 } from '../test/mock-esp32.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  \u2713', m)) : (fail++, console.log('  \u2717', m)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((r) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); });
  });
}

async function waitFor(cond, ms, what) {
  const t = Date.now();
  while (Date.now() - t < ms) { if (await cond()) return true; await sleep(100); }
  throw new Error('超时: ' + what);
}

function tcpEcho(port, msg) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1', () => s.write(msg));
    let buf = '';
    const timer = setTimeout(() => { s.destroy(); reject(new Error('echo 超时')); }, 8000);
    s.on('data', (d) => { buf += d.toString(); if (buf === msg) { clearTimeout(timer); s.end(); resolve(buf); } });
    s.on('error', reject);
  });
}

// 模拟「手机外网」：打开 user WS -> OPEN(consoleLanIp:port) -> HTTP-over-frame 拉取 API。
// 与 console/public/index.html 里 frameRequest 的行为一致，用来验证远程路径真的通。
const FT = { OPEN: 1, OPEN_OK: 2, DATA: 3, CLOSE: 4 };
function encOpen(ch, ip, port) {
  const b = new Uint8Array(8); b[0] = FT.OPEN; b[1] = ch;
  b.set(ip.split('.').map(Number), 2);
  b[6] = (port >> 8) & 255; b[7] = port & 255; return b;
}
function encData(ch, bytes) {
  const b = new Uint8Array(2 + bytes.length); b[0] = FT.DATA; b[1] = ch; b.set(bytes, 2); return b;
}
function remoteApi(wsUrl, tunnel, consoleHost, method, httpPath, body) {
  return new Promise((resolve, reject) => {
    const [host, port] = [consoleHost.split(':')[0], Number(consoleHost.split(':')[1])];
    const ch = 1 + Math.floor(Math.random() * 254);
    const ws = new WebSocket(`${wsUrl}/ws/${tunnel}/user`);
    ws.binaryType = 'arraybuffer';
    let established = false;
    const chunks = [];
    const timer = setTimeout(() => { ws.close(); reject(new Error('远程请求超时')); }, 15000);
    const finish = () => {
      clearTimeout(timer);
      const total = chunks.reduce((n, c) => n + c.length, 0);
      const all = new Uint8Array(total); let o = 0;
      for (const c of chunks) { all.set(c, o); o += c.length; }
      const text = Buffer.from(all).toString('utf8');
      const i = text.indexOf('\r\n\r\n');
      const head = i >= 0 ? text.slice(0, i) : text;
      const bodyText = i >= 0 ? text.slice(i + 4) : '';
      const status = Number((head.match(/^HTTP\/\d\.\d (\d{3})/) || [])[1] || 0);
      let data; try { data = JSON.parse(bodyText); } catch { data = bodyText; }
      resolve({ status, ok: status >= 200 && status < 300, data });
    };
    ws.on('open', () => ws.send(encOpen(ch, host, port)));
    ws.on('message', (d) => {
      const b = new Uint8Array(d); if (!b.length) return;
      if (b[0] === FT.OPEN_OK) {
        established = true;
        let payload = '';
        const lines = [`${method} ${httpPath} HTTP/1.1`, 'Host: console'];
        if (body !== undefined) { payload = JSON.stringify(body); lines.push('Content-Type: application/json'); lines.push('Content-Length: ' + Buffer.byteLength(payload)); }
        lines.push('Connection: close');
        ws.send(encData(ch, Buffer.from(lines.join('\r\n') + '\r\n\r\n' + payload)));
      } else if (b[0] === FT.DATA) { chunks.push(b.slice(2)); }
      else if (b[0] === FT.CLOSE) { ws.close(); finish(); }
    });
    ws.on('close', () => { if (established) finish(); else { clearTimeout(timer); reject(new Error('隧道未建立')); } });
    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

async function main() {
  const { server: relay } = createRelay();
  await new Promise((r) => relay.listen(0, '127.0.0.1', r));
  const relayPort = relay.address().port;
  console.log(`[smoke] Node 中继 :${relayPort}`);

  const echo = net.createServer((s) => s.on('data', (d) => s.write(d)));
  await new Promise((r) => echo.listen(0, '127.0.0.1', r));
  const echoPort = echo.address().port;

  const CPORT = await freePort();
  const FAKE_LAN = '10.9.9.9';
  const esp = startMockEsp32({
    wsUrl: `ws://127.0.0.1:${relayPort}`,
    tunnel: 'wol',
    dialMap: {
      [`${FAKE_LAN}:${echoPort}`]: { host: '127.0.0.1', port: echoPort },
      // 让远程路径能拨到「控制台 PC」（这里即本机控制台）
      [`${FAKE_LAN}:${CPORT}`]: { host: '127.0.0.1', port: CPORT },
    },
  });
  await esp.ready();

  const stateFile = path.join(os.tmpdir(), `wol-console-smoke-${Date.now()}.json`);
  const child = spawn(process.execPath, [path.join(__dirname, 'server.mjs')], {
    env: {
      ...process.env,
      PORT: String(CPORT),
      WORKER_BASE: `http://127.0.0.1:${relayPort}`,
      TUNNEL_NAME: 'wol',
      CONSOLE_STATE: stateFile,
      TUNNEL_TOKEN: '',      // 确保不带上真实 token
      CONSOLE_TOKEN: '',
    },
    stdio: 'ignore',
  });
  const B = `http://127.0.0.1:${CPORT}`;

  try {
    await waitFor(async () => { try { return (await fetch(`${B}/api/config`)).ok; } catch { return false; } }, 8000, 'console ready');
    ok('控制台已启动 /api/config 可用', true);

    const cfg = await (await fetch(`${B}/api/config`)).json();
    ok(cfg.tunnel === 'wol' && !('TUNNEL_TOKEN' in cfg), 'config 不含任何 token 字段');

    await waitFor(async () => (await (await fetch(`${B}/api/status`)).json()).data?.esp32 === true, 8000, 'esp32 online');
    ok('GET /api/status 显示 ESP32 在线（代理 Worker 成功）', true);

    const localPort = await freePort();
    const add = await (await fetch(`${B}/api/tunnels`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '回显测试', localPort, targetHost: FAKE_LAN, targetPort: echoPort, start: true }),
    })).json();
    ok(add.ok && add.tunnel?.running, 'POST /api/tunnels 新增映射并启动');

    const echoed = await tcpEcho(localPort, 'hello-console');
    ok(echoed === 'hello-console', '本地端口 → 隧道 → 局域网目标 双向转发正确');

    const list = await (await fetch(`${B}/api/tunnels`)).json();
    const t = list.tunnels[0];
    ok(t.totalConns >= 1 && t.bytesUp > 0 && t.bytesDown > 0,
      `字节统计正确 (↑${t.bytesUp} ↓${t.bytesDown} conns=${t.totalConns})`);

    // WOL（mock 会记录）
    const wol = await (await fetch(`${B}/api/wol`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    })).json();
    ok(wol.ok, 'POST /api/wol 默认 MAC 发送成功');

    const wol2 = await (await fetch(`${B}/api/wol`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mac: 'AA:BB:CC:DD:EE:FF' }),
    })).json();
    const rec = await esp.waitForWolCount(2);
    ok(wol2.ok && rec[1].mac === 'AA:BB:CC:DD:EE:FF', 'POST /api/wol 指定 MAC 送达且一致');

    // 停止
    const id = t.id;
    await fetch(`${B}/api/tunnels/${id}/stop`, { method: 'POST' });
    await sleep(200);
    const after = (await (await fetch(`${B}/api/tunnels`)).json()).tunnels[0];
    ok(after.running === false, 'POST /api/tunnels/:id/stop 已停止');

    let refused = false;
    try { await tcpEcho(localPort, 'x'); } catch { refused = true; }
    ok(refused, '停止后本地端口不再接受连接');

    await fetch(`${B}/api/tunnels/${id}`, { method: 'DELETE' });
    const empty = (await (await fetch(`${B}/api/tunnels`)).json()).tunnels;
    ok(empty.length === 0, 'DELETE /api/tunnels/:id 已删除');

    // ---- 远程「自举」路径：手机浏览器帧隧道 ----
    const WSURL = `ws://127.0.0.1:${relayPort}`;
    const consoleHost = `${FAKE_LAN}:${CPORT}`;
    const rc = await remoteApi(WSURL, 'wol', consoleHost, 'GET', '/api/config');
    ok(rc.ok && rc.data?.tunnel === 'wol', '远程帧隧道 GET /api/config 成功（手机自举路径可用）');

    const rs = await remoteApi(WSURL, 'wol', consoleHost, 'GET', '/api/status');
    ok(rs.ok && typeof rs.data?.data?.esp32 === 'boolean', '远程帧隧道 GET /api/status 成功');

    const rt = await remoteApi(WSURL, 'wol', consoleHost, 'GET', '/api/tunnels');
    ok(rt.ok && Array.isArray(rt.data?.tunnels), '远程帧隧道 GET /api/tunnels 成功');
  } catch (e) {
    fail++;
    console.log('  \u2717 用例异常 ->', e.message);
  } finally {
    child.kill();
    esp.close();
    echo.close();
    relay.close();
    try { fs.unlinkSync(stateFile); } catch {}
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
