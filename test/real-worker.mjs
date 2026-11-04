// 直接测试真实 Worker 的转发（不经过 ESP32 固件，也不经过 Node 模拟中继）。
// 用途：判定「数据回不来」到底是 Worker 的锅还是固件的锅。
import { WebSocket } from 'ws';
import { encodeOpen, encodeData, encodeClose, encodeWol, decode, FrameType } from './protocol.mjs';

const BASE = process.env.WORKER || 'wss://tunnel.example.com';
const TOKEN = process.env.TUNNEL_TOKEN;
const TUNNEL = process.env.TUNNEL_NAME || 'wol';
const H = TOKEN ? { Authorization: `Bearer ${TOKEN}` } : undefined;
const q = TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : '';

if (!TOKEN) { console.error('需要 TUNNEL_TOKEN'); process.exit(1); }

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  let pass = 0, fail = 0;
  const ok = (c, m) => { c ? (pass++, log('  ✓', m)) : (fail++, log('  ✗', m)); };

  // --- 1. 扮演 ESP32 接入 ---
  const esp = new WebSocket(`${BASE}/ws/${TUNNEL}/esp32${q}`, { headers: H });
  await new Promise((res, rej) => { esp.on('open', res); esp.on('error', rej); });
  log('[1] ESP32 侧已接入');

  const espGot = [];
  esp.on('message', (d) => {
    const f = decode(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength));
    espGot.push(f);
    log(`    ESP32 收到: type=0x${f.type.toString(16)} ch=${f.channel}` +
        (f.type === FrameType.DATA ? ` payload=${f.payload.length}B` : ''));
  });
  await sleep(600);

  // --- 2. 扮演用户接入 ---
  const usr = new WebSocket(`${BASE}/ws/${TUNNEL}/user${q}`, { headers: H });
  await new Promise((res, rej) => { usr.on('open', res); usr.on('error', rej); });
  log('[2] 用户侧已接入');
  await sleep(400);

  const usrGot = [];
  usr.on('message', (d) => {
    const f = decode(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength));
    usrGot.push(f);
    log(`    用户收到: type=0x${f.type.toString(16)} ch=${f.channel}` +
        (f.type === FrameType.DATA ? ` payload=${Buffer.from(f.payload).toString()}` : ''));
  });

  // --- 3. 用户发 OPEN ---
  const CH = 7;
  usr.send(encodeOpen(CH, '192.168.1.10', 8080));
  await sleep(800);
  ok(espGot.some((f) => f.type === FrameType.OPEN && f.channel === CH),
     'OPEN 到达 ESP32 侧');
  ok(espGot.some((f) => f.type === FrameType.OPEN && f.ip === '192.168.1.10' && f.port === 8080),
     'OPEN 里 ip/port 解析正确');

  // --- 4. ESP32 回 OPEN_OK，验证能否回到用户 ---
  esp.send(Buffer.from([FrameType.OPEN_OK, CH]));
  await sleep(800);
  ok(usrGot.some((f) => f.type === FrameType.OPEN_OK && f.channel === CH),
     '★ OPEN_OK 回传用户（这一步失败=Worker 路由 bug）');

  // --- 5. ESP32 → 用户 的 DATA 回传 ---
  const msg = Buffer.from('HELLO-FROM-ESP32');
  esp.send(Buffer.concat([Buffer.from([FrameType.DATA, CH]), msg]));
  await sleep(800);
  const back = usrGot.find((f) => f.type === FrameType.DATA && f.channel === CH);
  ok(!!back, '★ DATA 回传用户');
  if (back) ok(Buffer.from(back.payload).toString() === 'HELLO-FROM-ESP32', 'DATA 内容一致');

  // --- 6. 用户 → ESP32 的 DATA 去程 ---
  const msg2 = Buffer.from('GET / HTTP/1.1');
  usr.send(Buffer.concat([Buffer.from([FrameType.DATA, CH]), msg2]));
  await sleep(800);
  const fwd = espGot.find((f) => f.type === FrameType.DATA && f.channel === CH);
  ok(!!fwd, '★ DATA 去程到达 ESP32');

  // --- 7. 多通道隔离 ---
  usr.send(encodeOpen(9, '192.168.1.99', 22));
  await sleep(600);
  ok(espGot.some((f) => f.type === FrameType.OPEN && f.channel === 9), '第二通道 OPEN 可达');

  // --- 8. CLOSE 传播 ---
  esp.send(Buffer.from([FrameType.CLOSE, 9]));
  await sleep(600);
  ok(usrGot.some((f) => f.type === FrameType.CLOSE && f.channel === 9), 'CLOSE 传播到用户');

  esp.close(); usr.close();
  await sleep(300);

  log('');
  log(`结果: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('FATAL', e); process.exit(2); });
