-- 冷却哨兵归一 (运维审计 #4): key 级 cooldown 的 upstream_model 原来写 NULL,
-- 而 UNIQUE(key_id, reason, upstream_model) 对 NULL 与 NULL 永不相等 → ON CONFLICT 失效,
-- 每次错误都新插一行 (生产曾堆积 key23 的 1955 行重复 auth)。
-- 统一改为 '' 哨兵。转换必须先去重: 多行 NULL 同时转 '' 会互相撞 UNIQUE。
-- 三步在同一事务内顺序执行 (runner 按文件 BEGIN/COMMIT)。

-- 1) 同 key+reason 的重复 NULL 行: 每组只保留 expires_at 最晚的一行 (同值保留 id 最小)
DELETE FROM cooldowns
WHERE upstream_model IS NULL
  AND EXISTS (
    SELECT 1 FROM cooldowns c2
    WHERE c2.key_id = cooldowns.key_id
      AND c2.reason = cooldowns.reason
      AND c2.upstream_model IS NULL
      AND (c2.expires_at > cooldowns.expires_at
           OR (c2.expires_at = cooldowns.expires_at AND c2.id < cooldowns.id))
  );

-- 2) 组内若已存在 '' 行 (新代码写入), 删除剩余 NULL 残行
DELETE FROM cooldowns
WHERE upstream_model IS NULL
  AND EXISTS (
    SELECT 1 FROM cooldowns c3
    WHERE c3.key_id = cooldowns.key_id
      AND c3.reason = cooldowns.reason
      AND c3.upstream_model = ''
  );

-- 3) 归一化为 '' 哨兵
UPDATE cooldowns SET upstream_model = '' WHERE upstream_model IS NULL;
