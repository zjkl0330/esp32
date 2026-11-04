// security.ts —— 鉴权、配额、目标地址校验。
//
// 三条原则（都是踩过或差点踩过的）：
//   1. fail-closed：密钥没配 = 拒绝服务，不是敞开。安全生产最常见的洞就是
//      "本地开发为了省事默认不鉴权，结果这份配置被一起部署上去了"。
//   2. 恒定时间比较：`a === b` 会在第一个不同的字节就返回，理论上可被计时爆破。
//      虽然网络抖动会淹没这个信号，但改掉只是几行代码，没有不做的理由。
//   3. 出口必须防 SSRF：这个 Worker 的 fetch 请求最终由「你家局域网里的板子」发出，
//      也就是说它的网络位置比 Worker 本身更靠近你的路由器。放任它去 fetch
//      192.168.1.1，等于把内网探测能力开放给了任何持 key 的人。

// ── 恒定时间字符串比较
// 先各自 SHA-256 再逐字节比：这样比较耗时才与「第几位开始不同」无关，
// 也不会因为长度不同而提前返回。
export async function safeEqual(a: string, b: string): Promise<boolean> {
  if (!a || !b) return false;
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  const va = new Uint8Array(ha);
  const vb = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

// ── 会话令牌派生
// Cookie 里不存明文口令：存 HMAC(用户名 + 口令, 固定上下文)。
// 好处是即使 Cookie 被读到，也拿不到能用于 `Authorization: Bearer` 的口令本身。
//
// 用户名也参与派生：这样「知道用户名」不等于「能伪造会话」，
// 而且换用户名会让所有旧会话立刻失效。
export async function deriveSession(adminUser: string, adminToken: string): Promise<string> {
  if (!adminToken) return '';
  const enc = new TextEncoder();
  const material = `${adminUser || ''}\n${adminToken}`;
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(material),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode('esp32-exit-session-v1'));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 生成一把新的客户端密钥。
 * 用 crypto.getRandomValues 而不是 Math.random —— 后者的熵不够，
 * 而这串东西一旦可预测就等于没有密钥。
 */
export function generateClientKey(name: string): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  const safe = String(name || 'key')
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, 16) || 'key';
  return `sk_${safe}_${hex}`;
}

// ── 客户端密钥
// 为什么是「多把」而不是一把：这个出口要给别的项目用。一把 key 分发出去，
// 泄漏了就没法定位是谁漏的，只能全撤。多把才能做到「撤一把、其余照跑」。
export interface ClientKey {
  /** 展示用名字，同时是配额计数的键，所以必须唯一 */
  name: string;
  key: string;
  /** 每日调用上限；不填 = 不限 */
  dayCalls?: number;
  /** 每日回传字节上限；不填 = 不限 */
  dayBytes?: number;
  /** 域名白名单，支持 *.example.com；不填 = 除私网外全放行 */
  hosts?: string[];
}

/**
 * 解析 CLIENT_KEYS。格式（JSON 数组）：
 *   [{"name":"rin","key":"sk_xxx","dayCalls":2000,"dayBytes":52428800}]
 *
 * 解析失败一律返回空数组 —— 空数组在入口处表现为「所有 key 都不匹配」，
 * 也就是拒绝，而不是放行。这是 fail-closed 在这里的具体落法。
 */
export function parseClientKeys(raw: string | undefined): ClientKey[] {
  if (!raw) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out: ClientKey[] = [];
  for (const it of arr) {
    if (!it || typeof it !== 'object') continue;
    const o = it as Record<string, unknown>;
    if (typeof o.key !== 'string' || !o.key) continue;
    out.push({
      name: typeof o.name === 'string' && o.name ? o.name : 'unnamed',
      key: o.key,
      dayCalls: typeof o.dayCalls === 'number' ? o.dayCalls : undefined,
      dayBytes: typeof o.dayBytes === 'number' ? o.dayBytes : undefined,
      hosts: Array.isArray(o.hosts) ? o.hosts.filter((h): h is string => typeof h === 'string') : undefined,
    });
  }
  return out;
}

