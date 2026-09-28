/**
 * Key / Candidate 选择器
 *
 * Phase 2 范围:
 *   - 同 Channel 多 Key 选择 (KeyPoolSelector)
 *   - 跨 Channel 候选选择 (CandidateSelector) - 通过 model_candidates 表
 *   - 自动从 discovered_models 推断候选 (Phase 2.4 简化, 让用户确认/调整)
 *
 * Phase 3 起会引入 VirtualModel 完全手动管理
 */
import {getDb} from '../db/connection.js'
import {listKeys} from '../db/repos/keys.js'
import {getAllActiveCooldownsForKey, isKeyOnCooldown} from '../db/repos/cooldowns.js'
import {getAllSettings} from '../db/repos/settings.js'
import {listChannels} from '../db/repos/channels.js'
import {isKeyEligibleForModel} from './resolver.js'
import {getRemainingQuotaRatio} from '../services/quotaTracker.js'
import {rankCandidates, type ScoringInput, type RoutingStrategy, DEFAULT_STRATEGY} from './scorer.js'

export interface PoolResult {
  available: Array<{ key: any; score: number }>;
  unavailable: Array<{ key: any; reason: string; score: number }>;
}

/**
 * 读取当前路由策略 (从 settings 表)
 */
function getRoutingStrategy(): RoutingStrategy {
  const settings = getAllSettings();
  const raw = settings['routing_strategy'] ?? DEFAULT_STRATEGY;
  if (raw === 'priority' || raw === 'balanced' || raw === 'smartest' || raw === 'fastest' || raw === 'reliable') {
    return raw;
  }
  return DEFAULT_STRATEGY;
}

/**
 * 同 Channel 多 Key 选择
 * 给定 provider_id + channel_label, 列出该 Channel 下所有 key, 按 score 排序
 */
export function selectKeyPool(providerId: number, upstreamModel: string | null, withinChannelId?: number): PoolResult {
  const all = listKeys().filter(k =>
    k.provider_id === providerId &&
    (k.channel_enabled ?? 1) === 1 &&
    (withinChannelId == null || k.channel_id === withinChannelId) &&
    (upstreamModel == null || isKeyEligibleForModel(k, upstreamModel)),
  );
  return rankPool(all, upstreamModel);
}

/**
 * 跨 Channel 候选选择
 * 给定 model 名, 找所有声称支持该 model 的 (key, upstream_model) 对, 按 score 排序
 * @param eligibilityModel 用于校验 key.allowed_models 的模型名 (可选)
 */
