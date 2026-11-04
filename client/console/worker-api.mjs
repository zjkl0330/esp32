// worker-api.mjs —— 控制台向 Cloudflare Worker 发请求的薄封装。
// 只用 Node 内置 fetch（v22 已有），token 由调用方传入（来自 env 或页面输入），永不写死。
//
// Worker 侧契约（见 worker/src/Relay.ts）：
//   GET /status/<tunnel>          -> { esp32, users, hibernatable, tunnel }
//   GET /wol/<tunnel>             -> "wol sent (default mac)"   （用固件默认 MAC）
//   GET /wol/<tunnel>/<mac>       -> "wol sent (<mac>)"
//   无 token / token 错误         -> 401
//   ESP32 离线                    -> 503 "esp32 offline"

/** https:// -> wss://, http:// -> ws://，并去掉结尾斜杠 */
export function httpToWs(base) {
  return String(base || '').trim().replace(/\/+$/, '').replace(/^http/i, 'ws');
}

/** 统一去掉结尾斜杠的 http base */
export function normalizeBase(base) {
  return String(base || '').trim().replace(/\/+$/, '');
}

function authHeaders(token) {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * 查询隧道状态。
 * @returns {Promise<{ok:boolean,status:number,data:any,error?:string}>}
 */
export async function getStatus({ base, tunnel, token }) {
  const url = `${normalizeBase(base)}/status/${encodeURIComponent(tunnel)}`;
  try {
    const res = await fetch(url, { headers: authHeaders(token) });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: null, error: e?.message ?? String(e) };
  }
}

/**
 * 发送 Wake-on-LAN 魔术包。mac 省略 = 用 ESP32 固件里的默认 MAC（全 0 帧）。
 * @returns {Promise<{ok:boolean,status:number,message:string,error?:string}>}
 */
export async function sendWol({ base, tunnel, token, mac }) {
  const clean = (mac || '').trim();
  // 注意：不要 encodeURIComponent —— MAC 里的 ':' 被编码成 %3A 后，
  // Worker 侧 /wol/<mac> 的正则会失配（panelHtml 里就用了 encodeURIComponent，有同样隐患）。
  const safeMac = /^[0-9a-fA-F]{2}([:-][0-9a-fA-F]{2}){5}$/.test(clean) ? clean : '';
  const url = `${normalizeBase(base)}/wol/${encodeURIComponent(tunnel)}` +
    (safeMac ? `/${safeMac}` : '');
  try {
    const res = await fetch(url, { headers: authHeaders(token) });
    const message = await res.text();
    return { ok: res.ok, status: res.status, message };
  } catch (e) {
    return { ok: false, status: 0, message: '网络错误', error: e?.message ?? String(e) };
  }
}
