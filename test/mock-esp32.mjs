// mock-esp32.mjs —— Node 模拟的 ESP32 隧道客户端。
// 行为与 ESP32_WOL_Tunnel.ino 一致：OPEN 拨号局域网 TCP、DATA 双向透传、CLOSE 关闭、
// WOL 广播魔术包（这里只记录收到的 MAC，供断言）。
//
// v2 增加控制面：连上后发 hello 自报身份与工具表，收到 call 时执行工具并把结果
// 以「若干 DATA 块 + 一条 result」回传 —— 与固件侧的时序完全对应：
//   hello → (hb 周期) → call → DATA×N → result
import net from 'node:net';
import { WebSocket } from 'ws';
import {
  decode,
  decodeCtrl,
  encodeCtrl,
  encodeData,
  encodeOpenOk,
  encodeClose,
  FrameType,
  bytesToMac,
} from './protocol.mjs';

const DATA_CHUNK = 4096;

export function startMockEsp32({
  wsUrl,
  tunnel = 'wol',
  dialMap = {},
  node = 'c6-01',
  model = 'ESP32-C6',
  fw = '1.2.0',
  tools = ['https_fetch', 'http_get', 'net_info', 'wol'],
  capacity = 2,
  toolHandlers = {},
  heartbeatMs = 0,
}) {
  const ws = new WebSocket(`${wsUrl}/ws/${tunnel}/esp32`);
  ws.binaryType = 'nodebuffer';
  const socks = new Map();
  const wolEvents = [];
  const wolWaiters = [];
  const calls = [];
  let hbTimer = null;
  const startedAt = Date.now();

  const fire = (mac) => {
    const rec = { mac, allZero: /^00:00:00:00:00:00$/.test(mac) };
    wolEvents.push(rec);
    while (wolWaiters.length) wolWaiters.shift()(rec);
  };

  function sendHello() {
    ws.send(
      encodeCtrl({
        t: 'hello',
        node,
        model,
        fw,
        tools,
        capacity,
        heap: 213_000,
        rssi: -55,
        ip: '192.168.1.42',
      })
    );
  }

  async function onCall(msg) {
    calls.push({ tool: msg.tool, args: msg.args });
    const handler = toolHandlers[msg.tool];
    if (!handler) {
      ws.send(encodeCtrl({ t: 'result', id: msg.id, ok: false, err: 'unsupported tool: ' + msg.tool }));
      return;
    }
    const t0 = Date.now();
    try {
      const r = await handler(msg.args || {});
      const body = Buffer.isBuffer(r.body) ? r.body : Buffer.from(String(r.body ?? ''));
      for (let i = 0; i < body.length; i += DATA_CHUNK) {
        ws.send(encodeData(msg.ch, new Uint8Array(body.subarray(i, i + DATA_CHUNK))));
      }
      ws.send(
        encodeCtrl({
          t: 'result',
          id: msg.id,
          ok: r.ok !== false,
          err: r.ok === false ? r.err : undefined,
          meta: { status: r.status, bytes: body.length, ms: Date.now() - t0, host: r.host },
        })
      );
    } catch (e) {
      ws.send(encodeCtrl({ t: 'result', id: msg.id, ok: false, err: e.message }));
    }
  }

  ws.on('message', (data, isBinary) => {
    if (!isBinary) {
      const msg = decodeCtrl(data.toString());
      if (msg && msg.t === 'call') onCall(msg);
      return;
    }
    const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    const f = decode(buf);
    if (f.type === FrameType.OPEN) {
      // dialMap 允许把请求的目标改写到本地回显服务（模拟局域网主机）
      const key = `${f.ip}:${f.port}`;
      const target = dialMap[key] || { host: f.ip, port: f.port };
      const sock = net.connect(target.port, target.host, () => {
        ws.send(encodeOpenOk(f.channel));
      });
      sock.on('data', (d) => ws.send(encodeData(f.channel, new Uint8Array(d))));
      sock.on('error', () => {
        try {
          ws.send(encodeClose(f.channel));
        } catch {
          /* ignore */
        }
      });
      sock.on('close', () => {
        try {
          ws.send(encodeClose(f.channel));
        } catch {
          /* ignore */
        }
      });
      socks.set(f.channel, sock);
    } else if (f.type === FrameType.DATA) {
      socks.get(f.channel)?.write(Buffer.from(f.payload));
    } else if (f.type === FrameType.CLOSE) {
      socks.get(f.channel)?.destroy();
      socks.delete(f.channel);
    } else if (f.type === FrameType.WOL) {
      fire(bytesToMac(f.mac));
    }
  });

  ws.on('open', () => {
    sendHello();
    if (heartbeatMs > 0) {
      hbTimer = setInterval(() => {
        ws.send(
          encodeCtrl({
            t: 'hb',
            heap: 213_000 - Math.round(Math.random() * 8000),
            rssi: -55 - Math.round(Math.random() * 6),
            up: Math.round((Date.now() - startedAt) / 1000),
            conns: socks.size,
            fw,
          })
        );
      }, heartbeatMs);
    }
  });

  return {
    ws,
    wolEvents,
    calls,
    ready: () => new Promise((r) => ws.on('open', r)),
    waitForWol: (timeoutMs = 8000) => {
      const hit = wolEvents.find(() => true);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('WOL 等待超时')), timeoutMs);
        wolWaiters.push((rec) => {
          clearTimeout(timer);
          resolve(rec);
        });
      });
    },
    waitForWolCount: async (n, timeoutMs = 8000) => {
      const start = Date.now();
      while (wolEvents.length < n) {
        if (Date.now() - start > timeoutMs) throw new Error(`WOL 数量不足: ${wolEvents.length}/${n}`);
        await new Promise((r) => setTimeout(r, 50));
      }
      return wolEvents;
    },
    close: () => {
      if (hbTimer) clearInterval(hbTimer);
      for (const s of socks.values()) s.destroy();
      ws.close();
    },
    /** 单独停心跳（保持 WS 连接）——用于验证"心跳断了但要等 TTL 才判离线" */
    stopHeartbeat: () => {
      if (hbTimer) {
        clearInterval(hbTimer);
        hbTimer = null;
      }
    },
  };
}
