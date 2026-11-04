import md5Module from 'js-md5';
import { GatewayError } from '../openai/errors.js';

const md5 = md5Module as unknown as (message: string) => string;
import type { ChatMessage, ChatRequest, ModelInfo } from '../types.js';
import { randomHex, stripHtml, truncate } from '../util.js';

export const DEFAULT_GLM_BASE = 'https://chatglm.cn';
const DEFAULT_SIGN_SECRET = '8a1317a7468aa3ad86e997d08f3f31cb';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const ASSISTANT_ID = '65940acff94777010aa6b796';

export function glmBase(value: string | undefined): string {
  return (value || DEFAULT_GLM_BASE).replace(/\/+$/, '');
}

export function listGlmModels(): ModelInfo[] {
  return ['glm', 'glm-think'].map((id) => ({
    id: `web/glm/${id}`,
    object: 'model' as const,
    owned_by: 'glm',
    created: 0,
  }));
}

function uuid(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

function generateSign(secret: string): { timestamp: string; nonce: string; sign: string } {
  const now = Date.now().toString();
  const length = now.length;
  const digits = now.split('').map(Number);
  const sum = digits.reduce((total, value) => total + value, 0) - digits[length - 2];
  const check = sum % 10;
  const timestamp = now.substring(0, length - 2) + check + now.substring(length - 1, length);
  const nonce = uuid();
  return { timestamp, nonce, sign: md5(`${timestamp}-${nonce}-${secret}`) };
}

function headers(base: string, token: string, secret: string): Record<string, string> {
  const sign = generateSign(secret);
  return {
    accept: 'text/event-stream',
    'content-type': 'application/json',
    origin: base,
    referer: `${base}/main/alltoolsdetail`,
    'user-agent': UA,
    'app-name': 'chatglm',
    'x-app-fr': 'browser_extension',
    'x-app-platform': 'pc',
    'x-app-version': '0.0.1',
    'x-lang': 'zh',
    'x-device-id': uuid(),
    'x-request-id': uuid(),
    'x-sign': sign.sign,
    'x-timestamp': sign.timestamp,
    'x-nonce': sign.nonce,
    authorization: `Bearer ${token}`,
  };
}

class GlmAccumulator {
  private lastFull = '';
  done = false;
  error: string | null = null;

  handle(event: string): string {
    let data = '';
    for (const line of event.split('\n')) {
      if (line.startsWith('data:')) {
        data = line.slice('data:'.length).trimStart();
        break;
      }
    }
    if (!data) return '';

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return '';
    }
    if (typeof parsed.code === 'number' && parsed.code !== 0) {
      this.error = String(parsed.message ?? parsed.msg ?? `GLM error ${parsed.code}`);
      return '';
    }

    const parts = Array.isArray(parsed.parts) ? parsed.parts : [];
    let full = '';
    for (const part of parts) {
      if (!part || typeof part !== 'object') continue;
      const content = (part as Record<string, unknown>).content;
      if (!Array.isArray(content)) continue;
      for (const item of content) {
        if (!item || typeof item !== 'object') continue;
        const record = item as Record<string, unknown>;
        if (record.type !== 'text') continue;
        if (typeof record.text === 'string') full += record.text;
      }
    }

    const delta = full.startsWith(this.lastFull)
      ? full.slice(this.lastFull.length)
      : full;
    this.lastFull = full;
    if (parsed.status === 'finish') this.done = true;
    return delta;
  }
}

function splitEvents(text: string): string[] {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n\n')
    .filter((event) => event.trim() !== '');
}

