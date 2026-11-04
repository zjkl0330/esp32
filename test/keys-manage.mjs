/**
 * 接出密钥管理 —— 真实链路验证
 *
 * 跑：ADMIN_TOKEN=xxx node test/keys-manage.mjs
 *
 * 验证的不只是「接口返回 200」，而是：
 *   新建的钥匙 → 真的能调通出口 → 吊销后 → 真的开始 401
 * 因为「能创建」和「能使用」是两件事，只有后者才算这个功能成立。
 */
const BASE = process.env.BASE || 'https://exit.example.com';
const ADMIN = process.env.ADMIN_TOKEN || '';
const USER = process.env.ADMIN_USER || 'admin';

if (!ADMIN) {
  console.error('需要 ADMIN_TOKEN');
  process.exit(2);
}

let cookie = '';
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

async function login(user = USER, pass_ = ADMIN) {
  const r = await fetch(`${BASE}/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ user, token: pass_ }).toString(),
    redirect: 'manual',
  });
  const sc = r.headers.get('set-cookie');
  return { status: r.status, cookie: sc ? sc.split(';')[0] : '' };
}

async function api(path, init = {}) {
  const r = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...(init.headers || {}), cookie, authorization: `Bearer ${ADMIN}` },
  });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON */
  }
  return { status: r.status, json, text };
}

console.log('接出密钥管理（真实链路）');

// ── 1. 登录
{
  const r = await login();
  ok('用户名+口令登录成功', r.status === 303 && !!r.cookie, `status=${r.status}`);
  cookie = r.cookie;
}
{
  const r = await login(USER, 'wrong-password');
  ok('错口令被拒', r.status === 401, `status=${r.status}`);
}
{
  const r = await login('nobody', ADMIN);
  ok('错用户名被拒', r.status === 401, `status=${r.status}`);
}

// ── 2. 列出密钥（含明文）
let list = [];
{
  const r = await api('/admin/api/keys');
  ok('GET /admin/api/keys 返回 200', r.status === 200, `status=${r.status}`);
  list = r.json?.keys || [];
  ok('能列出密钥', Array.isArray(list) && list.length > 0, `共 ${list.length} 把`);
  const withPlain = list.filter((k) => typeof k.key === 'string' && k.key.startsWith('sk_'));
  ok('密钥是明文可复制的', withPlain.length === list.length, `${withPlain.length}/${list.length}`);
  console.log(
    '    现有：' +
      list.map((k) => `${k.name}(${k.key.slice(0, 12)}…, ${k.dayCalls || '不限'}次/天)`).join('  ')
  );
}

// ── 3. 新增一把
const newName = 'probe-' + Math.random().toString(36).slice(2, 7);
let newKey = '';
{
  const r = await api('/admin/api/keys', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: newName, dayCalls: 5, dayBytes: 1024 * 1024 }),
  });
  ok('POST 新增密钥 → 200', r.status === 200, `status=${r.status}`);
  newKey = r.json?.key?.key || '';
  ok('返回了新密钥明文', newKey.startsWith('sk_'), newKey);
  ok('名字对得上', r.json?.key?.name === newName, r.json?.key?.name);
  ok('配额上限设上了', r.json?.key?.dayCalls === 5, `dayCalls=${r.json?.key?.dayCalls}`);
}

// ── 4. 新密钥能不能真的调通出口
{
  const r = await fetch(`${BASE}/api/fetch?url=https%3A%2F%2Fip.3322.net`, {
    headers: { authorization: `Bearer ${newKey}` },
  });
  const body = await r.text();
  ok('新密钥能调通出口', r.status === 200, `status=${r.status} body=${body.slice(0, 40)}`);
}

// ── 5. 配额上限是不是真的生效
{
  const r = await fetch(`${BASE}/api/me`, { headers: { authorization: `Bearer ${newKey}` } });
  const j = await r.json();
  ok('/api/me 认得这把新钥匙', j && j.key === newName, JSON.stringify(j).slice(0, 120));
}

// ── 6. 吊销后必须立刻失效
{
  const r = await api('/admin/api/keys/' + encodeURIComponent(newName), { method: 'DELETE' });
  ok('DELETE 吊销 → 200', r.status === 200, `status=${r.status}`);
}
{
  const r = await fetch(`${BASE}/api/fetch?url=https%3A%2F%2Fip.3322.net`, {
    headers: { authorization: `Bearer ${newKey}` },
  });
  ok('吊销后立刻 401', r.status === 401, `status=${r.status}`);
}
{
  const r = await api('/admin/api/keys');
  const names = (r.json?.keys || []).map((k) => k.name);
  ok('吊销后列表里没有了', !names.includes(newName), names.join(','));
}

// ── 7. 不能把同一把钥匙挂在两个名字下
{
  const a = await api('/admin/api/keys', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'dup-a' }),
  });
  const keyA = a.json?.key?.key || '';
  const b = await api('/admin/api/keys', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'dup-b', key: keyA }),
  });
  ok('同一把钥匙不能挂两个名字', b.status === 400 && b.json?.error === 'duplicate_key', JSON.stringify(b.json));
  await api('/admin/api/keys/dup-a', { method: 'DELETE' });
}

// ── 8. 名字非法要挡下来
{
  const r = await api('/admin/api/keys', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'bad name!' }),
  });
  ok('非法名字被拒', r.status === 400 && r.json?.error === 'bad_name', JSON.stringify(r.json));
}

// ── 9. 未鉴权不能碰密钥表
{
  const r = await fetch(`${BASE}/admin/api/keys`);
  ok('未鉴权读密钥表 → 401', r.status === 401, `status=${r.status}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
