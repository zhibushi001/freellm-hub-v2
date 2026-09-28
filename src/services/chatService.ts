/**
 * Chat 服务 - 封装 failover 引擎，提供 chatCompletion 和 chatStream
 */
import {
  chatWithFailover,
  selectFirstCandidate,
  classifyError,
  handleFailure,
  toTopLevelError,
  extractMessage,
  DEFAULT_FAILOVER_CONFIG,
  type ChatRequest,
  type SkipState,
  type ClassifiedError,
} from '../routing/failover.js';
import { httpStream } from '../adapters/client.js';
import { getDecryptedApiKey, recordKeyUsage } from '../db/repos/keys.js';
import { resolveModel } from '../routing/resolver.js';
import { listKeys } from '../db/repos/keys.js';
import { transitionKeyStatus } from './keyHealth.js';
import { recordUsage } from './usageService.js';
import { recordQuotaHeaders } from './quotaTracker.js';
import { parseJsonSafe } from '../util/json.js';
import { inflightStart, inflightEnd } from './inflightTracker.js';
import { clearCooldownHits } from '../db/repos/cooldowns.js';
import { checkInputContent } from './guardrailsService.js';

/** B10: 输入内容护栏 — Guardrails 页承诺"保存后立即生效, 拦截返回400", 但 check 从未被调用。
 *  统一挂在 chatService 入口 → /v1/chat、/v1/messages(Anthropic)、/v1/responses 全部覆盖。
 *  输出侧 checkOutputContent 需要流式缓冲, 暂未接入。 */
function guardInput(req: ChatRequest): { error: string; status: number } | null {
  try {
    const text = (req.messages ?? [])
      .map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')))
      .join('\n');
    const gate = checkInputContent(text);
    if (!gate.allowed) return { error: gate.reason ?? '输入被内容护栏拦截', status: 400 };
  } catch { /* 护栏故障不阻断正常请求 */ }
  return null;
}
import { buildUpstreamRequest, buildUpstreamUrl } from '../adapters/openai.js';
import {
  type ChatMessage,
  type ChatConversation,
  listConversations,
  getConversation,
  createConversation,
  addMessage,
  updateConversationTitle,
  deleteConversation,
  clearConversationMessages,
  getConversationStats,
} from './conversationService.js';

// 重新导出 conversation 相关类型和函数
export {
  type ChatMessage,
  type ChatConversation,
  listConversations,
  getConversation,
  createConversation,
  addMessage,
  updateConversationTitle,
  deleteConversation,
  clearConversationMessages,
  getConversationStats,
};

export interface ChatResult {
  status: number;
  body: any;
  keyId: number;
  keyName: string;
  upstreamModel: string;
  latencyMs: number;
  attempts?: number;
}

export interface ChatStreamHandle {
  status: number;
  headers: any;
  body: NodeJS.ReadableStream;
  keyId: number;
  keyName: string;
  upstreamModel: string;
  latencyMs: number;
  onStreamEnd?: () => void;
}

export type ChatCompletionResult =
  | ChatResult
  | { error: string; status: number; details?: any; attempts?: number };

/**
 * 非流式 chat - 使用 failover 引擎
 */
export async function chatCompletion(
  req: ChatRequest,
  hubKeyId: number | null,
): Promise<ChatCompletionResult> {
  const blocked = guardInput(req);
  if (blocked) return { error: blocked.error, status: blocked.status };
  const r = await chatWithFailover(req, hubKeyId);
  if (!r.ok) {
    return {
      error: errorMessage(r.error),
      status: errorStatus(r.error),
      details: r.error,
      attempts: r.attempts.length,
    };
  }
  const a = r.result;
  return {
    status: a.status,
    body: a.body,
    keyId: a.keyId,
    keyName: a.keyName,
    upstreamModel: a.upstreamModel,
    latencyMs: a.latencyMs,
    attempts: r.attempts.length,
  };
}

function errorMessage(e: any): string {
  switch (e.kind) {
    case 'no_candidates':
      // P1-4: 区分 model_not_found vs no_keys, 使用 resolver 给出的 reason
      return e.reason || (e.errorKind === 'model_not_found' ? '模型不存在' : '没有可用的 Key');
    case 'budget_exhausted': return '请求超过 wall-clock budget';
    case 'client_error': return e.message;
    case 'auth_invalid': return '所有 Key 都 401 失败';
    case 'quota_exhausted': return '所有 Key 都额度耗尽';
    case 'rate_limited': return '所有 Key 都触发速率限制';
    case 'upstream_error': return '上游持续错误: ' + e.message;
    default: return '未知错误';
  }
}

