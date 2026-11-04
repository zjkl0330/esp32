-- 网页账号池：Cookie / token 只存密文，密钥在 Worker secret COOKIE_ENC_KEY。
CREATE TABLE IF NOT EXISTS web_accounts (
  id               TEXT PRIMARY KEY,
  provider         TEXT NOT NULL,
  label            TEXT NOT NULL,
  credentials_enc  TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'active',
  created_at       INTEGER NOT NULL,
  last_ok_at       INTEGER,
  UNIQUE(provider, label)
);

CREATE INDEX IF NOT EXISTS idx_web_accounts_provider ON web_accounts (provider, status);
