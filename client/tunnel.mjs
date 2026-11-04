// tunnel.mjs —— 把本机端口穿透到局域网目标（RDP 3389 / SSH 22 / 任意 TCP）。
// 用法: node client/tunnel.mjs <本地端口> <局域网IP> <目标端口> <worker ws前缀> [tunnel]
// 例:   node client/tunnel.mjs 3389 192.168.1.50 3389 wss://esp32-wol-tunnel.abc.workers.dev wol
//       然后用「远程桌面」连 127.0.0.1:3389，即直达局域网那台机器。
import net from 'node:net';
import { WebSocket } from 'ws';
import { encodeOpen, encodeData, encodeClose, decode, FrameType } from '../test/protocol.mjs';

const localPort = Number(process.argv[2] ?? 3389);
const targetHost = process.argv[3];
const targetPort = Number(process.argv[4] ?? 3389);
const workerUrl = process.argv[5];
const tunnel = process.argv[6] ?? 'wol';
const token = process.env.TUNNEL_TOKEN || '';

if (!targetHost || !workerUrl) {
  console.error('用法: node client/tunnel.mjs <本地端口> <局域网IP> <目标端口> <worker ws前缀> [tunnel]');
  process.exit(1);
}

let seq = 0;

// ⚠️ ESP32 固件的 MAX_CHANNELS = 8，channel 只能是 0..7。
// 早先写成 1 + (seq++ % 254)，通道号一旦超过 7，固件在 handleFrame 里
// `if (ch >= MAX_CHANNELS) return;` 会**静默丢弃** OPEN 帧 ——
// 现象是「本地连上了、用户 WS 也建了，但永远收不到 OPEN_OK」。
//
// 另一个坑：channel 是**全局**资源（ESP32 上共 8 条）。同时跑多个 tunnel.mjs
// 进程时，各自都从 1 开始分配就会互相踩。用 CHANNEL_BASE / CHANNEL_COUNT
// 给每个进程划不重叠的区间，例如：
//   进程A: CHANNEL_BASE=1 CHANNEL_COUNT=4   （占 1-4）
//   进程B: CHANNEL_BASE=5 CHANNEL_COUNT=3   （占 5-7）
const CHANNEL_BASE = Number(process.env.CHANNEL_BASE || 1);
const CHANNEL_COUNT = Number(process.env.CHANNEL_COUNT || 7);
// 硬上限 7（固件 0..7，0 号保留不用）
const CHANNEL_TOP = Math.min(CHANNEL_BASE + CHANNEL_COUNT - 1, 7);

const server = net.createServer((socket) => {
  const span = Math.max(1, CHANNEL_TOP - CHANNEL_BASE + 1);
  const channel = CHANNEL_BASE + (seq++ % span);
  const url = `${workerUrl.replace(/\/$/, '')}/ws/${tunnel}/user${token ? `?token=${encodeURIComponent(token)}` : ''}`;
  console.log(`[tunnel] ch${channel} 建立 WS -> ${url.replace(/token=[^&]+/, 'token=***')}`);
  const ws = new WebSocket(
    url,
    token ? { headers: { Authorization: `Bearer ${token}` } } : undefined
  );
  let established = false;
  // WS 建链 + OPEN 往返要花几百毫秒到几秒（TLS + 中继 + ESP32 拨号），
  // 而本地客户端往往一连上就立刻发数据（HTTP 请求就是这样）。
  // 早期版本在 established=false 时直接 return 丢掉，导致「拨号成功却收不到任何响应」。
  // 正确做法：先缓冲，OPEN_OK 到达后再按序补发。
  const pending = [];

  ws.on('open', () => ws.send(encodeOpen(channel, targetHost, targetPort)));

  ws.on('message', (data) => {
    const f = decode(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    if (f.type === FrameType.OPEN_OK) {
      established = true;
      console.log(`[tunnel] ch${channel} 已连通 ${targetHost}:${targetPort}`);
      // 补发提前到达的数据
      for (const c of pending) ws.send(encodeData(channel, new Uint8Array(c)));
      pending.length = 0;
    } else if (f.type === FrameType.DATA) {
      socket.write(Buffer.from(f.payload));
    } else if (f.type === FrameType.CLOSE) {
      socket.end();
    }
  });

  socket.on('data', (chunk) => {
    if (!established) {
      pending.push(chunk);
      return;
    }
    ws.send(encodeData(channel, new Uint8Array(chunk)));
  });

  socket.on('close', () => {
    try {
      ws.send(encodeClose(channel));
    } catch {
      /* ignore */
    }
    ws.close();
  });
  ws.on('close', () => socket.end());
  ws.on('unexpected-response', (_req, res) => {
    console.error(`[ws] ch${channel} 握手被拒 HTTP ${res.statusCode}`);
    socket.destroy();
  });
  ws.on('error', (e) => {
    console.error('[ws]', e.message);
    socket.destroy();
  });
  // 诊断：5 秒后若仍未 OPEN，打印 readyState 帮助定位卡在哪一步
  setTimeout(() => {
    if (ws.readyState !== WebSocket.OPEN) {
      const st = ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'][ws.readyState] ?? ws.readyState;
      console.error(`[tunnel] ch${channel} WS 5s 未就绪, readyState=${st}`);
    }
  }, 5000);
  socket.on('error', () => {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  });
});

server.listen(localPort, '127.0.0.1', () => {
  console.log(`本地监听 127.0.0.1:${localPort} -> ${targetHost}:${targetPort} (tunnel=${tunnel})`);
  console.log(`新开一个窗口跑: node client/wol.mjs ${workerUrl} ${tunnel}   # 手动唤醒`);
});
