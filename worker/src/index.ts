import { Relay } from './Relay';
import { Manager, MANAGER_SINGLETON } from './Manager';
import { adminPage, loginPage, setupPage } from './panel';
import {
  checkTarget,
  deriveSession,
  hostAllowed,
  matchClientKey,
  parseClientKeys,
  safeEqual,
  type ClientKey,
} from './security';

export { Relay, Manager };

interface Env {
  Relay: DurableObjectNamespace;
  Manager: DurableObjectNamespace;
  /** 设备与该 Worker 之间的共享密钥；同时充当 /_call 内部路由的密钥 */
  TUNNEL_TOKEN?: string;
  /** 面板口令 */
  ADMIN_TOKEN?: string;
  /** 面板登录用户名。不配就用 admin —— 用户名不是秘密，密码才是 */
  ADMIN_USER?: string;
  /** 对外发给其他项目的客户端密钥（JSON 数组），只在第一次当种子用，之后以面板里的为准 */
  CLIENT_KEYS?: string;
  /** 固件二进制与 manifest（OTA 用）。没有它设备就只是「查询失败」，不影响出口功能 */
  FW_KV?: KVNamespace;
}

/** 面板登录的默认用户名。口令必须走 secret，用户名可以有个默认值。 */
const DEFAULT_ADMIN_USER = 'admin';

const USAGE = [
  'ESP32 住宅出口 — Cloudflare Workers',
  '',
  '  面板',
  '    /admin                        控制面板（口令登录）',
  '    /admin/api/*                  面板数据接口',
  '',
  '  给其他项目调（各自独立的 key，各自独立配额）',
  '    GET  /api/fetch?url=<目标>    抓一个网页，直接返回原始内容',
  '    POST /api/fetch               {url, method, headers, body, maxBytes, json}',
  '                                  支持 GET/POST/PUT/DELETE/PATCH/HEAD，body 上限 16KB',
  '                                  user-agent 可透传（需固件 2.1.0+，旧固件会忽略）',
  '    GET  /api/me                  查这把 key 今天还剩多少额度',
  '',
  '  设备通道（固件用，需 TUNNEL_TOKEN）',
  '    /ws/<tunnel>/esp32            ESP32 常驻连接',
  '    /ws/<tunnel>/user             按需的数据通道',
  '    /wol/<tunnel>[/<mac>]         发魔术包唤醒',
  '    /status/<tunnel>              隧道状态 JSON',
  '    /panel/<tunnel>               手机一键唤醒页',
  '',
  '  /health                        健康检查（不鉴权，不返回任何内部信息）',
].join('\n');

const HTML = { 'content-type': 'text/html; charset=utf-8' };
const JSONH = { 'content-type': 'application/json; charset=utf-8' };
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'authorization,content-type',
  'access-control-max-age': '86400',
};

function cookieToken(request: Request): string | null {
  const raw = request.headers.get('Cookie') ?? '';
  for (const part of raw.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === 'adm') return decodeURIComponent(rest.join('='));
  }
  return null;
}

