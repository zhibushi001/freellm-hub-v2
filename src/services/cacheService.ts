/**
 * 响应缓存服务
 * 用于缓存相同的请求结果，减少重复请求
 */
import { getDb } from '../db/connection.js';

export interface CacheEntry {
  cacheKey: string;
  requestModel: string;
  requestHash: string;
  responseStatus: number;
  responseBody: any;
  upstreamModel?: string;
  providerName?: string;
  keyId?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  latencyMs?: number;
  createdAt: number;
  expiresAt: number;
  hitCount: number;
  lastHitAt?: number;
}

export interface CacheStats {
  totalEntries: number;
  hitCount: number;
  missCount: number;
  hitRate: number;
}


/**
 * 检查缓存配置是否启用
 */
export function isCacheEnabled(): boolean {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = 'cache_enabled'").get() as any;
  return row?.value === '1' || row?.value === 'true';
}

/**
 * 获取缓存 TTL（秒）
 */
export function getCacheTTL(): number {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = 'cache_ttl'").get() as any;
  return parseInt(row?.value || '300', 10); // 默认 5 分钟
}



/**
 * 清理过期缓存
 */
export function cleanupExpiredCache(): number {
  const result = getDb()
    .prepare("DELETE FROM response_cache WHERE expires_at < ?")
    .run(Date.now());
  return Number(result.changes);
}

/**
 * 获取缓存统计
 */
export function getCacheStats(): CacheStats {
  const totalEntries = getDb()
    .prepare("SELECT COUNT(*) as count FROM response_cache")
    .get() as any;
  const hits = getDb()
    .prepare("SELECT SUM(hit_count) as total FROM response_cache")
    .get() as any;
  const misses = totalEntries.count; // 简化计算
  const hitRate = misses > 0 ? (hits.total || 0) / misses : 0;

  return {
    totalEntries: totalEntries.count || 0,
    hitCount: hits.total || 0,
    missCount: misses,
    hitRate,
  };
}
