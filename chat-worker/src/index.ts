import { adminOk, authenticate, resolveKeys } from './auth.js';
import {
  GatewayError,
  asGatewayError,
  errorResponse,
  jsonResponse,
  withCors,
} from './openai/errors.js';
import { parseChatRequest } from './openai/validate.js';
import { countBytesStream, guardSseStream, sseHeaders } from './openai/sse.js';
import {
  buildUpstreamBody,
  kiloBase,
  listKiloModels,
  requestKiloChat,
  responseToSseStream,
  rewriteJsonText,
} from './providers/kilo.js';
import { deepseekBase, listDeepSeekModels, requestDeepSeekChat } from './providers/deepseek.js';
import {
  deepseekSendSms,
  deepseekVerifySms,
  loginLabel,
} from './providers/deepseek-login.js';
import { doubaoBase, listDoubaoModels, requestDoubaoChat } from './providers/doubao.js';
import {
  doubaoLoginLabel,
  doubaoSendSms,
  doubaoVerifySms,
} from './providers/doubao-login.js';
import { chatGptBase, listChatGptModels, requestChatGptChat } from './providers/chatgpt.js';
import { glmBase, listGlmModels, requestGlmChat } from './providers/glm.js';
import { listQwenModels, qwenBase, requestQwenChat } from './providers/qwen.js';
import { createExitFetch } from './exit-client.js';
import { adminPage } from './panel.js';
import { resolveModel } from './router.js';
import { createAccountStore, type AccountStore } from './storage/accounts.js';
import { createCache, type ModelCache } from './storage/cache.js';
import { createStore, type Store } from './storage/store.js';
import type { ApiKeyRecord, Env, KiloModel } from './types.js';
import { dayKey, randomHex, requestId, sha256Hex } from './util.js';

export interface Deps {
  env: Env;
  /** 直连 fetch：Kilo 免费池用 */
  fetch: typeof fetch;
  /** 网页出口 fetch：Qwen / DeepSeek / 豆包走这里 */
  webFetch: typeof fetch;
  store: Store;
  accounts: AccountStore;
  cache: ModelCache;
  now: () => number;
  waitUntil?: (promise: Promise<unknown>) => void;
}

const MAX_CHAT_BODY = 1_048_576; // M1 是 Kilo 直连；网页通道的 16KB 在 M3 单独限
const MAX_ADMIN_BODY = 65_536;
const CATALOG_TTL_MS = 10 * 60 * 1000;

const FALLBACK_MODELS: KiloModel[] = [
  {
    id: 'kilo/kilo-auto/free',
    object: 'model',
    owned_by: 'kilo',
    created: 0,
    upstream: 'kilo-auto/free',
  },
  {
    id: 'kilo/openrouter/free',
    object: 'model',
    owned_by: 'kilo',
    created: 0,
    upstream: 'openrouter/free',
  },
];

function readBytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

async function readJson(request: Request, maxBytes: number): Promise<unknown> {
  const text = await request.text();
  if (readBytes(text) > maxBytes) {
    throw new GatewayError(
      413,
      'body_too_large',
      `request body exceeds ${maxBytes} bytes`,
      'invalid_request_error'
    );
  }
  if (text.trim() === '') {
    throw new GatewayError(400, 'invalid_json', 'request body is empty', 'invalid_request_error');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new GatewayError(400, 'invalid_json', 'request body is not valid JSON', 'invalid_request_error');
  }
}

async function requireKey(request: Request, deps: Deps): Promise<ApiKeyRecord> {
  const keys = await resolveKeys(deps.store, deps.env);
  if (keys.length === 0) {
    // 有记录但全被吊销 → 401；从未配置 → 503。两者对调用方的含义不同。
    if (await deps.store.hasKeys()) {
      throw new GatewayError(401, 'invalid_api_key', 'Invalid API key', 'authentication_error');
    }
    throw new GatewayError(
      503,
      'not_configured',
      'No API keys configured. Set CHAT_API_KEYS or create one via /admin/api/keys.',
      'server_error'
    );
  }
  const key = await authenticate(request, keys);
  if (!key) {
    throw new GatewayError(401, 'invalid_api_key', 'Invalid API key', 'authentication_error');
  }
  return key;
}

