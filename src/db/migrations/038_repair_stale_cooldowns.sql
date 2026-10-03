-- 修复历史"假已清除"冷却行 (setCooldown 的 bug 数据遗留)
--
-- bug: upsert 冲突分支重新启用冷却时没有重置 cleared_at, 而所有读取都过
-- `cleared_at IS NULL` → 被清过一次的行再次启用后**永久隐身**, 冷却静默失效。
-- 判定式: cleared_at < started_at = "先被清除, 后又被重新启用却没有清标记"
-- (正常行必然 cleared_at > started_at)。
--
-- 后果 (2026-10-03): OpenRouter 免费模型每日额度用尽后 rate_limit 冷却没生效,
-- 客户端 1 小时内重试 17 次, 连续失败把唯一可用 Key 打进 30 分钟封禁。
-- 代码侧已修 (upsert 重置 cleared_at), 这里把存量脏数据捞出来。
UPDATE cooldowns SET cleared_at = NULL, cleared_reason = NULL
 WHERE cleared_at IS NOT NULL AND cleared_at < started_at;
