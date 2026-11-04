// test/security.mjs —— 安全逻辑的单元测试。
//
// 为什么这几条必须真跑而不是"看着代码觉得对"：
//   · SSRF 拦截漏一个写法（比如 2130706433）就等于没拦，而这种写法恰恰是
//     攻击者最先试的，不是构造刁钻 case，是常识 case。
//   · 配额边界差一（>= 写成 >）会让"上限 2000"变成 2001，测试能钉住。
//   · 恒定时间比较如果提前返回，功能上完全正常，只有专门的用例才看得出来。
//
// 被测代码直接用源码，不经过编译产物 —— 这样不可能出现"测的是旧版本"。
// Node 22.18+ 的 type stripping 让这一步不需要 tsc。
import {
  checkTarget,
  hostAllowed,
  matchClientKey,
  parseClientKeys,
  safeEqual,
  deriveSession,
  generateClientKey,
} from '../worker/src/security.ts';

let pass = 0, fail = 0;
const failures = [];

function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}${extra ? '  → ' + extra : ''}`); }
}

function section(t) { console.log(`\n${t}`); }

// ═══════════════ SSRF：该拦的必须拦住
section('SSRF 拦截（这些地址如果放行，等于把内网探测能力交给持 key 的人）');

const MUST_BLOCK = [
  ['127.0.0.1', '回环'],
  ['127.1.2.3', '回环段'],
  ['10.0.0.1', '私网 10/8'],
  ['172.16.0.1', '私网 172.16/12'],
  ['172.31.255.254', '私网 172.16/12 上界'],
  ['192.168.1.1', '你自己的路由器'],
  ['169.254.169.254', '云元数据服务（最经典的 SSRF 目标）'],
  ['100.64.0.1', '运营商 CGNAT 大内网'],
  ['0.0.0.0', '全零地址'],
  ['localhost', 'localhost'],
  ['router.local', 'mDNS 能直达你家设备'],
  ['metadata.google.internal', 'GCP 元数据'],
  ['::1', 'IPv6 回环'],
  ['fd00::1', 'IPv6 唯一本地'],
  ['fe80::1', 'IPv6 链路本地'],
  ['2130706433', '十进制的 127.0.0.1'],
  ['0x7f000001', '十六进制的 127.0.0.1'],
  ['', '空 host'],
  ['http://a:b@evil.com', '带凭据的写法'],
];

for (const [host, why] of MUST_BLOCK) {
  const r = checkTarget(host);
  ok(`拦 ${host}（${why}）`, r.ok === false, r.ok ? '竟然放行了' : r.reason);
}

section('SSRF 放行（正常站点不能被误伤，否则功能就废了）');
const MUST_ALLOW = [
  'www.baidu.com',
  'v.douyin.com',
  'api.github.com',
  '1.2.3.4',
  '8.8.8.8',
  'a-b.c-d.example.com',
];
for (const host of MUST_ALLOW) {
  const r = checkTarget(host);
  ok(`放行 ${host}`, r.ok === true, r.ok ? '' : r.reason);
}

// ═══════════════ 域名白名单
section('域名白名单');
ok('*.douyin.com 匹配 v.douyin.com', hostAllowed('v.douyin.com', ['*.douyin.com']));
ok('*.douyin.com 匹配 douyin.com 本身', hostAllowed('douyin.com', ['*.douyin.com']));
ok('*.douyin.com 不匹配 notdouyin.com', !hostAllowed('notdouyin.com', ['*.douyin.com']));
ok('*.douyin.com 不匹配 douyin.com.evil.cn', !hostAllowed('douyin.com.evil.cn', ['*.douyin.com']));
ok('精确域名匹配', hostAllowed('api.github.com', ['api.github.com']));
ok('精确域名不匹配子域', !hostAllowed('x.api.github.com', ['api.github.com']));
ok('不配白名单 = 全放行', hostAllowed('anything.example', undefined));

// ═══════════════ 密钥解析
section('CLIENT_KEYS 解析（解析失败必须得到空数组 = 全部拒绝，而不是放行）');
ok('非法 JSON → 空数组', parseClientKeys('{oops').length === 0);
ok('非数组 JSON → 空数组', parseClientKeys('{"a":1}').length === 0);
ok('undefined → 空数组', parseClientKeys(undefined).length === 0);
ok('缺少 key 字段的项被跳过', parseClientKeys('[{"name":"x"}]').length === 0);

const keys = parseClientKeys(
  '[{"name":"rin","key":"sk_a","dayCalls":2000,"dayBytes":52428800,"hosts":["*.douyin.com"]},' +
  '{"key":"sk_b"}]'
);
ok('正常解析出 2 把', keys.length === 2);
ok('第一把带名字与额度', keys[0].name === 'rin' && keys[0].dayCalls === 2000);
ok('第二把缺名字时给 unnamed', keys[1].name === 'unnamed');
ok('第二把没限额 = undefined（不限制）', keys[1].dayCalls === undefined);

section('密钥匹配（多把 key 要能正确区分）');
ok('匹配到正确的 key', (await matchClientKey(keys, 'sk_a'))?.name === 'rin');
ok('错误 key 返回 null', (await matchClientKey(keys, 'sk_wrong')) === null);
ok('空 key 返回 null', (await matchClientKey(keys, '')) === null);
ok('未登记 key 返回 null', (await matchClientKey(keys, 'sk_not_in_list')) === null);

// ═══════════════ 恒定时间比较
section('恒定时间比较');
ok('相同字符串返回 true', (await safeEqual('abc123', 'abc123')) === true);
ok('不同字符串返回 false', (await safeEqual('abc123', 'abc124')) === false);
ok('长度不同返回 false', (await safeEqual('abc', 'abcd')) === false);
ok('空串不通过（不能因为两边都空就算相等）', (await safeEqual('', '')) === false);
ok('一边为空不通过', (await safeEqual('abc', '')) === false);

// 真正的"恒定时间"无法在 JS 里实测（JIT + GC 噪声大于信号），
// 但至少可以确认：前缀相同的两个串不会被判定为相等。
ok('前缀相同但整体不同 → false', (await safeEqual('sk_aaaaaaaaX', 'sk_aaaaaaaaY')) === false);

// ═══════════════ 会话派生
section('会话令牌派生（Cookie 里存派生值，不存口令本身）');
const s1 = await deriveSession('admin', 'my-password');
const s2 = await deriveSession('admin', 'my-password');
const s3 = await deriveSession('admin', 'other-password');
const s4 = await deriveSession('someone-else', 'my-password');
ok('同口令派生结果稳定', s1 === s2);
ok('不同口令派生结果不同', s1 !== s3);
ok('不同用户名派生结果不同（换用户名即让旧会话失效）', s1 !== s4);
ok('派生值不等于口令本身', s1 !== 'my-password');
ok('派生值是 64 位十六进制', /^[0-9a-f]{64}$/.test(s1));
ok('空口令不产生可用令牌', (await deriveSession('admin', '')) === '');

// ═══════════════ 密钥生成
section('接出密钥生成');
{
  const k1 = generateClientKey('news');
  const k2 = generateClientKey('news');
  ok('生成格式为 sk_<名字>_<hex>', /^sk_news_[0-9a-f]{32}$/.test(k1), k1);
  ok('两次生成不相同', k1 !== k2);
  ok('名字里的非法字符被剔除', /^sk_abc_[0-9a-f]{32}$/.test(generateClientKey('a b/../c')));
  ok('空名字回落到 key', /^sk_key_[0-9a-f]{32}$/.test(generateClientKey('')));
}

// ═══════════════ 汇总
console.log(`\n${'─'.repeat(52)}`);
if (fail === 0) {
  console.log(`${pass} passed, 0 failed`);
  process.exit(0);
} else {
  console.log(`${pass} passed, ${fail} failed`);
  for (const f of failures) console.log(`  失败: ${f}`);
  process.exit(1);
}