async function assertQuota(store: Store, key: ApiKeyRecord, day: string): Promise<void> {
  const usage = await store.getUsage(key.id, day);
  if (key.dayCalls !== null && usage && usage.calls >= key.dayCalls) {
    throw new GatewayError(
      429,
      'quota_exceeded',
      `daily call quota reached (${key.dayCalls})`,
      'rate_limit_error'
    );
  }
  if (key.dayBytes !== null && usage && usage.bytesOut >= key.dayBytes) {
    throw new GatewayError(
      429,
      'quota_exceeded',
      `daily byte quota reached (${key.dayBytes})`,
      'rate_limit_error'
    );
  }
}

interface CatalogResult {
  models: KiloModel[];
  source: 'cache' | 'upstream' | 'stale' | 'fallback';
}

async function getCatalog(deps: Deps): Promise<CatalogResult> {
  const cached = await deps.cache.get();
  if (cached && deps.now() - cached.at < CATALOG_TTL_MS) {
    return { models: cached.models, source: 'cache' };
  }

  try {
    const models = await listKiloModels({
      base: kiloBase(deps.env.KILO_BASE),
      fetchImpl: deps.fetch,
    });
    await deps.cache.put(models);
    return { models, source: 'upstream' };
  } catch {
    if (cached) return { models: cached.models, source: 'stale' };
    return { models: FALLBACK_MODELS, source: 'fallback' };
  }
}

async function accountCredentials(
  deps: Deps,
  provider: 'qwen' | 'deepseek' | 'doubao' | 'glm' | 'chatgpt'
): Promise<Record<string, string> | null> {
  try {
    return (await deps.accounts.getByProvider(provider))?.credentials ?? null;
  } catch {
    return null;
  }
}

async function accountProviders(deps: Deps): Promise<Set<string>> {
  try {
    return new Set((await deps.accounts.list()).map((account) => account.provider));
  } catch {
    return new Set();
  }
}

async function handleModels(request: Request, deps: Deps, rid: string): Promise<Response> {
  await requireKey(request, deps);
  const catalog = await getCatalog(deps);
  const providers = await accountProviders(deps);
  const qwen = deps.env.QWEN_TOKEN || providers.has('qwen')
    ? await listQwenModels({
        base: qwenBase(deps.env.QWEN_BASE),
        fetchImpl: deps.webFetch,
      })
    : [];
  const deepseek = deps.env.DEEPSEEK_TOKEN || providers.has('deepseek') ? listDeepSeekModels() : [];
  const doubao = deps.env.DOUBAO_SESSIONID || providers.has('doubao') ? listDoubaoModels() : [];
  const glm = deps.env.GLM_TOKEN || providers.has('glm') ? listGlmModels() : [];
  const chatgpt =
    deps.env.CHATGPT_ACCESS_TOKEN || providers.has('chatgpt') ? listChatGptModels() : [];

  return jsonResponse(
    {
      object: 'list',
      data: [
        ...catalog.models.map((model) => ({
          id: model.id,
          object: 'model',
          owned_by: model.owned_by,
          created: model.created,
        })),
        ...qwen,
        ...deepseek,
        ...doubao,
        ...glm,
        ...chatgpt,
      ],
    },
    200,
    { 'x-request-id': rid, 'x-catalog-source': catalog.source }
  );
}

