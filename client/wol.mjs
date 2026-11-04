// wol.mjs —— 手动发送魔术包（命令行）。这就是「公网手动唤醒」的最简入口。
// 用法: node client/wol.mjs <worker前缀> [tunnel] [mac]
// 例:   node client/wol.mjs https://tunnel.example.com wol
//       node client/wol.mjs https://tunnel.example.com wol AA:BB:CC:DD:EE:FF
//
// Worker 设了 TUNNEL_TOKEN 的话，需要通过环境变量传进来：
//   TUNNEL_TOKEN=xxxx node client/wol.mjs https://tunnel.example.com wol
// （Windows cmd:  set TUNNEL_TOKEN=xxxx && node client/wol.mjs ...）
const base = process.argv[2];
const tunnel = process.argv[3] || 'wol';
const mac = process.argv[4];
const token = process.env.TUNNEL_TOKEN || '';

if (!base) {
  console.error('用法: node client/wol.mjs <worker前缀> [tunnel] [mac]');
  process.exit(1);
}

let url = `${base.replace(/\/$/, '')}/wol/${tunnel}${mac ? '/' + mac : ''}`;
if (token) url += `?token=${encodeURIComponent(token)}`;
console.log('[wol] GET', url.replace(/token=[^&]+/, 'token=***'));

try {
  const res = await fetch(url, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined);
  const body = await res.text();
  console.log(`[wol] HTTP ${res.status}: ${body}`);
  if (res.status === 401) {
    console.error('[wol] 401 未授权 —— Worker 已开鉴权，请设置 TUNNEL_TOKEN 环境变量');
  }
  process.exit(res.ok ? 0 : 1);
} catch (e) {
  console.error('[wol] 失败:', e.message);
  process.exit(1);
}
