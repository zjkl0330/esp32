/**
 * 把 Worker 的 fetch 换成一个“经住宅出口”的 fetch。
 *
 * 调用链：chat Worker → service binding esp32-exit → ESP32（家里）→ 目标站点。
 * 目前走 exit 的 /api/fetch（缓冲模式）：请求体 ≤16KB，响应 ≤256KB，固件单次预算约 15s。
 * 真正的逐块流式要等 exit 的 /internal/stream + 固件 https_fetch_stream。
 */
export function createExitFetch(
  exit: Fetcher,
  clientKey: string,
  base = 'https://exit.internal'
): typeof fetch {
  return async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, name) => {
      headers[name] = value;
    });

    let body: string | undefined;
    if (typeof init.body === 'string') body = init.body;
    else if (init.body != null) {
      throw new Error('exit fetch only supports string bodies');
    }

    const response = await exit.fetch(`${base}/api/fetch`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${clientKey}`,
      },
      body: JSON.stringify({
        url,
        method: init.method ?? 'GET',
        headers,
        body,
        maxBytes: 262_144,
        timeoutMs: 30_000,
      }),
      signal: init.signal,
    });

    // 出口自己的错误（401/429/503）原样返回，交给 provider 映射。
    if (!response.ok) return response;

    const statusHeader = response.headers.get('x-exit-status');
    const status = statusHeader ? Number(statusHeader) : 200;
    const ctype = response.headers.get('x-exit-ctype') ?? 'application/octet-stream';
    const raw = await response.arrayBuffer();
    const outHeaders = new Headers({ 'content-type': ctype });
    if (response.headers.get('x-exit-truncated') === '1') {
      outHeaders.set('x-exit-truncated', '1');
    }
    const noBody = status === 204 || status === 205 || status === 304;
    return new Response(noBody ? null : raw, { status, headers: outHeaders });
  };
}
