-- login_attempts: identifier 唯一 + 并发安全
--
-- 审计发现: 无 UNIQUE 约束, 且写入是"SELECT 计数 → UPDATE"两步, 并发登录失败会
-- 读同一个旧值各写各的 → 计数丢失, 限流被绕过。同时同一 identifier 可能存在重复行。
-- 这里先去重 (保留最新一行), 再加唯一索引, 之后写入走 UPSERT。

DELETE FROM login_attempts
WHERE id NOT IN (SELECT MAX(id) FROM login_attempts GROUP BY identifier);

CREATE UNIQUE INDEX idx_login_attempts_ident ON login_attempts(identifier);
