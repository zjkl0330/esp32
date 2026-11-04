/**
 * 住宅出口 SDK —— 让其他项目一行接入 exit.example.com
 *
 * 作用：把一个 HTTPS 请求改成从家里那条宽带（ESP32-C6 所在网络）出去。
 *      目标站看到的是家庭公网 IP（江西电信），不是 Cloudflare、也不是你的云服务器 IP。
 *
 * 零依赖。Node 18+ / Cloudflare Workers / Bun / Deno 通用（都自带 fetch 和 Response）。
 *
 *   import { createExit } from './sdk/exit-fetch.mjs';
 *   const exit = createExit({ key: 'sk_xxx' });
 *
 *   const res  = await exit.fetch('https://api.example.com/data');
 *   const data = await res.json();
 *
 *   // 和原生 fetch 一样用，只是多绕一跳
 *   const post = await exit.fetch('https://httpbin.org/post', {
 *     method: 'POST',
 *     headers: { 'content-type': 'application/json' },
 *     body: JSON.stringify({ n: 42 }),
 *   });
 *
 * 它返回的是标准 Response：status 是「目标站」的真实状态码，
 * 不是出口自己的状态码。出口自己出错时抛异常（带 .status / .body）。
 *
 * 另外两个细节：
 *   · 目标的 Content-Type 会挂在 res.headers.get('content-type') 上；
 *   · 内容被截断时 res.headers.get('x-exit-truncated') === '1'。
 *     半截内容和完整内容长得一模一样，所以这个标记必须看 ——
 *     不看就等于把不完整的数据当完整数据用。
 */

const DEFAULTS = {
  base: 'https://exit.example.com',
  /** 单次抓取的链路上限。设备侧总预算 20s，这里留出余量 */
  timeoutMs: 35000,
  /** 单次响应最多拿回多少字节，默认跟固件一致（128KB） */
  maxBytes: 131072,
};

/** 出口自己没有正常返回时（鉴权失败/额度用完/设备离线），统一成这个错误 */
export class ExitError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'ExitError';
    this.status = status;
    this.body = body;
  }
}

export function createExit(options = {}) {
  const base = (options.base || DEFAULTS.base).replace(/\/+$/, '');
  const key = options.key;
  if (!key) {
    throw new ExitError('[exit] 缺少 key。每个项目一把，别共用（见 docs/04）');
  }
  const defaultTimeout = options.timeoutMs ?? DEFAULTS.timeoutMs;
  const defaultMaxBytes = options.maxBytes ?? DEFAULTS.maxBytes;

  /**
   * 和原生 fetch 签名一致。
   * 只支持字符串 body —— 出口是把请求体拼进 ESP32 内存里发出去的，
   * FormData / ReadableStream / Blob 这类没法传（要传就自己序列化成字符串）。
   */
  async function exitFetch(input, init = {}) {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input && typeof input === 'object' && 'url' in input
            ? String(input.url)
            : '';

    if (!url) throw new ExitError('[exit] 第一个参数得是 URL 或 Request');

    const method = String(init.method || 'GET').toUpperCase();

    // Headers 实例 / 普通对象 / 数组都吃
    const headers = {};
    if (init.headers) {
      new Headers(init.headers).forEach((v, k) => {
        headers[k] = v;
      });
    }

    let body;
    if (init.body != null) {
      if (typeof init.body !== 'string') {
        throw new ExitError(
          `[exit] body 只支持字符串，收到的类型是 ${Object.prototype.toString.call(init.body)}`
        );
      }
      body = init.body;
    }

    const timeoutMs = init.timeoutMs ?? defaultTimeout;
    const maxBytes = init.maxBytes ?? defaultMaxBytes;

    // 两层超时：外面这层网络层，里面那层设备预算
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new ExitError(`[exit] 本地超时 ${timeoutMs}ms`)), timeoutMs + 5000);
    if (init.signal) {
      if (init.signal.aborted) ac.abort(init.signal.reason);
      else init.signal.addEventListener('abort', () => ac.abort(init.signal.reason), { once: true });
    }

    let r;
    try {
      r = await fetch(`${base}/api/fetch`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${key}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          url,
          method,
          headers: Object.keys(headers).length ? headers : undefined,
          body,
          maxBytes,
          timeoutMs,
        }),
        signal: ac.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    // x-exit-status 只在实际抓到了目标响应时才有。
    // 没有它 → 是出口自己拒绝/出错（401 鉴权、429 额度、503 设备离线…）
    const viaStatus = r.headers.get('x-exit-status');
    if (viaStatus === null) {
      const text = await r.text();
      let detail;
      try {
        detail = JSON.parse(text);
      } catch {
        detail = { raw: text.slice(0, 300) };
      }
      throw new ExitError(
        `[exit] ${detail.error || 'unknown_error'}${detail.detail ? '：' + detail.detail : ''}`,
        { status: r.status, body: detail }
      );
    }

    const buf = await r.arrayBuffer();
    const status = Number(viaStatus) || 200;

    // 204/205/304 在 HTTP 里不允许带 body，构造 Response 时必须给 null
    const noBody = status === 204 || status === 205 || status === 304;

    // 把目标的真实 Content-Type 挂到响应上，这样 res.json() / blob() / 图片判断都正常。
    // 拿不到就退回 octet-stream —— 不要猜。
    const ctype = r.headers.get('x-exit-ctype');

    const outHeaders = {
      'x-exit-via': 'esp32-residential',
      'x-exit-ms': r.headers.get('x-exit-ms') || '',
      'x-exit-bytes': r.headers.get('x-exit-bytes') || '',
    };
    if (ctype) outHeaders['content-type'] = ctype;
    // 截断是数据完整性问题，必须让调用方能发现：
    // 半截内容和完整内容长得一样，是最危险的一种「假成功」。
    if (r.headers.get('x-exit-truncated') === '1') {
      outHeaders['x-exit-truncated'] = '1';
    }

    return new Response(noBody ? null : buf, { status, headers: outHeaders });
  }

  return {
    fetch: exitFetch,

    /** 便捷方法，语义更直白 */
    get: (url, init) => exitFetch(url, { ...init, method: 'GET' }),
    post: (url, body, init) => exitFetch(url, { ...init, method: 'POST', body }),

    /** 直接拿 JSON，省一次 .json() */
    async json(url, init) {
      const res = await exitFetch(url, init);
      if (!res.ok) {
        throw new ExitError(`[exit] 目标返回 ${res.status}`, { status: res.status });
      }
      return res.json();
    },

    /** 查这把 key 今天还剩多少额度 */
    async me() {
      const r = await fetch(`${base}/api/me`, {
        headers: { authorization: `Bearer ${key}` },
      });
      return r.json();
    },
  };
}

export default createExit;
