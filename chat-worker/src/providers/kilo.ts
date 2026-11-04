import { GatewayError } from '../openai/errors.js';
import {
  jsonCompletionToSse,
  plainTextToSse,
  rewriteSseStream,
  rewriteSseText,
  textToStream,
} from '../openai/sse.js';
import type { ChatRequest, KiloModel } from '../types.js';
import { stripHtml, truncate } from '../util.js';

export const DEFAULT_KILO_BASE = 'https://api.kilo.ai/api/gateway';
export const USER_AGENT = 'chat2api-workers/0.1';

export function kiloBase(value: string | undefined): string {
  return (value || DEFAULT_KILO_BASE).replace(/\/+$/, '');
}

export function publicModelId(upstream: string): string {
  return `kilo/${upstream}`;
}

interface TimeoutSignal {
  signal: AbortSignal;
  cleanup: () => void;
  timedOut: () => boolean;
}

function timeoutSignal(ms: number, parent?: AbortSignal): TimeoutSignal {
  let timedOut = false;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, ms);

  const onAbort = () => controller.abort(parent?.reason);
  parent?.addEventListener('abort', onAbort, { once: true });

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', onAbort);
    },
  };
}

function extractErrorMessage(text: string): string {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const error = parsed.error;
    if (typeof error === 'string') return truncate(stripHtml(error), 300);
    if (error && typeof error === 'object') {
      const message = (error as Record<string, unknown>).message;
      if (typeof message === 'string') return truncate(stripHtml(message), 300);
    }
    const message = parsed.message;
    if (typeof message === 'string') return truncate(stripHtml(message), 300);
  } catch {
    // 不是 JSON，退回纯文本
  }
  return truncate(stripHtml(text), 300);
}

async function upstreamError(response: Response): Promise<GatewayError> {
  const text = await response.text().catch(() => '');
  const message = extractErrorMessage(text) || `upstream HTTP ${response.status}`;
  const retryAfter = response.headers.get('retry-after') ?? undefined;

  if (response.status === 429) {
    return new GatewayError(
      429,
      'upstream_rate_limited',
      message,
      'rate_limit_error',
      undefined,
      retryAfter ? { 'retry-after': retryAfter } : undefined
    );
  }

  // Kilo 对免费池之外的 id 经常回 401/403/404；对调用方统一成“模型不存在”。
  if (response.status === 401 || response.status === 403 || response.status === 404) {
    return new GatewayError(
      404,
      'model_not_found',
      `Kilo rejected this model: ${message}`,
      'invalid_request_error',
      'model'
    );
  }

  return new GatewayError(502, 'upstream_error', `Kilo ${response.status}: ${message}`, 'api_error');
}

export interface KiloListOptions {
  base: string;
  fetchImpl: typeof fetch;
  timeoutMs?: number;
}

/** 拉 Kilo 的公开模型清单，只保留 isFree === true 的行。 */
export async function listKiloModels(options: KiloListOptions): Promise<KiloModel[]> {
  const timeout = timeoutSignal(options.timeoutMs ?? 15_000);
  try {
    const response = await options.fetchImpl(`${options.base}/models`, {
      headers: {
        accept: 'application/json',
        'user-agent': USER_AGENT,
      },
      signal: timeout.signal,
    });
    if (!response.ok) {
      const message = await response.text().catch(() => '');
      throw new GatewayError(
        502,
        'upstream_error',
        `Kilo model listing failed: ${extractErrorMessage(message) || response.status}`,
        'api_error'
      );
    }

    const payload = (await response.json()) as unknown;
    const rows = Array.isArray((payload as { data?: unknown })?.data)
      ? ((payload as { data: unknown[] }).data as unknown[])
      : Array.isArray((payload as { models?: unknown })?.models)
        ? ((payload as { models: unknown[] }).models as unknown[])
        : Array.isArray(payload)
          ? payload
          : [];

    const seen = new Set<string>();
    const models: KiloModel[] = [];
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      const item = row as Record<string, unknown>;
      if (item.isFree !== true) continue;
      const id = typeof item.id === 'string' ? item.id.trim() : '';
      if (!id || seen.has(id)) continue;
      seen.add(id);
      models.push({
        id: publicModelId(id),
        object: 'model',
        owned_by: 'kilo',
        created: 0,
        upstream: id,
      });
    }

    if (models.length === 0) {
      throw new GatewayError(
        502,
        'upstream_error',
        'Kilo returned no free models',
        'api_error'
      );
    }
    return models;
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    if (timeout.timedOut()) {
      throw new GatewayError(504, 'upstream_timeout', 'Kilo model listing timed out', 'api_error');
    }
    throw new GatewayError(
      502,
      'upstream_error',
      `Kilo model listing failed: ${error instanceof Error ? error.message : String(error)}`,
      'api_error'
    );
  } finally {
    timeout.cleanup();
  }
}