async function handleChat(request: Request, deps: Deps, rid: string): Promise<Response> {
  const key = await requireKey(request, deps);
  const day = dayKey(deps.now());
  await assertQuota(deps.store, key, day);

  const raw = await readJson(request, MAX_CHAT_BODY);
  const chat = parseChatRequest(raw);

  // M1 不拉清单：kilo/* 直接透传，裸 id 只放行已知免费路由。
  const resolved = resolveModel(chat.model, null);
  const startedAt = deps.now();
  const upstreamBody = buildUpstreamBody(chat, resolved.upstreamModel);

  await deps.store.incCalls(key.id, day);

  let upstream: Response;
  if (resolved.channel === 'kilo') {
    upstream = await requestKiloChat({
      base: kiloBase(deps.env.KILO_BASE),
      body: upstreamBody,
      stream: chat.stream,
      fetchImpl: deps.fetch,
      signal: request.signal,
    });
  } else if (resolved.channel === 'qwen') {
    const token = deps.env.QWEN_TOKEN || (await accountCredentials(deps, 'qwen'))?.token;
    if (!token) {
      throw new GatewayError(
        503,
        'web_not_configured',
        'QWEN_TOKEN is not configured and no qwen account is stored',
        'server_error'
      );
    }
    upstream = await requestQwenChat({
      base: qwenBase(deps.env.QWEN_BASE),
      token,
      body: upstreamBody,
      stream: chat.stream,
      fetchImpl: deps.webFetch,
      signal: request.signal,
    });
  } else if (resolved.channel === 'deepseek') {
    const credentials = await accountCredentials(deps, 'deepseek');
    const token = deps.env.DEEPSEEK_TOKEN || credentials?.token;
    if (!token) {
      throw new GatewayError(
        503,
        'web_not_configured',
        'DEEPSEEK_TOKEN is not configured and no deepseek account is stored',
        'server_error'
      );
    }
    upstream = await requestDeepSeekChat({
      base: deepseekBase(deps.env.DEEPSEEK_BASE),
      token,
      chat,
      fetchImpl: deps.webFetch,
      signal: request.signal,
      sessionId: deps.env.DEEPSEEK_SESSION_ID || credentials?.sessionId,
      cookie: credentials?.cookie,
    });
  } else if (resolved.channel === 'chatgpt') {
    const credentials = await accountCredentials(deps, 'chatgpt');
    const token = deps.env.CHATGPT_ACCESS_TOKEN || credentials?.token;
    if (!token) {
      throw new GatewayError(
        503,
        'web_not_configured',
        'CHATGPT_ACCESS_TOKEN is not configured and no chatgpt account is stored',
        'server_error'
      );
    }
    upstream = await requestChatGptChat({
      base: chatGptBase(deps.env.CHATGPT_BASE),
      token,
      chat,
      fetchImpl: deps.webFetch,
      signal: request.signal,
      turnstileSolverUrl: deps.env.CHATGPT_TURNSTILE_SOLVER_URL,
      arkoseTokenUrl: deps.env.CHATGPT_ARKOSE_TOKEN_URL,
    });
  } else if (resolved.channel === 'glm') {
    const credentials = await accountCredentials(deps, 'glm');
    const token = deps.env.GLM_TOKEN || credentials?.token;
    if (!token) {
      throw new GatewayError(
        503,
        'web_not_configured',
        'GLM_TOKEN is not configured and no glm account is stored',
        'server_error'
      );
    }
    upstream = await requestGlmChat({
      base: glmBase(deps.env.GLM_BASE),
      token,
      signSecret: deps.env.GLM_SIGN_SECRET,
      chat,
      fetchImpl: deps.webFetch,
      signal: request.signal,
    });
  } else {
    const credentials = await accountCredentials(deps, 'doubao');
    const sessionId = deps.env.DOUBAO_SESSIONID || credentials?.sessionid;
    if (!sessionId) {
      throw new GatewayError(
        503,
        'web_not_configured',
        'DOUBAO_SESSIONID is not configured and no doubao account is stored',
        'server_error'
      );
    }
    upstream = await requestDoubaoChat({
      base: doubaoBase(deps.env.DOUBAO_BASE),
      sessionId,
      cookie: credentials?.cookie,
      chat,
      fetchImpl: deps.webFetch,
      signal: request.signal,
    });
  }

  const headers: Record<string, string> = {
    'x-request-id': rid,
    'x-chat-channel': resolved.channel,
    'x-chat-model': resolved.publicModel,
    'x-upstream-ms': String(deps.now() - startedAt),
  };

  if (chat.stream) {
    const body = await responseToSseStream(upstream, resolved.publicModel);
    const counted = countBytesStream(body, (bytes) => {
      const update = deps.store.addBytes(key.id, day, bytes);
      if (deps.waitUntil) deps.waitUntil(update);
    });
    const guarded = guardSseStream(counted);
    return new Response(guarded, { status: 200, headers: sseHeaders(headers) });
  }

  const text = await rewriteJsonText(upstream, resolved.publicModel);
  const bytes = readBytes(text);
  const update = deps.store.addBytes(key.id, day, bytes);
  if (deps.waitUntil) deps.waitUntil(update);
  else await update;

  return new Response(text, {
    status: upstream.status,
    headers: withCors({
      ...headers,
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    }),
  });
}

