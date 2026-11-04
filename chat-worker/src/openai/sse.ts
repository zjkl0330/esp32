import { withCors } from './errors.js';
import { randomHex } from '../util.js';

const encoder = new TextEncoder();

export function sseHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return withCors({
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    'x-accel-buffering': 'no',
    ...extra,
  });
}

function rewriteDataLine(line: string, publicModel: string): string {
  const rest = line.slice('data:'.length);
  const value = rest.startsWith(' ') ? rest.slice(1) : rest;
  if (value.trim() === '[DONE]') return 'data: [DONE]';
  if (value.trim() === '') return line;

  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      parsed.model = publicModel;
      return `data: ${JSON.stringify(parsed)}`;
    }
  } catch {
    // 不是 JSON 的 data 行原样保留，不把注释/自定义事件吃掉。
  }
  return line;
}

/** 把一个完整 SSE 事件（不含结尾空行）改写成公开模型名。 */
export function rewriteSseEvent(event: string, publicModel: string): string {
  return event
    .split('\n')
    .map((line) => (line.startsWith('data:') ? rewriteDataLine(line, publicModel) : line))
    .join('\n');
}

/** 纯文本版本，测试和“非流式上游伪装成 SSE”都用它。 */
export function rewriteSseText(text: string, publicModel: string): string {
  const normalized = text.replace(/\r\n/g, '\n');
  const events = normalized.split('\n\n');
  const out: string[] = [];
  for (const event of events) {
    if (!event.trim()) continue;
    out.push(rewriteSseEvent(event, publicModel));
  }
  return out.length ? `${out.join('\n\n')}\n\n` : '';
}

/** 逐块处理上游 SSE，避免等整段生成完再返回。 */
export function rewriteSseStream(
  input: ReadableStream<Uint8Array>,
  publicModel: string
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  let buffer = '';

  return input.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        buffer = buffer.replace(/\r\n/g, '\n');

        let at = buffer.indexOf('\n\n');
        while (at >= 0) {
          const event = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          if (event.trim()) {
            controller.enqueue(encoder.encode(`${rewriteSseEvent(event, publicModel)}\n\n`));
          }
          at = buffer.indexOf('\n\n');
        }
      },
      flush(controller) {
        buffer += decoder.decode();
        buffer = buffer.replace(/\r\n/g, '\n');
        if (buffer.trim()) {
          controller.enqueue(encoder.encode(`${rewriteSseEvent(buffer, publicModel)}\n\n`));
        }
      },
    })
  );
}

export function textToStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string') {
          return (part as { text: string }).text;
        }
        return '';
      })
      .join('');
  }
  return '';
}

function completionMeta(json: Record<string, unknown>, publicModel: string): {
  id: string;
  created: number;
} {
  return {
    id: typeof json.id === 'string' ? json.id : `chatcmpl-${randomHex(12)}`,
    created:
      typeof json.created === 'number' && Number.isFinite(json.created)
        ? json.created
        : Math.floor(Date.now() / 1000),
  };
}

/** 非流式上游 JSON → OpenAI SSE（客户端要 stream 但上游回了整包时用）。 */
export function jsonCompletionToSse(json: Record<string, unknown>, publicModel: string): string {
  const choices = Array.isArray(json.choices) ? json.choices : [];
  const first = (choices[0] ?? {}) as Record<string, unknown>;
  const message = (first.message ?? {}) as Record<string, unknown>;
  const content = extractText(message.content) || extractText(first.text);
  const finish = typeof first.finish_reason === 'string' ? first.finish_reason : 'stop';
  const { id, created } = completionMeta(json, publicModel);

  const chunks: Record<string, unknown>[] = [
    {
      id,
      object: 'chat.completion.chunk',
      created,
      model: publicModel,
      choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }],
    },
    {
      id,
      object: 'chat.completion.chunk',
      created,
      model: publicModel,
      choices: [{ index: 0, delta: {}, finish_reason: finish }],
    },
  ];

  if (json.usage && typeof json.usage === 'object') {
    chunks.push({
      id,
      object: 'chat.completion.chunk',
      created,
      model: publicModel,
      choices: [],
      usage: json.usage,
    });
  }

  return `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`;
}

export function plainTextToSse(text: string, publicModel: string): string {
  return jsonCompletionToSse(
    {
      id: `chatcmpl-${randomHex(12)}`,
      created: Math.floor(Date.now() / 1000),
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    },
    publicModel
  );
}

export function sseErrorText(code: string, message: string): string {
  return `data: ${JSON.stringify({
    error: { message, type: 'server_error', code },
  })}\n\ndata: [DONE]\n\n`;
}

/** 流中途失败时补一帧 error + [DONE]，避免客户端只看到网络中断。 */
export function guardSseStream(
  input: ReadableStream<Uint8Array>,
  message = 'upstream stream failed'
): ReadableStream<Uint8Array> {
  const reader = input.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch {
        controller.enqueue(encoder.encode(sseErrorText('upstream_stream_error', message)));
        controller.close();
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/** 统计回传字节；flush 里回调，调用方用 waitUntil 落库。 */
export function countBytesStream(
  input: ReadableStream<Uint8Array>,
  onDone: (bytes: number) => void
): ReadableStream<Uint8Array> {
  const reader = input.getReader();
  let total = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        onDone(total);
        controller.close();
        return;
      }
      total += value.byteLength;
      controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}