function errorStatus(e: any): number {
  switch (e.kind) {
    case 'client_error': return e.status;
    case 'no_candidates':
      // P1-4: 区分 model_not_found (400 客户端错误) vs no_keys (404 资源不可用)
      return e.errorKind === 'model_not_found' ? 400 : 404;
    case 'budget_exhausted': return 504;
    case 'auth_invalid': return 502;
    case 'quota_exhausted': return 502;
    case 'rate_limited': return 429;
    case 'upstream_error': return 502;
    default: return 500;
  }
}

/**
 * 流式 chat - 带 failover (修复: 之前只试一个 key, 失败直接 502)
 *
 * 切换时机: 流开始前 (连接失败 / 非 2xx) 自动按 skip 三层 + cooldown 换 key/渠道重试;
 * 流一旦开始 (2xx 首包) 就不再切换 — 数据已吐给客户端。
 */
export async function chatStream(
  req: ChatRequest,
  hubKeyId: number | null,
): Promise<ChatStreamHandle | { error: string; status: number }> {
  const blockedB = guardInput(req);
  if (blockedB) return blockedB;
  const allKeys = listKeys();
  const resolved = resolveModel(req.model, allKeys);
  if ('error' in resolved) {
    // 区分: 模型名不存在 (400 客户端错误) vs 模型存在但无可用 Key (503 资源不可用)
    const status = resolved.errorKind === 'model_not_found' ? 400 : 503;
    return { error: resolved.error, status };
  }

  const start = Date.now();
  const config = DEFAULT_FAILOVER_CONFIG;
  const state: SkipState = { keys: new Set(), models: new Set(), platforms: new Set() };
  const parts = req.model.split('/').filter(Boolean);
  const selectOpts = {
    hubKeyId,
    // 三段式是用户显式 pin (selectFirstCandidate 内部处理), 其余按 resolver 选定的渠道优先
    preferredChannelId: parts.length === 3 ? undefined : resolved.key.channel_id,
  };
  let lastCls: ClassifiedError | null = null;
  const failWith = (cls: ClassifiedError): { error: string; status: number } => {
    const top = toTopLevelError(cls);
    return { error: errorMessage(top), status: errorStatus(top) };
  };

  for (let i = 0; i < config.maxCandidates; i++) {
    // Budget: attempt 0 必跑, 之后受 wall-clock 约束 (与非流式一致)
    if (i > 0 && Date.now() - start > config.wallClockBudgetMs) {
      return { error: errorMessage({ kind: 'budget_exhausted' }), status: errorStatus({ kind: 'budget_exhausted' }) };
    }

    const pick = selectFirstCandidate(req.model, allKeys, state, selectOpts);
    if ('error' in pick) {
      if (lastCls) return failWith(lastCls);
      const status = pick.errorKind === 'model_not_found' ? 400 : 503;
      return { error: pick.error, status };
    }
    const key = pick.key;
    const upstreamModel = pick.upstreamModel;
    const attempt = (): any => ({
      keyId: key.id,
      keyName: key.label ?? `key#${key.id}`,
      upstreamModel,
      status: 0,
      body: null,
      latencyMs: 0,
      fromRetry: false,
    });

    // F12: 解密失败 (master.key 变更/密钥损坏) 原来直接抛出 → 500 且不计失败,
    // 坏 key 永远赢评分继续抛错。这里按 key_auth 跳过 +5min cooldown, 自动恢复
    let apiKey: string;
    try {
      apiKey = getDecryptedApiKey(key.id);
    } catch (e: any) {
      const failCls: ClassifiedError = { kind: 'key_auth', message: `key 解密失败: ${e.message}` };
      lastCls = failCls;
      handleFailure(failCls, attempt(), key, upstreamModel, state, req.model);
      continue;
    }
    const url = buildUpstreamUrl(key);
    const upstreamReq = buildUpstreamRequest(req, upstreamModel);
    const attemptStart = Date.now();
    inflightStart(key.id, upstreamModel);

    // ── 1) 连接上游 ─────────────────────────────────────────────
    let res;
    try {
      res = await httpStream(url, apiKey, {
        method: 'POST',
        body: JSON.stringify({ ...upstreamReq, stream: true }),
        // F11: 原来传0 → undici headersTimeout 被禁用, 上游 accept 了连接但不回包时
        // 请求永久挂起 (budget 只在 candidate 之间检查, 永远轮不到)
        timeoutMs: 30_000,
      }, null); // null: 统一在下面记录一次, 避免 httpStream 内部重复计数
    } catch (e: any) {
      const latencyMs = Date.now() - attemptStart;
      inflightEnd(key.id, upstreamModel, latencyMs);
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
        stream: 1,
      });
      // 网络错误: 走 retry_ok 分支 → skipPlatform +30s cooldown, 换下一个 candidate
      const cls: ClassifiedError = { kind: 'retry_ok', message: e.message };
      lastCls = cls;
      const decision = handleFailure(cls, { ...attempt(), latencyMs }, key, upstreamModel, state, req.model);
      if (decision === 'onFatal') return { error: cls.message, status: 502 };
      if (decision === 'stop') return failWith(cls);
      continue;
    }

    const latencyMs = Date.now() - attemptStart;

    // ── 2) 2xx → 流开始, 交给调用方 (不再切换) ────────────────────
    if (res.status >= 200 && res.status < 300) {
      recordQuotaHeaders(key.id, res.headers);
      transitionKeyStatus(key.id, { status: res.status, body: undefined, upstreamModel });
      recordKeyUsage(key.id, true, latencyMs);
      // F7: 成功也要清 ladder hit 计数 — 原来只有非流式路径清, 纯流式服务的
      // 429 计数只涨不落 → cooldown 稳定爬到 24h 永不回落
      clearCooldownHits(key.id);
      recordUsage({
        hub_key_id: hubKeyId,
        key_id: key.id,
        provider_name: key.provider_name,
        request_model: req.model,
        routed_model: upstreamModel,
        latency_ms: latencyMs,
        status: 'success',
        error_code: null,
        error_type: null,
        error_message: null,
        stream: 1,
      });
      return {
        status: res.status,
        headers: res.headers,
        body: res.body as unknown as NodeJS.ReadableStream,
        keyId: key.id,
        keyName: key.label ?? `key#${key.id}`,
        upstreamModel,
        latencyMs,
        onStreamEnd: () => inflightEnd(key.id, upstreamModel, Date.now() - attemptStart),
      };
    }

    // ── 3) 非 2xx → 缓冲错误 body, 分类, 换 key/渠道重试 ──────────
    const errText = await readBodyCapped(res.body, 64 * 1024);
    const errBody = parseJsonSafe(errText);
    inflightEnd(key.id, upstreamModel, latencyMs);
    recordQuotaHeaders(key.id, res.headers);
    transitionKeyStatus(key.id, { status: res.status, body: errBody, upstreamModel });
    recordKeyUsage(key.id, false, latencyMs);
    recordUsage({
      hub_key_id: hubKeyId,
      key_id: key.id,
      provider_name: key.provider_name,
      request_model: req.model,
      routed_model: upstreamModel,
      latency_ms: latencyMs,
      status: 'error',
      error_code: res.status >= 400 ? res.status : null,
      error_type:
        res.status === 401 ? 'auth' :
        res.status === 402 ? 'quota' :
        res.status === 429 ? 'rate_limit' :
        res.status >= 500 ? 'upstream' :
        res.status >= 400 ? 'client' : 'upstream',
      error_message: extractMessage(errBody),
      stream: 1,
    });

    const cls = classifyError(res.status, errBody, res.headers);
    lastCls = cls;
    const decision = handleFailure(cls, { ...attempt(), status: res.status, body: errBody, latencyMs }, key, upstreamModel, state, req.model);
    if (decision === 'onFatal') {
      // 真正的客户端错误 (400/422 等): 原样透传状态码, 不重试
      return { error: cls.message, status: res.status };
    }
    if (decision === 'stop') return failWith(cls);
    // continue → 下一个 candidate
  }

  // 候选耗尽
  if (lastCls) return failWith(lastCls);
  return { error: '没有可用的 Key (所有都在 cooldown 或失败)', status: 503 };
}

/** 读取上游错误 body (上限 64KB), 避免错误响应拖垮网关 */
async function readBodyCapped(stream: any, cap: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      const buf = Buffer.from(chunk);
      chunks.push(buf);
      size += buf.length;
      if (size >= cap) break;
    }
  } catch { /* 连接中断忽略 */ }
  try { stream.destroy?.(); } catch { /* 释放连接 */ }
  return Buffer.concat(chunks).toString('utf8').slice(0, cap);
}
