import type { ApiKeyRecord, Env, UsageRecord } from '../types.js';

export interface Store {
  /** 是否曾经有过 key（包含已吊销）。用来区分「从未配置」和「全部吊销」。 */
  hasKeys(): Promise<boolean>;
  listKeys(): Promise<ApiKeyRecord[]>;
  addKey(record: ApiKeyRecord): Promise<void>;
  revokeKey(name: string): Promise<boolean>;
  getUsage(keyId: string, day: string): Promise<UsageRecord | null>;
  incCalls(keyId: string, day: string): Promise<void>;
  addBytes(keyId: string, day: string, bytes: number): Promise<void>;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parseHosts(value: unknown): string[] | null {
  if (typeof value !== 'string' || value === '') return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : null;
  } catch {
    return null;
  }
}

function mapKey(row: Record<string, unknown>): ApiKeyRecord {
  return {
    id: String(row.id ?? ''),
    name: String(row.name ?? ''),
    keyHash: String(row.key_hash ?? ''),
    prefix: String(row.prefix ?? ''),
    dayCalls: numberOrNull(row.day_calls),
    dayBytes: numberOrNull(row.day_bytes),
    hosts: parseHosts(row.hosts),
    createdAt: Number(row.created_at ?? 0),
    revokedAt: numberOrNull(row.revoked_at),
  };
}

export class D1Store implements Store {
  constructor(private readonly db: D1Database) {}

  async hasKeys(): Promise<boolean> {
    const row = await this.db
      .prepare(`SELECT COUNT(*) AS n FROM api_keys`)
      .first<{ n?: number }>();
    return Number(row?.n ?? 0) > 0;
  }

  async listKeys(): Promise<ApiKeyRecord[]> {
    const result = await this.db
      .prepare(
        `SELECT id, name, key_hash, prefix, day_calls, day_bytes, hosts, created_at, revoked_at
         FROM api_keys
         WHERE revoked_at IS NULL`
      )
      .all<Record<string, unknown>>();
    return (result.results ?? []).map(mapKey);
  }

  async addKey(record: ApiKeyRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO api_keys
           (id, name, key_hash, prefix, day_calls, day_bytes, hosts, created_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        record.id,
        record.name,
        record.keyHash,
        record.prefix,
        record.dayCalls,
        record.dayBytes,
        record.hosts ? JSON.stringify(record.hosts) : null,
        record.createdAt,
        record.revokedAt
      )
      .run();
  }

  async revokeKey(name: string): Promise<boolean> {
    const result = await this.db
      .prepare(`UPDATE api_keys SET revoked_at = ? WHERE name = ? AND revoked_at IS NULL`)
      .bind(Date.now(), name)
      .run();
    return Number(result.meta?.changes ?? 0) > 0;
  }

  async getUsage(keyId: string, day: string): Promise<UsageRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT key_id, day, calls, bytes_out, tokens_in, tokens_out
         FROM usage_daily
         WHERE key_id = ? AND day = ?`
      )
      .bind(keyId, day)
      .first<Record<string, unknown>>();
    if (!row) return null;
    return {
      keyId: String(row.key_id ?? keyId),
      day: String(row.day ?? day),
      calls: Number(row.calls ?? 0),
      bytesOut: Number(row.bytes_out ?? 0),
      tokensIn: Number(row.tokens_in ?? 0),
      tokensOut: Number(row.tokens_out ?? 0),
    };
  }

  async incCalls(keyId: string, day: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO usage_daily (key_id, day, calls, bytes_out, tokens_in, tokens_out)
         VALUES (?, ?, 1, 0, 0, 0)
         ON CONFLICT(key_id, day) DO UPDATE SET calls = calls + 1`
      )
      .bind(keyId, day)
      .run();
  }

  async addBytes(keyId: string, day: string, bytes: number): Promise<void> {
    if (bytes <= 0) return;
    await this.db
      .prepare(
        `INSERT INTO usage_daily (key_id, day, calls, bytes_out, tokens_in, tokens_out)
         VALUES (?, ?, 0, ?, 0, 0)
         ON CONFLICT(key_id, day) DO UPDATE SET bytes_out = bytes_out + excluded.bytes_out`
      )
      .bind(keyId, day, bytes)
      .run();
  }
}

export class MemoryStore implements Store {
  private readonly keys = new Map<string, ApiKeyRecord>();
  private readonly usage = new Map<string, UsageRecord>();

  async hasKeys(): Promise<boolean> {
    return this.keys.size > 0;
  }

  async listKeys(): Promise<ApiKeyRecord[]> {
    return [...this.keys.values()].filter((key) => key.revokedAt === null);
  }

  async addKey(record: ApiKeyRecord): Promise<void> {
    if (this.keys.has(record.name)) {
      throw new Error(`duplicate key name: ${record.name}`);
    }
    this.keys.set(record.name, { ...record });
  }

  async revokeKey(name: string): Promise<boolean> {
    const key = this.keys.get(name);
    if (!key || key.revokedAt !== null) return false;
    key.revokedAt = Date.now();
    return true;
  }

  async getUsage(keyId: string, day: string): Promise<UsageRecord | null> {
    const record = this.usage.get(`${keyId}|${day}`);
    return record ? { ...record } : null;
  }

  async incCalls(keyId: string, day: string): Promise<void> {
    const id = `${keyId}|${day}`;
    const record = this.usage.get(id) ?? {
      keyId,
      day,
      calls: 0,
      bytesOut: 0,
      tokensIn: 0,
      tokensOut: 0,
    };
    record.calls += 1;
    this.usage.set(id, record);
  }

  async addBytes(keyId: string, day: string, bytes: number): Promise<void> {
    if (bytes <= 0) return;
    const id = `${keyId}|${day}`;
    const record = this.usage.get(id) ?? {
      keyId,
      day,
      calls: 0,
      bytesOut: 0,
      tokensIn: 0,
      tokensOut: 0,
    };
    record.bytesOut += bytes;
    this.usage.set(id, record);
  }
}

let memoryStore: MemoryStore | undefined;

/** 生产必须 D1；没有 DB 时退回进程内存，只适合本地/测试。 */
export function createStore(env: Env): Store {
  if (env.DB) return new D1Store(env.DB);
  memoryStore ??= new MemoryStore();
  return memoryStore;
}
