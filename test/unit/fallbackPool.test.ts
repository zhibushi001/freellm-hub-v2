/**
 * F1 候选池收紧测试
 * - 无 discovered / 精确池不可用 → 兜底只砸"模型列表含该模型(或通配)"的通道, 不再 any-key 跨通道乱砸
 * - 配了 model_routes → failover 不越出路由通道; 路由通道全跳过则明确报错
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

describe('F1 候选池收紧', () => {
  let dataDir: string;
  let db: DatabaseSync;
  let chAId: number, chBId: number, keyAId: number, keyBId: number;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'hub-test-'));
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
    const pA = providers.createProvider({ name: 'prov-a', base_url: 'https://a.test/v1' });
    const pB = providers.createProvider({ name: 'prov-b', base_url: 'https://b.test/v1' });
    const chA = channels.createChannel({ provider_id: pA.id, multi_key_mode: 'sticky' } as any);
    const chB = channels.createChannel({ provider_id: pB.id, multi_key_mode: 'sticky' } as any);
    chAId = chA.id; chBId = chB.id;
    keyAId = keys.createKey({ channel_id: chA.id, label: 'KA', apiKey: 'sk-a' }).id;
    keyBId = keys.createKey({ channel_id: chB.id, label: 'KB', apiKey: 'sk-b' }).id;
    // 显式模型列表: A 只有 model-x, B 只有 model-y
    db.prepare('UPDATE channels SET models = ? WHERE id = ?').run('model-x', chAId);
    db.prepare('UPDATE channels SET models = ? WHERE id = ?').run('model-y', chBId);
    const settingsRepo = await import('../../src/db/repos/settings.js');
    settingsRepo.setSetting('routing_strategy', 'priority');
  });

  afterEach(() => { try { rmSync(dataDir, { recursive: true, force: true }); } catch {} });

  it('无 discovered → 兜底只含"模型列表匹配"的通道 (不再 any-key)', async () => {
    const { selectCandidatePool } = await import('../../src/routing/selector.js');
    const pool = selectCandidatePool('model-x');
    const ids = [...pool.available, ...pool.unavailable].map(p => p.key.id);
    assert.deepEqual(ids, [keyAId], `expected only chA key, got ${JSON.stringify(ids)}`);
  });

  it('通配通道 (models 为空 = 支持所有模型) 参与兜底', async () => {
    db.prepare('UPDATE channels SET models = ? WHERE id = ?').run('', chBId);
    const { selectCandidatePool } = await import('../../src/routing/selector.js');
    const pool = selectCandidatePool('anything-else');
    const ids = [...pool.available, ...pool.unavailable].map(p => p.key.id);
    assert.ok(ids.includes(keyBId), `wildcard channel should be eligible, got ${JSON.stringify(ids)}`);
    assert.ok(!ids.includes(keyAId), 'A 有显式列表且不含该模型, 不应命中');
  });

  it('selectFallbackPool 可限定路由通道集合', async () => {
    db.prepare('UPDATE channels SET models = ? WHERE id = ?').run('shared', chAId);
    db.prepare('UPDATE channels SET models = ? WHERE id = ?').run('shared', chBId);
    const { selectFallbackPool } = await import('../../src/routing/selector.js');
    const pool = selectFallbackPool('shared', new Set([chAId]));
    assert.deepEqual(pool.available.map(p => p.key.id), [keyAId]);
  });

  it('有 model_routes → selectFirstCandidate 不越界; 路由通道全跳过则报错', async () => {
    db.prepare('UPDATE channels SET models = ? WHERE id = ?').run('M3', chAId);
    db.prepare('UPDATE channels SET models = ? WHERE id = ?').run('M3', chBId);
    const dm = await import('../../src/db/repos/discoveredModels.js');
    dm.upsertDiscoveredModel(keyAId, 'M3');
    dm.upsertDiscoveredModel(keyBId, 'M3');
    const now = Date.now();
    db.prepare('INSERT INTO model_routes (request_model, channel_ids, enabled, notes, created_at, updated_at) VALUES (?, ?, 1, NULL, ?, ?)')
      .run('M3', JSON.stringify([chAId]), now, now);

    const failover = await import('../../src/routing/failover.js');
    const { listKeys } = await import('../../src/db/repos/keys.js');
    const state = { keys: new Set<number>(), models: new Set<string>(), platforms: new Set<number>() };

    const r1 = failover.selectFirstCandidate('M3', listKeys(), state as any);
    assert.ok('key' in r1, `expected key, got ${JSON.stringify(r1)}`);
    assert.equal(r1.key.channel_id, chAId, 'must stay within route channel');

    // 跳过路由通道的 key → 只能报错, 不能越到 chB
    state.keys.add(r1.key.id);
    const r2 = failover.selectFirstCandidate('M3', listKeys(), state as any);
    assert.ok('error' in r2, `expected error, got ${JSON.stringify(r2)}`);
    assert.match((r2 as any).error, /路由/);
  });
});
