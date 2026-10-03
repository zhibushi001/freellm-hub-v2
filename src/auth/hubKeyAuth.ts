/**
 * Hub Key 鉴权中间件
 * 从 Authorization: Bearer fh_... 提取并验证
 */
import type { FastifyRequest, FastifyReply } from 'fastify';
import { getHubKeyByHash, recordHubKeyUsage, parseAllowedModels } from '../db/repos/hubKeys.js';
import { checkHubKeyQuota } from '../services/quota.js';

declare module 'fastify' {
  interface FastifyRequest {
    hubKey?: {
      id: number;
      name: string;
      prefix: string;
      /** null = 不限制; 数组 = 只允许调用列表中的模型 */
      allowed_models: string[] | null;
      /** 配额: rpm / 日预算 / 月预算 (null = 不限) —— 之前 rpm 字段存了但从不执行 */
      rate_limit_rpm: number | null;
      daily_budget_usd: number | null;
      monthly_budget_usd: number | null;
    };
  }
}

export interface AuthFailure {
  code: string;
  message: string;
}

/**
 * 判断 Hub Key 是否允许调用指定模型
 * - allowed_models 为 null: 不限制, 允许
 * - 否则 model 必须精确出现在列表中
 */
export function isHubKeyAllowedForModel(hubKey: NonNullable<FastifyRequest['hubKey']>, model: string | null | undefined): boolean {
  if (!hubKey.allowed_models || hubKey.allowed_models.length === 0) return true;
  if (!model) return true;
  // 支持 'provider/model' 形式的完整名与纯模型名两种写法
  const requested = model;
  const bare = requested.includes('/') ? requested.split('/').pop()! : requested;
  return hubKey.allowed_models.includes(requested) || hubKey.allowed_models.includes(bare);
}

export function authenticateHubKey(req: FastifyRequest, reply?: FastifyReply):
  | { ok: true; hubKey: NonNullable<FastifyRequest['hubKey']> }
  | { ok: false; error: AuthFailure; quotaExceeded?: boolean } {
  // 同时支持两种 header:
  //   - Authorization: Bearer fh_<64hex> (OpenAI 风格, 主流)
  //   - x-api-key: fh_<64hex> (Anthropic 风格, Claude Code 默认)
  const auth = req.headers['authorization'];
  const xApiKey = req.headers['x-api-key'];
  let plain: string | null = null;
  if (typeof auth === 'string') {
    const m = auth.match(/^Bearer\s+(.+)$/);
    if (m) plain = m[1].trim();
  }
  if (!plain && typeof xApiKey === 'string') {
    plain = xApiKey.trim();
  }
  if (!plain) {
    return { ok: false, error: { code: 'hub_key_missing', message: '缺少 Authorization / x-api-key header. 用法: Authorization: Bearer fh_<64hex> 或 x-api-key: fh_<64hex>' } };
  }
  if (!plain.startsWith('fh_') || plain.length !== 67) {
    return { ok: false, error: { code: 'hub_key_invalid', message: 'Hub Key 无效. 请检查是否拼写错误. (期望 fh_<64hex>)' } };
  }
  const key = getHubKeyByHash(plain);
  if (!key) {
    return { ok: false, error: { code: 'hub_key_not_found', message: 'Hub Key 已被删除. 请在 Hub 后台创建新的.' } };
  }
  if (key.enabled === 0) {
    // P3-3: 不向客户端泄露 key.name, 仅返回通用提示
    return { ok: false, error: { code: 'hub_key_disabled', message: 'Hub Key 已被禁用. 请在 Hub 后台启用.' } };
  }
  if (key.expires_at && key.expires_at < Date.now()) {
    return { ok: false, error: { code: 'hub_key_expired', message: `Hub Key 已过期 (${key.name}). 请在 Hub 后台重新生成.` } };
  }
  // 记录使用
  recordHubKeyUsage(key.id);
  // 配额硬限 (RPM / 日预算 / 月预算): 超了直接 429。
  // 放在这里 = 所有 /v1/* 端点 (chat / stream / embeddings / images / audio / anthropic) 一次覆盖,
  // 新加端点不会漏掉。
  const quota = checkHubKeyQuota(key.id, {
    rate_limit_rpm: key.rate_limit_rpm,
    daily_budget_usd: key.daily_budget_usd,
    monthly_budget_usd: key.monthly_budget_usd,
  });
  if (!quota.allowed) {
    if (quota.retry_after_sec && reply) reply.header('retry-after', String(quota.retry_after_sec));
    return {
      ok: false,
      error: { code: quota.code!, message: quota.message! },
      quotaExceeded: true,
    };
  }
  return {
    ok: true,
    hubKey: {
      id: key.id,
      name: key.name,
      prefix: key.key_prefix,
      allowed_models: parseAllowedModels(key.allowed_models),
      rate_limit_rpm: key.rate_limit_rpm ?? null,
      daily_budget_usd: key.daily_budget_usd ?? null,
      monthly_budget_usd: key.monthly_budget_usd ?? null,
    },
  };
}

/**
 * Fastify preHandler 风格
 */
export async function requireHubKey(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const result = authenticateHubKey(req, reply);
  if (!result.ok) {
    // 配额超限是 429 (可重试), 鉴权失败才是 401 —— 调用方要能区分"key 有问题"和"钱花完了"
    if (result.quotaExceeded) {
      return reply.code(429).send({
        error: { message: result.error.message, code: result.error.code, type: 'rate_limit_error' },
      });
    }
    return reply.code(401).send({ error: { message: result.error.message, code: result.error.code, type: 'hub_key_error' } });
  }
  req.hubKey = result.hubKey;
}

/**
 * 在 requireHubKey 之后调用: 校验该 Hub Key 是否允许调用 body.model
 * 返回 true = 放行; false = 已发送 403 响应, 调用方应直接 return。
 */
export function requireModelAllowed(req: FastifyRequest, reply: FastifyReply, model: string | null | undefined): boolean {
  const hubKey = req.hubKey;
  if (!hubKey) return false;
  if (isHubKeyAllowedForModel(hubKey, model)) return true;
  reply.code(403).send({
    error: {
      message: `Hub Key '${hubKey.name}' 不允许调用模型 '${model}'。当前允许: ${hubKey.allowed_models!.join(', ')}。请在 Hub 后台的 Hub Keys 页面调整该 Key 的模型权限。`,
      code: 'hub_key_model_forbidden',
      type: 'permission_error',
    },
  });
  return false;
}
