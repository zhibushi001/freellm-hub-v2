-- 登录失败锁定 (按 username 维度 + IP 维度)
-- 比 @fastify/rate-limit 更严格:
--   1. 跨重启持续 (rate-limit 是内存的)
--   2. 按 username + IP 双维度, 防分布式爆破
--   3. 锁定后必须等冷却时间才能再试

CREATE TABLE IF NOT EXISTS login_attempts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  identifier    TEXT NOT NULL,       -- "user:zhibushi" 或 "ip:1.2.3.4"
  attempts      INTEGER NOT NULL DEFAULT 0,
  locked_until  INTEGER,              -- 锁定截止时间 (ms epoch), null = 未锁定
  last_attempt  INTEGER NOT NULL,
  last_ip       TEXT,
  last_user_agent TEXT
);

CREATE INDEX IF NOT EXISTS idx_login_attempts_id ON login_attempts(identifier);
CREATE INDEX IF NOT EXISTS idx_login_attempts_locked ON login_attempts(locked_until);
