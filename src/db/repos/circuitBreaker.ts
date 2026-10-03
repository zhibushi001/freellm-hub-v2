/**
 * 熔断器 + 每 (Key × 模型) 的 EWMA 统计
 *
 * 与既有冷却 (cooldowns) 的分工:
 *   cooldowns  = 硬门槛: 明确证据表明这把 Key/这个模型此刻不能用 (401/402/403/额度/限流)
 *                → 直接不参与选择。
 *   熔断器     = 软自适应: 连续的上游故障 (5xx/超时/429) 达到阈值就先别打了, 到期放一个
 *                探测请求; 探测好了自动回场。全程不需要人工干预, 也不看错误文本。
 *
 * EWMA (alpha=0.3) 替代 Key 级累计平均喂给评分:
 *   累计平均 (keys.avg_latency_ms) 要几小时才反映"这把 Key 刚变慢";
 *   EWMA 三五次采样就跟上, 于是"快的、稳的 Key 自动多拿流量"。
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

/** 连续失败多少次才熔断 */
const FAILURE_THRESHOLD = Number(process.env.HUB_CIRCUIT_FAILURES || 3);
/** 首次熔断时长, 之后按 (次数-阈值) 指数退避, 上限 MAX_OPEN */
const BASE_OPEN_MS = Number(process.env.HUB_CIRCUIT_BASE_MS || 30_000);
const MAX_OPEN_MS = Number(process.env.HUB_CIRCUIT_MAX_MS || 15 * 60_000);
/** EWMA 平滑系数 */
const ALPHA = 0.3;
/** 半开探测在途多久算超时 (上游半死不活时别让探测永远占位) */
const PROBE_TTL_MS = 60_000;

export function getCircuitState(keyId: number, upstreamModel: string | null): CircuitState | undefined {
  const model = upstreamModel ?? '';
  return getDb()
    .prepare('SELECT * FROM circuit_state WHERE key_id = ? AND upstream_model = ?')
    .get(keyId, model) as CircuitState | undefined;
}

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

/**
 * 熔断器当前怎么对待这把 Key:
 *   blocked    = 完全不发请求 (open 且未到退避时间)
 *   halfOpen   = 放一个探测请求 (已到退避时间, 但探测位还被上一次占着)
 *   closed     = 正常
 */
export function breakerGate(
  st: CircuitState | undefined,
  now: number = Date.now(),
): { blocked: boolean; halfOpen: boolean } {
  if (!st || st.state === 'closed') return { blocked: false, halfOpen: false };
  if (st.state === 'open') {
    if (st.retry_at == null || now < st.retry_at) return { blocked: true, halfOpen: false };
    // 到期 → 半开: 放一个探测, 但同刻只允许一个 (probe_in_flight_at 未过期则挡住后来者)
    const probeBusy = st.probe_in_flight_at != null && now - st.probe_in_flight_at < PROBE_TTL_MS;
    return probeBusy ? { blocked: true, halfOpen: false } : { blocked: false, halfOpen: true };
  }
  // half_open: 探测在途
  const probeBusy = st.probe_in_flight_at != null && now - st.probe_in_flight_at < PROBE_TTL_MS;
  return probeBusy ? { blocked: true, halfOpen: false } : { blocked: false, halfOpen: true };
}

/** 半开探测位是否已被占 (发请求前调用, 占了就写时间戳) */
export function claimProbeSlot(keyId: number, upstreamModel: string | null, now: number = Date.now()): boolean {
  const model = upstreamModel ?? '';
  const st = getCircuitState(keyId, model);
  if (!st || st.state === 'closed') return true;
  const gate = breakerGate(st, now);
  if (gate.blocked) return false;
  getDb()
    .prepare(
      `INSERT INTO circuit_state (key_id, upstream_model, state, probe_in_flight_at, updated_at)
       VALUES (?, ?, 'half_open', ?, ?)
       ON CONFLICT(key_id, upstream_model) DO UPDATE SET
         state = 'half_open', probe_in_flight_at = excluded.probe_in_flight_at,
         updated_at = excluded.updated_at`,
    )
    .run(keyId, model, now, now);
  return true;
}

function backoffMs(consecutiveFailures: number): number {
  const over = Math.max(0, consecutiveFailures - FAILURE_THRESHOLD);
  return Math.min(MAX_OPEN_MS, BASE_OPEN_MS * 2 ** over);
}

