import { GatewayError } from '../openai/errors.js';
import { deepseekBase } from './deepseek.js';
import { randomHex, stripHtml, truncate } from '../util.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';

export interface DeepSeekCaptcha {
  turnstile_token?: string;
  shumei_verification?: unknown;
  hcaptcha_token?: string;
}

export interface SendSmsOptions {
  base: string;
  mobile: string;
  areaCode?: string;
  region?: string;
  locale?: string;
  deviceId?: string;
  captcha?: DeepSeekCaptcha;
  fetchImpl: typeof fetch;
}

function deviceId(): string {
  let out = '7';
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  for (const byte of bytes) out += String(byte % 10);
  return out;
}

function headers(base: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    origin: base,
    referer: `${base}/`,
    'user-agent': UA,
    'x-client-version': '2.4.2',
    'x-client-platform': 'web',
    accept: '*/*',
    'accept-language': 'zh-CN,zh;q=0.9',
  };
}

interface Envelope {
  data?: {
    biz_code?: number;
    biz_msg?: string;
    biz_data?: Record<string, unknown>;
  };
}

async function postJson(
  url: string,
  body: unknown,
  base: string,
  fetchImpl: typeof fetch
): Promise<Envelope> {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: headers(base),
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: Envelope;
  try {
    parsed = JSON.parse(text) as Envelope;
  } catch {
    throw new GatewayError(
      502,
      'upstream_error',
      `DeepSeek login returned non-JSON: ${truncate(stripHtml(text), 200)}`,
      'api_error'
    );
  }
  const payload = parsed.data ?? {};
  const code = typeof payload.biz_code === 'number' ? payload.biz_code : 0;
  if (code !== 0) {
    throw new GatewayError(
      400,
      'login_failed',
      String(payload.biz_msg ?? `DeepSeek login error ${code}`),
      'invalid_request_error'
    );
  }
  return parsed;
}

/** 发送短信验证码。返回 deviceId 和发送窗口；验证时要带同一个 deviceId。 */
export async function deepseekSendSms(options: SendSmsOptions): Promise<{
  deviceId: string;
  sendWindowSecs: number | null;
}> {
  const base = deepseekBase(options.base);
  const device = options.deviceId || deviceId();
  const body = {
    locale: options.locale ?? 'zh_CN',
    turnstile_token: options.captcha?.turnstile_token ?? '',
    shumei_verification: options.captcha?.shumei_verification ?? null,
    hcaptcha_token: options.captcha?.hcaptcha_token ?? '',
    device_id: device,
    scenario: 'login',
    mobile_number: options.mobile,
    area_code: options.areaCode ?? '+86',
    ticket: '',
  };
  const envelope = await postJson(
    `${base}/api/v0/users/create_sms_verification_code`,
    body,
    base,
    options.fetchImpl
  );
  const bizData = envelope.data?.biz_data ?? {};
  const sendWindow = bizData.send_window_secs;
  return {
    deviceId: device,
    sendWindowSecs: typeof sendWindow === 'number' ? sendWindow : null,
  };
}

export interface VerifySmsOptions {
  base: string;
  mobile: string;
  code: string;
  areaCode?: string;
  region?: string;
  locale?: string;
  deviceId: string;
  fetchImpl: typeof fetch;
}

/** 校验短信验证码并换 token。token 只存 Worker，不回传给调用方。 */
export async function deepseekVerifySms(options: VerifySmsOptions): Promise<{
  token: string;
  userId: string | null;
}> {
  const base = deepseekBase(options.base);
  const body = {
    region: options.region ?? 'CN',
    locale: options.locale ?? 'zh_CN',
    mobile_number: options.mobile,
    area_code: options.areaCode ?? '+86',
    sms_verification_code: options.code,
    device_id: options.deviceId,
    os: 'web',
  };
  const envelope = await postJson(
    `${base}/api/v0/users/login_by_mobile_sms`,
    body,
    base,
    options.fetchImpl
  );
  const bizData = envelope.data?.biz_data ?? {};
  const user = (bizData.user ?? {}) as Record<string, unknown>;
  const token = typeof user.token === 'string' ? user.token : '';
  if (!token) {
    throw new GatewayError(
      502,
      'login_failed',
      'DeepSeek login succeeded but returned no token',
      'api_error'
    );
  }
  return {
    token,
    userId: typeof user.id === 'string' ? user.id : null,
  };
}

export function loginLabel(mobile: string): string {
  return `ds_${mobile.replace(/[^0-9]/g, '').slice(-4)}_${randomHex(2)}`;
}
