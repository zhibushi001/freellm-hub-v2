/**
 * 上游配额余量跟踪 (评分护栏 remaining_quota_ratio 的数据源)
 *
 * 数据源: 上游响应的 rate-limit 头 (OpenAI 风格 x-ratelimit-*)
 *   - x-ratelimit-remaining-requests / x-ratelimit-limit-requests
 *   - x-ratelimit-remaining-tokens   / x-ratelimit-limit-tokens
 *   - 任意 x-ratelimit-remaining-<name> 配 x-ratelimit-limit-<name>
 *
 * 只在两个头都存在时能算比例; 没有头的上游 (多数国内渠道) 保持 1.0,
 * 依赖 402/quota cooldown (24h) 兜底。
 *
 * 单进程内存缓存, TTL 10min (窗口重置后旧比例作废, 每次响应都会刷新)。
 */

interface QuotaEntry {
  ratio: number;
  at: number;
}

const TTL_MS = 10 * 60 * 1000;
const cache = new Map<number, QuotaEntry>();

/** 从上游响应头解析配额余量比例 (0~1), 无有效数据则不更新 */
export function recordQuotaHeaders(
  keyId: number | null | undefined,
  headers: Record<string, string | string[] | undefined> | null | undefined,
): void {
  if (keyId == null || !headers) return;
  // 归一化为小写 string
  const h: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v == null) continue;
    h[k.toLowerCase()] = Array.isArray(v) ? String(v[0]) : String(v);
  }
  let minRatio: number | null = null;
  for (const [k, v] of Object.entries(h)) {
    // F19: 同时匹配 OpenAI 风格 x-ratelimit-remaining-* 与 Anthropic 风格
    // anthropic-ratelimit-*-remaining (原来 Anthropic 渠道的配额比永远观测不到)
    const m = k.match(/^x-ratelimit-remaining-([a-z0-9-]+)$/)
      ?? k.match(/^anthropic-ratelimit-([a-z0-9-]+)-remaining$/);
    if (!m) continue;
    const limRaw = h[`x-ratelimit-limit-${m[1]}`] ?? h[`anthropic-ratelimit-${m[1]}-limit`];
    if (limRaw == null) continue;
    const rem = Number(v);
    const lim = Number(limRaw);
    if (!Number.isFinite(rem) || !Number.isFinite(lim) || lim <= 0) continue;
    const ratio = Math.max(0, Math.min(1, rem / lim));
    minRatio = minRatio == null ? ratio : Math.min(minRatio, ratio);
  }
  if (minRatio != null) {
    cache.set(keyId, { ratio: minRatio, at: Date.now() });
  }
}

/** 读取某 key 的剩余配额比例 (0~1, 1=无数据/满额) */
export function getRemainingQuotaRatio(keyId: number): number {
  const e = cache.get(keyId);
  if (!e) return 1;
  if (Date.now() - e.at > TTL_MS) {
    cache.delete(keyId);
    return 1;
  }
  return e.ratio;
}