export function selectCandidatePool(upstreamModel: string, eligibilityModel?: string): PoolResult {
  // Phase 2 简化: 任何 enabled key 都可能支持该 model
  // Phase 2.4 会用 model_candidates 表来精确
  // 这里通过 discovered_models 推断
  // 特殊: upstreamModel = '__any__' 返回所有 enabled keys (退化模式, 用于 failover)
  const eligModel = eligibilityModel ?? (upstreamModel === '__any__' ? null : upstreamModel);
  if (upstreamModel === '__any__') {
    const keys = listKeys().filter(k =>
      k.enabled === 1 && (k.channel_enabled ?? 1) === 1 && (eligModel == null || isKeyEligibleForModel(k, eligModel)),
    );
    return rankPool(keys, eligModel);
  }
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT DISTINCT k.*, p.id as provider_id, p.name as provider_name,
              p.base_url as provider_base_url, p.api_path as provider_api_path,
              p.models_path as provider_models_path, p.protocol as provider_protocol,
              ch.label as channel_name, dm.upstream_id
       FROM discovered_models dm
       JOIN keys k ON k.id = dm.key_id
       JOIN channels ch ON ch.id = k.channel_id
       JOIN providers p ON p.id = ch.provider_id
       WHERE dm.upstream_id = ? AND k.enabled = 1 AND ch.enabled = 1`,
    )
    .all(upstreamModel) as any[];

  // key.allowed_models 过滤: 限制可用模型的 Key 不能被候选池绕过
  const eligibleRows = rows.filter(r => isKeyEligibleForModel(r, eligModel ?? upstreamModel));

  if (eligibleRows.length === 0) {
    // 没有精确候选 (没 discovered / 全被 allowed_models 排除), 退化为 "任何 enabled key"
    return rankPool(listKeys().filter(k => k.enabled === 1 && (k.channel_enabled ?? 1) === 1 && (eligModel == null || isKeyEligibleForModel(k, eligModel))), upstreamModel);
  }
  // 有精确候选, 但如果全部 cooldown/failed (rankPool 会标 available=false),
  // 也退化到 "任何 enabled key" - 让 mock 等 fallback 接管
  const exactPool = rankPool(eligibleRows, upstreamModel);
  if (exactPool.available.length === 0) {
    return rankPool(listKeys().filter(k => k.enabled === 1 && (k.channel_enabled ?? 1) === 1 && (eligModel == null || isKeyEligibleForModel(k, eligModel))), upstreamModel);
  }
  return exactPool;
}

/**
 * 把 keys 列表转成 PoolResult
 */
function rankPool(keys: any[], upstreamModel: string | null): PoolResult {
  const strategy = getRoutingStrategy();
  const inputs: ScoringInput[] = keys.map((k, idx) => {
    const cd = upstreamModel ? isKeyOnCooldown(k.id, upstreamModel) : { onCooldown: false };
    const cds = getAllActiveCooldownsForKey(k.id);
    // 仅用户主动禁用才排除 — 失败/冷却/配额耗尽仍留在池中，靠评分降权
    // 这样失败 Key 可以自动恢复
    const isUserDisabled = k.enabled !== 1 || k.status === 'disabled';
    // 字段归一: selectCandidatePool 走 JOIN 用 alias (provider_base_url), listKeys() 直接拿 (base_url)
    // 统一映射成 key.base_url / key.api_path 给 tryOnce / buildUpstreamUrl 用
    if (k.provider_base_url) k.base_url = k.provider_base_url;
    if (k.provider_api_path) k.api_path = k.provider_api_path;
    return {
      key_id: k.id,
      enabled: k.enabled,
      status: k.status,
      avg_latency_ms: k.avg_latency_ms,
      success_count: k.success_count,
      failure_count: k.failure_count,
      rank_in_candidates: idx,
      weight: k.weight ?? 1,
      recent_usage_ratio: 0,  // Phase 2.6 接上
      // 配额护栏数据源: 上游 rate-limit 头 (无头 = 1.0), quota_exhausted 状态 = 0
      remaining_quota_ratio: k.status === 'quota_exhausted' ? 0 : getRemainingQuotaRatio(k.id),
      available: isUserDisabled ? 0 : 1,
      cooldown_remaining_sec: cds.length > 0 ? Math.ceil((cds[0].expires_at - Date.now()) / 1000) : undefined,
    };
  });
  const results = rankCandidates(inputs, strategy);
  const available: any[] = [];
  const unavailable: any[] = [];
  // results 已按分数排序 — 必须按 key_id 回配原 key, 不能用 keys[i] 对齐排序下标
  // (否则顺序永远是输入序, 评分/冷却/配额对排序完全失效)
  const keyById = new Map(keys.map((k) => [k.id, k]));
  for (const r of results) {
    const k = keyById.get(r.key_id);
    if (!k) continue;
    if (r.available) available.push({ key: k, score: r.score });
    else unavailable.push({ key: k, reason: r.reason ?? 'unavailable', score: r.score });
  }
  return { available, unavailable };
}

/**
 * Failover: 从 ranking 中选下一个可用 key
 * 配合 chatService 的重试循环
 */
export function pickNext(pool: PoolResult): { key: any; score: number } | null {
  return pool.available[0] ?? null;
}

// ── multi_key_mode: 同渠道多 Key 分配策略 ──────────────────────────────────

/** polling 游标 (channel_id → 下一个 index), 单进程内存即可 */
const rrCursor = new Map<number, number>();

/** 简单整数 hash (FNV-1a 变体), sticky 模式用 hub_key_id 稳定映射 */
function stableHash(n: number): number {
  let h = 2166136261;
  h = Math.imul(h ^ (n >>> 0), 16777619);
  return h >>> 0;
}

export interface MultiKeyPickOpts {
  /** 调用方 hub_key_id (sticky 模式按它固定分配) */
  hubKeyId?: number | null;
  /** 优先使用的 channel (流式: resolver 已选定的 channel; 不传 = 按评分最高 channel) */
  preferredChannelId?: number;
}

/**
 * 按渠道的 multi_key_mode 在目标渠道的候选里选 key, 并把它排到 available[0]。
 *
 * - random (默认): 随机
 * - sequential / polling: 渠道内轮询
 * - sticky: 同一 hub_key_id 永远映射到同一 key (无 hub_key 时按评分序)
 *
 * 只在"目标渠道"内部调整顺序: 跨渠道仍由评分决定, 不受影响。
 * 修复 (路由审计 F1b/F13/F14):
 * - 单 key 渠道也要提升 (原来 group.length<=1 直接返回 → 路由渠道只有1个 key 时偏好失效)
 * - 渠道内按 key id 稳定排序 (原来按评分会随 Thompson 每请求重排 → sticky≈random, polling 乱序)
 * - 整个目标渠道都在冷却时不做提升 (保持跨渠道评分序, 不把冷却 key 顶到健康 key 前面)
 */
export function applyMultiKeyMode(
  available: Array<{ key: any; score: number }>,
  opts: MultiKeyPickOpts = {},
): Array<{ key: any; score: number }> {
  if (available.length <= 1) return available;

  // 目标 channel: 调用方偏好优先 (但必须在池里), 否则取最高分 key 的 channel
  let targetChannelId: number | null = opts.preferredChannelId ?? null;
  if (targetChannelId != null && !available.some(p => p.key.channel_id === targetChannelId)) {
    targetChannelId = null;
  }
  if (targetChannelId == null) targetChannelId = available[0].key.channel_id as number;

  const group = available.filter(p => p.key.channel_id === targetChannelId);
  if (group.length === 0) return available;

  const mode = listChannels().find(c => c.id === targetChannelId)?.multi_key_mode ?? 'random';
  // 渠道内稳定序 (key id): sticky/polling 的索引必须落在确定序上
  const stableGroup = [...group].sort((a, b) => a.key.id - b.key.id);
  const healthy = stableGroup.filter(p => getAllActiveCooldownsForKey(p.key.id).length === 0);
  // F14: 目标渠道全部冷却 → 不提升, 交给跨渠道评分序 (×0.2 已经把它们排后)
  if (healthy.length === 0) return available;
  const candidates = healthy;

  let chosen;
  if (mode === 'sequential' || mode === 'polling') {
    const cur = rrCursor.get(targetChannelId) ?? 0;
    chosen = candidates[cur % candidates.length];
    rrCursor.set(targetChannelId, (cur + 1) % candidates.length);
  } else if (mode === 'sticky') {
    const h = opts.hubKeyId;
    chosen = h != null && h > 0
      ? candidates[stableHash(h) % candidates.length]
      : candidates[0];
  } else {
    // random (默认): 均匀随机
    chosen = candidates[Math.floor(Math.random() * candidates.length)];
  }
  return [chosen, ...available.filter(p => p !== chosen)];
}
