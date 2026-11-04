import { GatewayError } from './errors.js';
import type { ChatMessage, ChatRequest, ChatRole } from '../types.js';

function bad(message: string, code = 'invalid_request', param?: string): never {
  throw new GatewayError(400, code, message, 'invalid_request_error', param);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeRole(value: unknown, index: number): ChatRole {
  if (value === 'system' || value === 'developer') return 'system';
  if (value === 'user' || value === 'assistant') return value;
  return bad(`messages[${index}].role must be system/user/assistant`, 'invalid_request', `messages[${index}].role`);
}

function normalizeContent(value: unknown, index: number): string {
  if (typeof value === 'string') return value;
  // 各家的多模态 content 数组在 M1 明确不支持，避免把图片当文本转发。
  if (Array.isArray(value)) {
    bad(
      `messages[${index}].content arrays (multimodal) are not supported in M1`,
      'unsupported_parameter',
      `messages[${index}].content`
    );
  }
  return bad(`messages[${index}].content must be a string`, 'invalid_request', `messages[${index}].content`);
}

export function parseChatRequest(raw: unknown): ChatRequest {
  if (!isRecord(raw)) bad('request body must be a JSON object');

  if (raw.tools !== undefined && Array.isArray(raw.tools) && raw.tools.length > 0) {
    bad('tools/function calling is not supported in M1', 'unsupported_parameter', 'tools');
  }
  if (raw.functions !== undefined) {
    bad('functions is not supported in M1', 'unsupported_parameter', 'functions');
  }
  if (raw.n !== undefined && Number(raw.n) !== 1) {
    bad('n must be 1', 'unsupported_parameter', 'n');
  }
  if (raw.modalities !== undefined || raw.audio !== undefined) {
    bad('audio/modalities are not supported in M1', 'unsupported_parameter');
  }
  if (raw.logprobs === true || raw.top_logprobs !== undefined) {
    bad('logprobs are not supported in M1', 'unsupported_parameter');
  }

  const model = raw.model;
  if (typeof model !== 'string' || model.trim() === '') {
    bad('model is required', 'invalid_request', 'model');
  }

  if (!Array.isArray(raw.messages) || raw.messages.length === 0) {
    bad('messages must be a non-empty array', 'invalid_request', 'messages');
  }

  const messages: ChatMessage[] = raw.messages.map((item, index) => {
    if (!isRecord(item)) bad(`messages[${index}] must be an object`, 'invalid_request', `messages[${index}]`);
    return {
      role: normalizeRole(item.role, index),
      content: normalizeContent(item.content, index),
    };
  });

  const stream = raw.stream === true;

  let temperature: number | undefined;
  if (raw.temperature !== undefined) {
    const value = Number(raw.temperature);
    if (!Number.isFinite(value) || value < 0 || value > 2) {
      bad('temperature must be a number between 0 and 2', 'invalid_request', 'temperature');
    }
    temperature = value;
  }

  const rawMax = raw.max_tokens ?? raw.max_completion_tokens;
  let maxTokens: number | undefined;
  if (rawMax !== undefined) {
    const value = Number(rawMax);
    if (!Number.isInteger(value) || value < 1) {
      bad('max_tokens must be a positive integer', 'invalid_request', 'max_tokens');
    }
    // 网页通道后面会单独限；这里先给一个统一上限，防止一次请求把上游打爆。
    if (value > 4096) {
      bad('max_tokens must be <= 4096 in M1', 'invalid_request', 'max_tokens');
    }
    maxTokens = value;
  }

  let stop: string | string[] | undefined;
  if (raw.stop !== undefined) {
    if (typeof raw.stop === 'string') {
      stop = raw.stop.slice(0, 64);
    } else if (Array.isArray(raw.stop)) {
      if (raw.stop.length > 4) bad('stop supports at most 4 sequences', 'invalid_request', 'stop');
      stop = raw.stop.map((item) => {
        if (typeof item !== 'string') bad('stop entries must be strings', 'invalid_request', 'stop');
        return item.slice(0, 64);
      });
    } else {
      bad('stop must be a string or an array of strings', 'invalid_request', 'stop');
    }
  }

  let streamOptions: { include_usage?: boolean } | undefined;
  if (raw.stream_options !== undefined) {
    if (!isRecord(raw.stream_options)) {
      bad('stream_options must be an object', 'invalid_request', 'stream_options');
    }
    streamOptions = { include_usage: raw.stream_options.include_usage === true };
    if (!stream) bad('stream_options requires stream=true', 'invalid_request', 'stream_options');
  }

  return {
    model: model.trim(),
    messages,
    stream,
    ...(temperature !== undefined ? { temperature } : {}),
    ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
    ...(stop !== undefined ? { stop } : {}),
    ...(streamOptions !== undefined ? { stream_options: streamOptions } : {}),
  };
}