/** 找出匹配的 key。逐个用恒定时间比较，避免「第一个匹配就返回」把顺序暴露出去。 */
export async function matchClientKey(keys: ClientKey[], presented: string): Promise<ClientKey | null> {
  if (!presented) return null;
  let hit: ClientKey | null = null;
  for (const k of keys) {
    if (await safeEqual(k.key, presented)) hit = k;
  }
  return hit;
}

// ── 目标地址校验（SSRF）
// 只判断「字面量地址」这一层。域名解析到内网的情况在这里拦不住 ——
// 那需要 DNS 解析结果，由 ESP32 拿到 IP 后再判一次（固件里有对应实现）。
// 两层都做，因为两层能拦的东西不一样。

const PRIVATE_V4 = [
  /^0\./, // 0.0.0.0/8
  /^10\./, // 私网
  /^127\./, // 回环
  /^169\.254\./, // 链路本地，云元数据 169.254.169.254 在这里面
  /^172\.(1[6-9]|2\d|3[01])\./, // 私网
  /^192\.168\./, // 私网
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CGNAT，运营商大内网
  /^22[4-9]\.|^23\d\.|^24\d\.|^25[0-5]\./, // 组播 / 保留
];

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata',
  'metadata.google.internal',
  'instance-data',
]);

export type TargetCheck = { ok: true } | { ok: false; reason: string };

export function checkTarget(hostRaw: string): TargetCheck {
  const host = (hostRaw || '').trim().toLowerCase().replace(/\.$/, '');
  if (!host) return { ok: false, reason: 'empty_host' };

  // 带凭据的 URL（http://a:b@host）在某些解析器里会被误当成 host，直接拒
  if (host.includes('@')) return { ok: false, reason: 'credentials_in_url' };

  if (BLOCKED_HOSTNAMES.has(host)) return { ok: false, reason: 'blocked_hostname' };
  if (host === '::' || host === '::1' || host === '[::1]') return { ok: false, reason: 'loopback_v6' };
  // IPv6 私网：fc00::/7（唯一本地）、fe80::/10（链路本地）
  if (/^\[?f[cd][0-9a-f]{2}:/.test(host)) return { ok: false, reason: 'private_v6' };
  if (/^\[?fe[89ab][0-9a-f]:/.test(host)) return { ok: false, reason: 'linklocal_v6' };

  // 纯 IPv4 字面量
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    // 八位组越界的写法（如 1.2.3.999）交给解析器处理，这里只拦明确的内网段
    if (PRIVATE_V4.some((re) => re.test(host))) return { ok: false, reason: 'private_ipv4' };
    return { ok: true };
  }

  // 域名后缀类：.local（mDNS，能直达你家设备）、.internal、.home.arpa
  if (/\.local$/.test(host) || /\.internal$/.test(host) || /\.home\.arpa$/.test(host)) {
    return { ok: false, reason: 'lan_suffix' };
  }

  // 数字/十六进制等价的 IP 写法（http://2130706433/ = 127.0.0.1）：
  // 不含点且能转成数字的 host 一律拒，正常域名不会长这样
  if (/^\d+$/.test(host) || /^0x[0-9a-f]+$/.test(host)) {
    return { ok: false, reason: 'numeric_host' };
  }

  return { ok: true };
}

/** 白名单匹配：`*.douyin.com` 匹配 a.douyin.com，也匹配 douyin.com 本身 */
export function hostAllowed(host: string, allow?: string[]): boolean {
  if (!allow || !allow.length) return true;
  const h = host.toLowerCase();
  return allow.some((pat) => {
    const p = pat.toLowerCase().trim();
    if (!p) return false;
    if (p.startsWith('*.')) {
      const base = p.slice(2);
      return h === base || h.endsWith(`.${base}`);
    }
    return h === p;
  });
}
