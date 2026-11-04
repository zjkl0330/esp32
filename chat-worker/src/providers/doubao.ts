import { GatewayError } from '../openai/errors.js';
import type { ChatMessage, ChatRequest, ModelInfo } from '../types.js';
import { randomHex, stripHtml, truncate } from '../util.js';

export const DEFAULT_DOUBAO_BASE = 'https://www.doubao.com';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const ASSISTANT_ID = '497858';
const VERSION_CODE = '20800';
const PC_VERSION = '2.44.0';

export function doubaoBase(value: string | undefined): string {
  return (value || DEFAULT_DOUBAO_BASE).replace(/\/+$/, '');
}

export function listDoubaoModels(): ModelInfo[] {
  return [
    {
      id: 'web/doubao/doubao',
      object: 'model',
      owned_by: 'doubao',
      created: 0,
    },
  ];
}

function digits(length: number): string {
  let out = '';
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  for (const byte of bytes) out += String(byte % 10);
  return out;
}

function buildContent(messages: ChatMessage[]): string {
  if (messages.length === 1) return messages[0].content;
  return messages
    .map((message) => `<|im_start|>${message.role}\n${message.content}\n<|im_end|>`)
    .join('\n');
}

function query(): string {
  const deviceId = `7${digits(18)}`;
  const webId = `7${digits(18)}`;
  const params = new URLSearchParams({
    aid: ASSISTANT_ID,
    device_id: deviceId,
    device_platform: 'web',
    language: 'zh',
    pc_version: PC_VERSION,
    pkg_type: 'release_version',
    real_aid: ASSISTANT_ID,
    region: 'CN',
    samantha_web: '1',
    sys_region: 'CN',
    tea_uuid: webId,
    'use-olympus-account': '1',
    version_code: VERSION_CODE,
    web_id: webId,
    web_tab_id: crypto.randomUUID(),
  });
  return params.toString();
}

function requestBody(chat: ChatRequest): Record<string, unknown> {
  return {
    messages: buildContent(chat.messages),
    completion_option: {
      is_regen: false,
      with_suggest: true,
      need_create_conversation: true,
      launch_stage: 1,
      is_replace: false,
      is_delete: false,
      message_from: 0,
      action_bar_skill_id: 0,
      use_deep_think: false,
      use_auto_cot: false,
      resend_for_regen: false,
      enable_commerce_credit: false,
      event_id: '0',
    },
    evaluate_option: { web_ab_params: '' },
    section_id: `26${digits(16)}`,
    conversation_id: '0',
    local_conversation_id: `local_16${digits(14)}`,
    local_message_id: crypto.randomUUID(),
  };
}

class DoubaoAccumulator {
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
      this.error = String(parsed.message ?? parsed.msg ?? `Doubao error ${parsed.code}`);
      return '';
    }
    if (parsed.event_type === 2003) {
      this.done = true;
      return '';
    }
    if (parsed.event_type !== 2001) return '';

    let eventData: Record<string, unknown>;
    try {
      eventData = JSON.parse(String(parsed.event_data ?? '')) as Record<string, unknown>;
    } catch {
      return '';
    }
    if (eventData.is_finish === true) {
      this.done = true;
      return '';
    }

    const message = (eventData.message ?? {}) as Record<string, unknown>;
    if (message.content_type === 2074) return '';
    const content = message.content;
    if (typeof content !== 'string' || content === '') return '';

    try {
      const inner = JSON.parse(content) as unknown;
      if (typeof inner === 'string') return inner;
      if (inner && typeof inner === 'object') {
        const record = inner as Record<string, unknown>;
        if (typeof record.text === 'string') return record.text;
        if (record.delta && typeof record.delta === 'object') {
          const delta = record.delta as Record<string, unknown>;
          if (typeof delta.text === 'string') return delta.text;
        }
        if (typeof record.content === 'string') return record.content;
      }
    } catch {
      // 不是 JSON，按纯文本处理
    }
    return content;
  }
}

function splitEvents(text: string): string[] {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n\n')
    .filter((event) => event.trim() !== '');
}

function completionFromText(text: string, model: string): Record<string, unknown> {
  const accumulator = new DoubaoAccumulator();
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
    throw new GatewayError(502, 'upstream_error', 'Doubao returned empty content', 'api_error');
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

function streamFromDoubao(input: ReadableStream<Uint8Array>, model: string): ReadableStream<Uint8Array> {
  const reader = input.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const accumulator = new DoubaoAccumulator();
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
        fail(controller, error instanceof Error ? error.message : 'Doubao stream failed');
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

export interface DoubaoChatOptions {
  base: string;
  sessionId: string;
  chat: ChatRequest;
  fetchImpl: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export async function requestDoubaoChat(options: DoubaoChatOptions): Promise<Response> {
  if (!options.sessionId) {
    throw new GatewayError(
      503,
      'web_not_configured',
      'DOUBAO_SESSIONID is not configured',
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

  try {
    const sessionId = options.sessionId;
    const response = await options.fetchImpl(
      `${options.base}/samantha/chat/completion?${query()}`,
      {
        method: 'POST',
        headers: {
          accept: 'text/event-stream',
          'content-type': 'application/json',
          origin: options.base,
          referer: `${options.base}/chat/`,
          'user-agent': UA,
          'accept-language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
          'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
          'sec-ch-ua-mobile': '?0',
          'sec-ch-ua-platform': '"Windows"',
          'sec-fetch-dest': 'empty',
          'sec-fetch-mode': 'cors',
          'sec-fetch-site': 'same-origin',
          cookie: `sessionid=${sessionId}; sessionid_ss=${sessionId}`,
          'x-flow-trace': `04-${crypto.randomUUID()}-${randomHex(8)}-01`,
          'agw-js-conv': 'str, str',
        },
        body: JSON.stringify(requestBody(options.chat)),
        signal: controller.signal,
      }
    );

    if (response.status === 401 || response.status === 403) {
      throw new GatewayError(
        401,
        'invalid_web_token',
        'Doubao rejected the sessionid',
        'authentication_error'
      );
    }
    if (response.status === 429) {
      throw new GatewayError(
        429,
        'upstream_rate_limited',
        'Doubao rate limited this account',
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
        `Doubao ${response.status}: ${truncate(stripHtml(text), 300)}`,
        'api_error'
      );
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('text/event-stream')) {
      const text = await response.text().catch(() => '');
      throw new GatewayError(
        502,
        'upstream_error',
        `Doubao returned ${contentType || 'unknown content-type'}: ${truncate(stripHtml(text), 200)}`,
        'api_error'
      );
    }
    if (!response.body) {
      throw new GatewayError(502, 'upstream_error', 'Doubao returned an empty stream', 'api_error');
    }

    if (options.chat.stream) {
      return new Response(streamFromDoubao(response.body, options.chat.model), {
        status: 200,
        headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' },
      });
    }

    const text = await response.text();
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
      throw new GatewayError(504, 'upstream_timeout', 'Doubao request timed out', 'api_error');
    }
    throw new GatewayError(
      502,
      'upstream_error',
      `Doubao request failed: ${error instanceof Error ? error.message : String(error)}`,
      'api_error'
    );
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}
