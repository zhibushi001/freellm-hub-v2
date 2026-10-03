/**
 * 每 (Key × 模型) 的 EWMA 统计
 *
 * 历史: 本文件曾是"熔断器 + EWMA"。2026-10-03 按使用者要求移除了熔断拦截——
 *   "我们其实完全不需要熔断吧, 因为我们都是自己用"
 * 个人自用场景: 上游抖就让它抖, 重试本来就是 failover 的职责; 熔断反而会
 * 在上游恢复后继续拦自己的请求。冷却 (cooldowns) 保留——那是上游明确拒绝
 * (401/402/额度/限流) 的硬证据, 与熔断的"连续失败猜测"是两回事。
 *
 * 现在只保留 EWMA: 它不拦任何请求, 只是让"快的、稳的 Key"自动多拿流量。
 *   累计平均 (keys.avg_latency_ms) 要几小时才反映"这把 Key 刚变慢";
 *   EWMA 三五次采样就跟上。
 *
 * circuit_state 表保留 (EWMA 存储)。state/retry_at 等熔断列已无读取方,
 * recordOutcome 每次写入会顺手把它们归位为 closed, 旧行随流量自愈。
 */
import { getDb } from '../connection.js';

export type CircuitStateName = 'closed' | 'open' | 'half_open';

export interface CircuitState {
  key_id: number;
  upstream_model: string;
  state: CircuitStateName;
  consecutive_failures: number;
  opened_at: number | null;
  retry_at: number | null;
  probe_in_flight_at: number | null;
  ewma_latency_ms: number | null;
  ewma_fail_rate: number | null;
  samples: number;
  updated_at: number;
}

/** EWMA 平滑系数 */
const ALPHA = 0.3;

/** 批量取 (一次选池只需一次查询) */
export function getCircuitStates(keyIds: number[], upstreamModel: string | null): Map<number, CircuitState> {
  const map = new Map<number, CircuitState>();
  if (keyIds.length === 0) return map;
  const model = upstreamModel ?? '';
  const placeholders = keyIds.map(() => '?').join(',');
  const rows = getDb()
    .prepare(`SELECT * FROM circuit_state WHERE upstream_model = ? AND key_id IN (${placeholders})`)
    .all(model, ...keyIds) as unknown as CircuitState[];
  for (const r of rows) map.set(r.key_id, r);
  return map;
}

export interface OutcomeOpts {
  now?: number;
}

/**
 * 记录一次请求结果: 只更新 EWMA (不再有任何熔断状态机)。
 * 每个 (Key × 模型) 各自统计, 互不干扰。
 */
export function recordOutcome(
  keyId: number,
  upstreamModel: string | null,
  ok: boolean,
  latencyMs: number,
  opts: OutcomeOpts = {},
): void {
  const now = opts.now ?? Date.now();
  const model = upstreamModel ?? '';
  const prev = getCircuitStates([keyId], model).get(keyId);

  const prevLat = prev?.ewma_latency_ms;
  const prevFail = prev?.ewma_fail_rate;
  const ewmaLatency = prevLat == null ? latencyMs : ALPHA * latencyMs + (1 - ALPHA) * prevLat;
  const failSample = ok ? 0 : 1;
  const ewmaFail = prevFail == null ? failSample : ALPHA * failSample + (1 - ALPHA) * prevFail;
  const samples = (prev?.samples ?? 0) + 1;

  getDb()
    .prepare(
      `INSERT INTO circuit_state
         (key_id, upstream_model, state, consecutive_failures, opened_at, retry_at,
          probe_in_flight_at, ewma_latency_ms, ewma_fail_rate, samples, updated_at)
       VALUES (?, ?, 'closed', 0, NULL, NULL, NULL, ?, ?, ?, ?)
       ON CONFLICT(key_id, upstream_model) DO UPDATE SET
         state = 'closed',
         consecutive_failures = 0,
         opened_at = NULL,
         retry_at = NULL,
         probe_in_flight_at = NULL,
         ewma_latency_ms = excluded.ewma_latency_ms,
         ewma_fail_rate = excluded.ewma_fail_rate,
         samples = excluded.samples,
         updated_at = excluded.updated_at`,
    )
    .run(keyId, model, ewmaLatency, ewmaFail, samples, now);
}