export function buildUpstreamBody(
  request: ChatRequest,
  upstreamModel: string
): Record<string, unknown> {
  return {
    model: upstreamModel,
    messages: request.messages,
    stream: request.stream,
    // 免费池多个模型默认走 reasoning；不给上限时容易把额度花在思考上。
    max_tokens: request.max_tokens ?? 1024,
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.stop !== undefined ? { stop: request.stop } : {}),
    ...(request.stream_options !== undefined ? { stream_options: request.stream_options } : {}),
  };
}

export interface KiloChatOptions {
  base: string;
  body: Record<string, unknown>;
  stream: boolean;
  fetchImpl: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * 调 Kilo 的 /chat/completions。
 * 只做一次重试，而且只在“还没拿到任何可用响应”时重试，避免重复计费。
 */
export async function requestKiloChat(options: KiloChatOptions): Promise<Response> {
  const url = `${options.base}/chat/completions`;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: options.stream ? 'text/event-stream' : 'application/json',
    'user-agent': USER_AGENT,
  };

  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (options.signal?.aborted) {
      throw new GatewayError(499, 'client_closed', 'client closed request', 'api_error');
    }

    const timeout = timeoutSignal(options.timeoutMs ?? 300_000, options.signal);
    try {
      const response = await options.fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(options.body),
        signal: timeout.signal,
      });

      if (response.status >= 500 && attempt === 0) {
        await response.text().catch(() => '');
        continue;
      }
      if (!response.ok) throw await upstreamError(response);
      return response;
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      if (options.signal?.aborted) {
        throw new GatewayError(499, 'client_closed', 'client closed request', 'api_error');
      }
      lastError = error;
      if (timeout.timedOut()) {
        lastError = new GatewayError(504, 'upstream_timeout', 'Kilo chat timed out', 'api_error');
      }
      if (attempt === 0) continue;
    } finally {
      timeout.cleanup();
    }
  }

  if (lastError instanceof GatewayError) throw lastError;
  throw new GatewayError(
    502,
    'upstream_error',
    `Kilo request failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    'api_error'
  );
}

/** 非流式：读 JSON，改公开模型名，返回序列化后的文本。 */
export async function rewriteJsonText(response: Response, model: string): Promise<string> {
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new GatewayError(502, 'upstream_error', 'Kilo returned a non-JSON response', 'api_error');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new GatewayError(502, 'upstream_error', 'Kilo returned an unexpected JSON shape', 'api_error');
  }
  (parsed as Record<string, unknown>).model = model;
  return JSON.stringify(parsed);
}

/** 流式：SSE 原样改写；上游误回 JSON/纯文本时也能兜住。 */
export async function responseToSseStream(
  response: Response,
  model: string
): Promise<ReadableStream<Uint8Array>> {
  const contentType = response.headers.get('content-type') ?? '';

  if (contentType.includes('text/event-stream')) {
    if (!response.body) {
      throw new GatewayError(502, 'upstream_error', 'Kilo returned an empty stream', 'api_error');
    }
    return rewriteSseStream(response.body, model);
  }

  const text = await response.text();
  const trimmed = text.trimStart();
  if (trimmed.startsWith('data:')) {
    return textToStream(rewriteSseText(text, model));
  }

  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    return textToStream(jsonCompletionToSse(parsed, model));
  } catch {
    return textToStream(plainTextToSse(text, model));
  }
}
