/**
 * Failover 引擎 (Phase 2 终版)
 *
 * 设计依据:
 *   - one-api Relay() 主循环: top-priority 桶内随机 + 重试跳过 lastFailed
 *   - freellmapi fallback-loop.ts: 三层 skip (skipKeys/skipModels/skipPlatforms)
 *   - 我们规格 PHASE2_DESIGN.md §3
 *
 * 关键规则:
 *   - 401  → skipKeys + 5min heuristic cooldown, 换 key
 *   - 402  → skipKeys + 24h credit cooldown, 换 key
 *   - 403  → skipModels + 24h tier cooldown, 换 model (这里直接 skipKeys 整 key)
 *   - 404  → skipModels (model not found), 不写 cooldown
 *   - 413  → skipModels (context too large), 不写 cooldown
 *   - 429  → skipKeys + 90s heuristic (或 Retry-After authoritative), 换 key
 *   - 5xx  → skipPlatforms + 30s heuristic, 同 key 可重试 1 次
 *   - 0/网络 → skipPlatforms + 30s heuristic, 同 key 可重试 1 次
 *   - 400/422 → onFatal, 立即返回, 不重试
 *
 * 同一请求内三层 skip 是非持久化的: 每个新请求重新开始
 */
import {httpSend} from '../adapters/client.js'
import {getDecryptedApiKey, recordKeyUsage} from '../db/repos/keys.js'
import {recordOutcome as recordCircuitOutcome, claimProbeSlot} from '../db/repos/circuitBreaker.js'
import {transitionKeyStatus, getEscalationLadder, recordCooldownHit, clearCooldownHits} from '../services/keyHealth.js'
import {recordUsage} from '../services/usageService.js'
import {parseJsonSafe} from '../util/json.js'
import {inflightStart, inflightEnd, inflightWeightPenalty} from '../services/inflightTracker.js'
import {recordQuotaHeaders} from '../services/quotaTracker.js'
import {selectCandidatePool, selectKeyPool, selectFallbackPool, applyMultiKeyMode, type PoolResult} from './selector.js'
import {getModelRouteByName} from '../db/repos/modelRoutes.js'
import {resolveModel} from './resolver.js'
import {listKeys} from '../db/repos/keys.js'
import {resolveRequestAlias, applyChannelModelMapping} from '../services/modelAlias.js'
import {setCooldown} from '../db/repos/cooldowns.js'
import {isLocalEndpoint} from '../util/endpoints.js'

export interface FailoverConfig {
  wallClockBudgetMs: number;
  maxCandidates: number;
  maxRetriesPerKey: number;
}

export const DEFAULT_FAILOVER_CONFIG: FailoverConfig = {
  wallClockBudgetMs: 60_000,
  maxCandidates: 5,
  maxRetriesPerKey: 1,
};