export interface OutcomeOpts {
  /**
   * 是否算熔断级失败。只把"上游侧故障"算进来:
   * 5xx / 超时 / 429 / 连接失败。
   * 不算: 4xx 客户端错误 (请求本身有问题)、401/402/403 (Key 级问题, 由 cooldown/状态机管)。
   */
  breakerFailure: boolean;
  now?: number;
}

/**
 * 记录一次请求结果: 更新 EWMA + 熔断器状态。
 * 每个 (Key × 模型) 各自统计, 互不干扰。
 */
export function recordOutcome(
  keyId: number,
  upstreamModel: string | null,
  ok: boolean,
  latencyMs: number,
  opts: OutcomeOpts,
): void {
  const now = opts.now ?? Date.now();
  const model = upstreamModel ?? '';
  const prev = getCircuitState(keyId, model);

  const prevLat = prev?.ewma_latency_ms;
  const prevFail = prev?.ewma_fail_rate;
  const ewmaLatency = prevLat == null ? latencyMs : ALPHA * latencyMs + (1 - ALPHA) * prevLat;
  const failSample = ok ? 0 : 1;
  const ewmaFail = prevFail == null ? failSample : ALPHA * failSample + (1 - ALPHA) * prevFail;
  const samples = (prev?.samples ?? 0) + 1;

  let state: CircuitStateName = 'closed';
  let consecutive = 0;
  let openedAt: number | null = null;
  let retryAt: number | null = null;
  let probeAt: number | null = null;

  if (opts.breakerFailure && !ok) {
    consecutive = (prev?.consecutive_failures ?? 0) + 1;
    if (consecutive >= FAILURE_THRESHOLD) {
      state = 'open';
      openedAt = prev?.opened_at ?? now;
      retryAt = now + backoffMs(consecutive);
      probeAt = null;
    } else {
      state = prev?.state === 'half_open' ? 'half_open' : 'closed';
      // 半开探测失败还没到阈值? 半开本身就是回炉前的最后机会, 直接重新打开
      if (prev?.state === 'half_open') {
        state = 'open';
        openedAt = prev.opened_at ?? now;
        retryAt = now + backoffMs(consecutive);
      }
    }
  } else if (ok) {
    // 成功 = 熔断器归零 (探测成功也算回场)
    consecutive = 0;
    state = 'closed';
    openedAt = null;
    retryAt = null;
    probeAt = null;
  } else {
    // 非熔断级失败 (如 400): 熔断状态不动, 只更新 EWMA
    state = prev?.state ?? 'closed';
    consecutive = prev?.consecutive_failures ?? 0;
    openedAt = prev?.opened_at ?? null;
    retryAt = prev?.retry_at ?? null;
    probeAt = prev?.probe_in_flight_at ?? null;
  }

  getDb()
    .prepare(
      `INSERT INTO circuit_state
         (key_id, upstream_model, state, consecutive_failures, opened_at, retry_at,
          probe_in_flight_at, ewma_latency_ms, ewma_fail_rate, samples, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(key_id, upstream_model) DO UPDATE SET
         state = excluded.state,
         consecutive_failures = excluded.consecutive_failures,
         opened_at = excluded.opened_at,
         retry_at = excluded.retry_at,
         probe_in_flight_at = excluded.probe_in_flight_at,
         ewma_latency_ms = excluded.ewma_latency_ms,
         ewma_fail_rate = excluded.ewma_fail_rate,
         samples = excluded.samples,
         updated_at = excluded.updated_at`,
    )
    .run(keyId, model, state, consecutive, openedAt, retryAt, probeAt,
      ewmaLatency, ewmaFail, samples, now);
}

/** 熔断器全景 (仪表盘/运维视图用) */
export function listOpenCircuits(limit = 100): Array<CircuitState & { key_label: string | null; channel_id: number }> {
  return getDb()
    .prepare(
      `SELECT c.*, k.label as key_label, k.channel_id
         FROM circuit_state c JOIN keys k ON k.id = c.key_id
        WHERE c.state != 'closed'
        ORDER BY c.retry_at IS NULL, c.retry_at ASC
        LIMIT ?`,
    )
    .all(limit) as unknown as Array<CircuitState & { key_label: string | null; channel_id: number }>;
}
