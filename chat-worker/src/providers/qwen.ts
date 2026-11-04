import { GatewayError } from '../openai/errors.js';
import type { ModelInfo } from '../types.js';
import { stripHtml, truncate } from '../util.js';
import { USER_AGENT } from './kilo.js';

export const DEFAULT_QWEN_BASE = 'https://chat.qwen.ai';

export function qwenBase(value: string | undefined): string {
  return (value || DEFAULT_QWEN_BASE).replace(/\/+$/, '');
}

interface QwenOptions {
  base: string;
  token: string;
  fetchImpl: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}

function timeoutSignal(ms: number, parent?: AbortSignal): {
  signal: AbortSignal;
  cleanup: () => void;
  timedOut: () => boolean;
} {
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

function errorMessage(text: string, status: number): string {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const error = parsed.error;
    if (error && typeof error === 'object') {
      const message = (error as Record<string, unknown>).message;
      if (typeof message === 'string') return truncate(stripHtml(message), 300);
    }
    if (typeof parsed.message === 'string') return truncate(stripHtml(parsed.message), 300);
  } catch {
    // 不是 JSON，退回纯文本
  }
  return truncate(stripHtml(text), 300) || `Qwen HTTP ${status}`;
}

/** 拉千问网页端的模型清单。该接口公开，不需要 token。 */
export async function listQwenModels(options: {
  base: string;
  fetchImpl: typeof fetch;
  timeoutMs?: number;
}): Promise<ModelInfo[]> {
  const timeout = timeoutSignal(options.timeoutMs ?? 15_000);
  try {
    const response = await options.fetchImpl(`${options.base}/api/models`, {
      headers: {
        accept: 'application/json',
        'user-agent': USER_AGENT,
      },
      signal: timeout.signal,
    });
    if (!response.ok) return [];
    const payload = (await response.json()) as { data?: unknown };
    const rows = Array.isArray(payload?.data) ? payload.data : [];
    const seen = new Set<string>();
    const models: ModelInfo[] = [];
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      const id = typeof (row as { id?: unknown }).id === 'string' ? (row as { id: string }).id.trim() : '';
      if (!id || seen.has(id)) continue;
      seen.add(id);
      models.push({
        id: `web/qwen/${id}`,
        object: 'model',
        owned_by: 'qwen',
        created: 0,
      });
    }
    return models;
  } catch {
    return [];
  } finally {
    timeout.cleanup();
  }
}

/**
 * 千问网页端 /api/chat/completions。
 * 返回体是 OpenAI 兼容 SSE，所以后续可以直接复用 Kilo 的改写逻辑。
 */
export async function requestQwenChat(
  options: QwenOptions & { body: Record<string, unknown>; stream: boolean }
): Promise<Response> {
  if (!options.token) {
    throw new GatewayError(
      503,
      'web_not_configured',
      'QWEN_TOKEN is not configured',
      'server_error'
    );
  }

  const timeout = timeoutSignal(options.timeoutMs ?? 300_000, options.signal);
  try {
    const response = await options.fetchImpl(`${options.base}/api/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${options.token}`,
        'content-type': 'application/json',
        accept: options.stream ? 'text/event-stream' : 'application/json',
        'user-agent': USER_AGENT,
        origin: options.base,
        referer: `${options.base}/`,
      },
      body: JSON.stringify(options.body),
      signal: timeout.signal,
    });

    if (response.ok) return response;

    const text = await response.text().catch(() => '');
    const message = errorMessage(text, response.status);
    const retryAfter = response.headers.get('retry-after') ?? undefined;

    if (response.status === 401 || response.status === 403) {
      throw new GatewayError(
        401,
        'invalid_web_token',
        `Qwen rejected the web token: ${message}`,
        'authentication_error'
      );
    }
    if (response.status === 404) {
      throw new GatewayError(
        404,
        'model_not_found',
        `Qwen rejected this model: ${message}`,
        'invalid_request_error',
        'model'
      );
    }
    if (response.status === 429) {
      throw new GatewayError(
        429,
        'upstream_rate_limited',
        message,
        'rate_limit_error',
        undefined,
        retryAfter ? { 'retry-after': retryAfter } : undefined
      );
    }
    throw new GatewayError(502, 'upstream_error', `Qwen ${response.status}: ${message}`, 'api_error');
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    if (options.signal?.aborted) {
      throw new GatewayError(499, 'client_closed', 'client closed request', 'api_error');
    }
    if (timeout.timedOut()) {
      throw new GatewayError(504, 'upstream_timeout', 'Qwen request timed out', 'api_error');
    }
    throw new GatewayError(
      502,
      'upstream_error',
      `Qwen request failed: ${error instanceof Error ? error.message : String(error)}`,
      'api_error'
    );
  } finally {
    timeout.cleanup();
  }
}
