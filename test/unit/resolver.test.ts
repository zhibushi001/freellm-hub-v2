/**
 * Resolver 单元测试
 * 详见 docs/DESIGN.md §4.2
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

describe('resolver', () => {
  let dataDir: string;
  let db: DatabaseSync;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'hub-test-'));
    process.env.HUB_DATA_DIR = dataDir;
    process.env.HUB_PORT = '0';
    const { runMigrations } = await import('../../src/db/migrations/runner.js');
    db = new DatabaseSync(join(dataDir, 'hub.db'));
    process.env.HUB_SKIP_SEED = process.env.HUB_SKIP_SEED ?? '1'; runMigrations(db);
    const conn = await import('../../src/db/connection.js');
    conn.setDbForTest(db);

    // 创建 2 个 provider, 3 个 key
    const providers = await import('../../src/db/repos/providers.js');
    const channels = await import('../../src/db/repos/channels.js');
    const keys = await import('../../src/db/repos/keys.js');

    const p1 = providers.createProvider({ name: 'minimax', base_url: 'https://api.minimax/v1' });
    const p2 = providers.createProvider({ name: 'openrouter', base_url: 'https://openrouter.ai/api/v1' });
    const c1 = channels.createChannel({ provider_id: p1.id });
    const c2 = channels.createChannel({ provider_id: p2.id });
    keys.createKey({ channel_id: c1.id, label: 'A1-主力', apiKey: 'sk-a1' });
    keys.createKey({ channel_id: c1.id, label: 'A2-备用', apiKey: 'sk-a2' });
    keys.createKey({ channel_id: c2.id, label: 'B1', apiKey: 'sk-b1' });
  });

  afterEach(() => {
    try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
  });

  it('纯 model 名 → 第一个可用 key', async () => {
    const { listKeys } = await import('../../src/db/repos/keys.js');
    const { resolveModel } = await import('../../src/routing/resolver.js');
    const allKeys = listKeys();
    const r = resolveModel('M3', allKeys);
    assert.ok('key' in r);
    assert.equal(r.key.provider_name, 'minimax');
    assert.equal(r.upstreamModel, 'M3');
  });

  it('provider/model → 该 provider 下选第一个', async () => {
    const { listKeys } = await import('../../src/db/repos/keys.js');
    const { resolveModel } = await import('../../src/routing/resolver.js');
    const r = resolveModel('openrouter/M3', listKeys());
    assert.ok('key' in r);
    assert.equal(r.key.provider_name, 'openrouter');
    assert.equal(r.upstreamModel, 'M3');
  });

  it('provider/key/model 三段 → 强制指定', async () => {
    const { listKeys } = await import('../../src/db/repos/keys.js');
    const { resolveModel } = await import('../../src/routing/resolver.js');
    const r = resolveModel('minimax/A2-备用/M3', listKeys());
    assert.ok('key' in r);
    assert.equal(r.key.label, 'A2-备用');
    assert.equal(r.key.provider_name, 'minimax');
  });

  it('非提供商前缀的斜杠 → 按完整字面量匹配 (OpenRouter org/model 形式, F2)', async () => {
    const { listKeys } = await import('../../src/db/repos/keys.js');
    const { resolveModel } = await import('../../src/routing/resolver.js');
    // 前缀 nosuch 不是真实提供商 → 不再报 "Provider 下没有可用 Key",
    // 而是把 'nosuch/M3' 当完整字面量; 通道 models 为空 = 通配 → 可命中
    const r = resolveModel('nosuch/M3', listKeys());
    assert.ok('key' in r, `expected key, got ${JSON.stringify(r)}`);
    assert.equal(r.upstreamModel, 'nosuch/M3');
  });

  it('字面量斜杠 ID 只命中"模型列表包含它"的通道 (F2)', async () => {
    const { listKeys } = await import('../../src/db/repos/keys.js');
    const { resolveModel } = await import('../../src/routing/resolver.js');
    const channels = await import('../../src/db/repos/channels.js');
    const chs = channels.listChannels();
    // c1 (minimax) 配别的模型, c2 (openrouter) 配 bunny
    db.prepare('UPDATE channels SET models = ? WHERE id = ?').run('foo-model', chs[0].id);
    db.prepare('UPDATE channels SET models = ? WHERE id = ?').run('stealth/space-bunny-alpha', chs[1].id);
    const r = resolveModel('stealth/space-bunny-alpha', listKeys());
    assert.ok('key' in r, `expected key, got ${JSON.stringify(r)}`);
    assert.equal(r.upstreamModel, 'stealth/space-bunny-alpha');
    assert.equal(r.key.provider_name, 'openrouter');
  });

  it('字面量斜杠 ID 没有任何通道配置 → model_not_found (F2)', async () => {
    const { listKeys } = await import('../../src/db/repos/keys.js');
    const { resolveModel } = await import('../../src/routing/resolver.js');
    const channels = await import('../../src/db/repos/channels.js');
    const chs = channels.listChannels();
    for (const c of chs) db.prepare('UPDATE channels SET models = ? WHERE id = ?').run('other-model', c.id);
    const r = resolveModel('ghost/xyz', listKeys());
    assert.ok('error' in r);
    assert.match(r.error, /未配置/);
    assert.equal((r as any).errorKind, 'model_not_found');
  });

  it('没有 key → 错误', async () => {
    // 禁用所有 key
    const { listKeys, updateKey } = await import('../../src/db/repos/keys.js');
    const { resolveModel } = await import('../../src/routing/resolver.js');
    for (const k of listKeys()) updateKey(k.id, { enabled: 0 });
    const r = resolveModel('M3', listKeys());
    assert.ok('error' in r);
  });

  it('failed 状态的 key 不会被选中', async () => {
    const { listKeys, updateKey } = await import('../../src/db/repos/keys.js');
    const { resolveModel } = await import('../../src/routing/resolver.js');
    const keys = listKeys();
    updateKey(keys[0].id, { status: 'failed' });
    const r = resolveModel('M3', listKeys());
    // 应选第二个 key (minimax A2) 而不是第一个
    assert.ok('key' in r);
    assert.notEqual(r.key.id, keys[0].id);
  });
});
