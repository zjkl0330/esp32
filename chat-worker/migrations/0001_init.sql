-- chat2api M1 初始表结构。
-- 日界按北京时间切；调用方不要直接写库，统一走 Worker。

CREATE TABLE IF NOT EXISTS api_keys (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  key_hash    TEXT NOT NULL,
  prefix      TEXT NOT NULL,
  day_calls   INTEGER,
  day_bytes   INTEGER,
  hosts       TEXT,
  created_at  INTEGER NOT NULL,
  revoked_at  INTEGER
);

CREATE INDEX IF NOT EXISTS idx_api_keys_revoked ON api_keys (revoked_at);

CREATE TABLE IF NOT EXISTS usage_daily (
  key_id      TEXT NOT NULL,
  day         TEXT NOT NULL,
  calls       INTEGER NOT NULL DEFAULT 0,
  bytes_out   INTEGER NOT NULL DEFAULT 0,
  tokens_in   INTEGER NOT NULL DEFAULT 0,
  tokens_out  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key_id, day)
);

CREATE TABLE IF NOT EXISTS request_log (
  id          TEXT PRIMARY KEY,
  key_id      TEXT NOT NULL,
  model       TEXT NOT NULL,
  channel     TEXT NOT NULL,
  status      INTEGER NOT NULL,
  ttft_ms     INTEGER,
  total_ms    INTEGER,
  bytes_out   INTEGER,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_request_log_created ON request_log (created_at);
