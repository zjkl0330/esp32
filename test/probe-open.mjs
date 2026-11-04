// 单次 OPEN 探测：连用户 WS，发 OPEN，把收到的每个帧打印出来。
import { WebSocket } from 'ws';
import { encodeOpen, decode } from '../test/protocol.mjs';

const names = { 1: 'OPEN', 2: 'OPEN_OK', 3: 'DATA', 4: 'CLOSE', 5: 'WOL' };
const target = process.argv[2] || '192.168.1.10';
const port = Number(process.argv[3] || 8080);
const ch = Number(process.argv[4] || 9);
const token = process.env.TUNNEL_TOKEN;

const ws = new WebSocket('wss://tunnel.example.com/ws/wol/user', {
  headers: { Authorization: `Bearer ${token}` },
});

ws.on('open', () => {
  console.log(`  已发 OPEN ch${ch} -> ${target}:${port}`);
  ws.send(encodeOpen(ch, target, port));
});

ws.on('message', (d) => {
  const f = decode(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength));
  const tag = names[f.type] || `0x${f.type.toString(16)}`;
  console.log(`  <<< 收到 ${tag} ch=${f.channel}`);
  if (f.type === 3) {
    process.stdout.write('      ' + Buffer.from(f.payload).toString('utf8').slice(0, 120) + '\n');
  }
});

ws.on('error', (e) => console.log('  err:', e.message));
ws.on('unexpected-response', (_r, res) => console.log('  HTTP', res.statusCode));

setTimeout(() => process.exit(0), 12000);
