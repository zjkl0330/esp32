import type { Env, KiloModel } from '../types.js';

export interface CachedCatalog {
  models: KiloModel[];
  at: number;
}

export interface ModelCache {
  get(): Promise<CachedCatalog | null>;
  put(models: KiloModel[]): Promise<void>;
}

function isValidModel(value: unknown): value is KiloModel {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === 'string' &&
    item.id.startsWith('kilo/') &&
    typeof item.upstream === 'string' &&
    item.upstream !== '' &&
    item.object === 'model' &&
    typeof item.owned_by === 'string'
  );
}

export class KVModelCache implements ModelCache {
  constructor(private readonly kv: KVNamespace) {}

  async get(): Promise<CachedCatalog | null> {
    const raw = await this.kv.get('models:kilo', 'json');
    if (!raw || typeof raw !== 'object') return null;
    const value = raw as { models?: unknown; at?: unknown };
    if (typeof value.at !== 'number' || !Array.isArray(value.models)) return null;
    const models = value.models.filter(isValidModel);
    if (models.length === 0) return null;
    return { models, at: value.at };
  }

  async put(models: KiloModel[]): Promise<void> {
    if (models.length === 0) return;
    await this.kv.put('models:kilo', JSON.stringify({ models, at: Date.now() }), {
      expirationTtl: 600,
    });
  }
}

export class MemoryModelCache implements ModelCache {
  private value: CachedCatalog | null = null;

  async get(): Promise<CachedCatalog | null> {
    return this.value ? { models: [...this.value.models], at: this.value.at } : null;
  }

  async put(models: KiloModel[]): Promise<void> {
    this.value = { models: [...models], at: Date.now() };
  }
}

let memoryCache: MemoryModelCache | undefined;

export function createCache(env: Env): ModelCache {
  if (env.KV) return new KVModelCache(env.KV);
  memoryCache ??= new MemoryModelCache();
  return memoryCache;
}
