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
  it('字面量模型: 通道列表没有但 discovered 有 → 仍可路由 (R1 回归防线)', async () => {
    // chA 列表只写 foo, 但 keyA 实际发现过 org/secret-model
    db.prepare('UPDATE channels SET models = ? WHERE id = ?').run('foo', chAId);
    const dm = await import('../../src/db/repos/discoveredModels.js');
    dm.upsertDiscoveredModel(keyAId, 'org/secret-model');
    const { resolveModel } = await import('../../src/routing/resolver.js');
    const { listKeys } = await import('../../src/db/repos/keys.js');
    const r = resolveModel('org/secret-model', listKeys());
    assert.ok('key' in r, `discovered 证据应可路由, got ${JSON.stringify(r)}`);
    assert.equal(r.upstreamModel, 'org/secret-model');
    assert.equal(r.key.id, keyAId);
  });

  it('兜底池: discovered 证据的 Key 也参与 (R1)', async () => {
    db.prepare('UPDATE channels SET models = ? WHERE id = ?').run('foo', chAId);
    db.prepare('UPDATE channels SET models = ? WHERE id = ?').run('bar', chBId);
    const dm = await import('../../src/db/repos/discoveredModels.js');
    dm.upsertDiscoveredModel(keyAId, 'only/discovered');
    const { selectFallbackPool } = await import('../../src/routing/selector.js');
    const pool = selectFallbackPool('only/discovered');
    const ids = [...pool.available, ...pool.unavailable].map(p => p.key.id);
    assert.deepEqual(ids, [keyAId]);
  });

  it('三段式 pin: 返回被指定的那把 Key, 不被评分换成同通道其他 Key (R2)', async () => {
    // chA 里再放一把 key A2, 两者都服务 M3 且都发现过
    const keys = await import('../../src/db/repos/keys.js');
    const keyA2 = keys.createKey({ channel_id: chAId, label: 'KA2', apiKey: 'sk-a2' }).id;
    db.prepare('UPDATE channels SET models = ? WHERE id = ?').run('M3', chAId);
    const dm = await import('../../src/db/repos/discoveredModels.js');
    dm.upsertDiscoveredModel(keyAId, 'M3');
    dm.upsertDiscoveredModel(keyA2, 'M3');
    const failover = await import('../../src/routing/failover.js');
    const state = { keys: new Set<number>(), models: new Set<string>(), platforms: new Set<number>() };
    const { listKeys } = keys;
    const r = failover.selectFirstCandidate(`prov-a/KA/M3`, listKeys(), state as any);
    assert.ok('key' in r, `expected pin key, got ${JSON.stringify(r)}`);
    assert.equal(r.key.label, 'KA', '必须是被 pin 的 KA, 不是评分选出的其他 Key');
    assert.equal(r.upstreamModel, 'M3');
  });

  it('冷却作用域: model 级只作用于同模型, key 级压所有模型 (R3)', async () => {
    const cooldowns = await import('../../src/db/repos/cooldowns.js');
    // model 级: 只冷 M3
    cooldowns.setCooldown({ keyId: keyAId, reason: 'rate_limit', upstreamModel: 'M3', durationMs: 60000, recoverable: true, source: 'heuristic' });
    let scope = cooldowns.getCooldownScopeForKey(keyAId, 'M3');
    assert.equal(scope.applicable.length, 1, 'M3 应命中自己的 model 级冷却');
    assert.equal(scope.keyWide.length, 0);
    scope = cooldowns.getCooldownScopeForKey(keyAId, 'other');
    assert.equal(scope.applicable.length, 0, 'other 模型不受 M3 的 model 级冷却影响');
    // key 级 (auth): 所有模型都命中
    cooldowns.setCooldown({ keyId: keyAId, reason: 'auth', upstreamModel: null, durationMs: 60000, recoverable: true, source: 'heuristic' });
    scope = cooldowns.getCooldownScopeForKey(keyAId, 'other');
    assert.equal(scope.keyWide.length, 1, 'key 级冷却应对所有模型生效');
    assert.equal(scope.applicable.length, 1);
  });

  it('错误分类: OpenRouter 的 not a valid model 不当客户端错误; rate limit 不当额度耗尽 (R4/R6)', async () => {
    const { classifyError } = await import('../../src/routing/failover.js');
    assert.equal(classifyError(400, { error: { message: 'X is not a valid model ID' } }).kind, 'provider_error');
    assert.equal(classifyError(400, { error: { message: 'Rate limit exceeded, retry later' } }).kind, 'rate_limit');
    assert.equal(classifyError(400, { error: { message: 'insufficient permissions' } }).kind, 'provider_error');
    assert.equal(classifyError(400, { error: { message: 'insufficient balance' } }).kind, 'key_quota');
  });

});
