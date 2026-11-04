/**
 * SDK 冒烟测试 —— 全部走真实线上链路，不打桩。
 *
 * 跑：node test/sdk-smoke.mjs
 * 需要环境变量 EXIT_KEY（不给就用下面那把 main key）
 */
import { createExit, ExitError } from '../sdk/exit-fetch.mjs';

const KEY = process.env.EXIT_KEY || 'sk_main_69d7c3cee69c5b2f0b448061d7c87c5b';
const exit = createExit({ key: KEY });

let pass = 0;
let fail = 0;
function ok(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}${detail ? '  ' + detail : ''}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${detail ? '  ' + detail : ''}`);
  }
}

console.log('SDK 冒烟（真实链路）');

// 1) 出口 IP 必须是家庭宽带，不是 Cloudflare
{
  const res = await exit.get('https://ip.3322.net');
  const ip = (await res.text()).trim();
  const local = (await (await fetch('https://ip.3322.net')).text()).trim();
  ok('GET 走通', res.status === 200, `status=${res.status}`);
  ok('出口 IP = 家庭 IP', ip === local, `${ip} vs 本机 ${local}`);
  ok('不是 Cloudflare 网段', !/^(104\.2[0-9]|172\.6[4-9]|162\.15[89])\./.test(ip), ip);
}

// 2) POST + JSON body
{
  const res = await exit.post(
    'https://httpbin.org/post',
    JSON.stringify({ n: 42, s: '中文' }),
    { headers: { 'content-type': 'application/json' } }
  );
  const j = await res.json();
  ok('POST 状态 200', res.status === 200, `status=${res.status}`);
  ok('body 完整到达', j.json?.n === 42 && j.json?.s === '中文', JSON.stringify(j.json));
  ok('目标看到家庭 IP', j.origin === '203.0.113.7', `origin=${j.origin}`);
}

// 3) 自定义 header + 自定义 UA
{
  const ua = 'Mozilla/5.0 (compatible; ExitProbe/1.0)';
  const res = await exit.get('https://httpbin.org/headers', {
    headers: { 'x-smoke': 'yes', referer: 'https://example.com/', 'user-agent': ua },
  });
  const j = await res.json();
  const h = j.headers || {};
  ok('自定义 header 送达', h['X-Smoke'] === 'yes', `x-smoke=${h['X-Smoke']}`);
  ok('referer 送达', h['Referer'] === 'https://example.com/', `referer=${h['Referer']}`);
  // 固件 2.1.0 起不再写死 UA —— 写死的话大多数站点直接拒，这个出口就谈不上通用
  ok(
    '自定义 UA 生效（不再是写死的 ESP32）',
    h['User-Agent'] === ua,
    `UA=${h['User-Agent']}`
  );
}

// 3b) 目标的 content-type 要能带回来
{
  const res = await exit.get('https://httpbin.org/json');
  ok(
    'content-type 回传',
    String(res.headers.get('content-type') || '').includes('json'),
    `content-type=${res.headers.get('content-type')}`
  );
}

// 3c) 截断必须显式标记，否则半截内容会被当成完整的
{
  const res = await exit.get('https://httpbin.org/bytes/50000', { maxBytes: 20000 });
  ok(
    '撞上限时标记截断',
    res.headers.get('x-exit-truncated') === '1',
    `truncated=${res.headers.get('x-exit-truncated')} bytes=${res.headers.get('x-exit-bytes')}`
  );
}

// 4) 目标 404 必须原样透传，不能被吞成 200
{
  const res = await exit.get('https://httpbin.org/status/404');
  ok('404 透传', res.status === 404, `status=${res.status}`);
}

// 5) 错误 key 要抛 ExitError，不能静默
{
  const bad = createExit({ key: 'sk_definitely_wrong' });
  let caught = null;
  try {
    await bad.get('https://ip.3322.net');
  } catch (e) {
    caught = e;
  }
  ok('错 key 抛 ExitError', caught instanceof ExitError, caught?.message || '没抛');
  ok('错 key 状态 401', caught?.status === 401, `status=${caught?.status}`);
}

// 6) SSRF 要拦住
{
  let caught = null;
  try {
    await exit.get('http://192.168.1.1/');
  } catch (e) {
    caught = e;
  }
  ok('内网地址被拦', caught instanceof ExitError, caught?.message || '没抛');
  ok('拦的是 target_blocked', caught?.body?.error === 'target_blocked', JSON.stringify(caught?.body));
}

// 7) 额度查询
{
  const me = await exit.me();
  ok('/api/me 可读', typeof me === 'object' && me !== null, JSON.stringify(me).slice(0, 120));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
