-- 清理"成本与配额"的表与列 (迁移 036 建, 随功能一并撤回)
--
-- 背景: 本项目是**纯个人自用, 全部免费渠道**。036 那套价格目录 / 成本落库 / 预算硬限
-- 是面向"多调用方 + 付费上游"的形态, 对个人自用没有意义 (成本恒为 0, 看板永远是 $0,
-- 给自己限额度也没有意义), 已随代码撤回。迁移 036 已经执行过, 按项目惯例**不删已应用的
-- 迁移文件** (删了会在台账留孤儿行, 正是当年 006 事故的成因), 所以在这里反向清理它建的东西。
--
-- 注意: 若日后真接了付费 Key, 应作为一个**新**特性重新引入 (含价格表与成本列), 而不是
-- 恢复 036 —— 那时按"多调用方"的需求重新设计 (预算维度可能是 Hub Key 而不是单用户)。

DROP INDEX IF EXISTS idx_usage_cost;
DROP INDEX IF EXISTS idx_price_lookup;

ALTER TABLE usage_logs DROP COLUMN cost_usd;
ALTER TABLE usage_logs DROP COLUMN price_ref;

ALTER TABLE hub_keys DROP COLUMN daily_budget_usd;
ALTER TABLE hub_keys DROP COLUMN monthly_budget_usd;

DROP TABLE IF EXISTS price_catalog;

-- 说明: usage_daily 建了但**从来没有任何代码读写它** (全仓只有 001 建表 + 注释)。
-- 用量事实来源只有 usage_logs, 看板/趋势都是查询时实时聚合 —— 不依赖 cron 聚合表,
-- 永远是最新数据。此表保留仅为兼容旧库, 无需处理。
