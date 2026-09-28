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
import {transitionKeyStatus, getEscalationLadder, recordCooldownHit, clearCooldownHits} from '../services/keyHealth.js'
import {recordUsage} from '../services/usageService.js'
import {parseJsonSafe} from '../util/json.js'
import {inflightStart, inflightEnd, inflightWeightPenalty} from '../services/inflightTracker.js'
import {recordQuotaHeaders} from '../services/quotaTracker.js'
import {selectCandidatePool, selectKeyPool, applyMultiKeyMode, type PoolResult} from './selector.js'
import {resolveModel} from './resolver.js'
import {listKeys} from '../db/repos/keys.js'
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
  if (status >= 400 && status < 500
      && (msgStr.includes('unknown model') || msgStr.includes('model not found')
          || msgStr.includes('model does not exist') || msgStr.includes('invalid model'))) {
    return { kind: 'provider_error', message: String(msg) };
  }
  // 400 + 配额/限流关键词 (SenseNova/MiniMax 返 invalid_request_error 但实际是 credit/rate-limit)
  // → key_quota (skipKey 换下一个 key)
  if (status === 400 && (msgStr.includes('balance') || msgStr.includes('credit')
      || msgStr.includes('quota') || msgStr.includes('rate limit')
      || msgStr.includes('insufficient'))) {
    return { kind: 'key_quota', message: String(msg) };
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
export function selectFirstCandidate(
  requestModel: string,
  allKeys: any[],
  state: SkipState,
  opts: SelectCandidateOpts = {},
): { key: any; upstreamModel: string; pool: PoolResult } | { error: string; errorKind?: string } {
  const r = resolveModel(requestModel, allKeys);
  if ('error' in r) {
    return { error: r.error, errorKind: r.errorKind };
  }

  // 强制指定 (三段 provider/key/model) - 跳过 candidate 池 (用户显式 pin, 不走 multi_key_mode)
  if (requestModel.split('/').filter(Boolean).length === 3) {
    if (state.keys.has(r.key.id)) return { error: '该 Key 已被本请求跳过' };
    if (state.models.has(r.upstreamModel)) return { error: '该 Model 已被本请求跳过' };
    if (state.platforms.has(r.key.provider_id)) return { error: '该 Provider 已被本请求跳过' };
    const pool = selectKeyPool(r.key.provider_id, r.upstreamModel, r.key.channel_id);
    // 过滤已被 skip 的
    pool.available = pool.available.filter(p => !state.keys.has(p.key.id));
    if (pool.available.length === 0) return { error: '该 Key 当前不可用' };
    return { key: pool.available[0].key, upstreamModel: r.upstreamModel, pool };
  }

  // 两段或纯 model 名 - 用 candidate 池
  if (state.models.has(r.upstreamModel)) return { error: '该 Model 已被本请求跳过' };
  // Phase 2 候选池 (精确 discovered)
  let pool = selectCandidatePool(r.upstreamModel);
  // 过滤已被 skip 的
  pool.available = pool.available.filter(p =>
    !state.keys.has(p.key.id) && !state.platforms.has(p.key.provider_id)
  );
  // 如果精确候选全 skip 或 unavailable, 退化到 "any enabled key" (mock 等 fallback 接管)
  if (pool.available.length === 0) {
    pool = selectCandidatePool('__any__', r.upstreamModel);
    pool.available = pool.available.filter(p =>
      !state.keys.has(p.key.id) && !state.platforms.has(p.key.provider_id)
    );
  }
  if (pool.available.length === 0) {
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
  });
  return { key: pool.available[0].key, upstreamModel: r.upstreamModel, pool };
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
      state.keys.add(k);
      setCooldown({
        keyId: k,
        reason: 'quota',
        upstreamModel: null,
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
        reason: 'transient',
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
