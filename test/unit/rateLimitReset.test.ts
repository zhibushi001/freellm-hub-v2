/**
 * 限流冷却精度测试 (2026-10-03 修复)
 * 事故: OpenRouter 每日额度 429 按 Retry-After:86400 冷却了 +24h, 而真实重置点
 * (X-RateLimit-Reset) 是下一个 UTC 午夜 —— 网关多关 9h51m。
 * - rateLimitResetRemainingMs: X-RateLimit-Reset 解析 (秒/毫秒、大小写、合理性)
 * - classifyError 429: 精确重置点优先于通用 retry-after
 * - handleFailure 每日额度分支: 有精确重置点按它冷却, 没有才回退 UTC 午夜
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

describe('限流冷却精度 (X-RateLimit-Reset 优先)', () => {
  let db: DatabaseSync, keyId: number;

  beforeEach(async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hub-rlr-'));
    process.env.HUB_DATA_DIR = dataDir;
    process.env.HUB_PORT = '0';
    process.env.HUB_SKIP_SEED = process.env.HUB_SKIP_SEED ?? '1';
    const { runMigrations } = await import('../../src/db/migrations/runner.js');
    db = new DatabaseSync(join(dataDir, 'hub.db'));
    runMigrations(db);
    const conn = await import('../../src/db/connection.js');
    conn.setDbForTest(db);
    const providers = await import('../../src/db/repos/providers.js');
    const channels = await import('../../src/db/repos/channels.js');
    const keys = await import('../../src/db/repos/keys.js');
    const p = providers.createProvider({ name: 'p1', base_url: 'https://p1.test/v1' });
    const ch = channels.createChannel({ provider_id: p.id, multi_key_mode: 'sticky' } as any);
    keyId = keys.createKey({ channel_id: ch.id, label: 'K', apiKey: 'sk-1' }).id;
  });

  it('rateLimitResetRemainingMs: 毫秒/秒 epoch、大小写不敏感, 拒绝缺失/过期/超24h', async () => {
    const { rateLimitResetRemainingMs } = await import('../../src/services/keyHealth.js');
    const now = Date.now();
    const in2hMs = now + 2 * 3_600_000;
    const in2hSec = Math.floor(in2hMs / 1000);
    // 毫秒 epoch
    const a = rateLimitResetRemainingMs({ 'X-RateLimit-Reset': in2hMs });
    assert.ok(a != null && Math.abs(a - 2 * 3_600_000) < 5000, `毫秒解析 got ${a}`);
    // 秒 epoch + 小写头
    const b = rateLimitResetRemainingMs({ 'x-ratelimit-reset': in2hSec });
    assert.ok(b != null && Math.abs(b - 2 * 3_600_000) < 5000, `秒解析 got ${b}`);
    // 缺失 / null / 已过期 / 超 24h
    assert.equal(rateLimitResetRemainingMs(undefined), undefined);
    assert.equal(rateLimitResetRemainingMs({}), undefined);
    assert.equal(rateLimitResetRemainingMs({ 'x-ratelimit-reset': Math.floor((now - 60_000) / 1000) }), undefined, '已过期应拒绝');
    assert.equal(rateLimitResetRemainingMs({ 'x-ratelimit-reset': Math.floor((now + 48 * 3_600_000) / 1000) }), undefined, '超24h应拒绝');
  });

  it('classifyError 429: 精确重置点 (3h) 优先于 retry-after: 86400', async () => {
    const { classifyError } = await import('../../src/routing/failover.js');
    const resetAtSec = Math.floor((Date.now() + 3 * 3_600_000) / 1000);
    const cls = classifyError(
      429,
      {
        error: { message: 'Rate limit exceeded: free-models-per-day-stealth.' },
        metadata: { headers: { 'X-RateLimit-Reset': resetAtSec } },
      },
      { 'retry-after': '86400' },
    );
    assert.equal(cls.kind, 'rate_limit');
    const ra = cls.retryAfterMs ?? 0;
    assert.ok(ra > 2.9 * 3_600_000 && ra < 3.1 * 3_600_000,
      `应取 3h 的精确重置点而非 24h 的 retry-after, got ${Math.round(ra / 60_000)}min`);
  });

  it('classifyError 429: 没有 reset 头时回退 retry-after', async () => {
    const { classifyError } = await import('../../src/routing/failover.js');
    const cls = classifyError(429, { error: { message: 'Rate limit exceeded' } }, { 'retry-after': '120' });
    assert.equal(cls.kind, 'rate_limit');
    assert.equal(cls.retryAfterMs, 120_000);
  });

  it('handleFailure 每日额度: 有精确重置点按它冷却 (≈reset+2min), 不等 UTC 午夜', async () => {
    const { handleFailure } = await import('../../src/routing/failover.js');
    const { getAllActiveCooldownsForKey } = await import('../../src/db/repos/cooldowns.js');
    const keys = await import('../../src/db/repos/keys.js');
    const key = keys.getKey(keyId)!;
    const cls = {
      kind: 'rate_limit' as const,
      retryAfterMs: 2 * 3_600_000,
      message: 'Rate limit exceeded: free-models-per-day-stealth.',
    };
    const state = { keys: new Set<number>(), models: new Set<string>(), platforms: new Set<number>() };
    const decision = handleFailure(cls, {} as any, key, 'M3', state, 'M3');
    assert.equal(decision, 'continue', '429 应跳过本 Key 试下一个');
    const cd = getAllActiveCooldownsForKey(keyId).find(c => c.reason === 'rate_limit');
    assert.ok(cd, '应写入 rate_limit 冷却');
    const remain = cd!.expires_at - Date.now();
    // ≈ 2h + 2min 缓冲
    assert.ok(remain > 1.95 * 3_600_000 && remain < 2.2 * 3_600_000,
      `应≈ reset+2min, got ${Math.round(remain / 60_000)}min (若≈到UTC午夜则回退逻辑没走到)`);
  });

  it('handleFailure 每日额度: 没有重置点时回退下一个 UTC 午夜 + 2min', async () => {
    const { handleFailure } = await import('../../src/routing/failover.js');
    const { getAllActiveCooldownsForKey } = await import('../../src/db/repos/cooldowns.js');
    const { dailyQuotaCooldownMs } = await import('../../src/services/keyHealth.js');
    const keys = await import('../../src/db/repos/keys.js');
    const key = keys.getKey(keyId)!;
    const cls = { kind: 'rate_limit' as const, message: 'Rate limit exceeded: free-models-per-day-stealth.' };
    const state = { keys: new Set<number>(), models: new Set<string>(), platforms: new Set<number>() };
    handleFailure(cls, {} as any, key, 'M3', state, 'M3');
    const cd = getAllActiveCooldownsForKey(keyId).find(c => c.reason === 'rate_limit');
    assert.ok(cd, '应写入 rate_limit 冷却');
    const remain = cd!.expires_at - Date.now();
    const expect = dailyQuotaCooldownMs();
    assert.ok(Math.abs(remain - expect) < 60_000, `应回退 UTC 午夜+2min (${Math.round(expect / 60_000)}min), got ${Math.round(remain / 60_000)}min`);
  });
});
