/**
 * 定价与成本
 *
 * 价格来自 price_catalog (每百万 token 单价), 匹配优先级 (从具体到通用):
 *   1. provider 精确 + 模型精确      openrouter / gpt-5.2
 *   2. provider 精确 + 模型前缀通配  openrouter / gpt-5.2*
 *   3. 全局默认 + 模型精确            *         / gpt-5.2
 *   4. 全局默认 + 模型前缀通配        *         / gpt-5.2*
 * 都没命中 → 该次请求成本记 0 并标 price_ref = NULL (免费渠道的常态, 不是错误)。
 *
 * 缓存: 价格表变动极少, 但每个请求都要查 → 内存缓存 60s, CRUD 时显式失效。
 */
import { getDb } from '../db/connection.js';

export interface PriceEntry {
  id: number;
  provider_name: string;
  model_pattern: string;
  input_price_per_m: number;
  output_price_per_m: number;
  note: string | null;
  enabled: number;
  updated_at: number;
}

export interface ResolvedPrice {
  input_per_m: number;
  output_per_m: number;
  /** 命中的 "provider/model" 标识, 写进 usage_logs.price_ref 备查 */
  ref: string;
}

let cache: { at: number; rows: PriceEntry[] } | null = null;
const CACHE_TTL_MS = 60_000;

export function invalidatePriceCache(): void {
  cache = null;
}

function loadPrices(): PriceEntry[] {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.rows;
  const rows = getDb()
    .prepare('SELECT * FROM price_catalog WHERE enabled = 1')
    .all() as unknown as PriceEntry[];
  cache = { at: now, rows };
  return rows;
}

/** 模型模式匹配: 精确相等, 或以 '*' 结尾的前缀通配 */
function patternMatches(pattern: string, model: string): boolean {
  if (pattern === model) return true;
  if (pattern.endsWith('*')) return model.startsWith(pattern.slice(0, -1));
  return false;
}

export function resolvePrice(providerName: string | null | undefined, model: string | null | undefined): ResolvedPrice | null {
  if (!model) return null;
  const rows = loadPrices();
  const prov = (providerName ?? '').trim();

  // specificity: 0=provider+精确 1=provider+通配 2=全局+精确 3=全局+通配
  let best: { row: PriceEntry; spec: number } | null = null;
  for (const row of rows) {
    const rowProv = row.provider_name === '*' ? '' : row.provider_name;
    if (rowProv !== prov && rowProv !== '') continue;
    const provExact = rowProv !== '' && rowProv === prov;
    const modelExact = row.model_pattern === model;
    if (!modelExact && !patternMatches(row.model_pattern, model)) continue;
    const spec = provExact ? (modelExact ? 0 : 1) : (modelExact ? 2 : 3);
    if (!best || spec < best.spec) best = { row, spec };
  }
  if (!best) return null;
  return {
    input_per_m: best.row.input_price_per_m,
    output_per_m: best.row.output_price_per_m,
    ref: `${best.row.provider_name}/${best.row.model_pattern}`,
  };
}

/**
 * 算一次请求的成本 (美元)。
 * token 缺失 (上游不返回 usage) 时返回 0 而不是瞎猜。
 */
export function computeCostUsd(
  providerName: string | null | undefined,
  model: string | null | undefined,
  promptTokens: number | null | undefined,
  completionTokens: number | null | undefined,
): { cost_usd: number | null; price_ref: string | null } {
  const price = resolvePrice(providerName, model);
  if (!price) return { cost_usd: 0, price_ref: null };
  const p = (promptTokens ?? 0) / 1_000_000 * price.input_per_m;
  const c = (completionTokens ?? 0) / 1_000_000 * price.output_per_m;
  // 保留 8 位小数 (亚分钱级别的免费/低价渠道也要能看出量级)
  return { cost_usd: Math.round((p + c) * 1e8) / 1e8, price_ref: price.ref };
}

// ── CRUD (管理 API 用) ──────────────────────────────────────────────────

export function listPrices(): PriceEntry[] {
  invalidatePriceCache();
  return getDb().prepare('SELECT * FROM price_catalog ORDER BY provider_name, model_pattern').all() as unknown as PriceEntry[];
}

export function upsertPrice(input: {
  provider_name: string;
  model_pattern: string;
  input_price_per_m: number;
  output_price_per_m: number;
  note?: string | null;
  enabled?: number;
}): PriceEntry {
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO price_catalog (provider_name, model_pattern, input_price_per_m, output_price_per_m, note, enabled, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider_name, model_pattern) DO UPDATE SET
         input_price_per_m = excluded.input_price_per_m,
         output_price_per_m = excluded.output_price_per_m,
         note = excluded.note,
         enabled = excluded.enabled,
         updated_at = excluded.updated_at`,
    )
    .run(input.provider_name.trim() || '*', input.model_pattern.trim(),
      Number(input.input_price_per_m), Number(input.output_price_per_m),
      input.note ?? null, input.enabled ?? 1, now);
  invalidatePriceCache();
  return getDb()
    .prepare('SELECT * FROM price_catalog WHERE provider_name = ? AND model_pattern = ?')
    .get(input.provider_name.trim() || '*', input.model_pattern.trim()) as unknown as PriceEntry;
}

export function deletePrice(id: number): boolean {
  const info = getDb().prepare('DELETE FROM price_catalog WHERE id = ?').run(id);
  invalidatePriceCache();
  return Number(info.changes ?? 0) > 0;
}
