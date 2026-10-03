-- 成本与配额: 价格目录 / 用量成本列 / Hub Key 预算
--
-- 动机 (审计结论): 系统只记 token 数, 没有价格维度 —— 有付费 Key 时
-- 无法回答"这把 Key / 这个模型 / 这个调用方这个月花了多少钱"。
--
-- 1) price_catalog: 每 (provider, 模型模式) 的每百万 token 单价。
--    模型模式支持前缀通配 (gpt-4o* / claude-3*), provider_name 为 '*' 表示全局默认。
--    匹配优先级在 src/services/pricing.ts 里定 (provider 精确 > provider 通配 > 全局精确 > 全局通配)。
-- 2) usage_logs 加 cost_usd / price_ref: 成本随请求落库 (而不是查询时猜),
--    price_ref 记下当时命中的是哪条价格, 以后价格改了历史账单仍然说得清。
-- 3) hub_keys 加预算列: null = 不限; 有值则超额请求直接 429。

CREATE TABLE IF NOT EXISTS price_catalog (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_name      TEXT    NOT NULL,      -- '*' = 任意 provider (全局默认价)
  model_pattern      TEXT    NOT NULL,      -- 精确模型名, 或前缀通配 (如 'gpt-4o*')
  input_price_per_m  REAL    NOT NULL,      -- 每百万输入 token 美元价
  output_price_per_m REAL    NOT NULL,      -- 每百万输出 token 美元价
  note               TEXT,
  enabled            INTEGER NOT NULL DEFAULT 1,
  updated_at         INTEGER NOT NULL,
  UNIQUE (provider_name, model_pattern)
);

CREATE INDEX IF NOT EXISTS idx_price_lookup ON price_catalog(enabled, provider_name, model_pattern);

ALTER TABLE usage_logs ADD COLUMN cost_usd REAL;
ALTER TABLE usage_logs ADD COLUMN price_ref TEXT;
CREATE INDEX IF NOT EXISTS idx_usage_cost ON usage_logs(created_at, cost_usd);

ALTER TABLE hub_keys ADD COLUMN monthly_budget_usd REAL;
ALTER TABLE hub_keys ADD COLUMN daily_budget_usd REAL;

-- 说明: usage_daily 建了但**从来没有任何代码读写它** (全仓只有 001 建表 + 注释)。
-- 审计确认用量事实来源只有 usage_logs。成本/用量看板改为查询时从 usage_logs 聚合 ——
-- 不依赖 cron, 永远是最新数据, 也不会出现"聚合表 0 行"的误导。此表保留仅为兼容旧库。