function bearer(request: Request): string {
  const h = request.headers.get('Authorization') ?? '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}

// ── 面板密码 ───────────────────────────────────────────────────────────
// 面板里改过的密码以「盐 + SHA-256」存在 KV（_admin/auth），优先于 ADMIN_TOKEN；
// 没改过才回落到环境变量里的口令。这样改密码不用动 Secret，也不会把明文写进代码。
interface StoredAuth {
  salt: string;
  hash: string;
  at?: number;
}

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function storedAuth(env: Env): Promise<StoredAuth | null> {
  if (!env.FW_KV) return null;
  try {
    const raw = await env.FW_KV.get('_admin/auth');
    if (!raw) return null;
    const d = JSON.parse(raw) as StoredAuth;
    return d && d.hash && d.salt ? d : null;
  } catch {
    return null;
  }
}

async function passwordOk(pass: string, env: Env): Promise<boolean> {
  if (!pass) return false;
  const stored = await storedAuth(env);
  if (stored) return safeEqual(await sha256Hex(`${stored.salt}:${pass}`), stored.hash);
  return safeEqual(pass, env.ADMIN_TOKEN || '');
}

async function sessionSecret(env: Env): Promise<string> {
  const stored = await storedAuth(env);
  return stored ? stored.hash : env.ADMIN_TOKEN || '';
}

/**
 * 面板鉴权。注意这里与旧版的区别：
 *   旧版 `if (!want) return true` —— 没配口令就等于不设防；
 *   现在没配口令就直接拒绝，并提示去配。本地开发也必须配（.dev.vars 或 --var）。
 *
 * 也不再接受 `?token=`：口令进了 URL 就会留在 CF 边缘日志、浏览器历史、
 * 密码管理器里，是 OWASP 点名的反模式。口令只走两处 ——
 * 登录时 POST body 一次性换成 Cookie，或者脚本用 Authorization 头。
 *
 * 用户名也参与校验：Bearer 可以只带口令（脚本用），也可以带 "user:pass"。
 */
async function adminOk(request: Request, env: Env): Promise<boolean> {
  const user = env.ADMIN_USER || DEFAULT_ADMIN_USER;

  const bt = bearer(request);
  if (bt) {
    const colon = bt.indexOf(':');
    if (colon > 0) {
      // "user:pass" 形式
      if (
        (await safeEqual(bt.slice(0, colon), user)) &&
        (await passwordOk(bt.slice(colon + 1), env))
      ) {
        return true;
      }
    } else if (await passwordOk(bt, env)) {
      return true; // 只带口令，脚本用法
    }
  }

  const c = cookieToken(request);
  if (c) {
    const sess = await deriveSession(user, await sessionSecret(env));
    if (await safeEqual(c, sess)) return true;
  }
  return false;
}

/** 会话 Cookie。本地 http 调试时不加 Secure，否则浏览器根本不存。 */
function sessionCookie(sess: string, url: URL): string {
  const secure = url.protocol === 'https:' ? '; Secure' : '';
  return `adm=${sess}; Path=/; HttpOnly${secure}; SameSite=Strict; Max-Age=604800`;
}

function needToken(what: string): Response {
  return new Response(
    JSON.stringify({
      error: 'service_not_configured',
      detail: `${what} 未配置，服务按 fail-closed 策略拒绝请求`,
      fix: ['npx wrangler secret put TUNNEL_TOKEN', 'npx wrangler secret put ADMIN_TOKEN'],
    }),
    { status: 503, headers: { ...JSONH, ...CORS } }
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    // ── 健康检查：故意只回 ok，不透露节点数/版本，避免成为侦察入口
    if (url.pathname === '/health') {
      return new Response('{"ok":true}', { headers: JSONH });
    }

    // ═══════════════ 登录 ═══════════════
    // 口令只出现一次：POST body 里。换成一个 HMAC 派生的会话 Cookie，
    // 之后再也不用把口令带在身上 —— Cookie 里存的也不是口令本身。
    if (url.pathname === '/admin/login' && request.method === 'POST') {
      if (!env.ADMIN_TOKEN) {
        return new Response(setupPage('ADMIN_TOKEN'), { status: 503, headers: HTML });
      }
      const user = env.ADMIN_USER || DEFAULT_ADMIN_USER;
      let pass = '';
      let uname = '';
      try {
        const fd = await request.formData();
        pass = String(fd.get('token') ?? fd.get('password') ?? '');
        uname = String(fd.get('user') ?? '');
      } catch {
        // 不是表单（可能是脚本直接发 JSON/纯文本），退回 Authorization 头
      }
      if (!pass) pass = bearer(request);
      if (!uname) uname = user; // 脚本只带口令时按默认用户名算
      const userOk = await safeEqual(uname, user);
      const passOk = await passwordOk(pass, env);
      if (!userOk || !passOk) {
        return new Response(
          loginPage(userOk ? '口令不对，再试一次' : '用户名不对，再试一次', user),
          { status: 401, headers: HTML }
        );
      }
      const sess = await deriveSession(user, await sessionSecret(env));
      return new Response(null, {
        status: 303,
        headers: { location: '/admin', 'set-cookie': sessionCookie(sess, url) },
      });
    }

    // ═══════════════ 控制面板 ═══════════════
    if (url.pathname === '/' || url.pathname === '/admin' || url.pathname === '/admin/') {
      // 没配口令时给一段「怎么配」的说明页，而不是直接放行
      if (!env.ADMIN_TOKEN) {
        return new Response(setupPage('ADMIN_TOKEN'), { status: 503, headers: HTML });
      }
      if (!(await adminOk(request, env))) {
        // 老书签里带着 ?token= 的，明说一句比默默 401 好
        const hint = url.searchParams.has('token')
          ? '口令不能再放在网址里了（会留在访问日志和浏览器历史），请在下面输入框重新登录'
          : void 0;
        return new Response(loginPage(hint, env.ADMIN_USER || DEFAULT_ADMIN_USER), {
          status: 401,
          headers: HTML,
        });
      }
      return new Response(adminPage(), { headers: HTML });
    }

    if (url.pathname.startsWith('/admin/api/')) {
      if (!env.ADMIN_TOKEN) return needToken('ADMIN_TOKEN');
      if (!(await adminOk(request, env))) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: JSONH });
      }
      const sub = url.pathname.slice('/admin/api'.length);
      if (sub === '/password' && request.method === 'POST') {
        const body = (await request.json().catch(() => ({}))) as { old?: string; new?: string };
        const oldPass = String(body.old ?? '');
        const newPass = String(body.new ?? '');
        if (!(await passwordOk(oldPass, env))) {
          return new Response(JSON.stringify({ ok: false, error: 'bad_old' }), { status: 403, headers: JSONH });
        }
        if (newPass.length < 8) {
          return new Response(JSON.stringify({ ok: false, error: 'weak' }), { status: 400, headers: JSONH });
        }
        if (!env.FW_KV) {
          return new Response(JSON.stringify({ ok: false, error: 'no_kv' }), { status: 500, headers: JSONH });
        }
        const salt = crypto.randomUUID().replace(/-/g, '');
        await env.FW_KV.put(
          '_admin/auth',
          JSON.stringify({ salt, hash: await sha256Hex(`${salt}:${newPass}`), at: Date.now() })
        );
        return new Response(JSON.stringify({ ok: true }), { headers: JSONH });
      }
      // 面板的密钥管理接口，内部对应 Manager 的 /clientkeys
      const target = sub === '/keys' || sub.startsWith('/keys/') ? '/clientkeys' + sub.slice(5) : sub;
      const stub = env.Manager.get(env.Manager.idFromName(MANAGER_SINGLETON));
      return stub.fetch(new Request(`https://manager.invalid${target}${url.search}`, request));
    }

    // ═══════════════ 固件分发（设备 OTA 用） ═══════════════
    //
    // 必须鉴权，不是可选项：固件二进制里硬编码着 TUNNEL_TOKEN 和 WiFi 口令，
    // 公开分发等于把「进你家内网」的钥匙挂到网上等人来拿。
    // 设备本来就带着 Bearer，顺手就验证了，不增加任何成本。
    if (url.pathname === '/fw/manifest.json' || url.pathname.startsWith('/fw/')) {
      if (!env.TUNNEL_TOKEN) return needToken('TUNNEL_TOKEN');
      const presented =
        bearer(request) || (request.headers.get('sec-websocket-protocol') ?? '').split(',')[0].trim();
      if (!(await safeEqual(presented, env.TUNNEL_TOKEN))) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: JSONH });
      }
      const name =
        url.pathname === '/fw/manifest.json' ? 'manifest.json' : url.pathname.slice('/fw/'.length);
      // 只允许平铺的文件名，挡掉 ../ 之类的路径穿越
      if (!/^[A-Za-z0-9._-]+$/.test(name) || name.includes('..')) {
        return new Response(JSON.stringify({ error: 'bad_name' }), { status: 400, headers: JSONH });
      }
      if (!env.FW_KV) {
        return new Response(
          JSON.stringify({
            error: 'no_fw_storage',
            fix: 'npx wrangler kv namespace create exit-fw，然后把 id 填进 wrangler.exit.toml',
          }),
          { status: 503, headers: JSONH }
        );
      }
      const obj = await env.FW_KV.get(name, 'arrayBuffer');
      if (!obj) {
        return new Response(JSON.stringify({ error: 'not_found', name }), {
          status: 404,
          headers: JSONH,
        });
      }
      return new Response(obj, {
        headers: {
          'content-type': name.endsWith('.bin')
            ? 'application/octet-stream'
            : 'application/json; charset=utf-8',
          // 固件是「发布替换」语义，不需要缓存；缓存反而会让设备拿到旧版本
          'cache-control': 'no-store',
          'content-length': String(obj.byteLength),
        },
      });
    }

    // ═══════════════ 对外抓取 API（给其他项目用） ═══════════════
    if (url.pathname === '/api/fetch' || url.pathname === '/api/me') {
      return handleClientApi(request, url, env);
    }

    // ═══════════════ 设备通道 ═══════════════
    const m = url.pathname.match(/^\/(?:ws|wol|status|panel)\/([^/]+)/);
    if (!m) {
      return new Response(USAGE, {
        status: 404,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }

    if (!env.TUNNEL_TOKEN) return needToken('TUNNEL_TOKEN');

    // 设备通道鉴权：只认 Bearer 头 + WebSocket 子协议，不再接受 ?token=。
    // 理由同面板：URL 里的密钥会落进 CF 边缘日志、中间代理访问记录、以及
    // 任何一层愿意记它的地方。固件本来就用 Authorization 头，不受影响。
    const presented =
      bearer(request) || (request.headers.get('sec-websocket-protocol') ?? '').split(',')[0].trim();
    if (!(await safeEqual(presented, env.TUNNEL_TOKEN))) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: JSONH });
    }

    const stub = env.Relay.get(env.Relay.idFromName(m[1]));
    return stub.fetch(request);
  },
};

