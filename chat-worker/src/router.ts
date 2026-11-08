import { GatewayError } from './openai/errors.js';
import { publicModelId } from './providers/kilo.js';
import type { KiloModel } from './types.js';

export interface ResolvedModel {
  channel: 'kilo' | 'qwen' | 'deepseek' | 'doubao' | 'glm' | 'chatgpt';
  upstreamModel: string;
  publicModel: string;
}

const DEFAULT_FREE_IDS = new Set(['kilo-auto/free', 'openrouter/free']);

/**
 * 模型前缀路由：
 *   kilo/*  → Kilo 免费池
 *   web/*   → 网页账号通道（M1 未启用）
 *   ofm/*   → OpenCode（v2）
 * 也接受裸 Kilo id（如 kilo-auto/free），但只限清单里出现过的 id。
 */
export function resolveModel(model: string, catalog: KiloModel[] | null): ResolvedModel {
  const value = model.trim();

  if (value.startsWith('kilo/')) {
    const upstream = value.slice('kilo/'.length).trim();
    if (upstream === '') {
      throw new GatewayError(400, 'invalid_request', 'model id after kilo/ is empty', 'invalid_request_error', 'model');
    }
    return { channel: 'kilo', upstreamModel: upstream, publicModel: publicModelId(upstream) };
  }

  if (value.startsWith('web/qwen/')) {
    const upstream = value.slice('web/qwen/'.length).trim();
    if (upstream === '') {
      throw new GatewayError(400, 'invalid_request', 'model id after web/qwen/ is empty', 'invalid_request_error', 'model');
    }
    return { channel: 'qwen', upstreamModel: upstream, publicModel: value };
  }

  if (value.startsWith('web/deepseek/')) {
    const upstream = value.slice('web/deepseek/'.length).trim();
    if (upstream === '') {
      throw new GatewayError(400, 'invalid_request', 'model id after web/deepseek/ is empty', 'invalid_request_error', 'model');
    }
    return { channel: 'deepseek', upstreamModel: upstream, publicModel: value };
  }

  if (value.startsWith('web/doubao/')) {
    const upstream = value.slice('web/doubao/'.length).trim();
    if (upstream === '') {
      throw new GatewayError(400, 'invalid_request', 'model id after web/doubao/ is empty', 'invalid_request_error', 'model');
    }
    return { channel: 'doubao', upstreamModel: upstream, publicModel: value };
  }

  if (value.startsWith('web/chatgpt/')) {
    const upstream = value.slice('web/chatgpt/'.length).trim();
    if (upstream === '') {
      throw new GatewayError(400, 'invalid_request', 'model id after web/chatgpt/ is empty', 'invalid_request_error', 'model');
    }
    return { channel: 'chatgpt', upstreamModel: upstream, publicModel: value };
  }

  if (value.startsWith('web/glm/')) {
    const upstream = value.slice('web/glm/'.length).trim();
    if (upstream === '') {
      throw new GatewayError(400, 'invalid_request', 'model id after web/glm/ is empty', 'invalid_request_error', 'model');
    }
    return { channel: 'glm', upstreamModel: upstream, publicModel: value };
  }

  if (value.startsWith('web/')) {
    throw new GatewayError(
      404,
      'model_not_found',
      'this web channel is not enabled yet; currently available: web/qwen/*, web/deepseek/*, web/doubao/*, web/glm/*, web/chatgpt/*',
      'invalid_request_error',
      'model'
    );
  }

  if (value.startsWith('ofm/')) {
    throw new GatewayError(
      404,
      'model_not_found',
      'OpenCode channel is disabled; see design section 4.3',
      'invalid_request_error',
      'model'
    );
  }

  const known = catalog?.some((item) => item.upstream === value) ?? false;
  if (known || DEFAULT_FREE_IDS.has(value)) {
    return { channel: 'kilo', upstreamModel: value, publicModel: publicModelId(value) };
  }

  throw new GatewayError(
    404,
    'model_not_found',
    `unknown model: ${value}; use kilo/<model-id> or GET /v1/models`,
    'invalid_request_error',
    'model'
  );
}
