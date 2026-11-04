import { GatewayError } from '../openai/errors.js';
import { publicModelId } from './kilo.js';
import { solveDeepSeekPow } from './deepseek-pow.js';
import type { ChatMessage, ChatRequest, ModelInfo } from '../types.js';
import { randomHex, stripHtml, truncate } from '../util.js';

export const DEFAULT_DEEPSEEK_BASE = 'https://chat.deepseek.com';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';

export function deepseekBase(value: string | undefined): string {
  return (value || DEFAULT_DEEPSEEK_BASE).replace(/\/+$/, '');
}

export function listDeepSeekModels(): ModelInfo[] {
  return ['deepseek-default', 'deepseek-reasoner', 'deepseek-expert', 'deepseek-vision'].map(
    (id) => ({
      id: `web/deepseek/${id}`,
      object: 'model' as const,
      owned_by: 'deepseek',
      created: 0,
    })
  );
}

function dsHeaders(base: string, token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    origin: base,
    referer: `${base}/`,
    'user-agent': USER_AGENT,
    'x-client-version': '2.4.2',
    'x-client-platform': 'web',
  };
}

function absorbCookies(response: Response, jar: Map<string, string>): void {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const values = headers.getSetCookie?.() ?? [];
  if (values.length === 0) {
    const combined = headers.get('set-cookie');
    if (combined) values.push(combined);
  }
  for (const raw of values) {
    for (const part of raw.split(/,(?=[^;,]+=)/)) {
      const pair = part.split(';')[0];
      const at = pair.indexOf('=');
      if (at <= 0) continue;
      const name = pair.slice(0, at).trim();
      const value = pair.slice(at + 1).trim();
      if (name) jar.set(name, value);
    }
  }
}

function cookieHeader(jar: Map<string, string>): string {
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
}

function buildPrompt(messages: ChatMessage[]): string {
  const system = messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n');
  const rest = messages.filter((message) => message.role !== 'system');
  if (rest.length === 0) return system;
  if (rest.length === 1) return system ? `${system}\n\n${rest[0].content}` : rest[0].content;
  return [
    ...(system ? [`[system]\n${system}`] : []),
    ...rest.map((message) => `[${message.role}]\n${message.content}`),
  ].join('\n\n');
}

function modelOptions(model: string): {
  thinking: boolean;
  search: boolean;
  type: 'default' | 'expert' | 'vision';
} {
  const lower = model.toLowerCase();
  return {
    thinking: lower.includes('reason') || lower.includes('thinking'),
    search: lower.includes('search'),
    type: lower.includes('vision') ? 'vision' : lower.includes('expert') ? 'expert' : 'default',
  };
}

/** DeepSeek SSE 是自定义结构，这里把它归一成文本增量。 */
class DeepSeekAccumulator {
  private channel: 'thinking' | 'content' | null = null;
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
    if (data === '[DONE]') {
      this.done = true;
      return '';
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return '';
    }

    if (parsed.type === 'error' || (typeof parsed.code === 'number' && parsed.msg)) {
      this.error = String(parsed.msg ?? parsed.message ?? 'DeepSeek returned an error');
      return '';
    }

    const path = typeof parsed.p === 'string' ? parsed.p : '';
    const op = typeof parsed.o === 'string' ? parsed.o : '';
    const value = parsed.v;

    if (path === 'response/status') {
      if (value === 'FINISHED') this.done = true;
      return '';
    }
    if (path === 'response/thinking_content') {
      this.channel = 'thinking';
      return '';
    }
    if (path === 'response/content') {
      this.channel = 'content';
      return typeof value === 'string' ? value : '';
    }
    if (path === 'response/fragments') {
      return this.fragments(value);
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const response = (value as Record<string, unknown>).response;
      if (response && typeof response === 'object') {
        const fragments = (response as Record<string, unknown>).fragments;
        if (Array.isArray(fragments)) return this.fragments(fragments);
      }
      return '';
    }
    if (typeof value === 'string') {
      if (this.channel === 'thinking') return '';
      if (this.channel === 'content' || path === '' || op === 'APPEND') {
        this.channel = 'content';
        return value;
      }
    }
    return '';
  }

  private fragments(value: unknown): string {
    if (!Array.isArray(value)) return '';
    let out = '';
    for (const fragment of value) {
      if (!fragment || typeof fragment !== 'object') continue;
      const type = (fragment as Record<string, unknown>).type;
      const content = (fragment as Record<string, unknown>).content;
      if (typeof content !== 'string' || content === '') continue;
      if (type === 'THINK') {
        this.channel = 'thinking';
        continue;
      }
      this.channel = 'content';
      out += content;
    }
    return out;
  }
}

function splitEvents(text: string): string[] {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n\n')
    .filter((event) => event.trim() !== '');
}

