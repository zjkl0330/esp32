export interface Env {
  DB?: D1Database;
  KV?: KVNamespace;
  /** D1 为空时当种子用。JSON: [{name,key,dayCalls?,dayBytes?}] */
  CHAT_API_KEYS?: string;
  ADMIN_TOKEN?: string;
  ADMIN_USER?: string;
  KILO_BASE?: string;
  WEB_CHANNEL_ENABLED?: string;
  OPENCODE_MODE?: string;
  /** 千问网页端 token（Authorization: Bearer ...） */
  QWEN_TOKEN?: string;
  QWEN_BASE?: string;
  /** DeepSeek 网页端 token（M3 下一个接入） */
  DEEPSEEK_TOKEN?: string;
  DEEPSEEK_BASE?: string;
  /** 可选：复用已有会话，省一次 chat_session/create */
  DEEPSEEK_SESSION_ID?: string;
  /** 豆包网页端 sessionid cookie */
  DOUBAO_SESSIONID?: string;
  DOUBAO_BASE?: string;
  DOUBAO_AID?: string;
  DOUBAO_SERVICE?: string;
  DOUBAO_PASSPORT_BASE?: string;
  /** 网页账号池 AES-256-GCM 密钥；不配则只能用 env 里的 token */
  COOKIE_ENC_KEY?: string;
  /** service binding：esp32-exit */
  EXIT?: Fetcher;
  /** 调 exit /api/fetch 的客户端 key（在 exit 面板里创建） */
  EXIT_CLIENT_KEY?: string;
  /** "1" 时网页通道必须走 ESP32；没配 EXIT 就返回 503，不静默直连 */
  WEB_EGRESS_REQUIRED?: string;
  /** 智谱清言网页 access token */
  GLM_TOKEN?: string;
  GLM_BASE?: string;
  GLM_SIGN_SECRET?: string;
  /** ChatGPT 网页 access token */
  CHATGPT_ACCESS_TOKEN?: string;
  CHATGPT_BASE?: string;
  CHATGPT_TURNSTILE_SOLVER_URL?: string;
  CHATGPT_ARKOSE_TOKEN_URL?: string;
}

export interface ApiKeyRecord {
  id: string;
  name: string;
  keyHash: string;
  prefix: string;
  dayCalls: number | null;
  dayBytes: number | null;
  hosts: string[] | null;
  createdAt: number;
  revokedAt: number | null;
}

export interface UsageRecord {
  keyId: string;
  day: string;
  calls: number;
  bytesOut: number;
  tokensIn: number;
  tokensOut: number;
}

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  stream: boolean;
  temperature?: number;
  max_tokens?: number;
  stop?: string | string[];
  stream_options?: { include_usage?: boolean };
}

export interface ModelInfo {
  id: string;
  object: 'model';
  owned_by: string;
  created: number;
}

export interface KiloModel extends ModelInfo {
  upstream: string;
}
