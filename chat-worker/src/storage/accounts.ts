import type { Env } from '../types.js';
import { randomHex } from '../util.js';

export type WebProvider = 'qwen' | 'deepseek' | 'doubao' | 'glm' | 'chatgpt';

export interface WebAccountSummary {
  id: string;
  provider: WebProvider;
  label: string;
  status: string;
  createdAt: number;
  lastOkAt: number | null;
}

export interface WebAccount extends WebAccountSummary {
  credentials: Record<string, string>;
}

export interface AccountStore {
  list(): Promise<WebAccountSummary[]>;
  add(provider: WebProvider, label: string, credentials: Record<string, string>): Promise<WebAccountSummary>;
  remove(id: string): Promise<boolean>;
  getByProvider(provider: WebProvider): Promise<WebAccount | null>;
}

const encoder = new TextEncoder();

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function importKey(secret: string): Promise<CryptoKey> {
  if (!secret || secret.length < 24) throw new Error('COOKIE_ENC_KEY is missing or too short');
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

async function encrypt(
  secret: string,
  provider: WebProvider,
  label: string,
  credentials: Record<string, string>
): Promise<string> {
  const key = await importKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aad = encoder.encode(`${provider}|${label}`);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad },
    key,
    encoder.encode(JSON.stringify(credentials))
  );
  return `v1:${bytesToBase64(iv)}:${bytesToBase64(new Uint8Array(ciphertext))}`;
}

async function decrypt(
  secret: string,
  provider: WebProvider,
  label: string,
  payload: string
): Promise<Record<string, string>> {
  const [version, ivPart, cipherPart] = payload.split(':');
  if (version !== 'v1' || !ivPart || !cipherPart) throw new Error('bad credential envelope');
  const key = await importKey(secret);
  const iv = base64ToBytes(ivPart);
  const ciphertext = base64ToBytes(cipherPart);
  const aad = encoder.encode(`${provider}|${label}`);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, additionalData: aad },
    key,
    ciphertext
  );
  const parsed = JSON.parse(new TextDecoder().decode(plain)) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out: Record<string, string> = {};
  for (const [keyName, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === 'string') out[keyName] = value;
  }
  return out;
}

function mapSummary(row: Record<string, unknown>): WebAccountSummary {
  return {
    id: String(row.id ?? ''),
    provider: String(row.provider ?? '') as WebProvider,
    label: String(row.label ?? ''),
    status: String(row.status ?? 'active'),
    createdAt: Number(row.created_at ?? 0),
    lastOkAt: row.last_ok_at === null || row.last_ok_at === undefined ? null : Number(row.last_ok_at),
  };
}

export class D1AccountStore implements AccountStore {
  constructor(
    private readonly db: D1Database,
    private readonly secret: string | undefined
  ) {}

  async list(): Promise<WebAccountSummary[]> {
    const result = await this.db
      .prepare(
        `SELECT id, provider, label, status, created_at, last_ok_at
         FROM web_accounts WHERE status = 'active'`
      )
      .all<Record<string, unknown>>();
    return (result.results ?? []).map(mapSummary);
  }

  async add(
    provider: WebProvider,
    label: string,
    credentials: Record<string, string>
  ): Promise<WebAccountSummary> {
    if (!this.secret) throw new Error('COOKIE_ENC_KEY is not configured');
    const encrypted = await encrypt(this.secret, provider, label, credentials);
    const createdAt = Date.now();
    const id = `acct_${randomHex(8)}`;
    await this.db
      .prepare(
        `INSERT INTO web_accounts (id, provider, label, credentials_enc, status, created_at)
         VALUES (?, ?, ?, ?, 'active', ?)`
      )
      .bind(id, provider, label, encrypted, createdAt)
      .run();
    return { id, provider, label, status: 'active', createdAt, lastOkAt: null };
  }

  async remove(id: string): Promise<boolean> {
    const result = await this.db
      .prepare(`UPDATE web_accounts SET status = 'revoked' WHERE id = ? AND status = 'active'`)
      .bind(id)
      .run();
    return Number(result.meta?.changes ?? 0) > 0;
  }

  async getByProvider(provider: WebProvider): Promise<WebAccount | null> {
    if (!this.secret) return null;
    const row = await this.db
      .prepare(
        `SELECT id, provider, label, status, created_at, last_ok_at, credentials_enc
         FROM web_accounts
         WHERE provider = ? AND status = 'active'
         ORDER BY COALESCE(last_ok_at, 0) DESC, created_at ASC
         LIMIT 1`
      )
      .bind(provider)
      .first<Record<string, unknown>>();
    if (!row) return null;
    try {
      const credentials = await decrypt(
        this.secret,
        provider,
        String(row.label ?? ''),
        String(row.credentials_enc ?? '')
      );
      return { ...mapSummary(row), credentials };
    } catch {
      return null;
    }
  }
}

interface MemoryRecord {
  summary: WebAccountSummary;
  credentials: Record<string, string>;
}

export class MemoryAccountStore implements AccountStore {
  private readonly records = new Map<string, MemoryRecord>();

  async list(): Promise<WebAccountSummary[]> {
    return [...this.records.values()]
      .map((record) => record.summary)
      .filter((summary) => summary.status === 'active');
  }

  async add(
    provider: WebProvider,
    label: string,
    credentials: Record<string, string>
  ): Promise<WebAccountSummary> {
    for (const record of this.records.values()) {
      if (record.summary.provider === provider && record.summary.label === label) {
        throw new Error(`duplicate account: ${provider}/${label}`);
      }
    }
    const summary: WebAccountSummary = {
      id: `acct_${randomHex(8)}`,
      provider,
      label,
      status: 'active',
      createdAt: Date.now(),
      lastOkAt: null,
    };
    this.records.set(summary.id, { summary, credentials: { ...credentials } });
    return summary;
  }

  async remove(id: string): Promise<boolean> {
    const record = this.records.get(id);
    if (!record || record.summary.status !== 'active') return false;
    record.summary.status = 'revoked';
    return true;
  }

  async getByProvider(provider: WebProvider): Promise<WebAccount | null> {
    const active = [...this.records.values()].filter(
      (record) => record.summary.provider === provider && record.summary.status === 'active'
    );
    if (active.length === 0) return null;
    return { ...active[0].summary, credentials: { ...active[0].credentials } };
  }
}

let memoryAccounts: MemoryAccountStore | undefined;

export function createAccountStore(env: Env): AccountStore {
  if (env.DB) return new D1AccountStore(env.DB, env.COOKIE_ENC_KEY);
  memoryAccounts ??= new MemoryAccountStore();
  return memoryAccounts;
}