export interface ChatRequest {
  model: string;
  messages: any[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  tools?: any[];
  [k: string]: any;
}

export interface ChatAttempt {
  keyId: number;
  keyName: string;
  upstreamModel: string;
  status: number;
  body: any;
  latencyMs: number;
  fromRetry: boolean;
  /** 上游响应头 (F6: Retry-After 之前从未传进 classify → authoritative cooldown 是死代码) */
  headers?: Record<string, any>;
}

export type ChatFailureReason =
  | { kind: 'client_error'; status: number; body: any; message: string }  // 4xx (非 401/402/429/403/404/413) - 立即返回
  | { kind: 'auth_invalid' }
  | { kind: 'quota_exhausted' }
  | { kind: 'rate_limited' }
  | { kind: 'upstream_error'; message: string }
  | { kind: 'no_candidates'; reason?: string; errorKind?: 'model_not_found' | 'no_keys' }
  | { kind: 'budget_exhausted' };

export type ChatOutcome =
  | { ok: true; result: ChatAttempt; finalKeyId: number; attempts: ChatAttempt[] }
  | { ok: false; error: ChatFailureReason; attempts: ChatAttempt[] };

/** 三层 skip state - 同请求内 */
export interface SkipState {
  keys: Set<number>;
  models: Set<string>;           // upstream_model 名
  platforms: Set<number>;        // provider_id
}

/** 错误分类 (freellmapi error-classify.ts 启发) */
export interface ClassifiedError {
  kind: 'key_auth' | 'key_quota' | 'key_tier' | 'model_not_found' | 'context_too_large'
      | 'rate_limit' | 'client_error' | 'provider_error' | 'retry_ok';
  retryAfterMs?: number;
  message: string;
}

export function classifyError(status: number, body: any, headers?: Record<string, any>): ClassifiedError {
  const msg = body?.error?.message ?? body?.error ?? '';
  const msgStr = typeof msg === 'string' ? msg.toLowerCase() : '';
  // 401
  if (status === 401) return { kind: 'key_auth', message: String(msg) };
  // 402 或 insufficient_quota 字眼
  if (status === 402 || msgStr.includes('insufficient_quota') || msgStr.includes('quota_exhausted')
      || msgStr.includes('credit exhausted') || msgStr.includes('balance insufficient')) {
    return { kind: 'key_quota', message: String(msg) };
  }
  // 403 model 不在 key 等级
  if (status === 403) return { kind: 'key_tier', message: String(msg) };
  // 404 model not found - skipPlatform (one-api 思路: 是上游问题, 别的 provider 可能支持)
  if (status === 404) return { kind: 'provider_error', message: String(msg) };
  // 400/4xx 含 "unknown model" / "model not found" / "model does not exist" → provider_error
  // (e.g. minimax 返 400 "invalid params, unknown model 'X' (2013)")
  // "not a valid model" / "model_not_found" 等同"模型不存在" (OpenRouter 原话就是
  // "X is not a valid model ID") → 换渠道/换模型重试, 不能当客户端错误直接失败
  if (status >= 400 && status < 500
      && (msgStr.includes('unknown model') || msgStr.includes('model not found')
          || msgStr.includes('model does not exist') || msgStr.includes('invalid model')
          || msgStr.includes('not a valid model') || msgStr.includes('model_id')
          || msgStr.includes('model not supported'))) {
    return { kind: 'provider_error', message: String(msg) };
  }
  // 400 + 明确额度字眼 (余额/额度/欠费) → key_quota (24h 不可恢复封 Key)
  // 只认确凿的额度语义: "insufficient"/"rate limit" 这类宽泛词会把
  // "insufficient permissions" 之类普通 400 误判成额度耗尽 → 健康 Key 被永久误封
  if (status === 400 && (msgStr.includes('balance') || msgStr.includes('credit')
      || msgStr.includes('quota') || msgStr.includes('insufficient balance'))) {
    return { kind: 'key_quota', message: String(msg) };
  }
  // 400 但内容是限流 → rate_limit (可恢复阶梯冷却), 不再当额度耗尽永久封
  if (status === 400 && (msgStr.includes('rate limit') || msgStr.includes('rate_limit')
      || msgStr.includes('too many request'))) {
    return { kind: 'rate_limit', message: String(msg) };
  }
  // 400 + invalid_request_error (e.g. "inference request is invalid")
  // → provider_error (skipPlatform, 试其他 provider/key), 不是 client_error (请求格式错)
  // 区分: 真正的 client_error 通常含 "missing" / "invalid parameter" / "required field"
  if (status === 400 && body?.error?.type === 'invalid_request_error'
      && !msgStr.includes('missing') && !msgStr.includes('required')
      && !msgStr.includes('must be') && !msgStr.includes('invalid parameter')) {
    return { kind: 'provider_error', message: String(msg) };
  }
  // 413 context too large - skipModels (所有 provider 都会拒绝这个请求体)
  if (status === 413) return { kind: 'context_too_large', message: String(msg) };
  // 429
  if (status === 429) {
    // F6: 优先用真实响应头 (body.headers 是历史包袱, 上游 JSON body 里没有 retry-after)
    const ra = parseRetryAfter(headers ?? body?.headers ?? body);
    return { kind: 'rate_limit', retryAfterMs: ra, message: String(msg) };
  }
  // 5xx
  if (status >= 500 && status < 600) return { kind: 'provider_error', message: `HTTP ${status}: ${msg}` };
  // 4xx 其他: 大概率是上游临时问题 (credit/限流/维护), 应该 try 下一个 key
  // 但要排除真正的客户端错误: missing / required / must be / invalid parameter / context length
  if (status >= 400 && status < 500) {
    const isRealClientError = msgStr.includes('missing') || msgStr.includes('required')
      || msgStr.includes('must be') || msgStr.includes('invalid parameter')
      || msgStr.includes('context length') || msgStr.includes('too long')
      || msgStr.includes('invalid value') || msgStr.includes('not a valid')
      || msgStr.includes('out of range') || msgStr.includes('invalid format');
    if (!isRealClientError) {
      // 当作 provider_error, 跳过当前 key 试下一个
      return { kind: 'provider_error', message: `HTTP ${status}: ${msg}` };
    }
    return { kind: 'client_error', message: String(msg) };
  }
  return { kind: 'retry_ok', message: String(msg) };
}

function parseRetryAfter(input: any): number | undefined {
  // 既可能 body.headers 里有, 也可能直接是 retry-after 字段 (大小写不敏感)
  const ra = input?.['retry-after'] ?? input?.['Retry-After'];
  if (ra == null) return undefined;
  if (typeof ra === 'number') return ra * 1000;
  if (typeof ra === 'string') {
    // HTTP date 或 seconds
    const n = Number(ra);
    if (Number.isFinite(n)) return n * 1000;
    const d = Date.parse(ra);
    if (Number.isFinite(d)) return Math.max(0, d - Date.now());
  }
  return undefined;
}

export interface SelectCandidateOpts {
  /** hub_key_id: sticky 模式按它固定分配 */
  hubKeyId?: number | null;
  /** 优先渠道 (流式: resolver 选定的 channel) */
  preferredChannelId?: number;
}

/**
 * 选 (key, upstreamModel) 对
 * 返回 null = 该 model 整体不可用 (no candidate)
 */
/**
 * F1: 该模型若配了 enabled 的 model_routes, 返回其通道集合 (failover 不得越界), 否则 null。
 * 模型路由是用户显式指定的通道顺序 — 精确池/兜底池都必须尊重它。
 */
function getRouteChannelScope(requestModel: string): Set<number> | null {
  const route = getModelRouteByName(requestModel);
  if (!route || route.enabled !== 1) return null;
  try {
    const arr = JSON.parse(route.channel_ids);
    if (Array.isArray(arr)) {
      const ids = arr.filter((n: any) => Number.isFinite(n)).map(Number);
      if (ids.length > 0) return new Set(ids);
    }
  } catch { /* 解析失败 = 走默认作用域 */ }
  return null;
}

export function selectFirstCandidate(
  requestModel: string,
  allKeys: any[],
  state: SkipState,
  opts: SelectCandidateOpts = {},
): { key: any; upstreamModel: string; pool: PoolResult } | { error: string; errorKind?: string } {
  // 别名 / 虚拟模型解析 (审计修复: 这两套设施以前只有管理端 CRUD, 请求路径一个都没读 ——
  // 界面配好看着对, 真实请求仍按原名路由; 按别名发请求必然 400 model_not_found)。
  // 只对单段名生效: 带斜杠的是上游字面 ID (如 org/model), 改写会破坏字面路由语义。
  const alias = resolveRequestAlias(requestModel);
  if (alias?.source === 'virtual') {
    const usable = alias.candidates.filter((c) => c.usable);
    if (usable.length === 0) {
      const why = alias.candidates.map((c) => c.unusableReason ?? `候选 ${c.upstreamModel}`).join('; ')
        || '未配置任何候选';
      return { error: `虚拟模型 '${requestModel}' 没有可用候选 (${why})`, errorKind: 'no_keys' };
    }
    const tried: string[] = [];
    for (const cand of usable) {
      if (state.keys.has(cand.keyId)) { tried.push(`${cand.upstreamModel}@key${cand.keyId}: 本请求已跳过`); continue; }
      const key = allKeys.find((k: any) => k.id === cand.keyId);
      if (!key) { tried.push(`${cand.upstreamModel}@key${cand.keyId}: Key 不存在`); continue; }
      const pool = selectKeyPool(key.provider_id, cand.upstreamModel, key.channel_id);
      const entry = [...pool.available, ...pool.unavailable].find((p) => p.key.id === cand.keyId);
      if (!entry || !pool.available.find((p) => p.key.id === cand.keyId)) {
        const un = pool.unavailable.find((p) => p.key.id === cand.keyId) as { reason?: string } | undefined;
        tried.push(`${cand.upstreamModel}@key${cand.keyId}: ${un?.reason ?? '当前不可用'}`);
        continue;
      }
      return {
        key,
        upstreamModel: cand.upstreamModel,
        pool: { ...pool, available: [entry], unavailable: pool.unavailable.filter((p) => p.key.id !== cand.keyId) },
      };
    }
    return { error: `虚拟模型 '${requestModel}' 的候选当前都不可用 (${tried.join('; ')})`, errorKind: 'no_keys' };
  }
  // 全局别名: 映射后的名字才进入路由
  const effectiveModel = alias ? alias.model : requestModel;
  const r = resolveModel(effectiveModel, allKeys);
  if ('error' in r) {
    return { error: r.error, errorKind: r.errorKind };
  }

  // 强制指定 (三段 provider/key/model) - 跳过 candidate 池 (用户显式 pin, 不走 multi_key_mode)
  if (requestModel.split('/').filter(Boolean).length === 3) {
    if (state.keys.has(r.key.id)) return { error: '该 Key 已被本请求跳过' };
    if (state.models.has(r.upstreamModel)) return { error: '该 Model 已被本请求跳过' };
    if (state.platforms.has(r.key.provider_id)) return { error: '该 Provider 已被本请求跳过' };
    const pool = selectKeyPool(r.key.provider_id, r.upstreamModel, r.key.channel_id);
    // 用户显式 pin 的就是这一个 Key — 之前误用评分选出的同通道其他 Key,
    // 导致"指定付费/独立限流 Key"静默失效。现在只认 pin 的那把 (冷却与否由冷却逻辑自己说话)。
    const entry = [...pool.available, ...pool.unavailable].find(p => p.key.id === r.key.id);
    if (!entry) return { error: `指定的 Key (${r.key.label ?? '#' + r.key.id}) 当前不满足条件 (已禁用/失败/或不在该通道)` };
    return {
      key: r.key,
      upstreamModel: r.upstreamModel,
      pool: {
        ...pool,
        available: [entry],
        unavailable: pool.unavailable.filter(p => p.key.id !== r.key.id),
      },
    };
  }

  // 两段或纯 model 名 - 用 candidate 池
  if (state.models.has(r.upstreamModel)) return { error: '该 Model 已被本请求跳过' };
  // F1: 模型路由作用域 — 配了 model_routes 的模型, failover 不得越出路由指定的通道
  // 路由表配的是"对外名"; 若本名走了别名映射, 要用映射后的名字去查作用域
  const routeScope = getRouteChannelScope(effectiveModel);
  // Phase 2 候选池 (精确 discovered)
  let pool = selectCandidatePool(r.upstreamModel);
  // 过滤已被 skip 的
  pool.available = pool.available.filter(p =>
    !state.keys.has(p.key.id) && !state.platforms.has(p.key.provider_id)
  );
  if (routeScope) {
    pool.available = pool.available.filter(p => routeScope.has(p.key.channel_id));
  }
  // 如果精确候选全 skip 或 unavailable, 兜底到"配置了该模型的通道" (F1: 不再 any-key 跨通道乱砸)
  if (pool.available.length === 0) {
    pool = selectFallbackPool(r.upstreamModel, routeScope);
    pool.available = pool.available.filter(p =>
      !state.keys.has(p.key.id) && !state.platforms.has(p.key.provider_id)
    );
  }
  if (pool.available.length === 0) {
    if (routeScope) {
      return { error: `模型路由配置的通道 ${[...routeScope].join(',')} 无可用 Key (均被跳过或未配置该模型)`, errorKind: 'no_keys' };
    }
    if (pool.unavailable.length === 0) {
      return { error: `没有通道配置模型 '${r.upstreamModel}'。请检查模型列表或在「渠道」中添加该模型`, errorKind: 'model_not_found' };
    }
    return { error: pool.unavailable[0]?.reason ?? '没有可用的 candidate' };
  }
  // Phase 4.C: 按 in-flight penalty 降序排序 — 空闲 key (权重 1.0) 优先, 在途多的 (1/(1+n)) 排后
  // 修复: 之前写成升序, 在途多的反而排第一 → 并发请求全堆到同一个忙 key
  pool.available.sort((a, b) => {
    return inflightWeightPenalty(b.key.id, r.upstreamModel) - inflightWeightPenalty(a.key.id, r.upstreamModel);
  });
  // multi_key_mode: 目标渠道内按 random/polling/sticky 选 key, 并排到最前
  // F1a: 非流式路径之前只传 {hubKeyId} → resolver/model_routes 选定的渠道被评分序覆盖,
  // 路由表只起了"非空校验"作用。≤2 段名用 resolver 返回的渠道 (r.key) 作为偏好, 与流式路径一致。
  pool.available = applyMultiKeyMode(pool.available, {
    hubKeyId: opts.hubKeyId ?? null,
    preferredChannelId: opts.preferredChannelId ?? r.key?.channel_id ?? undefined,
    upstreamModel: r.upstreamModel,
  });
  // 渠道级 model_mapping: 本渠道把对外名翻译成上游真实名 (审计修复: 以前存着从不读)。
  const chosen = pool.available[0];
  const mapped = applyChannelModelMapping(chosen.key.channel_model_mapping, r.upstreamModel);
  if (mapped) {
    console.log(`[model-alias] 渠道级映射: ${r.upstreamModel} → ${mapped} (channel ${chosen.key.channel_id})`);
  }
  return { key: chosen.key, upstreamModel: mapped ?? r.upstreamModel, pool };
}

/**
 * 主入口 - 非流式 chat with failover
 */
export async function chatWithFailover(
  req: ChatRequest,
  hubKeyId: number | null,
  config: FailoverConfig = DEFAULT_FAILOVER_CONFIG,
): Promise<ChatOutcome> {
  const start = Date.now();
  const allKeys = listKeys();
  const state: SkipState = { keys: new Set(), models: new Set(), platforms: new Set() };
  const attempts: ChatAttempt[] = [];
  let lastCls: ClassifiedError | null = null;  // F2: 保留最后一次分类, 决定最终错误语义

  // 第一次选
  let first = selectFirstCandidate(req.model, allKeys, state, { hubKeyId });
  if ('error' in first) {
    const ek = (first.errorKind === 'model_not_found' || first.errorKind === 'no_keys')
      ? first.errorKind : undefined;
    return {
      ok: false,
      error: { kind: 'no_candidates', reason: first.error, errorKind: ek },
      attempts,
    };
  }

  for (let i = 0; i < config.maxCandidates; i++) {
    // Budget 检查 (attempt 0 必跑, attempt 1+ 受约束, 对齐 freellmapi #751)
    if (i > 0 && Date.now() - start > config.wallClockBudgetMs) {
      return { ok: false, error: { kind: 'budget_exhausted' }, attempts };
    }
    // Pool 可能被前面的失败耗尽, 重新选
    if (i > 0 || !first) {
      first = selectFirstCandidate(req.model, allKeys, state, { hubKeyId });
      if ('error' in first) break;
    }
    const pool = first.pool;
    if (pool.available.length === 0) break;

    const pick = pool.available[0];
    const key = pick.key;
    const upstreamModel = first.upstreamModel;

    // 同 key 最多重试 maxRetriesPerKey 次 (5xx / 网络)
    for (let retry = 0; retry <= config.maxRetriesPerKey; retry++) {
      const result = await tryOnce(key, upstreamModel, req, hubKeyId, retry > 0);
      attempts.push(result);
      if (result.status >= 200 && result.status < 300) {
        // 成功 - 清该 key 的 hit 计数
        clearCooldownHits(key.id);
        return { ok: true, result, finalKeyId: key.id, attempts };
      }

      // 错误分类 + 处置
      const cls = classifyError(result.status, result.body, result.headers);
      lastCls = cls;
      const decision = handleFailure(cls, result, key, upstreamModel, state, req.model);

      if (decision === 'onFatal') {
        return { ok: false, error: { kind: 'client_error', status: result.status, body: result.body, message: cls.message }, attempts };
      }
      if (decision === 'stop') {
        // 没有更多 candidate 可试
        return { ok: false, error: toTopLevelError(cls), attempts };
      }
      // F3: 5xx/网络错误同 key 重试 (原实现 retry=0 就 break → maxRetriesPerKey 是死配置,
      // 上游抖一下就直接判整个请求失败)。只对 5xx/网络重试 — 404/400 类 provider_error
      // 是确定性错误, 重试同 key 只会浪费一次上游调用
      const retryable = (cls.kind === 'provider_error' && result.status >= 500) || cls.kind === 'retry_ok';
      if (retryable && retry < config.maxRetriesPerKey) continue;
      // 'continue' 跳出 retry 循环, 进入下一个 candidate
      break;
    }
  }

  // F2: 全部 candidate 失败时带上最后的错误分类 — 原实现永远返回裸 no_candidates →
  // 客户端一律收到 HTTP 404 "没有可用的 Key" (上游全 401/402/429 也404), 与流式路径不一致
  if (lastCls) return { ok: false, error: toTopLevelError(lastCls), attempts };
  return { ok: false, error: { kind: 'no_candidates' }, attempts };
}

export function toTopLevelError(cls: ClassifiedError): ChatFailureReason {
  switch (cls.kind) {
    case 'key_auth': return { kind: 'auth_invalid' };
    case 'key_quota': return { kind: 'quota_exhausted' };
    case 'rate_limit': return { kind: 'rate_limited' };
    default: return { kind: 'upstream_error', message: cls.message };
  }
}

/**
 * 失败处置:
 *   - onFatal: 4xx 不可重试, 立即返回给客户端
 *   - stop:    没更多 candidate, 返回通用错误
 *   - continue: 加 skip + cooldown, 试下一个
 */
export function handleFailure(
  cls: ClassifiedError,
  result: ChatAttempt,
  key: any,
  upstreamModel: string,
  state: SkipState,
  _requestModel: string,
): 'onFatal' | 'stop' | 'continue' {
  const k = key.id;
  const pid = key.provider_id;

  switch (cls.kind) {
    case 'key_auth': {
      // 401: skipKey + 5min heuristic cooldown
      state.keys.add(k);
      setCooldown({
        keyId: k,
        reason: 'auth',
        upstreamModel: null,
        durationMs: 5 * 60 * 1000,
        recoverable: true,
        source: 'heuristic',
      });
      return 'continue';
    }
    case 'key_quota': {
      // 402 / insufficient_quota: skipKey + 24h credit cooldown
      // 记到"出错的这个模型"上而不是整把 Key: 混搭 Key (OpenRouter 免费模型 + 付费模型)
      // 若整把封, 付费模型欠费会连带打死免费模型 —— 免费模型本就没欠费。
      // 真正的"余额耗尽"会逐个模型各记一条, 效果等价于整把停用。
      state.keys.add(k);
      setCooldown({
        keyId: k,
        reason: 'quota',
        upstreamModel,
        durationMs: 24 * 60 * 60 * 1000,
        recoverable: false,
        source: 'credit',
      });
      return 'continue';
    }
    case 'key_tier': {
      // 403: skipKey (该 model 在该 key 的档位不可用 — 只跳这个 key,
      // 让同 model 的其他 provider 继续 failover; 原实现 skipModel 是请求级全局跳,
      // 一个 403 就杀掉整个跨渠道候选)
      state.keys.add(k);
      setCooldown({
        keyId: k,
        reason: 'tier',
        upstreamModel,
        durationMs: 24 * 60 * 60 * 1000,
        recoverable: false,
        source: 'tier',
      });
      return 'continue';
    }
    case 'model_not_found': {
      // 404: 实际上分类到 provider_error (别的 provider 可能有), 不会到这里
      // 留个 fallback
      state.models.add(upstreamModel);
      return 'continue';
    }
    case 'context_too_large': {
      // 413: skipModel, 不写 cooldown
      state.models.add(upstreamModel);
      return 'continue';
    }
    case 'rate_limit': {
      // 429: skipKey + heuristic (90s) 或 authoritative (Retry-After)
      state.keys.add(k);
      const retryAfter = cls.retryAfterMs ?? 0;
      const heuristicMs = 90_000;
      if (retryAfter > heuristicMs) {
        setCooldown({
          keyId: k,
          reason: 'rate_limit',
          upstreamModel,
          durationMs: Math.min(retryAfter, 24 * 60 * 60 * 1000),
          recoverable: false,
          source: 'authoritative',
        });
      } else {
        // heuristic + escalation ladder
        // 先 record hit 再查 (freellmapi 顺序: push 数组后用 length 算 idx)
        if (!isLocalEndpoint(key.base_url)) {
          recordCooldownHit(k);
        }
        const ladderMs = getEscalationLadder(k);   // 现在 hits 包含本次 → ladder[0] = 2 min
        const isLocal = isLocalEndpoint(key.base_url);
        const finalMs = isLocal ? 5_000 : ladderMs;
        setCooldown({
          keyId: k,
          reason: 'rate_limit',
          upstreamModel,
          durationMs: finalMs,
          recoverable: true,
          source: 'heuristic',
        });
      }
      return 'continue';
    }
    case 'provider_error':
    case 'retry_ok': {
      // 5xx / 网络: skipPlatform + 30s heuristic
      state.platforms.add(pid);
      const isLocal = isLocalEndpoint(key.base_url);
      setCooldown({
        keyId: k,
        // reason 名与 keyHealth 一致 ('transient_error'): 否则同一个 (key, model) 会
        // 因为两个 reason 名各写一行冷却, UNIQUE(key_id, reason, model) 去不了重
        reason: 'transient_error',
        upstreamModel: upstreamModel,
        durationMs: isLocal ? 5_000 : 30_000,
        recoverable: true,
        source: 'heuristic',
      });
      // provider 错误还可以让同 key 重试一次 (handled in outer loop)
      return 'continue';
    }
    case 'client_error': {
      // 4xx 其他: 立即返回, 不重试
      return 'onFatal';
    }
  }
}

async function tryOnce(
  key: any,
  upstreamModel: string,
  req: ChatRequest,
  hubKeyId: number | null,
  fromRetry: boolean,
): Promise<ChatAttempt> {
  const apiKey = getDecryptedApiKey(key.id);
  const url = `${(key.base_url ?? '').replace(/\/$/, '')}${key.api_path ?? '/v1/chat/completions'}`;
  const upstreamReq = { ...req, model: upstreamModel, stream: false };
  const start = Date.now();
  inflightStart(key.id, upstreamModel);

  try {
    const send = await getHttpSend();
    // 4th arg = null: 由下面 tryOnce 统一记录一次 (httpSend 内部会重复 recordKeyUsage → 统计翻倍)
    const res = await send(url, apiKey, {
      method: 'POST',
      body: JSON.stringify(upstreamReq),
      timeoutMs: 60_000,
    }, null);
    const latencyMs = Date.now() - start;
    recordQuotaHeaders(key.id, res.headers);
    transitionKeyStatus(key.id, { status: res.status, body: parseJsonSafe(res.body), upstreamModel });
    recordKeyUsage(key.id, res.status >= 200 && res.status < 300, latencyMs);
    // 熔断器 + EWMA: 5xx/429/408 算熔断级失败; 4xx 客户端错误与 401/402/403 不算
    const okRes = res.status >= 200 && res.status < 300;
    recordCircuitOutcome(key.id, upstreamModel, okRes, latencyMs, {
      breakerFailure: !okRes && (res.status >= 500 || res.status === 429 || res.status === 408),
    });
    const body = parseJsonSafe(res.body);
    const usage = body?.usage ?? {};
    recordUsage({
      hub_key_id: hubKeyId,
      key_id: key.id,
      provider_name: key.provider_name,
      request_model: req.model,
      routed_model: upstreamModel,
      prompt_tokens: usage.prompt_tokens,
      completion_tokens: usage.completion_tokens,
      total_tokens: usage.total_tokens,
      latency_ms: latencyMs,
      status: res.status >= 200 && res.status < 300 ? 'success' : 'error',
      error_code: res.status >= 400 ? res.status : null,
      error_type:
        res.status === 401 ? 'auth' :
        res.status === 402 ? 'quota' :
        res.status === 429 ? 'rate_limit' :
        res.status >= 500 ? 'upstream' :
        res.status >= 400 ? 'client' : null,
      error_message: res.status >= 400 ? extractMessage(body) : null,
      stream: 0,
    });
    return {
      keyId: key.id,
      keyName: key.label ?? `key#${key.id}`,
      upstreamModel,
      status: res.status,
      body,
      latencyMs,
      fromRetry,
      headers: res.headers,
    };
  } catch (e: any) {
    const latencyMs = Date.now() - start;
    transitionKeyStatus(key.id, { status: 0, error: e.message, upstreamModel });
    recordKeyUsage(key.id, false, latencyMs);
    // 连接失败/超时 = 熔断级失败 (这是熔断器最主要的触发源)
    recordCircuitOutcome(key.id, upstreamModel, false, latencyMs, { breakerFailure: true });
    recordUsage({
      hub_key_id: hubKeyId,
      key_id: key.id,
      provider_name: key.provider_name,
      request_model: req.model,
      routed_model: upstreamModel,
      latency_ms: latencyMs,
      status: 'error',
      error_type: 'upstream',
      error_message: e.message,
      stream: 0,
    });
    return {
      keyId: key.id,
      keyName: key.label ?? `key#${key.id}`,
      upstreamModel,
      status: 0,
      body: { error: e.message },
      latencyMs,
      fromRetry,
    };
  } finally {
    inflightEnd(key.id, upstreamModel, Date.now() - start);
  }
}

export function extractMessage(body: any): string {
  if (!body) return '';
  if (body.error?.message) return body.error.message;
  if (typeof body.error === 'string') return body.error;
  return JSON.stringify(body).slice(0, 200);
}

// DI: 让测试可以 mock httpSend
let httpSendForTest: typeof httpSend | null = null;
export function setHttpSendForTest(fn: typeof httpSend | null): void {
  httpSendForTest = fn;
}
async function getHttpSend() {
  if (httpSendForTest) return httpSendForTest;
  return httpSend;
}