async function handleAuth(request: Request, deps: Deps, rid: string): Promise<Response> {
  if (!deps.env.ADMIN_TOKEN) {
    throw new GatewayError(
      503,
      'not_configured',
      'ADMIN_TOKEN is not configured; login endpoints are fail-closed',
      'server_error'
    );
  }
  if (!adminOk(request, deps.env)) {
    throw new GatewayError(401, 'unauthorized', 'admin token rejected', 'authentication_error');
  }

  const path = new URL(request.url).pathname;
  if (path === '/v1/auth/deepseek/sms/send' && request.method === 'POST') {
    const raw = await readJson(request, 65_536);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new GatewayError(400, 'invalid_request', 'body must be a JSON object', 'invalid_request_error');
    }
    const body = raw as Record<string, unknown>;
    const mobile = typeof body.mobile === 'string' ? body.mobile.trim() : '';
    if (!mobile) {
      throw new GatewayError(400, 'invalid_request', 'mobile is required', 'invalid_request_error', 'mobile');
    }
    const result = await deepseekSendSms({
      base: deepseekBase(deps.env.DEEPSEEK_BASE),
      mobile,
      areaCode: typeof body.areaCode === 'string' ? body.areaCode : '+86',
      region: typeof body.region === 'string' ? body.region : 'CN',
      locale: typeof body.locale === 'string' ? body.locale : 'zh_CN',
      deviceId: typeof body.deviceId === 'string' ? body.deviceId : undefined,
      captcha:
        body.captcha && typeof body.captcha === 'object' && !Array.isArray(body.captcha)
          ? (body.captcha as {
              turnstile_token?: string;
              shumei_verification?: unknown;
              hcaptcha_token?: string;
            })
          : undefined,
      fetchImpl: deps.webFetch,
    });
    return jsonResponse(
      { ok: true, provider: 'deepseek', method: 'sms', ...result },
      200,
      { 'x-request-id': rid }
    );
  }

  if (path === '/v1/auth/deepseek/sms/verify' && request.method === 'POST') {
    const raw = await readJson(request, 65_536);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new GatewayError(400, 'invalid_request', 'body must be a JSON object', 'invalid_request_error');
    }
    const body = raw as Record<string, unknown>;
    const mobile = typeof body.mobile === 'string' ? body.mobile.trim() : '';
    const code = typeof body.code === 'string' ? body.code.trim() : '';
    const deviceId = typeof body.deviceId === 'string' ? body.deviceId.trim() : '';
    if (!mobile || !code || !deviceId) {
      throw new GatewayError(
        400,
        'invalid_request',
        'mobile, code and deviceId are required',
        'invalid_request_error'
      );
    }
    const result = await deepseekVerifySms({
      base: deepseekBase(deps.env.DEEPSEEK_BASE),
      mobile,
      code,
      deviceId,
      areaCode: typeof body.areaCode === 'string' ? body.areaCode : '+86',
      region: typeof body.region === 'string' ? body.region : 'CN',
      locale: typeof body.locale === 'string' ? body.locale : 'zh_CN',
      cookie: typeof body.cookie === 'string' ? body.cookie : undefined,
      fetchImpl: deps.webFetch,
    });
    const label =
      typeof body.label === 'string' && body.label.trim() !== ''
        ? body.label.trim()
        : loginLabel(mobile);
    let account;
    try {
      account = await deps.accounts.add('deepseek', label, {
        token: result.token,
        ...(result.userId ? { userId: result.userId } : {}),
        ...(result.cookie ? { cookie: result.cookie } : {}),
      });
    } catch {
      throw new GatewayError(
        503,
        'web_not_configured',
        'account store is not configured (COOKIE_ENC_KEY / DB)',
        'server_error'
      );
    }
    return jsonResponse(
      { ok: true, provider: 'deepseek', method: 'sms', account },
      200,
      { 'x-request-id': rid }
    );
  }

  if (path === '/v1/auth/doubao/sms/send' && request.method === 'POST') {
    const raw = await readJson(request, 65_536);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new GatewayError(400, 'invalid_request', 'body must be a JSON object', 'invalid_request_error');
    }
    const body = raw as Record<string, unknown>;
    const mobile = typeof body.mobile === 'string' ? body.mobile.trim() : '';
    if (!mobile) {
      throw new GatewayError(400, 'invalid_request', 'mobile is required', 'invalid_request_error', 'mobile');
    }
    const result = await doubaoSendSms({
      mobile,
      aid: typeof body.aid === 'string' ? body.aid : deps.env.DOUBAO_AID,
      service: typeof body.service === 'string' ? body.service : deps.env.DOUBAO_SERVICE,
      verifyTicket: typeof body.verifyTicket === 'string' ? body.verifyTicket : undefined,
      cookie: typeof body.cookie === 'string' ? body.cookie : undefined,
      passportBase: deps.env.DOUBAO_PASSPORT_BASE,
      fetchImpl: deps.webFetch,
    });
    return jsonResponse(
      { ok: true, provider: 'doubao', method: 'sms', ...result },
      200,
      { 'x-request-id': rid }
    );
  }

  if (path === '/v1/auth/doubao/sms/verify' && request.method === 'POST') {
    const raw = await readJson(request, 65_536);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new GatewayError(400, 'invalid_request', 'body must be a JSON object', 'invalid_request_error');
    }
    const body = raw as Record<string, unknown>;
    const mobile = typeof body.mobile === 'string' ? body.mobile.trim() : '';
    const code = typeof body.code === 'string' ? body.code.trim() : '';
    if (!mobile || !code) {
      throw new GatewayError(400, 'invalid_request', 'mobile and code are required', 'invalid_request_error');
    }
    const result = await doubaoVerifySms({
      mobile,
      code,
      aid: typeof body.aid === 'string' ? body.aid : deps.env.DOUBAO_AID,
      service: typeof body.service === 'string' ? body.service : deps.env.DOUBAO_SERVICE,
      cookie: typeof body.cookie === 'string' ? body.cookie : undefined,
      passportBase: deps.env.DOUBAO_PASSPORT_BASE,
      fetchImpl: deps.webFetch,
    });
    const label =
      typeof body.label === 'string' && body.label.trim() !== ''
        ? body.label.trim()
        : doubaoLoginLabel(mobile);
    let account;
    try {
      account = await deps.accounts.add('doubao', label, {
        sessionid: result.sessionid,
        cookie: result.cookie,
      });
    } catch {
      throw new GatewayError(
        503,
        'web_not_configured',
        'account store is not configured (COOKIE_ENC_KEY / DB)',
        'server_error'
      );
    }
    return jsonResponse(
      { ok: true, provider: 'doubao', method: 'sms', account },
      200,
      { 'x-request-id': rid }
    );
  }

  throw new GatewayError(404, 'not_found', 'login route not found', 'invalid_request_error');
}

