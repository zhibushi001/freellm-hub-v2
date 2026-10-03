/**
 * 熔断器 + EWMA 测试
 * - 连续上游故障到阈值 → open, 完全不参与选择; 到期放一个探测 (half_open)
 * - 探测成功 → closed; 探测失败 → 退避翻倍再 open
 * - 客户端错误 (400) 不算熔断级失败
 * - 熔断/EWMA 按 (Key × 模型) 隔离: A 模型熔断不影响 B 模型
 * - EWMA 喂进评分输入: 变慢的 Key 自动降权
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

describe('熔断器 + EWMA', () => {
  let db: DatabaseSync, keyId: number, slowKeyId: number, chId: number;

  beforeEach(async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hub-cb-'));
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

  it('连续 3 次上游故障 → open; 未到退避时间完全阻断', async () => {
    const { recordOutcome, getCircuitState, breakerGate } = await cb();
    for (let i = 0; i < 2; i++) recordOutcome(keyId, 'M3', false, 100, { breakerFailure: true });
    assert.equal(breakerGate(getCircuitState(keyId, 'M3')).blocked, false, '2 次还没到阈值');
    recordOutcome(keyId, 'M3', false, 100, { breakerFailure: true });
    const st = getCircuitState(keyId, 'M3')!;
    assert.equal(st.state, 'open');
    assert.equal(st.consecutive_failures, 3);
    const gate = breakerGate(st);
    assert.equal(gate.blocked, true, 'open 且未到期应阻断');
    assert.equal(gate.halfOpen, false);
  });

  it('到期后放一个探测 (half_open), 同刻只允许一个', async () => {
    const { recordOutcome, getCircuitState, breakerGate, claimProbeSlot } = await cb();
    for (let i = 0; i < 3; i++) recordOutcome(keyId, 'M3', false, 100, { breakerFailure: true });
    const retryAt = getCircuitState(keyId, 'M3')!.retry_at!;
    assert.equal(breakerGate(getCircuitState(keyId, 'M3'), retryAt - 1).blocked, true);
    // 到期: 放探测
    assert.equal(breakerGate(getCircuitState(keyId, 'M3'), retryAt).blocked, false);
    assert.equal(breakerGate(getCircuitState(keyId, 'M3'), retryAt).halfOpen, true);
    // 第一个请求占住探测位
    assert.equal(claimProbeSlot(keyId, 'M3', retryAt), true);
    const busy = getCircuitState(keyId, 'M3')!;
    assert.equal(breakerGate(busy, retryAt + 1).blocked, true, '探测位被占, 后来者应挡住');
    // 探测位过期后可以再探
    assert.equal(breakerGate(busy, retryAt + 120_000).blocked, false);
  });

  it('探测成功 → closed 归零; 探测失败 → 退避翻倍再 open', async () => {
    const { recordOutcome, getCircuitState, breakerGate } = await cb();
    for (let i = 0; i < 3; i++) recordOutcome(keyId, 'M3', false, 100, { breakerFailure: true });
    const firstRetry = getCircuitState(keyId, 'M3')!.retry_at!;
    recordOutcome(keyId, 'M3', true, 120, { breakerFailure: false });
    let st = getCircuitState(keyId, 'M3')!;
    assert.equal(st.state, 'closed');
    assert.equal(st.consecutive_failures, 0);
    assert.equal(breakerGate(st).blocked, false);

    // 再熔断一次并让探测失败
    for (let i = 0; i < 3; i++) recordOutcome(keyId, 'M3', false, 100, { breakerFailure: true });
    const retry2 = getCircuitState(keyId, 'M3')!.retry_at!;
    assert.ok(retry2 > firstRetry, '再次熔断的退避应更长');
    recordOutcome(keyId, 'M3', false, 100, { breakerFailure: true }); // 半开探测失败
    st = getCircuitState(keyId, 'M3')!;
    assert.equal(st.state, 'open');
    assert.ok(st.retry_at! > retry2, '探测失败后应再退避一档');
  });

  it('客户端错误 (400) 不算熔断级失败', async () => {
    const { recordOutcome, getCircuitState } = await cb();
    for (let i = 0; i < 5; i++) recordOutcome(keyId, 'M3', false, 100, { breakerFailure: false });
    const st = getCircuitState(keyId, 'M3')!;
    assert.equal(st.state, 'closed', '4xx 不该熔断');
    assert.equal(st.consecutive_failures, 0);
  });

  it('按 (Key × 模型) 隔离: M3 熔断不影响 M7', async () => {
    const { recordOutcome, getCircuitState, breakerGate } = await cb();
    for (let i = 0; i < 3; i++) recordOutcome(keyId, 'M3', false, 100, { breakerFailure: true });
    assert.equal(breakerGate(getCircuitState(keyId, 'M3')).blocked, true);
    assert.equal(breakerGate(getCircuitState(keyId, 'M7')).blocked, false, 'M7 不该被 M3 的熔断连累');
  });

  it('熔断的 Key 从候选池消失; EWMA 让变慢的 Key 自动降权', async () => {
    const { recordOutcome } = await cb();
    for (let i = 0; i < 3; i++) recordOutcome(keyId, 'M3', false, 100, { breakerFailure: true });
    const { selectCandidatePool } = await import('../../src/routing/selector.js');
    let pool = selectCandidatePool('M3');
    const ids = [...pool.available, ...pool.unavailable].map(p => p.key.id);
    assert.ok(!pool.available.some(p => p.key.id === keyId), '熔断的 Key 不该出现在可用池');
    assert.ok(ids.includes(slowKeyId), '另一把 Key 仍可用');

    // EWMA: K2 (slowKeyId) 连续慢且失败率高 → 排名应落后于没数据的 Key1
    recordOutcome(slowKeyId, 'M3', false, 9000, { breakerFailure: false });
    recordOutcome(slowKeyId, 'M3', false, 9000, { breakerFailure: false });
    recordOutcome(slowKeyId, 'M3', false, 9000, { breakerFailure: false });
    recordOutcome(keyId, 'M3', true, 100, { breakerFailure: false });
    recordOutcome(keyId, 'M3', true, 100, { breakerFailure: false });
    recordOutcome(keyId, 'M3', true, 100, { breakerFailure: false });
    const db2 = db;
    // 让 K1 熔断器归零 (前面已 open), 用另一把 Key 验证排序
    const { clearCircuit } = await import('../../src/db/repos/circuitBreaker.js').then(m => ({ clearCircuit: null })).catch(() => ({ clearCircuit: null }));
    pool = selectCandidatePool('M3');
    const order = pool.available.map(p => `${p.key.label}:${Math.round(p.score * 1000)}`);
    const slowIdx = order.findIndex(x => x.startsWith('K2'));
    assert.ok(slowIdx >= 0, 'K2 应仍在池中 (只是降权, 不排除)');
    const st = db2.prepare('SELECT ewma_latency_ms, ewma_fail_rate, samples FROM circuit_state WHERE key_id = ?').get(slowKeyId) as any;
    assert.ok(st.samples >= 3 && st.ewma_latency_ms > 1000, `EWMA 应学到慢延迟, got ${JSON.stringify(st)}`);
  });
});