function completionFromText(
  text: string,
  model: string
): Record<string, unknown> {
  const accumulator = new DeepSeekAccumulator();
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
    throw new GatewayError(502, 'upstream_error', 'DeepSeek returned empty content', 'api_error');
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

function streamFromDeepSeek(
  input: ReadableStream<Uint8Array>,
  model: string
): ReadableStream<Uint8Array> {
  const reader = input.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const accumulator = new DeepSeekAccumulator();
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
        fail(controller, error instanceof Error ? error.message : 'DeepSeek stream failed');
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

export interface DeepSeekChatOptions {
  base: string;
  token: string;
  chat: ChatRequest;
  fetchImpl: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  sessionId?: string;
}

/** DeepSeek 网页端：session → PoW → SSE。 */
export async function requestDeepSeekChat(options: DeepSeekChatOptions): Promise<Response> {
  if (!options.token) {
    throw new GatewayError(
      503,
      'web_not_configured',
      'DEEPSEEK_TOKEN is not configured',
      'server_error'
    );
  }

  let timedOut = false;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs ?? 300_000);
  const onAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', onAbort, { once: true });

  const base = options.base;
  const headers = dsHeaders(base, options.token);
  const jar = new Map<string, string>();

  const post = async (
    path: string,
    body: unknown,
    extraHeaders: Record<string, string> = {}
  ): Promise<Response> => {
    const cookie = cookieHeader(jar);
    const response = await options.fetchImpl(`${base}${path}`, {
      method: 'POST',
      headers: { ...headers, ...(cookie ? { cookie } : {}), ...extraHeaders },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    absorbCookies(response, jar);
    if (response.status === 401 || response.status === 403) {
      const text = await response.text().catch(() => '');
      throw new GatewayError(
        401,
        'invalid_web_token',
        `DeepSeek rejected the web token${text ? `: ${truncate(stripHtml(text), 200)}` : ''}`,
        'authentication_error'
      );
    }
    if (response.status === 429) {
      throw new GatewayError(
        429,
        'upstream_rate_limited',
        'DeepSeek rate limited this account',
        'rate_limit_error',
        undefined,
        response.headers.get('retry-after')
          ? { 'retry-after': response.headers.get('retry-after') as string }
          : undefined
      );
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new GatewayError(
        502,
        'upstream_error',
        `DeepSeek ${response.status}: ${truncate(stripHtml(text), 300)}`,
        'api_error'
      );
    }
    return response;
  };

  try {
    let sessionId = options.sessionId ?? '';
    if (!sessionId) {
      const sessionResponse = await post('/api/v0/chat_session/create', {});
      const sessionJson = (await sessionResponse.json()) as Record<string, unknown>;
      const data = (sessionJson.data ?? {}) as Record<string, unknown>;
      const biz = (data.biz_data ?? {}) as Record<string, unknown>;
      const session = (biz.chat_session ?? {}) as Record<string, unknown>;
      sessionId = typeof session.id === 'string' ? session.id : '';
      if (!sessionId && typeof biz.chat_session_id === 'string') sessionId = biz.chat_session_id;
      if (!sessionId) {
        throw new GatewayError(502, 'upstream_error', 'DeepSeek did not return a session id', 'api_error');
      }
    }

    const powResponse = await post('/api/v0/chat/create_pow_challenge', {
      target_path: '/api/v0/chat/completion',
    });
    const powJson = (await powResponse.json()) as Record<string, unknown>;
    const powData = (powJson.data ?? {}) as Record<string, unknown>;
    const powBiz = (powData.biz_data ?? {}) as Record<string, unknown>;
    const challenge = (powBiz.challenge ?? {}) as Record<string, unknown>;
    if (!challenge || typeof challenge.challenge !== 'string') {
      throw new GatewayError(502, 'upstream_error', 'DeepSeek did not return a PoW challenge', 'api_error');
    }
    const powToken = await solveDeepSeekPow({
      algorithm: String(challenge.algorithm ?? 'DeepSeekHashV1'),
      challenge: String(challenge.challenge ?? ''),
      salt: String(challenge.salt ?? ''),
      difficulty: Number(challenge.difficulty ?? 0),
      expire_at: Number(challenge.expire_at ?? 0),
      signature: String(challenge.signature ?? ''),
      target_path: String(challenge.target_path ?? '/api/v0/chat/completion'),
    });

    const optionsForModel = modelOptions(options.chat.model);
    const prompt = buildPrompt(options.chat.messages);
    if (!prompt) {
      throw new GatewayError(400, 'invalid_request', 'messages produced an empty prompt', 'invalid_request_error');
    }

    const chatResponse = await post(
      '/api/v0/chat/completion',
      {
        chat_session_id: sessionId,
        parent_message_id: null,
        prompt,
        ref_file_ids: [],
        thinking_enabled: optionsForModel.thinking,
        search_enabled: optionsForModel.search,
        model_type: optionsForModel.type,
        ...(options.chat.max_tokens !== undefined ? { max_tokens: options.chat.max_tokens } : {}),
        ...(options.chat.temperature !== undefined ? { temperature: options.chat.temperature } : {}),
      },
      { 'x-ds-pow-response': powToken }
    );

    const contentType = chatResponse.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      const text = await chatResponse.text();
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = JSON.parse(text) as Record<string, unknown>;
      } catch {
        parsed = null;
      }
      if (parsed && typeof parsed.code === 'number' && parsed.code !== 0) {
        throw new GatewayError(
          502,
          'upstream_error',
          String(parsed.msg ?? parsed.message ?? 'DeepSeek request failed'),
          'api_error'
        );
      }
      throw new GatewayError(502, 'upstream_error', 'DeepSeek returned JSON instead of an SSE stream', 'api_error');
    }

    if (!chatResponse.body) {
      throw new GatewayError(502, 'upstream_error', 'DeepSeek returned an empty stream', 'api_error');
    }

    if (options.chat.stream) {
      return new Response(streamFromDeepSeek(chatResponse.body, options.chat.model), {
        status: 200,
        headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' },
      });
    }

    const text = await chatResponse.text();
    return new Response(JSON.stringify(completionFromText(text, options.chat.model)), {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    if (options.signal?.aborted) {
      throw new GatewayError(499, 'client_closed', 'client closed request', 'api_error');
    }
    if (timedOut) {
      throw new GatewayError(504, 'upstream_timeout', 'DeepSeek request timed out', 'api_error');
    }
    throw new GatewayError(
      502,
      'upstream_error',
      `DeepSeek request failed: ${error instanceof Error ? error.message : String(error)}`,
      'api_error'
    );
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

void publicModelId;