async function handleMe(request: Request, deps: Deps, rid: string): Promise<Response> {
  const key = await requireKey(request, deps);
  const day = dayKey(deps.now());
  const usage = await deps.store.getUsage(key.id, day);
  return jsonResponse(
    {
      object: 'chat.usage',
      key: key.name,
      day,
      calls: usage?.calls ?? 0,
      bytes: usage?.bytesOut ?? 0,
      limits: {
        dayCalls: key.dayCalls,
        dayBytes: key.dayBytes,
      },
      storage: deps.env.DB ? 'd1' : 'memory',
    },
    200,
    { 'x-request-id': rid }
  );
}

interface AdminKeyBody {
  name?: unknown;
  key?: unknown;
  dayCalls?: unknown;
  dayBytes?: unknown;
  hosts?: unknown;
}

function adminKeyView(key: ApiKeyRecord): Record<string, unknown> {
  return {
    name: key.name,
    prefix: key.prefix,
    dayCalls: key.dayCalls,
    dayBytes: key.dayBytes,
    hosts: key.hosts,
    createdAt: key.createdAt,
  };
}

async function handleAdmin(request: Request, deps: Deps, rid: string): Promise<Response> {
  if (!deps.env.ADMIN_TOKEN) {
    throw new GatewayError(
      503,
      'not_configured',
      'ADMIN_TOKEN is not configured; admin API is fail-closed',
      'server_error'
    );
  }
  if (!adminOk(request, deps.env)) {
    throw new GatewayError(401, 'unauthorized', 'admin token rejected', 'authentication_error');
  }

  const url = new URL(request.url);
  const path = url.pathname;

  if (path === '/admin/api/keys' && request.method === 'GET') {
    const keys = await deps.store.listKeys();
    return jsonResponse(
      { object: 'list', data: keys.map(adminKeyView) },
      200,
      { 'x-request-id': rid }
    );
  }

  if (path === '/admin/api/keys' && request.method === 'POST') {
    const raw = await readJson(request, MAX_ADMIN_BODY);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new GatewayError(400, 'invalid_request', 'body must be a JSON object', 'invalid_request_error');
    }
    const body = raw as AdminKeyBody;
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) {
      throw new GatewayError(
        400,
        'bad_name',
        'name must be 1-32 chars of letters/digits/_/-',
        'invalid_request_error',
        'name'
      );
    }

    const plain =
      typeof body.key === 'string' && body.key.trim() !== ''
        ? body.key.trim()
        : `sk-chat_${randomHex(24)}`;
    if (plain.length < 24) {
      throw new GatewayError(400, 'bad_key', 'key must be at least 24 characters', 'invalid_request_error', 'key');
    }

    const dayCalls =
      typeof body.dayCalls === 'number' && Number.isFinite(body.dayCalls) && body.dayCalls > 0
        ? Math.trunc(body.dayCalls)
        : null;
    const dayBytes =
      typeof body.dayBytes === 'number' && Number.isFinite(body.dayBytes) && body.dayBytes > 0
        ? Math.trunc(body.dayBytes)
        : null;
    const hosts = Array.isArray(body.hosts)
      ? body.hosts.filter((host): host is string => typeof host === 'string' && host.trim() !== '')
      : null;

    const record: ApiKeyRecord = {
      id: `k_${randomHex(8)}`,
      name,
      keyHash: await sha256Hex(plain),
      prefix: plain.slice(0, 12),
      dayCalls,
      dayBytes,
      hosts,
      createdAt: deps.now(),
      revokedAt: null,
    };

    // 同一把 key 不能挂在两个名字下，否则「吊销一个」会连带影响另一个。
    const existing = await deps.store.listKeys();
    if (existing.some((item) => item.keyHash === record.keyHash)) {
      throw new GatewayError(
        409,
        'duplicate_key',
        'this key is already bound to another name',
        'invalid_request_error',
        'key'
      );
    }

    try {
      await deps.store.addKey(record);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('duplicate') || message.includes('UNIQUE')) {
        throw new GatewayError(409, 'duplicate_name', `key name already exists: ${name}`, 'invalid_request_error', 'name');
      }
      throw error;
    }

    return jsonResponse(
      {
        ok: true,
        name,
        key: plain,
        prefix: record.prefix,
        note: '这份 key 只显示一次，请现在保存',
      },
      201,
      { 'x-request-id': rid }
    );
  }

  const deleteMatch = path.match(/^\/admin\/api\/keys\/([^/]+)$/);
  if (deleteMatch && request.method === 'DELETE') {
    const name = decodeURIComponent(deleteMatch[1]);
    const revoked = await deps.store.revokeKey(name);
    if (!revoked) {
      throw new GatewayError(404, 'key_not_found', `no active key named ${name}`, 'invalid_request_error');
    }
    return jsonResponse({ ok: true, name, revoked: true }, 200, { 'x-request-id': rid });
  }

  if (path === '/admin/api/accounts' && request.method === 'GET') {
    const accounts = await deps.accounts.list();
    return jsonResponse({ object: 'list', data: accounts }, 200, { 'x-request-id': rid });
  }

  if (path === '/admin/api/accounts' && request.method === 'POST') {
    const raw = await readJson(request, 65_536);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new GatewayError(400, 'invalid_request', 'body must be a JSON object', 'invalid_request_error');
    }
    const body = raw as Record<string, unknown>;
    const provider = typeof body.provider === 'string' ? body.provider : '';
    if (!['qwen', 'deepseek', 'doubao', 'glm', 'chatgpt'].includes(provider)) {
      throw new GatewayError(
        400,
        'bad_provider',
        'provider must be qwen / deepseek / doubao / glm / chatgpt',
        'invalid_request_error',
        'provider'
      );
    }
    const label = typeof body.label === 'string' ? body.label.trim() : '';
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(label)) {
      throw new GatewayError(400, 'bad_label', 'label must be 1-32 chars', 'invalid_request_error', 'label');
    }
    if (!body.credentials || typeof body.credentials !== 'object' || Array.isArray(body.credentials)) {
      throw new GatewayError(400, 'bad_credentials', 'credentials must be an object', 'invalid_request_error');
    }
    const credentials: Record<string, string> = {};
    for (const [key, value] of Object.entries(body.credentials as Record<string, unknown>)) {
      if (typeof value === 'string' && value.trim() !== '') credentials[key] = value.trim();
    }
    if (Object.keys(credentials).length === 0) {
      throw new GatewayError(400, 'bad_credentials', 'credentials is empty', 'invalid_request_error');
    }
    try {
      const account = await deps.accounts.add(
        provider as 'qwen' | 'deepseek' | 'doubao' | 'glm' | 'chatgpt',
        label,
        credentials
      );
      return jsonResponse({ ok: true, account }, 201, { 'x-request-id': rid });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('duplicate') || message.includes('UNIQUE')) {
        throw new GatewayError(409, 'duplicate_account', `account exists: ${provider}/${label}`, 'invalid_request_error');
      }
      throw new GatewayError(
        503,
        'web_not_configured',
        'account store is not configured (COOKIE_ENC_KEY / DB)',
        'server_error'
      );
    }
  }

  const accountDelete = path.match(/^\/admin\/api\/accounts\/([^/]+)$/);
  if (accountDelete && request.method === 'DELETE') {
    const id = decodeURIComponent(accountDelete[1]);
    const removed = await deps.accounts.remove(id);
    if (!removed) {
      throw new GatewayError(404, 'account_not_found', `no account ${id}`, 'invalid_request_error');
    }
    return jsonResponse({ ok: true, id, removed: true }, 200, { 'x-request-id': rid });
  }

  if (path === '/admin/api/egress-check' && request.method === 'GET') {
    if (!deps.env.EXIT || !deps.env.EXIT_CLIENT_KEY) {
      throw new GatewayError(
        503,
        'web_egress_not_configured',
        'EXIT binding and EXIT_CLIENT_KEY are required',
        'server_error'
      );
    }
    const started = Date.now();
    try {
      const response = await deps.webFetch('https://chat.qwen.ai/api/models', { method: 'GET' });
      const ms = Date.now() - started;
      return jsonResponse(
        { ok: response.ok, egress: 'esp32', status: response.status, ms },
        200,
        { 'x-request-id': rid }
      );
    } catch (error) {
      throw new GatewayError(
        502,
        'egress_check_failed',
        `ESP32 egress check failed: ${error instanceof Error ? error.message : String(error)}`,
        'api_error'
      );
    }
  }

  if (path === '/admin/api/status' && request.method === 'GET') {
    const keys = await deps.store.listKeys();
    return jsonResponse(
      {
        ok: true,
        day: dayKey(deps.now()),
        keys: keys.length,
        storage: deps.env.DB ? 'd1' : 'memory',
        kiloBase: kiloBase(deps.env.KILO_BASE),
        webChannel: deps.env.WEB_CHANNEL_ENABLED === '1',
        egress:
          deps.env.EXIT && deps.env.EXIT_CLIENT_KEY
            ? 'esp32'
            : deps.env.WEB_EGRESS_REQUIRED === '1'
              ? 'missing'
              : 'direct',
        opencode: deps.env.OPENCODE_MODE ?? 'off',
      },
      200,
      { 'x-request-id': rid }
    );
  }

  throw new GatewayError(404, 'not_found', 'admin route not found', 'invalid_request_error');
}

