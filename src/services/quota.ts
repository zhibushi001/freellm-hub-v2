/**
 * Hub Key 配额: 月/日预算硬限 + RPM 限流
 *
 * 审计发现: hub_keys.rate_limit_rpm 这个字段**建了但从来没被执行过** ——
 * 界面上能填, 接口能存, 请求路径上没有任何地方读它。现在两个配额都真正生效。
 *
 * 预算口径: usage_logs.cost_usd 的 SUM (成本随请求落库, 见 pricing.ts)。
 * 索引 idx_usage_hub(hub_key_id, created_at) 支撑这个聚合。
 * 没配价格表的渠道成本恒为 0 —— 也就是说"预算"只对**配了价格**的渠道有意义,
 * 这是刻意的: 免费渠道本来就不花钱, 不该被预算拦。
 */
import { getDb } from '../db/connection.js';

export interface QuotaDecision {
  allowed: boolean;
  code?: 'daily_budget_exceeded' | 'monthly_budget_exceeded' | 'rate_limited';
  message?: string;
  /** 429 时带上, 方便调用方知道什么时候能再来 */
  retry_after_sec?: number;
}

function monthStart(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}
function dayStart(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** 本月 / 今日已花 (美元) */
export function spendForHubKey(hubKeyId: number, now: number = Date.now()): { month: number; day: number } {
  const row = getDb()
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN created_at >= ? THEN cost_usd ELSE 0 END), 0) AS day_cost,
         COALESCE(SUM(cost_usd), 0) AS month_cost
       FROM usage_logs
       WHERE hub_key_id = ? AND created_at >= ?`,
    )
    .get(dayStart(now), hubKeyId, monthStart(now)) as { day_cost: number; month_cost: number } | undefined;
  return { day: Number(row?.day_cost ?? 0), month: Number(row?.month_cost ?? 0) };
}

// ── RPM 限流 (单进程内存计数; 每分钟窗口, 惰性清理) ──────────────────────

interface Window { start: number; count: number }
const rpmWindows = new Map<number, Window>();

/** @returns 超限时给出剩余等待秒数 */
export function hitRpmLimit(hubKeyId: number, rpm: number, now: number = Date.now()): { limited: boolean; retryAfterSec: number } {
  if (!rpm || rpm <= 0) return { limited: false, retryAfterSec: 0 };
  const cur = rpmWindows.get(hubKeyId);
  if (!cur || now - cur.start >= 60_000) {
    rpmWindows.set(hubKeyId, { start: now, count: 1 });
    // 顺手清掉过期窗口, 避免 key 删了之后残留
    if (rpmWindows.size > 1000) {
      for (const [k, w] of rpmWindows) if (now - w.start >= 60_000) rpmWindows.delete(k);
    }
    return { limited: false, retryAfterSec: 0 };
  }
  cur.count++;
  if (cur.count > rpm) {
    return { limited: true, retryAfterSec: Math.max(1, Math.ceil((cur.start + 60_000 - now) / 1000)) };
  }
  return { limited: false, retryAfterSec: 0 };
}

export function clearRpmWindows(hubKeyId?: number): void {
  if (hubKeyId == null) rpmWindows.clear();
  else rpmWindows.delete(hubKeyId);
}

/**
 * 配额总闸: 请求进来先过这里。
 * 顺序: RPM (廉价) → 日预算 → 月预算。
 */
export function checkHubKeyQuota(
  hubKeyId: number,
  limits: { rate_limit_rpm?: number | null; daily_budget_usd?: number | null; monthly_budget_usd?: number | null },
  now: number = Date.now(),
): QuotaDecision {
  const rpm = hitRpmLimit(hubKeyId, Number(limits.rate_limit_rpm ?? 0), now);
  if (rpm.limited) {
    return {
      allowed: false,
      code: 'rate_limited',
      message: `超过该 Hub Key 的速率限制 (${limits.rate_limit_rpm} 次/分钟)`,
      retry_after_sec: rpm.retryAfterSec,
    };
  }

  const daily = limits.daily_budget_usd;
  const monthly = limits.monthly_budget_usd;
  if (daily == null && monthly == null) return { allowed: true };

  const spend = spendForHubKey(hubKeyId, now);
  if (daily != null && spend.day >= daily) {
    return {
      allowed: false,
      code: 'daily_budget_exceeded',
      message: `该 Hub Key 的日预算已用尽 ($${spend.day.toFixed(4)} / $${daily.toFixed(4)})`,
      retry_after_sec: Math.max(60, Math.ceil((dayStart(now) + 86_400_000 - now) / 1000)),
    };
  }
  if (monthly != null && spend.month >= monthly) {
    return {
      allowed: false,
      code: 'monthly_budget_exceeded',
      message: `该 Hub Key 的月预算已用尽 ($${spend.month.toFixed(4)} / $${monthly.toFixed(4)})`,
      retry_after_sec: Math.max(60, Math.ceil((monthStart(now) + 32 * 86_400_000 - now) / 1000)),
    };
  }
  return { allowed: true };
}
