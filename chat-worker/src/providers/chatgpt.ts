import { sha3_512 } from 'js-sha3';
import { GatewayError } from '../openai/errors.js';
import type { ChatMessage, ChatRequest, ModelInfo } from '../types.js';
import { randomHex, stripHtml, truncate } from '../util.js';

export const DEFAULT_CHATGPT_BASE = 'https://chatgpt.com';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0';

const NAVIGATOR_KEYS = [
  'webdriver−false',
  'vendor−Google Inc.',
  'hardwareConcurrency−32',
  'language−zh-CN',
  'cookieEnabled−true',
];
const DOCUMENT_KEYS = ['location'];
const WINDOW_KEYS = ['window', 'document', 'name', 'location', 'navigator', 'origin', 'crypto'];

let cachedScripts: string[] = [];
let cachedDpl = '';
let cachedAt = 0;

export function chatGptBase(value: string | undefined): string {
  return (value || DEFAULT_CHATGPT_BASE).replace(/\/+$/, '');
}

export function listChatGptModels(): ModelInfo[] {
  return ['gpt-4o', 'gpt-4o-mini', 'gpt-4', 'o3', 'o1', 'gpt-3.5-turbo'].map((id) => ({
    id: `web/chatgpt/${id}`,
    object: 'model' as const,
    owned_by: 'chatgpt',
    created: 0,
  }));
}

