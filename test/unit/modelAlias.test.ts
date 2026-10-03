/**
 * 别名 / 虚拟模型 / 渠道级 model_mapping 接入请求路径
 *
 * 背景: 这三套设施以前只有管理端 CRUD, 请求路径一个都没读 —— 界面配好看着对,
 * 真实请求仍按原名路由, 按别名发请求必然 400 model_not_found。
 *
 * 本测试最关键的一条: **没配置时行为必须与改动前完全一致** (斜杠名绝不被改写)。
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

describe('模型别名 / 虚拟模型 (请求路径)', () => {
  let dataDir: string;
  let db: any;
  let resolveRequestAlias: typeof import('../../src/services/modelAlias.js').resolveRequestAlias;
  let applyChannelModelMapping: typeof import('../../src/services/modelAlias.js').applyChannelModelMapping;
  let resolveMappingChain: typeof import('../../src/services/modelAlias.js').resolveMappingChain;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'hub-alias-'));
    process.env.HUB_DATA_DIR = dataDir;
    process.env.HUB_PORT = '0';
    process.env.HUB_SKIP_SEED = '1';
    const conn = await import('../../src/db/connection.js');
    const { runMigrations } = await import('../../src/db/migrations/runner.js');
    // 与其它测试一致: 每次一个全新库并注入 (getDb() 是单例, 不注入会串库)
    db = new DatabaseSync(join(dataDir, 'hub.db'));
    runMigrations(db);
    conn.setDbForTest(db);
    const mod = await import('../../src/services/modelAlias.js');
    resolveRequestAlias = mod.resolveRequestAlias;
    applyChannelModelMapping = mod.applyChannelModelMapping;
    resolveMappingChain = mod.resolveMappingChain;
  });

  function insertProviderChannelKey(label: string, channelModelMapping: string | null = null) {
    db.prepare(`INSERT INTO providers (name, base_url, enabled, created_at, updated_at) VALUES (?, 'https://x', 1, 1, 1)`).run(label);
    const pid = db.prepare('SELECT id FROM providers WHERE name = ?').get(label).id;
    db.prepare(`INSERT INTO channels (provider_id, label, enabled, created_at, updated_at, model_mapping)
                VALUES (?, ?, 1, 1, 1, ?)`)
      .run(pid, `${label}-ch`, channelModelMapping);
    const cid = db.prepare('SELECT id FROM channels WHERE provider_id = ?').get(pid).id;
    db.prepare(`INSERT INTO keys (channel_id, api_key_enc, api_key_hint, label, enabled, status, created_at, updated_at)
                VALUES (?, ?, ?, ?, 1, 'active', 1, 1)`).run(cid, Buffer.from(`enc-${label}`), 'sk-xxx', `${label}-k`);
    const kid = db.prepare('SELECT id FROM keys WHERE label = ?').get(`${label}-k`).id;
    // key_hash 必须唯一, 用 label 区分
    return { providerId: pid, channelId: cid, keyId: kid };
  }

  describe('安全前提: 没配置 = 零行为变化', () => {
    it('单段名没有配置任何映射 → 返回 null (走原路径)', () => {
      assert.equal(resolveRequestAlias('space-bunny-alpha'), null);
      assert.equal(resolveRequestAlias('my-model'), null);
    });

    it('带斜杠的上游字面 ID 永不解析 (即使配了同名映射)', () => {
      db.prepare('INSERT INTO model_mappings (from_model, to_model, enabled, created_at) VALUES (?, ?, 1, 1)')
        .run('org/model', 'should-not-apply');
      db.prepare(`INSERT INTO virtual_models (name, enabled, created_at, updated_at) VALUES ('org/model', 1, 1, 1)`).run();
      assert.equal(resolveRequestAlias('org/model'), null, '斜杠名必须原样透传给上游');
      assert.equal(resolveRequestAlias('a/b/c'), null);
    });

    it('已禁用的映射与虚拟模型不参与解析', () => {
      db.prepare('INSERT INTO model_mappings (from_model, to_model, enabled, created_at) VALUES (?, ?, 0, 1)')
        .run('old-alias', 'real-model');
      db.prepare(`INSERT INTO virtual_models (name, enabled, created_at, updated_at) VALUES ('off-vm', 0, 1, 1)`).run();
      assert.equal(resolveRequestAlias('old-alias'), null);
      assert.equal(resolveRequestAlias('off-vm'), null);
    });
  });

  describe('全局别名 (model_mappings)', () => {
    it('直接映射生效', () => {
      db.prepare('INSERT INTO model_mappings (from_model, to_model, enabled, created_at) VALUES (?, ?, 1, 1)')
        .run('fast', 'gpt-4o-mini');
      const r = resolveRequestAlias('fast')!;
      assert.equal(r.source, 'mapping');
      assert.equal(r.model, 'gpt-4o-mini');
      assert.deepEqual(r.chain, ['fast', 'gpt-4o-mini']);
    });

    it('多跳链一次解到底', () => {
      const ins = db.prepare('INSERT INTO model_mappings (from_model, to_model, enabled, created_at) VALUES (?, ?, 1, 1)');
      ins.run('a', 'b'); ins.run('b', 'c'); ins.run('c', 'gpt-4o');
      const r = resolveRequestAlias('a')!;
      assert.equal(r.model, 'gpt-4o');
      assert.equal(r.chain.length, 4);
    });

    it('映射循环不会无限转: 按原名处理并给出 cyclic 标记', () => {
      const ins = db.prepare('INSERT INTO model_mappings (from_model, to_model, enabled, created_at) VALUES (?, ?, 1, 1)');
      ins.run('x', 'y'); ins.run('y', 'x');
      assert.equal(resolveRequestAlias('x'), null, '循环配置按未配置处理 (请求会正常报没有该模型)');
      const c = resolveMappingChain('x');
      assert.equal(c.cyclic, true);
    });

    it('超长链被截断, 不拖垮请求', () => {
      const ins = db.prepare('INSERT INTO model_mappings (from_model, to_model, enabled, created_at) VALUES (?, ?, 1, 1)');
      for (let i = 0; i < 15; i++) ins.run(`m${i}`, `m${i + 1}`);
      const r = resolveRequestAlias('m0');
      // 截断后按原名 (返回的仍是 mapping, 但链被限长) —— 关键是函数返回了而不是卡死
      assert.ok(r === null || r.chain.length <= 11, `链长应受限, got ${r?.chain.length}`);
    });
  });

  describe('虚拟模型 (virtual_models + model_candidates)', () => {
    it('优先于全局别名, 并按 pinned/priority 选出候选', () => {
      db.prepare('INSERT INTO model_mappings (from_model, to_model, enabled, created_at) VALUES (?, ?, 1, 1)')
        .run('smart', 'from-mapping');
      const a = insertProviderChannelKey('A');
      const b = insertProviderChannelKey('B');
      db.prepare(`INSERT INTO virtual_models (name, enabled, created_at, updated_at) VALUES ('smart', 1, 1, 1)`).run();
      const vmId = db.prepare('SELECT id FROM virtual_models WHERE name = ?').get('smart').id;
      const ins = db.prepare(`INSERT INTO model_candidates (virtual_model_id, key_id, upstream_model, priority, weight, enabled, created_at)
                             VALUES (?, ?, ?, ?, 1, 1, 1)`);
      ins.run(vmId, a.keyId, 'a-model', 1);
      ins.run(vmId, b.keyId, 'b-model', 9);

      const r = resolveRequestAlias('smart')!;
      assert.equal(r.source, 'virtual');
      assert.equal(r.candidates.length, 2);
      assert.equal(r.candidates[0].upstreamModel, 'b-model', '高 priority 应排前');
      assert.equal(r.model, 'b-model');
    });

    it('候选按 pinned 优先于 priority', () => {
      const a = insertProviderChannelKey('A');
      const b = insertProviderChannelKey('B');
      db.prepare(`INSERT INTO virtual_models (name, enabled, created_at, updated_at) VALUES ('pin-test', 1, 1, 1)`).run();
      const vmId = db.prepare('SELECT id FROM virtual_models WHERE name = ?').get('pin-test').id;
      const ins = db.prepare(`INSERT INTO model_candidates (virtual_model_id, key_id, upstream_model, priority, weight, pinned, enabled, created_at)
                             VALUES (?, ?, ?, ?, 1, ?, 1, 1)`);
      ins.run(vmId, a.keyId, 'low-prio', 1, 0);
      ins.run(vmId, b.keyId, 'pinned', 0, 1);
      const r = resolveRequestAlias('pin-test')!;
      assert.equal(r.candidates[0].upstreamModel, 'pinned');
    });

    it('禁用/坏掉的候选排后, 并带不可用原因 (供报错说明)', () => {
      const a = insertProviderChannelKey('A');
      db.prepare(`INSERT INTO virtual_models (name, enabled, created_at, updated_at) VALUES ('mix', 1, 1, 1)`).run();
      const vmId = db.prepare('SELECT id FROM virtual_models WHERE name = ?').get('mix').id;
      db.prepare(`INSERT INTO model_candidates (virtual_model_id, key_id, upstream_model, priority, weight, enabled, created_at)
                  VALUES (?, ?, 'good', 1, 1, 1, 1)`).run(vmId, a.keyId);
      // 禁用另一个 key, 让它成为低优先级候选
      const b = insertProviderChannelKey('B');
      db.prepare(`INSERT INTO model_candidates (virtual_model_id, key_id, upstream_model, priority, weight, enabled, created_at)
                  VALUES (?, ?, 'bad', 5, 1, 1, 1)`).run(vmId, b.keyId);
      db.prepare('UPDATE keys SET enabled = 0 WHERE id = ?').run(b.keyId);

      const r = resolveRequestAlias('mix')!;
      assert.equal(r.candidates[0].upstreamModel, 'good', '可用候选排前');
      assert.equal(r.candidates[1].usable, false);
      assert.match(r.candidates[1].unusableReason!, /已禁用/);
    });

    it('全部候选不可用时仍返回结构, 由路由层给出明确报错', () => {
      const b = insertProviderChannelKey('B');
      db.prepare(`INSERT INTO virtual_models (name, enabled, created_at, updated_at) VALUES ('dead', 1, 1, 1)`).run();
      const vmId = db.prepare('SELECT id FROM virtual_models WHERE name = ?').get('dead').id;
      db.prepare(`INSERT INTO model_candidates (virtual_model_id, key_id, upstream_model, enabled, created_at)
                  VALUES (?, ?, 'x', 1, 1)`).run(vmId, b.keyId);
      db.prepare('UPDATE keys SET enabled = 0 WHERE id = ?').run(b.keyId);
      const r = resolveRequestAlias('dead')!;
      assert.equal(r.candidates.length, 1);
      assert.equal(r.candidates.filter((c) => c.usable).length, 0);
      assert.match(r.candidates[0].unusableReason!, /已禁用/);
    });

    it('禁用的候选条目不参与选择', () => {
      const a = insertProviderChannelKey('A');
      db.prepare(`INSERT INTO virtual_models (name, enabled, created_at, updated_at) VALUES ('dis', 1, 1, 1)`).run();
      const vmId = db.prepare('SELECT id FROM virtual_models WHERE name = ?').get('dis').id;
      db.prepare(`INSERT INTO model_candidates (virtual_model_id, key_id, upstream_model, enabled, created_at)
                  VALUES (?, ?, 'x', 0, 1)`).run(vmId, a.keyId);
      const r = resolveRequestAlias('dis')!;
      assert.equal(r.candidates.length, 0);
    });
  });

  describe('渠道级 model_mapping', () => {
    it('JSON 对象写法', () => {
      assert.equal(applyChannelModelMapping('{"fast":"gpt-4o-mini"}', 'fast'), 'gpt-4o-mini');
      assert.equal(applyChannelModelMapping('{"fast":"gpt-4o-mini"}', 'other'), null);
    });
    it('每行 alias=real 写法', () => {
      const raw = '# 注释行\nfast = gpt-4o-mini\nsmart=o3\n';
      assert.equal(applyChannelModelMapping(raw, 'fast'), 'gpt-4o-mini');
      assert.equal(applyChannelModelMapping(raw, 'smart'), 'o3');
      assert.equal(applyChannelModelMapping(raw, 'nope'), null);
    });
    it('未配置 / 空 / 坏 JSON → null (不能把请求带崩)', () => {
      assert.equal(applyChannelModelMapping(null, 'x'), null);
      assert.equal(applyChannelModelMapping('   ', 'x'), null);
      assert.equal(applyChannelModelMapping('{bad json', 'x'), null);
    });
  });
});