function completionFromText(text: string, model: string): Record<string, unknown> {
  const accumulator = new GlmAccumulator();
  let content = '';
  for (const event of splitEvents(text)) {
    const delta = accumulator.handle(event);
    if (delta) content += delta;
    if (accumulator.error) {
      throw new GatewayError(502, 'upstream_error', accumulator.error, 'api_error');
    }
    if (accumulator.done) break;
  }
  if (!content) {
    throw new GatewayError(502, 'upstream_error', 'GLM returned empty content', 'api_error');
  }
  return {
    id: `chatcmpl-${randomHex(12)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        logprobs: null,
        finish_reason: 'stop',
      },
    ],
  };
}

function streamFromGlm(input: ReadableStream<Uint8Array>, model: string): ReadableStream<Uint8Array> {
  const reader = input.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const accumulator = new GlmAccumulator();
  const id = `chatcmpl-${randomHex(12)}`;
  const created = Math.floor(Date.now() / 1000);
  const base = { id, object: 'chat.completion.chunk', created, model };
  let buffer = '';
  let roleSent = false;
  let completed = false;

  const emit = (controller: ReadableStreamDefaultController<Uint8Array>, payload: unknown) => {
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
  };
  const emitRole = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (roleSent) return;
    roleSent = true;
    emit(controller, {
      ...base,
      choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
    });
  };
  const emitContent = (controller: ReadableStreamDefaultController<Uint8Array>, content: string) => {
    emit(controller, {
      ...base,
      choices: [{ index: 0, delta: { content }, finish_reason: null }],
    });
  };
  const finish = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (completed) return;
    completed = true;
    emitRole(controller);
    emit(controller, {
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    });
    controller.enqueue(encoder.encode('data: [DONE]\n\n'));
    controller.close();
  };
  const fail = (controller: ReadableStreamDefaultController<Uint8Array>, message: string) => {
    if (completed) return;
    completed = true;
    emit(controller, { error: { message, type: 'server_error', code: 'upstream_error' } });
    controller.enqueue(encoder.encode('data: [DONE]\n\n'));
    controller.close();
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (completed) return;
      try {
        while (!completed) {
          const { done, value } = await reader.read();
          if (done) {
            buffer += decoder.decode();
            buffer = buffer.replace(/\r\n/g, '\n');
            if (buffer.trim()) {
              emitRole(controller);
              const delta = accumulator.handle(buffer);
              if (accumulator.error) {
                fail(controller, accumulator.error);
                return;
              }
              if (delta) emitContent(controller, delta);
            }
            finish(controller);
            return;
          }

          buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
          let at = buffer.indexOf('\n\n');
          while (at >= 0) {
            const event = buffer.slice(0, at);
            buffer = buffer.slice(at + 2);
            emitRole(controller);
            const delta = accumulator.handle(event);
            if (accumulator.error) {
              fail(controller, accumulator.error);
              return;
            }
            if (delta) emitContent(controller, delta);
            if (accumulator.done) {
              finish(controller);
              return;
            }
            at = buffer.indexOf('\n\n');
          }
        }
      } catch (error) {
        fail(controller, error instanceof Error ? error.message : 'GLM stream failed');
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

export interface GlmChatOptions {
  base: string;
  token: string;
  signSecret?: string;
  chat: ChatRequest;
  fetchImpl: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export async function requestGlmChat(options: GlmChatOptions): Promise<Response> {
  if (!options.token) {
    throw new GatewayError(503, 'web_not_configured', 'GLM_TOKEN is not configured', 'server_error');
  }

  let timedOut = false;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs ?? 300_000);
  const onAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const base = options.base;
    const model = options.chat.model;
    const chatMode = model.includes('think') || model.includes('zero') ? 'zero' : '';
    const messages = options.chat.messages.map((message: ChatMessage) => ({
      role: message.role,
      content: message.content,
    }));

    const response = await options.fetchImpl(`${base}/chatglm/backend-api/assistant/stream`, {
      method: 'POST',
      headers: headers(base, options.token, options.signSecret || DEFAULT_SIGN_SECRET),
      body: JSON.stringify({
        assistant_id: ASSISTANT_ID,
        conversation_id: '',
        project_id: '',
        chat_type: 'user_chat',
        messages,
        meta_data: {
          channel: '',
          ...(chatMode ? { chat_mode: chatMode } : {}),
          draft_id: '',
          if_plus_model: true,
          input_question_type: 'xxxx',
          is_networking: false,
          is_test: false,
          platform: 'pc',
          quote_log_id: '',
        },
      }),
      signal: controller.signal,
    });

    if (response.status === 401 || response.status === 403) {
      throw new GatewayError(
        401,
        'invalid_web_token',
        'GLM rejected the web token',
        'authentication_error'
      );
    }
    if (response.status === 429) {
      throw new GatewayError(429, 'upstream_rate_limited', 'GLM rate limited this account', 'rate_limit_error');
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new GatewayError(
        502,
        'upstream_error',
        `GLM ${response.status}: ${truncate(stripHtml(text), 300)}`,
        'api_error'
      );
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('text/event-stream') || !response.body) {
      const text = await response.text().catch(() => '');
      throw new GatewayError(
        502,
        'upstream_error',
        `GLM returned ${contentType || 'unknown'}: ${truncate(stripHtml(text), 200)}`,
        'api_error'
      );
    }

    if (options.chat.stream) {
      return new Response(streamFromGlm(response.body, model), {
        status: 200,
        headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' },
      });
    }

    const text = await response.text();
    return new Response(JSON.stringify(completionFromText(text, model)), {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    if (options.signal?.aborted) {
      throw new GatewayError(499, 'client_closed', 'client closed request', 'api_error');
    }
    if (timedOut) {
      throw new GatewayError(504, 'upstream_timeout', 'GLM request timed out', 'api_error');
    }
    throw new GatewayError(
      502,
      'upstream_error',
      `GLM request failed: ${error instanceof Error ? error.message : String(error)}`,
      'api_error'
    );
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}
