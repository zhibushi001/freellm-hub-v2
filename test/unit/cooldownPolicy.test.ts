/**
 * 冷却策略回归测试
 * - model 级冷却只作用同模型, key 级冷却作用所有模型 (作用域)
 * - 不可恢复的 24h 信用封禁不能被"任意一次成功调用"抹掉 (混搭 Key 不抖动)
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

describe('冷却策略', () => {
  let db: DatabaseSync, keyId: number;

  beforeEach(async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hub-cd-'));
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

  it('成功调用不得清除 24h 不可恢复的信用封禁, 但可恢复的照常清', async () => {
    const cd = await import('../../src/db/repos/cooldowns.js');
    // 不可恢复 (402 信用封禁)
    cd.setCooldown({ keyId, reason: 'quota', upstreamModel: null, durationMs: 86_400_000, recoverable: false, source: 'heuristic' });
    cd.clearCooldownIfRecoverable(keyId, 'quota', null, 'call_succeeded');
    assert.ok(cd.getActiveCooldown(keyId, 'quota', null), '不可恢复封禁不能被成功调用清除');
    // 可恢复 (限流)
    cd.setCooldown({ keyId, reason: 'rate_limit', upstreamModel: 'M', durationMs: 60_000, recoverable: true, source: 'heuristic' });
    cd.clearCooldownIfRecoverable(keyId, 'rate_limit', 'M', 'call_succeeded');
    assert.equal(cd.getActiveCooldown(keyId, 'rate_limit', 'M'), null, '可恢复冷却应由成功清除');
  });

  it('model 级冷却不连累其他模型; key 级冷却全模型生效', async () => {
    const cd = await import('../../src/db/repos/cooldowns.js');
    cd.setCooldown({ keyId, reason: 'rate_limit', upstreamModel: 'paid/model', durationMs: 60_000, recoverable: true, source: 'heuristic' });
    assert.equal(cd.getCooldownScopeForKey(keyId, 'paid/model').applicable.length, 1);
    assert.equal(cd.getCooldownScopeForKey(keyId, 'free/model').applicable.length, 0, '付费模型限流不该影响免费模型');
    cd.setCooldown({ keyId, reason: 'auth', upstreamModel: null, durationMs: 60_000, recoverable: true, source: 'heuristic' });
    assert.equal(cd.getCooldownScopeForKey(keyId, 'free/model').keyWide.length, 1, 'key 级冷却应全模型生效');
  });
});
