-- 熔断器 + 每 (Key × 模型) 的 EWMA 统计
--
-- 为什么按 (key, upstream_model) 而不是只按 key:
--   一把 Key 在 A 模型上被限流/超时, 在 B 模型上完全正常 (免费聚合渠道尤其如此:
--   某些模型欠费、某些模型秒回)。Key 级熔断会把好模型一起拖下水。
--
-- state:
--   closed    正常发请求
--   open      连续失败到阈值 → 熔断, 到 retry_at 之前完全不发请求
--   half_open 到期后放一个探测请求 (probe_in_flight_at 保证同一时刻只有一个探测),
--             探测成功 → closed; 失败 → 再 open 一档 (退避翻倍)
--
-- ewma_* 是指数加权移动平均 (alpha=0.3): 路由评分用它替代 Key 级累计平均 ——
--   累计平均要几小时才能反映"刚才这把 Key 变慢了", EWMA 三五下就跟上。

CREATE TABLE IF NOT EXISTS circuit_state (
  key_id               INTEGER NOT NULL REFERENCES keys(id) ON DELETE CASCADE,
  upstream_model       TEXT    NOT NULL,      -- '' = 不区分模型 (保留位)
  state                TEXT    NOT NULL DEFAULT 'closed',  -- closed | open | half_open
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  opened_at            INTEGER,
  retry_at             INTEGER,               -- open → 何时允许半开探测
  probe_in_flight_at   INTEGER,               -- 半开探测占用标记
  ewma_latency_ms      REAL,
  ewma_fail_rate       REAL,
  samples              INTEGER NOT NULL DEFAULT 0,
  updated_at           INTEGER NOT NULL,
  PRIMARY KEY (key_id, upstream_model)
);

CREATE INDEX IF NOT EXISTS idx_circuit_state_state ON circuit_state(state, retry_at);
