/**
 * 别名 / 虚拟模型在**真实路由路径**上的端到端验证
 *
 * 上一个文件只测了解析函数; 这里测 selectFirstCandidate 的实际选择结果:
 * 配了别名/虚拟模型/渠道映射之后, 请求到底发给了谁。
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

describe('别名 / 虚拟模型 — 路由路径端到端', () => {
  let db: DatabaseSync;
  let selectFirstCandidate: typeof import('../../src/routing/failover.js').selectFirstCandidate;
  let listKeys: typeof import('../../src/db/repos/keys.js').listKeys;

  beforeEach(async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hub-aliasrt-'));
    process.env.HUB_DATA_DIR = dataDir;
    process.env.HUB_PORT = '0';
    process.env.HUB_SKIP_SEED = process.env.HUB_SKIP_SEED ?? '1';
    const { runMigrations } = await import('../../src/db/migrations/runner.js');
    db = new DatabaseSync(join(dataDir, 'hub.db'));
    runMigrations(db);
    const conn = await import('../../src/db/connection.js');
    conn.setDbForTest(db);
    ({ selectFirstCandidate } = await import('../../src/routing/failover.js'));
    ({ listKeys } = await import('../../src/db/repos/keys.js'));
  });

  function mkUpstream(name: string, modelsCsv: string, channelModelMapping: string | null = null) {
    db.prepare(`INSERT INTO providers (name, base_url, enabled, created_at, updated_at) VALUES (?, 'https://x', 1, 1, 1)`).run(name);
    const pid = db.prepare('SELECT id FROM providers WHERE name = ?').get(name)!.id;
    db.prepare(`INSERT INTO channels (provider_id, label, models, enabled, created_at, updated_at, model_mapping)
                VALUES (?, ?, ?, 1, 1, 1, ?)`).run(pid, `${name}-ch`, modelsCsv, channelModelMapping);
    const cid = db.prepare('SELECT id FROM channels WHERE provider_id = ?').get(pid)!.id;
    db.prepare(`INSERT INTO keys (channel_id, api_key_enc, api_key_hint, label, enabled, status, created_at, updated_at)
                VALUES (?, ?, ?, ?, 1, 'active', 1, 1)`).run(cid, Buffer.from(`e-${name}`), 'sk-h', `${name}-k`);
    const kid = db.prepare('SELECT id FROM keys WHERE label = ?').get(`${name}-k`)!.id;
    // 证据用渠道 models CSV (两种证据任一即可, 与 resolver 的两维门一致)
    return { providerId: pid, channelId: cid, keyId: kid };
  }

  it('没配任何映射 → 请求模型名原样进入路由 (行为不变)', () => {
    mkUpstream('p1', 'plain-model');
    const keys = listKeys();
    const r = selectFirstCandidate('plain-model', keys, { keys: new Set(), models: new Set(), platforms: new Set() });
    assert.ok(!('error' in r), '应能选到候选');
    assert.equal(r.upstreamModel, 'plain-model');
  });

  it('斜杠字面名永不被别名改写', () => {
    mkUpstream('p1', 'org/model');
    db.prepare('INSERT INTO model_mappings (from_model, to_model, enabled, created_at) VALUES (?, ?, 1, 1)')
      .run('org/model', 'hijacked');
    const keys = listKeys();
    const r = selectFirstCandidate('org/model', keys, { keys: new Set(), models: new Set(), platforms: new Set() });
    assert.ok(!('error' in r), `斜杠名应按字面路由, got ${JSON.stringify(r)}`);
    assert.equal(r.upstreamModel, 'org/model', '不能被别名劫持');
  });

  it('全局别名 → 路由到映射后的真实模型', () => {
    mkUpstream('p1', 'gpt-4o-mini');
    db.prepare('INSERT INTO model_mappings (from_model, to_model, enabled, created_at) VALUES (?, ?, 1, 1)')
      .run('fast', 'gpt-4o-mini');
    const keys = listKeys();
    const r = selectFirstCandidate('fast', keys, { keys: new Set(), models: new Set(), platforms: new Set() });
    assert.ok(!('error' in r), `别名应能路由, got ${JSON.stringify(r)}`);
    assert.equal(r.upstreamModel, 'gpt-4o-mini');
  });

  it('别名指向不存在的模型 → 报的是"映射后的名字" (可诊断)', () => {
    mkUpstream('p1', 'real-model');
    db.prepare('INSERT INTO model_mappings (from_model, to_model, enabled, created_at) VALUES (?, ?, 1, 1)')
      .run('fast', 'ghost-model');
    const keys = listKeys();
    const r = selectFirstCandidate('fast', keys, { keys: new Set(), models: new Set(), platforms: new Set() });
    assert.ok('error' in r);
    assert.match(r.error, /ghost-model/);
  });

  it('虚拟模型 → 选到 pin 住的那把 Key 与它的上游模型', () => {
    mkUpstream('pA', 'a-upstream');
    mkUpstream('pB', 'b-upstream');
    db.prepare(`INSERT INTO virtual_models (name, enabled, created_at, updated_at) VALUES ('smart', 1, 1, 1)`).run();
    const vmId = db.prepare('SELECT id FROM virtual_models WHERE name = ?').get('smart')!.id;
    db.prepare(`INSERT INTO model_candidates (virtual_model_id, key_id, upstream_model, priority, weight, pinned, enabled, created_at)
                VALUES (?, ?, ?, 1, 1, 0, 1, 1)`).run(vmId, keyOf('pA'), 'a-upstream');
    db.prepare(`INSERT INTO model_candidates (virtual_model_id, key_id, upstream_model, priority, weight, pinned, enabled, created_at)
                VALUES (?, ?, ?, 0, 1, 1, 1, 1)`).run(vmId, keyOf('pB'), 'b-upstream');

    const keys = listKeys();
    const r = selectFirstCandidate('smart', keys, { keys: new Set(), models: new Set(), platforms: new Set() });
    assert.ok(!('error' in r), `虚拟模型应能路由, got ${JSON.stringify(r)}`);
    assert.equal(r.upstreamModel, 'b-upstream');
    assert.equal(r.key.label, 'pB-k');
  });

  it('虚拟模型的首选候选被跳过 → 自动改用下一个候选', () => {
    mkUpstream('pA', 'a-upstream');
    mkUpstream('pB', 'b-upstream');
    db.prepare(`INSERT INTO virtual_models (name, enabled, created_at, updated_at) VALUES ('smart2', 1, 1, 1)`).run();
    const vmId = db.prepare('SELECT id FROM virtual_models WHERE name = ?').get('smart2')!.id;
    db.prepare(`INSERT INTO model_candidates (virtual_model_id, key_id, upstream_model, priority, weight, pinned, enabled, created_at)
                VALUES (?, ?, ?, 9, 1, 0, 1, 1)`).run(vmId, keyOf('pA'), 'a-upstream');
    db.prepare(`INSERT INTO model_candidates (virtual_model_id, key_id, upstream_model, priority, weight, pinned, enabled, created_at)
                VALUES (?, ?, ?, 1, 1, 0, 1, 1)`).run(vmId, keyOf('pB'), 'b-upstream');

    const keys = listKeys();
    // 故障转移里已跳过 pA 的 key → 虚拟模型应换到 pB
    const r = selectFirstCandidate('smart2', keys, {
      keys: new Set([keyOf('pA')]), models: new Set(), platforms: new Set(),
    });
    assert.ok(!('error' in r), `应回退到第二候选, got ${JSON.stringify(r)}`);
    assert.equal(r.key.label, 'pB-k');
  });

  it('虚拟模型全部候选不可用 → 明确报错 (不是含糊的 model_not_found)', () => {
    mkUpstream('pA', 'a-upstream');
    db.prepare(`INSERT INTO virtual_models (name, enabled, created_at, updated_at) VALUES ('dead-vm', 1, 1, 1)`).run();
    const vmId = db.prepare('SELECT id FROM virtual_models WHERE name = ?').get('dead-vm')!.id;
    db.prepare(`INSERT INTO model_candidates (virtual_model_id, key_id, upstream_model, priority, weight, enabled, created_at)
                VALUES (?, ?, ?, 1, 1, 1, 1)`).run(vmId, keyOf('pA'), 'a-upstream');
    db.prepare('UPDATE keys SET enabled = 0 WHERE label = ?').run('pA-k');

    const keys = listKeys();
    const r = selectFirstCandidate('dead-vm', keys, { keys: new Set(), models: new Set(), platforms: new Set() });
    assert.ok('error' in r, '应报错');
    assert.equal(r.errorKind, 'no_keys');
    assert.match(r.error, /虚拟模型 'dead-vm'/);
    assert.match(r.error, /禁用/);
  });

  it('渠道级映射 → 发给上游的是映射后的名字', () => {
    mkUpstream('p1', 'fast', '{"fast":"gpt-4o-mini"}');
    mkUpstream('p2', 'fast', '{"fast":"gpt-4o"}');
    const keys = listKeys();
    const r = selectFirstCandidate('fast', keys, { keys: new Set(), models: new Set(), platforms: new Set() });
    assert.ok(!('error' in r));
    // 无论选中哪个渠道, 发给上游的名字都必须是该渠道自己映射的真实名
    const chosen = r.key.label;
    assert.ok(chosen === 'p1-k' || chosen === 'p2-k');
    assert.equal(r.upstreamModel, chosen === 'p1-k' ? 'gpt-4o-mini' : 'gpt-4o');
  });

  function keyOf(provider: string): number {
    return db.prepare('SELECT id FROM keys WHERE label = ?').get(`${provider}-k`)!.id;
  }
});