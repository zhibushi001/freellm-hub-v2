-- 删 Key / Hub Key 不再连带删掉用量历史
--
-- 背景: usage_logs.key_id / hub_key_id 的外键是 NO ACTION (默认), 删 Key 时会阻塞,
-- 于是删除路径上先跑 `DELETE FROM usage_logs WHERE key_id = ?` 硬清历史 —— 用户一删
-- 废弃 Key, 这把 Key 名下 (以及同 Hub Key 下其他 Key 的) token/延迟/错误记录全部不可恢复。
-- 审计发现 usage_logs 是唯一的用量记录 (usage_daily / request_attempts 都没人写)。
--
-- 改为 ON DELETE SET NULL: 历史保留, 只把已删除的 Key 置空。
-- SQLite 不支持 ALTER 改外键, 必须重建表; 无视图/触发器引用 usage_logs, 可安全重建。

CREATE TABLE usage_logs_new (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  hub_key_id        INTEGER REFERENCES hub_keys(id) ON DELETE SET NULL,
  virtual_model_id  INTEGER REFERENCES virtual_models(id) ON DELETE SET NULL,
  candidate_id      INTEGER REFERENCES model_candidates(id) ON DELETE SET NULL,
  key_id            INTEGER REFERENCES keys(id) ON DELETE SET NULL,
  provider_name     TEXT,
  request_model     TEXT,
  routed_model      TEXT,
  prompt_tokens     INTEGER,
  completion_tokens INTEGER,
  total_tokens      INTEGER,
  latency_ms        INTEGER,
  status            TEXT NOT NULL,
  error_code        INTEGER,
  error_type        TEXT,
  error_message     TEXT,
  stream            INTEGER NOT NULL DEFAULT 0,
  is_benchmark      INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL
);

INSERT INTO usage_logs_new SELECT * FROM usage_logs;

DROP TABLE usage_logs;
ALTER TABLE usage_logs_new RENAME TO usage_logs;

CREATE INDEX idx_usage_created ON usage_logs(created_at);
CREATE INDEX idx_usage_key     ON usage_logs(key_id, created_at);
CREATE INDEX idx_usage_hub     ON usage_logs(hub_key_id, created_at);
