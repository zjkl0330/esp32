import { GatewayError } from '../openai/errors.js';
import { randomHex, stripHtml, truncate } from '../util.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';

export const DEFAULT_DOUBAO_AID = '497858';
export const DEFAULT_DOUBAO_SERVICE = 'https://www.doubao.com';

function headers(base: string, cookie?: string): Record<string, string> {
  return {
    accept: 'application/json, text/plain, */*',
    'content-type': 'application/json',
    origin: base,
    referer: `${base}/`,
    'user-agent': UA,
    'accept-language': 'zh-CN,zh;q=0.9',
    'x-requested-with': 'XMLHttpRequest',
    ...(cookie ? { cookie } : {}),
  };
}

function mergeCookies(...values: string[]): string {
  const jar = new Map<string, string>();
  for (const value of values) {
    for (const pair of value.split(';')) {
      const at = pair.indexOf('=');
      if (at <= 0) continue;
      const name = pair.slice(0, at).trim();
      const cookieValue = pair.slice(at + 1).trim();
      if (name) jar.set(name, cookieValue);
    }
  }
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
}

function collectCookies(response: Response): string {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const values = headers.getSetCookie?.() ?? [];
  if (values.length === 0) {
    const combined = headers.get('set-cookie');
    if (combined) values.push(combined);
  }
  const pairs: string[] = [];
  for (const raw of values) {
    for (const part of raw.split(/,(?=[^;,]+=)/)) {
      const pair = part.split(';')[0]?.trim();
      if (pair && pair.includes('=')) pairs.push(pair);
    }
  }
  return pairs.join('; ');
}

function extractCookie(cookie: string, name: string): string {
  for (const pair of cookie.split(';')) {
    const at = pair.indexOf('=');
    if (at <= 0) continue;
    if (pair.slice(0, at).trim() === name) return pair.slice(at + 1).trim();
  }
  return '';
}

async function postJson(
  url: string,
  body: unknown,
  base: string,
  fetchImpl: typeof fetch,
  cookie?: string
): Promise<{ json: Record<string, unknown>; cookie: string; text: string }> {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: headers(base, cookie),
    body: JSON.stringify(body),
  });
  const nextCookie = collectCookies(response);
  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new GatewayError(
      502,
      'upstream_error',
      `Doubao passport returned non-JSON: ${truncate(stripHtml(text), 200)}`,
      'api_error'
    );
  }
  if (!response.ok) {
    throw new GatewayError(
      400,
      'login_failed',
      String(parsed.message ?? parsed.msg ?? `Doubao passport ${response.status}`),
      'invalid_request_error'
    );
  }
  const data = (parsed.data ?? {}) as Record<string, unknown>;
  const code = typeof parsed.code === 'number' ? parsed.code : 0;
  if (code !== 0 || (typeof data.code === 'number' && data.code !== 0)) {
    throw new GatewayError(
      400,
      'login_failed',
      String(parsed.message ?? data.message ?? data.description ?? `Doubao passport error ${code}`),
      'invalid_request_error'
    );
  }
  return { json: parsed, cookie: nextCookie, text };
}

export interface DoubaoLoginContext {
  mobile: string;
  aid?: string;
  service?: string;
  cookie?: string;
  passportBase?: string;
  fetchImpl: typeof fetch;
}

const DEFAULT_PASSPORT_BASE = 'https://accounts.doubao.com';

export async function doubaoBootstrap(
  base: string,
  fetchImpl: typeof fetch
): Promise<string> {
  try {
    const response = await fetchImpl(`${base}/`, {
      headers: headers(base),
    });
    return collectCookies(response);
  } catch {
    return '';
  }
}

export async function doubaoSendSms(
  options: DoubaoLoginContext & { verifyTicket?: string }
): Promise<{ cookie: string; message: string }> {
  const base = options.passportBase || DEFAULT_PASSPORT_BASE;
  const cookie = options.cookie || (await doubaoBootstrap(base, options.fetchImpl));
  const body = {
    aid: Number(options.aid || DEFAULT_DOUBAO_AID),
    mobile: options.mobile,
    type: 24,
    is6Digits: 1,
    verify_ticket: options.verifyTicket ?? '',
  };
  const result = await postJson(
    `${base}/passport/web/send_code/`,
    body,
    base,
    options.fetchImpl,
    cookie
  );
  return {
    cookie: mergeCookies(cookie, result.cookie),
    message: String(result.json.message ?? 'sent'),
  };
}

export async function doubaoVerifySms(
  options: DoubaoLoginContext & { code: string }
): Promise<{ cookie: string; sessionid: string }> {
  const base = options.passportBase || DEFAULT_PASSPORT_BASE;
  const body = {
    aid: Number(options.aid || DEFAULT_DOUBAO_AID),
    mobile: options.mobile,
    code: options.code,
    service: options.service || DEFAULT_DOUBAO_SERVICE,
    safe_mobile_register_to_login: false,
  };
  const result = await postJson(
    `${base}/passport/web/sms_login/`,
    body,
    base,
    options.fetchImpl,
    options.cookie
  );
  let cookie = mergeCookies(options.cookie ?? '', result.cookie);
  const data = (result.json.data ?? {}) as Record<string, unknown>;
  const redirect =
    typeof data.redirect_url === 'string'
      ? data.redirect_url
      : typeof result.json.redirect_url === 'string'
        ? result.json.redirect_url
        : '';
  if (redirect) {
    try {
      const target = redirect.startsWith('http') ? redirect : `${base}${redirect}`;
      const response = await options.fetchImpl(target, { headers: headers(base, cookie) });
      cookie = mergeCookies(cookie, collectCookies(response));
    } catch {
      // 登录本身成功但跟随 redirect 失败时仍然保存已有 cookie
    }
  }
  const sessionid =
    extractCookie(cookie, 'sessionid') ||
    (typeof data.sessionid === 'string' ? data.sessionid : '');
  if (!sessionid) {
    throw new GatewayError(
      502,
      'login_failed',
      'Doubao login succeeded but returned no sessionid',
      'api_error'
    );
  }
  return { cookie, sessionid };
}

export function doubaoLoginLabel(mobile: string): string {
  return `db_${mobile.replace(/[^0-9]/g, '').slice(-4)}_${randomHex(2)}`;
}
