/**
 * EWMA 测试 (熔断器已按使用者要求移除 — 2026-10-03)
 * - recordOutcome 只更新 EWMA: 不产生 open/half_open, 任何失败都不拦截
 * - EWMA 按 (Key × 模型) 隔离, 喂进评分让慢/连败 Key 自动降权
 * - 行为回归: 连续失败后 Key 仍留在候选池 (熔断移除的核心断言)
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

describe('EWMA (熔断已移除)', () => {
  let db: DatabaseSync, keyId: number, slowKeyId: number, chId: number;

  beforeEach(async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hub-cb--'));
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
    chId = channels.createChannel({ provider_id: p.id, multi_key_mode: 'sticky' } as any).id;
    db.prepare('UPDATE channels SET models = ? WHERE id = ?').run('M3', chId);
    keyId = keys.createKey({ channel_id: chId, label: 'K1', apiKey: 'sk-1' }).id;
    slowKeyId = keys.createKey({ channel_id: chId, label: 'K2', apiKey: 'sk-2' }).id;
  });

  const cb = () => import('../../src/db/repos/circuitBreaker.js');

  it('连续失败只更新 EWMA, 不产生任何熔断状态', async () => {
    const { recordOutcome, getCircuitStates } = await cb();
    for (let i = 0; i < 10; i++) recordOutcome(keyId, 'M3', false, 100);
    const st = getCircuitStates([keyId], 'M3').get(keyId)!;
    assert.ok(st, '应有 EWMA 行');
    assert.equal(st.state, 'closed', '连败不再打开熔断');
    assert.equal(st.retry_at, null, '无退避时间');
    assert.equal(st.consecutive_failures, 0, '无熔断计数');
    assert.equal(st.samples, 10, '每次采样都应计数');
    assert.ok((st.ewma_fail_rate ?? 0) > 0.9, `全失败的失败率 EWMA 应接近 1, got ${st.ewma_fail_rate}`);
  });

  it('成功采样把失败率 EWMA 往下拉', async () => {
    const { recordOutcome, getCircuitStates } = await cb();
    recordOutcome(keyId, 'M3', false, 500);
    recordOutcome(keyId, 'M3', false, 500);
    recordOutcome(keyId, 'M3', true, 500);
    const st = getCircuitStates([keyId], 'M3').get(keyId)!;
    assert.ok((st.ewma_fail_rate ?? 1) < 1, '成功采样应拉低失败率');
    assert.equal(st.state, 'closed');
  });

  it('按 (Key × 模型) 隔离: M3 的统计不影响 M7', async () => {
    const { recordOutcome, getCircuitStates } = await cb();
    for (let i = 0; i < 3; i++) recordOutcome(keyId, 'M3', false, 9000);
    assert.equal(getCircuitStates([keyId], 'M3').get(keyId)?.samples, 3);
    assert.equal(getCircuitStates([keyId], 'M7').get(keyId), undefined, 'M7 不该被 M3 的统计连累');
  });

  it('核心回归: 连败 10 次后 Key 仍在候选池, 不出现 circuit_open', async () => {
    const { recordOutcome } = await cb();
    for (let i = 0; i < 10; i++) recordOutcome(keyId, 'M3', false, 9000);
    const { selectCandidatePool } = await import('../../src/routing/selector.js');
    const pool = selectCandidatePool('M3');
    const ids = [...pool.available, ...pool.unavailable].map(p => p.key.id);
    assert.ok(ids.includes(keyId), '连败 Key 不能被剔除出池');
    assert.ok(!pool.unavailable.some(u => u.reason === 'circuit_open'), '不该出现 circuit_open 原因');
    assert.ok(pool.available.some(p => p.key.id === keyId), '连败 Key 应仍可用 (降权交给评分/冷却)');
    assert.ok(pool.available.some(p => p.key.id === slowKeyId), '另一把 Key 仍可用');
  });

  it('EWMA 喂进评分: 变慢的 Key 自动降权但不排除', async () => {
    const { recordOutcome } = await cb();
    // K2 慢且失败 → EWMA 学到高延迟
    for (let i = 0; i < 3; i++) recordOutcome(slowKeyId, 'M3', false, 9000);
    // K1 快且成功
    for (let i = 0; i < 3; i++) recordOutcome(keyId, 'M3', true, 100);
    const { selectCandidatePool } = await import('../../src/routing/selector.js');
    const pool = selectCandidatePool('M3');
    const order = pool.available.map(p => `${p.key.label}:${Math.round(p.score * 1000)}`);
    const slowIdx = order.findIndex(x => x.startsWith('K2'));
    const fastIdx = order.findIndex(x => x.startsWith('K1'));
    assert.ok(slowIdx >= 0, `K2 应仍在池中 (只是降权, 不排除), got ${JSON.stringify(order)}`);
    assert.ok(fastIdx >= 0, 'K1 应在池中');
    assert.ok(slowIdx > fastIdx, `变慢的 K2 应排在 K1 之后, got ${JSON.stringify(order)}`);
    const st = db.prepare('SELECT ewma_latency_ms, ewma_fail_rate, samples FROM circuit_state WHERE key_id = ?').get(slowKeyId) as any;
    assert.ok(st.samples >= 3 && st.ewma_latency_ms > 1000, `EWMA 应学到慢延迟, got ${JSON.stringify(st)}`);
  });
});