/**
 * 对外抓取 API。
 *
 * 为什么这里要经过 Manager 而不是直连 Relay：Manager 才持有节点表和配额计数。
 * 直连 Relay 就绕过了「选最闲节点」和「今天这个 key 用完没有」。
 */
/**
 * 取当前生效的接出密钥表。
 *
 * 表存在 Manager DO 里而不是 env.CLIENT_KEYS —— secret 是只写不可读的，
 * 面板要能「显示密钥 / 新增 / 吊销」就必须有个可读可写的地方。
 * 每次调用多一次 DO 往返，换来的是面板改完立即生效。
 */
async function fetchClientKeys(env: Env): Promise<ClientKey[]> {
  try {
    const mgr = env.Manager.get(env.Manager.idFromName(MANAGER_SINGLETON));
    const r = await mgr.fetch(new Request('https://manager.invalid/clientkeys'));
    const j = (await r.json()) as { keys?: ClientKey[] };
    return Array.isArray(j.keys) ? j.keys : [];
  } catch {
    return [];
  }
}

async function handleClientApi(request: Request, url: URL, env: Env): Promise<Response> {
  const keys = await fetchClientKeys(env);
  if (!keys.length) {
    return new Response(
      JSON.stringify({
        error: 'no_client_keys',
        detail: '当前没有可用的接出密钥。这个接口是给其他项目用的，必须显式发 key。',
        fix: '在面板上「接出密钥」里新增一把，或 npx wrangler secret put CLIENT_KEYS',
      }),
      { status: 503, headers: { ...JSONH, ...CORS } }
    );
  }

  const presented = bearer(request) || url.searchParams.get('key') || '';
  const key: ClientKey | null = await matchClientKey(keys, presented);
  if (!key) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { ...JSONH, ...CORS },
    });
  }

  const mgr = env.Manager.get(env.Manager.idFromName(MANAGER_SINGLETON));

  // 查额度
  if (url.pathname === '/api/me') {
    const r = await mgr.fetch(
      new Request(`https://manager.invalid/quota?name=${encodeURIComponent(key.name)}`)
    );
    return new Response(await r.text(), { status: r.status, headers: { ...JSONH, ...CORS } });
  }

  interface Payload {
    url?: string;
    method?: string;
    headers?: Record<string, string>;
    /** 请求体，仅 POST/PUT/PATCH 有意义。上限 16KB（要塞进设备内存拼请求） */
    body?: string;
    /**
     * 二进制请求体（base64）。
     *
     * 为什么必须有这条路：args.body 是 JSON 字符串，而字符串在固件的 C 层
     * 遇到 0x00 就截断 —— 实测发 8 字节 `AA\0BB\0CC`，目标只收到 `AA`，
     * Content-Length 也被写成 2。protobuf / gRPC 类接口（抖音私信、
     * 大部分字节系内部 API）整个都是这种字节流，走 body 一定是坏的。
     */
    bodyB64?: string;
    maxBytes?: number;
    timeoutMs?: number;
    json?: boolean;
  }
  let payload: Payload = {};

  if (request.method === 'GET') {
    payload.url = url.searchParams.get('url') ?? '';
    if (url.searchParams.get('json')) payload.json = true;
    const mb = url.searchParams.get('maxBytes');
    if (mb) payload.maxBytes = Number(mb);
  } else {
    try {
      payload = (await request.json()) as Payload;
    } catch {
      return new Response(JSON.stringify({ error: 'invalid_json' }), {
        status: 400,
        headers: { ...JSONH, ...CORS },
      });
    }
  }

  if (!payload.url) {
    return new Response(JSON.stringify({ error: 'url required' }), {
      status: 400,
      headers: { ...JSONH, ...CORS },
    });
  }

  // 解析目标，拆成 host / path / tls —— 固件的 https_fetch 收的是这几个字段
  let target: URL;
  try {
    target = new URL(payload.url);
  } catch {
    return new Response(JSON.stringify({ error: 'bad_url', detail: 'URL 解析失败' }), {
      status: 400,
      headers: { ...JSONH, ...CORS },
    });
  }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    return new Response(JSON.stringify({ error: 'bad_scheme', detail: '只支持 http / https' }), {
      status: 400,
      headers: { ...JSONH, ...CORS },
    });
  }

  // SSRF：先看字面量，再看白名单
  const chk = checkTarget(target.hostname);
  if (!chk.ok) {
    return new Response(
      JSON.stringify({ error: 'target_blocked', reason: chk.reason, host: target.hostname }),
      { status: 403, headers: { ...JSONH, ...CORS } }
    );
  }
  if (!hostAllowed(target.hostname, key.hosts)) {
    return new Response(
      JSON.stringify({ error: 'host_not_allowed', host: target.hostname, allow: key.hosts }),
      { status: 403, headers: { ...JSONH, ...CORS } }
    );
  }

  const includePort = target.port && target.port !== '80' && target.port !== '443';

  // 透传调用方的 method / headers / body。
  // 固件的 doFetch() 本来就收 args["method"] / args["headers"] / args["body"]，
  // 之前 Worker 这层没接线，等于把设备的能力锁死成"只会发裸 GET"——
  // 所有 POST 接口、所有需要 Cookie/Referer 的站点都用不了。
  const fwdHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(payload.headers ?? {})) {
    if (typeof v !== 'string') continue;
    const low = k.toLowerCase();
    // 这三个由固件自己管：host 跟着目标走，accept-encoding 必须 identity
    // （板子解不了 inflate），connection 必须 close（一次性连接）。
    if (low === 'host' || low === 'accept-encoding' || low === 'connection') continue;
    // user-agent 可以透传了：固件 2.1.0 起改成「调用方给了 UA 就不写默认」，
    // 不会再出现两条 User-Agent 的畸形请求。旧固件（2.0.0）上透传会被忽略，
    // 但也不会出错 —— 它只是多写一条默认 UA 在前面。
    fwdHeaders[k] = v;
  }

  const method = (payload.method ?? 'GET').toUpperCase();
  const ALLOWED_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD'];
  if (!ALLOWED_METHODS.includes(method)) {
    return new Response(
      JSON.stringify({ error: 'method_not_allowed', allow: ALLOWED_METHODS }),
      { status: 400, headers: { ...JSONH, ...CORS } }
    );
  }

  // body 走 String 拼进设备内存，C6 只有 ~270KB 可用堆，给个硬上限
  const MAX_BODY = 16 * 1024;
  if (payload.body && payload.body.length > MAX_BODY) {
    return new Response(
      JSON.stringify({ error: 'body_too_large', limit: MAX_BODY, got: payload.body.length }),
      { status: 413, headers: { ...JSONH, ...CORS } }
    );
  }

  // 二进制体：base64 后约为原文的 1.34 倍，上限按解码后的字节数算，
  // 免得「传了 16KB 原文却因为 21KB 的 base64 被拒」这种莫名其妙的失败。
  if (payload.bodyB64) {
    if (payload.body) {
      return new Response(
        JSON.stringify({ error: 'body_and_bodyB64_conflict', detail: '二者只能给一个' }),
        { status: 400, headers: { ...JSONH, ...CORS } }
      );
    }
    const decoded = Math.floor((payload.bodyB64.replace(/=+$/, '').length * 3) / 4);
    if (decoded > MAX_BODY) {
      return new Response(
        JSON.stringify({ error: 'body_too_large', limit: MAX_BODY, got: decoded }),
        { status: 413, headers: { ...JSONH, ...CORS } }
      );
    }
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(payload.bodyB64.trim())) {
      return new Response(JSON.stringify({ error: 'bad_base64' }), {
        status: 400,
        headers: { ...JSONH, ...CORS },
      });
    }
  }

  const relayArgs = {
    host: includePort ? `${target.hostname}:${target.port}` : target.hostname,
    path: target.pathname + target.search,
    tls: target.protocol === 'https:',
    maxBytes: payload.maxBytes,
    timeoutMs: payload.timeoutMs,
    method,
    headers: Object.keys(fwdHeaders).length ? fwdHeaders : undefined,
    body: payload.body || undefined,
    bodyB64: payload.bodyB64 || undefined,
  };

  const callResp = await mgr.fetch(
    new Request('https://manager.invalid/call', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-client-key': key.name,
      },
      body: JSON.stringify({
        tool: target.protocol === 'https:' ? 'https_fetch' : 'http_get',
        args: relayArgs,
        timeoutMs: payload.timeoutMs ?? 30_000,
        clientKey: key.name,
      }),
    })
  );

  const raw = await callResp.text();
  let parsed: {
    ok?: boolean;
    err?: string;
    error?: string;
    meta?: {
      status?: number;
      bytes?: number;
      ms?: number;
      redirects?: number;
      /** 撞到 maxBytes 被截断。固件 2.1.0 起才有 */
      truncated?: boolean;
      /** 目标的 Content-Type，原样带回来 */
      ctype?: string;
    };
    data?: string;
  };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return new Response(raw, { status: 502, headers: { ...JSONH, ...CORS } });
  }

  const metaHeaders: Record<string, string> = {
    ...CORS,
    'x-exit-ms': String(parsed.meta?.ms ?? ''),
    'x-exit-bytes': String(parsed.meta?.bytes ?? ''),
    'x-exit-key': key.name,
  };
  if (parsed.meta?.redirects) metaHeaders['x-exit-redirects'] = String(parsed.meta.redirects);
  // 截断必须显式告诉调用方 —— 半截内容看起来和完整内容一模一样，是最坑的一种"假成功"
  if (parsed.meta?.truncated) metaHeaders['x-exit-truncated'] = '1';
  // 目标的 Content-Type 只放在头里，不用它当响应的 content-type。
  // 原因：这是 exit.example.com 这个域，若让浏览器按 text/html 渲染目标页面，
  // 恶意页面就在我们自己的域里执行脚本，能同站调用 /admin/api/*（Cookie 会带上）。
  // 拿类型的目的只是让调用方知道该按什么解析，不需要让浏览器去渲染。
  if (parsed.meta?.ctype) metaHeaders['x-exit-ctype'] = parsed.meta.ctype;

  // 关键区分：目标站返回 404/500 是「目标在正常回答」，不是「出口坏了」。
  // 固件里 r.ok = (status >= 200 && status < 400)，所以 4xx/5xx 会让 ok=false。
  // 只要 meta.status 是一个合法 HTTP 状态码，就说明我们确实拿到了目标的响应，
  // 必须按目标响应透传；只有连状态码都没有（connect failed / 超时 / 截断）才算出口故障。
  const hasTargetStatus =
    typeof parsed.meta?.status === 'number' &&
    parsed.meta.status >= 100 &&
    parsed.meta.status <= 599;

  if (parsed.ok !== true && !hasTargetStatus) {
    return new Response(
      JSON.stringify({
        error: parsed.error ?? parsed.err ?? 'fetch_failed',
        meta: parsed.meta,
      }),
      {
        status: callResp.status === 200 ? 502 : callResp.status,
        headers: { ...JSONH, ...metaHeaders },
      }
    );
  }

  // 原始字节（base64 → Uint8Array）
  const bytes = parsed.data
    ? Uint8Array.from(atob(parsed.data), (c) => c.charCodeAt(0))
    : new Uint8Array();

  // json=1 时返回结构化结果，方便程序读取元信息；
  // 否则直接把内容吐回去 —— 这样 `curl` 拿到的就是网页本身，最省事。
  if (payload.json) {
    return new Response(
      JSON.stringify({
        ok: true,
        status: parsed.meta?.status ?? null,
        bytes: bytes.length,
        ms: parsed.meta?.ms ?? null,
        redirects: parsed.meta?.redirects ?? 0,
        truncated: parsed.meta?.truncated === true,
        ctype: parsed.meta?.ctype ?? null,
        via: key.name,
        encoding: 'base64',
        data: parsed.data ?? '',
        // 顺手给一份文本，小响应时省得调用方再解码
        text: bytes.length && bytes.length <= 262144 ? new TextDecoder().decode(bytes) : null,
      }),
      { headers: { ...JSONH, ...metaHeaders } }
    );
  }

  // 把目标站的真实状态码回传。之前这里恒定 200 —— 目标返 404 也当成功，
  // 调用方拿 200 + 错误页，根本没法判断，接给其他项目就是埋雷。
  const targetStatus = parsed.meta?.status;
  const status =
    typeof targetStatus === 'number' && targetStatus >= 200 && targetStatus <= 599
      ? targetStatus
      : 200;
  // 204/205/304 不允许带 body，强行带会让 Response 构造抛错
  const noBody = status === 204 || status === 205 || status === 304;

  return new Response(noBody ? null : bytes, {
    status,
    headers: {
      ...metaHeaders,
      'x-exit-status': String(status),
      'content-type': 'application/octet-stream',
      'cache-control': 'no-store',
    },
  });
}