export function createHandler(deps: Deps) {
  return async function handler(request: Request): Promise<Response> {
    const rid = requestId();
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: withCors() });
    }

    try {
      if (url.pathname === '/health') {
        return jsonResponse({ ok: true }, 200, { 'x-request-id': rid });
      }

      if (url.pathname.startsWith('/v1/auth/')) {
        return await handleAuth(request, deps, rid);
      }

      if (url.pathname === '/v1/models' && request.method === 'GET') {
        return await handleModels(request, deps, rid);
      }

      if (url.pathname === '/v1/chat/completions' && request.method === 'POST') {
        return await handleChat(request, deps, rid);
      }

      if (url.pathname === '/api/me' && request.method === 'GET') {
        return await handleMe(request, deps, rid);
      }

      if (url.pathname === '/admin' || url.pathname === '/admin/') {
        return new Response(adminPage(), {
          headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
        });
      }

      if (url.pathname.startsWith('/admin/api/')) {
        return await handleAdmin(request, deps, rid);
      }
    } catch (error) {
      return errorResponse(asGatewayError(error), rid);
    }

    return errorResponse(
      new GatewayError(404, 'not_found', `route not found: ${request.method} ${url.pathname}`, 'invalid_request_error'),
      rid
    );
  };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const direct = globalThis.fetch.bind(globalThis) as typeof fetch;
    const webFetch =
      env.EXIT && env.EXIT_CLIENT_KEY
        ? createExitFetch(env.EXIT, env.EXIT_CLIENT_KEY)
        : env.WEB_EGRESS_REQUIRED === '1'
          ? async () =>
              new Response(
                JSON.stringify({
                  error: {
                    code: 'web_egress_not_configured',
                    message: 'web channels require esp32-exit; set EXIT binding and EXIT_CLIENT_KEY',
                    type: 'server_error',
                  },
                }),
                { status: 503, headers: { 'content-type': 'application/json' } }
              )
          : direct;
    const handler = createHandler({
      env,
      fetch: direct,
      webFetch,
      store: createStore(env),
      accounts: createAccountStore(env),
      cache: createCache(env),
      now: () => Date.now(),
      waitUntil: (promise) => ctx.waitUntil(promise),
    });
    return handler(request);
  },
};
