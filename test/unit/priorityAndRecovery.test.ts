/**
 * 审拍板修复项单测:
 *  A) failed 锁 30 分钟自动回炉 (listKeys 读路径懒恢复 + 清零连续失败计数)
 *  B) priority 策略照常看状态 (冷却/低额度自动靠后; 干净 key 之间保持手动序)
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/+$/, '');

describe('failed 键 30 分钟自动回炉', () => {
  let dataDir: string;
  let db: DatabaseSync;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'hub-recover-'));
    process.env.HUB_DATA_DIR = dataDir;
    const { runMigrations } = await import(`${ROOT}/src/db/migrations/runner.js`);
    db = new DatabaseSync(join(dataDir, 'hub.db'));
    process.env.HUB_SKIP_SEED = process.env.HUB_SKIP_SEED ?? '1';
    runMigrations(db);
    const conn = await import(`${ROOT}/src/db/connection.js`);
    conn.setDbForTest(db);
    const providers = await import(`${ROOT}/src/db/repos/providers.js`);
    const channels = await import(`${ROOT}/src/db/repos/channels.js`);
    const keys = await import(`${ROOT}/src/db/repos/keys.js`);
    const p = providers.createProvider({ name: 'rec-test', base_url: 'https://api.rec/v1' });
    const c = channels.createChannel({ provider_id: p.id });
    keys.createKey({ channel_id: c.id, label: 'R1', apiKey: 'sk-r1' });
  });

  afterEach(() => { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* noop */ } });

  it('锁定期未到 (status_since=now) → 保持 failed', async () => {
    const keys = await import(`${ROOT}/src/db/repos/keys.js`);
    keys.updateKey(1, { status: 'failed', status_reason: '连续 5 次失败' });
    keys.listKeys();
    assert.equal(keys.getKey(1)?.status, 'failed');
  });

  it('锁 31 分钟已到 → 回炉 degraded + 清零 failure_count + 回炉原因', async () => {
    const keys = await import(`${ROOT}/src/db/repos/keys.js`);
    keys.updateKey(1, { status: 'failed', status_reason: '连续 5 次失败' });
    db.prepare('UPDATE keys SET status_since = ?, failure_count = 5 WHERE id = 1')
      .run(Date.now() - 31 * 60 * 1000);
    // 回炉扫描已从 listKeys() 挪到独立函数 (读路径不该在每个请求里写库)
    const n = keys.recoverExpiredFailedKeys();
    assert.equal(n, 1, '应有 1 把 failed 键回炉');
    const k = keys.listKeys().find(x => x.id === 1);
    assert.equal(k?.status, 'degraded');
    assert.equal(k?.failure_count, 0, '回炉应清零连续失败计数');
    assert.ok(k?.status_reason?.includes('回炉'), `status_reason: ${k?.status_reason}`);
    // 幂等: 已恢复的不再重复触发
    assert.equal(keys.recoverExpiredFailedKeys(), 0);
  });

  it('listKeys() 是纯读: 不再顺手把 failed 键改回 degraded', async () => {
    const keys = await import(`${ROOT}/src/db/repos/keys.js`);
    keys.updateKey(1, { status: 'failed', status_reason: '连续 5 次失败' });
    db.prepare('UPDATE keys SET status_since = ?, failure_count = 5 WHERE id = 1')
      .run(Date.now() - 31 * 60 * 1000);
    keys.listKeys();
    assert.equal(keys.getKey(1)?.status, 'failed',
      'listKeys 在每个请求的路由路径上, 在那里写库 = 每个请求抢一次 SQLite 写锁');
  });

  it('status_since 为 NULL → 退回 updated_at 判定', async () => {
    const keys = await import(`${ROOT}/src/db/repos/keys.js`);
    keys.updateKey(1, { status: 'failed', status_reason: '连续 5 次失败' });
    db.prepare('UPDATE keys SET status_since = NULL, updated_at = ? WHERE id = 1')
      .run(Date.now() - 31 * 60 * 1000);
    keys.recoverExpiredFailedKeys();
    assert.equal(keys.listKeys().find(x => x.id === 1)?.status, 'degraded');
  });
});

describe('priority 策略照常看状态 (方案 a)', () => {
  const mk = (
    id: number,
    o: { rank?: number; cd?: number; quota?: number } = {},
  ) => ({
    key_id: id,
    enabled: 1,
    status: 'healthy',
    avg_latency_ms: 500,
    success_count: 10,
    failure_count: 0,
    rank_in_candidates: o.rank ?? 0,
    weight: 1,
    recent_usage_ratio: 0,
    remaining_quota_ratio: o.quota ?? 1,
    available: 1,
    cooldown_remaining_sec: o.cd || undefined,
  });

  it('干净 key 之间保持手动序', async () => {
    const { rankCandidates } = await import(`${ROOT}/src/routing/scorer.js`);
    const r = rankCandidates([mk(1, { rank: 0 }), mk(2, { rank: 1 }), mk(3, { rank: 2 })], 'priority');
    assert.deepEqual(r.map(x => x.key_id), [1, 2, 3]);
  });

  it('冷却中的 rank0 被干净的 rank1 反超', async () => {
    const { rankCandidates } = await import(`${ROOT}/src/routing/scorer.js`);
    const r = rankCandidates([mk(1, { rank: 0, cd: 120 }), mk(2, { rank: 1 })], 'priority');
    assert.deepEqual(r.map(x => x.key_id), [2, 1]);
  });

  it('配额 <20% 的 rank0 被干净的 rank1 反超', async () => {
    const { rankCandidates } = await import(`${ROOT}/src/routing/scorer.js`);
    const r = rankCandidates([mk(1, { rank: 0, quota: 0.05 }), mk(2, { rank: 1 })], 'priority');
    assert.deepEqual(r.map(x => x.key_id), [2, 1]);
  });

  it('多个冷却 key 内部仍按手动序; 无干净候选时冷却 key 保留可用', async () => {
    const { rankCandidates } = await import(`${ROOT}/src/routing/scorer.js`);
    const r = rankCandidates([mk(1, { rank: 0, cd: 60 }), mk(2, { rank: 1, cd: 30 })], 'priority');
    assert.deepEqual(r.map(x => x.key_id), [1, 2]);
    assert.ok(r.every(x => x.available), '冷却 key 不应被移除, 只是靠后');
  });
});