function uuid(): string {
  return crypto.randomUUID();
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function parseTime(): string {
  const date = new Date();
  const parts = date.toUTCString().split(' ');
  // "Fri, 06 Nov 2026 15:00:00 GMT" → "Fri Nov 06 2026 15:00:00 GMT-0500 (Eastern Standard Time)"
  const weekday = parts[0]?.replace(',', '') ?? 'Fri';
  const day = parts[1] ?? '06';
  const month = parts[2] ?? 'Nov';
  const year = parts[3] ?? '2026';
  const time = parts[4] ?? '00:00:00';
  return `${weekday} ${month} ${day} ${year} ${time} GMT-0500 (Eastern Standard Time)`;
}

function buildConfig(userAgent: string): unknown[] {
  return [
    randomInt(1, 2) === 1 ? 3000 : 4000,
    parseTime(),
    4294705152,
    0,
    userAgent,
    cachedScripts.length > 0 ? cachedScripts[Math.floor(Math.random() * cachedScripts.length)] : '',
    cachedDpl,
    'en-US',
    'en-US,es-US,en,es',
    0,
    NAVIGATOR_KEYS[Math.floor(Math.random() * NAVIGATOR_KEYS.length)],
    DOCUMENT_KEYS[Math.floor(Math.random() * DOCUMENT_KEYS.length)],
    WINDOW_KEYS[Math.floor(Math.random() * WINDOW_KEYS.length)],
    performance.now() * 1000,
    uuid(),
    '',
    8,
    Date.now() - performance.now() * 1000,
  ];
}

function solvePoW(seed: string, diff: string, config: unknown[]): { answer: string; solved: boolean } {
  const static1 = `${JSON.stringify(config.slice(0, 3)).slice(0, -1)},`;
  const static2 = `,${JSON.stringify(config.slice(4, 9)).slice(1, -1)},`;
  const static3 = `,${JSON.stringify(config.slice(10)).slice(1)}`;
  const seedBytes = new TextEncoder().encode(seed);
  const target = hexToBytes(diff);
  const encoder = new TextEncoder();

  for (let i = 0; i < 500_000; i += 1) {
    const json = encoder.encode(`${static1}${i}${static2}${i >> 1}${static3}`);
    const base64 = bytesToBase64(json);
    const hash = sha3_512(seedBytes.length + base64.length ? `${seed}${base64}` : seed);
    const hashBytes = hexToBytes(hash);
    let ok = true;
    for (let j = 0; j < target.length; j += 1) {
      if (hashBytes[j] < target[j]) break;
      if (hashBytes[j] > target[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return { answer: base64, solved: true };
  }
  return {
    answer: `wQ8Lk5FbGpA2NcR9dShT6gYjU7VxZ4D${bytesToBase64(new TextEncoder().encode(`"${seed}"`))}`,
    solved: false,
  };
}

/** 供测试对照 chat2api 的 proofofWork.py 参考解 */
export function solveChatGptPoW(
  seed: string,
  diff: string,
  config: unknown[]
): { answer: string; solved: boolean } {
  return solvePoW(seed, diff, config);
}

function requirementsToken(config: unknown[]): string {
  const result = solvePoW(String(Math.random()), '0fffff', config);
  return `gAAAAAC${result.answer}`;
}

function answerToken(seed: string, diff: string, config: unknown[]): { token: string; solved: boolean } {
  const result = solvePoW(seed, diff, config);
  return { token: `gAAAAAB${result.answer}`, solved: result.solved };
}

async function bootstrap(base: string, fetchImpl: typeof fetch, signal?: AbortSignal): Promise<void> {
  if (Date.now() - cachedAt < 15 * 60 * 1000 && cachedScripts.length > 0) return;
  cachedScripts = [];
  cachedDpl = '';
  cachedAt = Date.now();
  try {
    const response = await fetchImpl(`${base}/`, {
      headers: { 'user-agent': UA, accept: 'text/html' },
      signal,
    });
    if (!response.ok) return;
    const html = await response.text();
    for (const match of html.matchAll(/<script[^>]+src="([^"]+)"/g)) {
      cachedScripts.push(match[1]);
    }
    const dpl = html.match(/<html[^>]*data-build="([^"]+)"/);
    if (dpl) cachedDpl = dpl[1];
  } catch {
    // 拿不到首页也让 sentinel 先试一次；拿不到 dpl 时 config 里为空
  }
  if (cachedScripts.length === 0) {
    cachedScripts.push('https://chatgpt.com/backend-api/sentinel/sdk.js');
  }
}

function headers(base: string, token: string): Record<string, string> {
  return {
    accept: '*/*',
    'accept-language': 'en-US,en;q=0.9',
    'content-type': 'application/json',
    'oai-language': 'en-US',
    origin: base,
    referer: `${base}/`,
    'user-agent': UA,
    'sec-ch-ua': '"Microsoft Edge";v="130", "Chromium";v="130", "Not?A_Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    authorization: `Bearer ${token}`,
  };
}

interface SentinelResponse {
  token?: string;
  persona?: string;
  proofofwork?: { required?: boolean; seed?: string; difficulty?: string };
  turnstile?: { required?: boolean; dx?: string };
  arkose?: { required?: boolean; dx?: string };
}

function mapModel(model: string): string {
  if (model.includes('gpt-4o-mini')) return 'gpt-4o-mini';
  if (model.includes('gpt-4o')) return 'gpt-4o';
  if (model.includes('o3-mini-high')) return 'o3-mini-high';
  if (model.includes('o3-mini')) return 'o3-mini';
  if (model.includes('o3')) return 'o3';
  if (model.includes('o1')) return 'o1';
  if (model.includes('gpt-4')) return 'gpt-4';
  if (model.includes('gpt-3.5')) return 'text-davinci-002-render-sha';
  return 'gpt-4o';
}

class ChatGptAccumulator {
  private lastLength = 0;
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
    if (parsed.type === 'error') {
      this.error = String((parsed.error as Record<string, unknown>)?.message ?? 'ChatGPT stream error');
      return '';
    }
    const message = (parsed.message ?? {}) as Record<string, unknown>;
    if (!message || Object.keys(message).length === 0) return '';
    const author = (message.author ?? {}) as Record<string, unknown>;
    if (author.role === 'user' || author.role === 'system') return '';
    const content = (message.content ?? {}) as Record<string, unknown>;
    const parts = Array.isArray(content.parts) ? content.parts : [];
    const text = parts.filter((part): part is string => typeof part === 'string').join('');
    if (message.status === 'finished_successfully') this.done = true;
    const delta = text.length >= this.lastLength ? text.slice(this.lastLength) : '';
    this.lastLength = Math.max(this.lastLength, text.length);
    return delta;
  }
}

function parseSse(text: string, model: string): { content: string; error: string | null } {
  const accumulator = new ChatGptAccumulator();
  let content = '';
  for (const event of text.replace(/\r\n/g, '\n').split('\n\n')) {
    if (!event.trim()) continue;
    const delta = accumulator.handle(event);
    if (delta) content += delta;
    if (accumulator.error) return { content, error: accumulator.error };
    if (accumulator.done) break;
  }
  return { content, error: accumulator.error };
}

function streamFromChatGpt(input: ReadableStream<Uint8Array>, model: string): ReadableStream<Uint8Array> {
  const reader = input.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const accumulator = new ChatGptAccumulator();
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
              const delta = accumulator.handle(buffer);
              if (delta) {
                emitRole(controller);
                emit(controller, { ...base, choices: [{ index: 0, delta: { content: delta }, finish_reason: null }] });
              }
            }
            finish(controller);
            return;
          }
          buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
          let at = buffer.indexOf('\n\n');
          while (at >= 0) {
            const event = buffer.slice(0, at);
            buffer = buffer.slice(at + 2);
            const delta = accumulator.handle(event);
            if (accumulator.error) {
              fail(controller, accumulator.error);
              return;
            }
            if (delta) {
              emitRole(controller);
              emit(controller, { ...base, choices: [{ index: 0, delta: { content: delta }, finish_reason: null }] });
            }
            if (accumulator.done) {
              finish(controller);
              return;
            }
            at = buffer.indexOf('\n\n');
          }
        }
      } catch (error) {
        fail(controller, error instanceof Error ? error.message : 'ChatGPT stream failed');
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

export interface ChatGptOptions {
  base: string;
  token: string;
  chat: ChatRequest;
  fetchImpl: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  turnstileSolverUrl?: string;
  arkoseTokenUrl?: string;
}

export async function requestChatGptChat(options: ChatGptOptions): Promise<Response> {
  if (!options.token) {
    throw new GatewayError(503, 'web_not_configured', 'CHATGPT_ACCESS_TOKEN is not configured', 'server_error');
  }

  const base = options.base;
  let timedOut = false;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs ?? 300_000);
  const onAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    await bootstrap(base, options.fetchImpl, controller.signal);
    const config = buildConfig(UA);
    const p = requirementsToken(config);
    const requirements = await options.fetchImpl(`${base}/backend-api/sentinel/chat-requirements`, {
      method: 'POST',
      headers: headers(base, options.token),
      body: JSON.stringify({ p }),
      signal: controller.signal,
    });

    if (requirements.status === 401 || requirements.status === 403) {
      const text = await requirements.text().catch(() => '');
      throw new GatewayError(
        403,
        'provider_blocked',
        text.includes('cf_chl_opt')
          ? 'ChatGPT returned cf_chl_opt (Cloudflare challenge)'
          : `ChatGPT sentinel rejected: ${truncate(stripHtml(text), 200)}`,
        'api_error'
      );
    }
    if (requirements.status === 429) {
      throw new GatewayError(429, 'upstream_rate_limited', 'ChatGPT rate limited this account', 'rate_limit_error');
    }
    if (!requirements.ok) {
      const text = await requirements.text().catch(() => '');
      throw new GatewayError(
        502,
        'upstream_error',
        `ChatGPT sentinel ${requirements.status}: ${truncate(stripHtml(text), 200)}`,
        'api_error'
      );
    }

    const sentinel = (await requirements.json()) as SentinelResponse;
    if (!sentinel.token) {
      throw new GatewayError(502, 'upstream_error', 'ChatGPT sentinel returned no token', 'api_error');
    }

    let proofToken: string | undefined;
    if (sentinel.proofofwork?.required) {
      if (!sentinel.proofofwork.seed || !sentinel.proofofwork.difficulty) {
        throw new GatewayError(502, 'upstream_error', 'ChatGPT proofofwork is incomplete', 'api_error');
      }
      const solved = answerToken(sentinel.proofofwork.seed, sentinel.proofofwork.difficulty, config);
      if (!solved.solved) {
        throw new GatewayError(403, 'provider_blocked', 'Failed to solve ChatGPT proof of work', 'api_error');
      }
      proofToken = solved.token;
    }

    let turnstileToken: string | undefined;
    if (sentinel.turnstile?.required) {
      if (!options.turnstileSolverUrl) {
        throw new GatewayError(
          403,
          'provider_blocked',
          'ChatGPT requires turnstile; set CHATGPT_TURNSTILE_SOLVER_URL',
          'api_error'
        );
      }
      const response = await options.fetchImpl(options.turnstileSolverUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: base, p, dx: sentinel.turnstile.dx, ua: UA }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new GatewayError(403, 'provider_blocked', 'Turnstile solver failed', 'api_error');
      }
      const solved = (await response.json()) as { t?: string };
      if (!solved.t) throw new GatewayError(403, 'provider_blocked', 'Turnstile solver returned no token', 'api_error');
      turnstileToken = solved.t;
    }

    let arkoseToken: string | undefined;
    if (sentinel.arkose?.required) {
      if (!options.arkoseTokenUrl) {
        throw new GatewayError(
          403,
          'provider_blocked',
          'ChatGPT requires arkose; set CHATGPT_ARKOSE_TOKEN_URL',
          'api_error'
        );
      }
      const method = sentinel.persona === 'chatgpt-freeaccount' ? 'chat35' : 'chat4';
      const response = await options.fetchImpl(options.arkoseTokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ blob: sentinel.arkose.dx, method }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new GatewayError(403, 'provider_blocked', 'Arkose solver failed', 'api_error');
      }
      const solved = (await response.json()) as { token?: string; solved?: boolean };
      if (solved.solved === false || !solved.token) {
        throw new GatewayError(403, 'provider_blocked', 'Arkose solver returned no token', 'api_error');
      }
      arkoseToken = solved.token;
    }

    const upstreamModel = mapModel(options.chat.model);
    const chatHeaders: Record<string, string> = {
      ...headers(base, options.token),
      accept: 'text/event-stream',
      'openai-sentinel-chat-requirements-token': sentinel.token,
      ...(proofToken ? { 'openai-sentinel-proof-token': proofToken } : {}),
      ...(turnstileToken ? { 'openai-sentinel-turnstile-token': turnstileToken } : {}),
      ...(arkoseToken ? { 'openai-sentinel-arkose-token': arkoseToken } : {}),
    };

    const messages = options.chat.messages.map((message: ChatMessage) => ({
      id: uuid(),
      author: { role: message.role },
      content: { content_type: 'text', parts: [message.content] },
      metadata: {},
    }));

    const body = {
      action: 'next',
      client_contextual_info: {
        is_dark_mode: false,
        time_since_loaded: randomInt(50, 500),
        page_height: randomInt(500, 1000),
        page_width: randomInt(1000, 2000),
        pixel_ratio: 1.5,
        screen_height: randomInt(800, 1200),
        screen_width: randomInt(1200, 2200),
      },
      conversation_mode: { kind: 'primary_assistant' },
      conversation_origin: null,
      force_paragen: false,
      force_paragen_model_slug: '',
      force_rate_limit: false,
      force_use_sse: true,
      history_and_training_disabled: true,
      messages,
      model: upstreamModel,
      paragen_cot_summary_display_override: 'allow',
      paragen_stream_type_override: null,
      parent_message_id: uuid(),
      reset_rate_limits: false,
      suggestions: [],
      supported_encodings: [],
      system_hints: [],
      timezone: 'America/Los_Angeles',
      timezone_offset_min: -480,
      variant_purpose: 'comparison_implicit',
      websocket_request_id: uuid(),
    };

    const conversation = await options.fetchImpl(`${base}/backend-api/conversation`, {
      method: 'POST',
      headers: chatHeaders,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (conversation.status === 401 || conversation.status === 403) {
      const text = await conversation.text().catch(() => '');
      throw new GatewayError(
        403,
        'provider_blocked',
        text.includes('cf_chl_opt')
          ? 'ChatGPT returned cf_chl_opt (Cloudflare challenge)'
          : `ChatGPT conversation rejected: ${truncate(stripHtml(text), 200)}`,
        'api_error'
      );
    }
    if (conversation.status === 429) {
      throw new GatewayError(429, 'upstream_rate_limited', 'ChatGPT rate limited this account', 'rate_limit_error');
    }
    if (!conversation.ok) {
      const text = await conversation.text().catch(() => '');
      throw new GatewayError(
        502,
        'upstream_error',
        `ChatGPT conversation ${conversation.status}: ${truncate(stripHtml(text), 200)}`,
        'api_error'
      );
    }

    const contentType = conversation.headers.get('content-type') ?? '';
    if (!contentType.includes('text/event-stream') || !conversation.body) {
      const text = await conversation.text().catch(() => '');
      throw new GatewayError(
        502,
        'upstream_error',
        `ChatGPT returned ${contentType || 'unknown'}: ${truncate(stripHtml(text), 200)}`,
        'api_error'
      );
    }

    if (options.chat.stream) {
      return new Response(streamFromChatGpt(conversation.body, options.chat.model), {
        status: 200,
        headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' },
      });
    }

    const text = await conversation.text();
    const parsed = parseSse(text, options.chat.model);
    if (parsed.error) {
      throw new GatewayError(502, 'upstream_error', parsed.error, 'api_error');
    }
    if (!parsed.content) {
      throw new GatewayError(
        403,
        'provider_blocked',
        'ChatGPT returned no content (unusual activity or sentinel rejected)',
        'api_error'
      );
    }
    return new Response(
      JSON.stringify({
        id: `chatcmpl-${randomHex(12)}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: options.chat.model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: parsed.content },
            logprobs: null,
            finish_reason: 'stop',
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } }
    );
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    if (options.signal?.aborted) {
      throw new GatewayError(499, 'client_closed', 'client closed request', 'api_error');
    }
    if (timedOut) {
      throw new GatewayError(504, 'upstream_timeout', 'ChatGPT request timed out', 'api_error');
    }
    throw new GatewayError(
      502,
      'upstream_error',
      `ChatGPT request failed: ${error instanceof Error ? error.message : String(error)}`,
      'api_error'
    );
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}
