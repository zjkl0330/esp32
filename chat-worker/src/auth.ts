import type { ApiKeyRecord, Env } from './types.js';
import type { Store } from './storage/store.js';
import { sha256Hex, timingSafeEqualHex } from './util.js';

export function bearer(request: Request): string {
  const header = request.headers.get('authorization') ?? '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

export function presentedApiKey(request: Request): string {
  return bearer(request) || (request.headers.get('x-api-key') ?? '').trim();
}

interface SeedKey {
  name?: unknown;
  key?: unknown;
  dayCalls?: unknown;
  dayBytes?: unknown;
  hosts?: unknown;
}

let seedCache: { raw: string; keys: ApiKeyRecord[] } | undefined;

async function seedKeys(env: Env): Promise<ApiKeyRecord[]> {
  const raw = env.CHAT_API_KEYS ?? '';
  if (seedCache && seedCache.raw === raw) return seedCache.keys;
  if (raw.trim() === '') {
    seedCache = { raw, keys: [] };
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = [];
  }
  if (!Array.isArray(parsed)) parsed = [];

  const keys: ApiKeyRecord[] = [];
  for (const item of parsed as SeedKey[]) {
    if (!item || typeof item.name !== 'string' || typeof item.key !== 'string') continue;
    const name = item.name.trim();
    const plain = item.key.trim();
    if (!name || plain.length < 16) continue;
    const now = Date.now();
    keys.push({
      id: `seed_${name}`,
      name,
      keyHash: await sha256Hex(plain),
      prefix: plain.slice(0, Math.min(12, plain.length)),
      dayCalls: typeof item.dayCalls === 'number' && item.dayCalls > 0 ? item.dayCalls : null,
      dayBytes: typeof item.dayBytes === 'number' && item.dayBytes > 0 ? item.dayBytes : null,
      hosts: Array.isArray(item.hosts)
        ? item.hosts.filter((host): host is string => typeof host === 'string')
        : null,
      createdAt: now,
      revokedAt: null,
    });
  }

  seedCache = { raw, keys };
  return keys;
}

/**
 * D1 里有 key 就以 D1 为准；D1 为空时才用 secret 里的种子。
 * 这样第一次部署不需要手工插库，之后面板/管理接口改完立即生效。
 */
export async function resolveKeys(store: Store, env: Env): Promise<ApiKeyRecord[]> {
  // 只要存储里曾经有过 key，就以存储为准（哪怕全部已吊销）。
  // 否则「吊销最后一把」会让 secret 里的种子重新生效，这是个隐蔽的复活漏洞。
  if (await store.hasKeys()) return store.listKeys();
  return seedKeys(env);
}

export async function authenticate(
  request: Request,
  keys: ApiKeyRecord[]
): Promise<ApiKeyRecord | null> {
  const presented = presentedApiKey(request);
  if (!presented) return null;
  const hash = await sha256Hex(presented);
  for (const key of keys) {
    if (timingSafeEqualHex(key.keyHash, hash)) return key;
  }
  return null;
}

export function adminOk(request: Request, env: Env): boolean {
  const expected = env.ADMIN_TOKEN;
  if (!expected) return false; // fail-closed
  const presented = bearer(request);
  if (!presented) return false;

  // 支持脚本只带口令，也支持 "user:pass" 形式；用户名不是秘密。
  const colon = presented.indexOf(':');
  const user = colon > 0 ? presented.slice(0, colon) : env.ADMIN_USER ?? 'admin';
  const pass = colon > 0 ? presented.slice(colon + 1) : presented;
  const expectedUser = env.ADMIN_USER ?? 'admin';
  return (
    timingSafeEqualHex(user, expectedUser) &&
    timingSafeEqualHex(pass, expected)
  );
}
