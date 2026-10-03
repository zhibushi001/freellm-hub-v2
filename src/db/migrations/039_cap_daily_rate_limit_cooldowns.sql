-- 限流冷却精度修复: 存量超长 rate_limit 冷却收敛到下一个 UTC 午夜 + 2min
--
-- 事故 (2026-10-03): OpenRouter 每日额度 429 携带 Retry-After: 86400, 网关
-- 按 source-authoritative 规则冷却了 +24h; 而该限流桶的真实重置点
-- (响应里的 X-RateLimit-Reset) 是下一个 UTC 午夜 —— 网关把 Key 多关了
-- 9 小时 51 分, 上游 08:00 已经开闸, 网关还在 17:51 才放行。
--
-- 代码侧已修 (classifyError / transitionKeyStatus 优先解析 X-RateLimit-Reset,
-- 回退才用 UTC 午夜 + 2min)。本迁移处理存量行: 每日桶最晚在 UTC 午夜重置,
-- 所以任何晚于该时刻的 rate_limit 冷却都是"猜过头"的 —— 收敛过去, 到点自动回场。
-- (代价最多是重置点后多打一次 429 再重新冷却, 无害。)
UPDATE cooldowns
   SET expires_at = ((strftime('%s', 'now') / 86400) + 1) * 86400 * 1000 + 120000
 WHERE cleared_at IS NULL
   AND reason = 'rate_limit'
   AND expires_at > ((strftime('%s', 'now') / 86400) + 1) * 86400 * 1000 + 120000;
