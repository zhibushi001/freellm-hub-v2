/**
 * 数据留存测试
 * - 删 Key / Hub Key 不再抹掉用量历史 (033 迁移: usage_logs 外键 ON DELETE SET NULL)
 * - 登录锁定: 锁定期过期后计数作废 (否则可被永久锁死)
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

describe('数据留存与锁定', () => {
  let db: DatabaseSync, providerId: number, channelId: number, keyId: number, hubKeyId: number;

  beforeEach(async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hub-ret-'));
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
    const hubKeys = await import('../../src/db/repos/hubKeys.js');
    const p = providers.createProvider({ name: 'p1', base_url: 'https://p1.test/v1' });
    providerId = p.id;
    channelId = channels.createChannel({ provider_id: p.id, multi_key_mode: 'sticky' } as any).id;
    keyId = keys.createKey({ channel_id: channelId, label: 'K', apiKey: 'sk-1' }).id;
    hubKeyId = hubKeys.createHubKey({ name: 'H' }).id;
  });

  it('删 Key: 用量历史保留, key_id 置空', async () => {
    db.prepare(
      `INSERT INTO usage_logs (key_id, hub_key_id, request_model, total_tokens, status, created_at)
       VALUES (?, ?, 'M3', 100, 'success', ?)`,
    ).run(keyId, hubKeyId, Date.now());
    const keys = await import('../../src/db/repos/keys.js');
    keys.deleteKey(keyId);
    const rows = db.prepare('SELECT key_id, hub_key_id, total_tokens FROM usage_logs').all() as any[];
    assert.equal(rows.length, 1, '删 Key 不该删掉用量历史');
    assert.equal(rows[0].key_id, null, 'key_id 应置空 (SET NULL)');
    assert.equal(rows[0].total_tokens, 100);
  });

  it('删 Hub Key: 用量历史保留, hub_key_id 置空', async () => {
    db.prepare(
      `INSERT INTO usage_logs (key_id, hub_key_id, request_model, total_tokens, status, created_at)
       VALUES (?, ?, 'M3', 50, 'success', ?)`,
    ).run(keyId, hubKeyId, Date.now());
    const hubKeys = await import('../../src/db/repos/hubKeys.js');
    hubKeys.deleteHubKey(hubKeyId);
    const rows = db.prepare('SELECT key_id, hub_key_id FROM usage_logs').all() as any[];
    assert.equal(rows.length, 1, '删 Hub Key 不该删掉用量历史');
    assert.equal(rows[0].hub_key_id, null);
  });

  it('登录锁定: 锁定期过期后计数作废, 不再永久锁死', async () => {
    const la = await import('../../src/db/repos/loginAttempts.js');
    // 5 次失败 → 锁定
    for (let i = 0; i < 5; i++) la.recordFailedLogin({ identifier: 'user:zhibushi', ip: '1.2.3.4' });
    const locked = la.getLoginStatus('user:zhibushi');
    assert.equal(locked.isLocked, true);
    // 把锁定期改到过去 = 模拟锁定已过期
    db.prepare('UPDATE login_attempts SET locked_until = ? WHERE identifier = ?').run(Date.now() - 1000, 'user:zhibushi');
    const expired = la.getLoginStatus('user:zhibushi');
    assert.equal(expired.isLocked, false, '锁定期过后应解锁');
    assert.equal(expired.remainingAttempts, 5, '锁定期过后计数应作废重置');
    // 过期后再失败一次: 不应立刻重新上锁
    la.recordFailedLogin({ identifier: 'user:zhibushi', ip: '1.2.3.4' });
    assert.equal(la.getLoginStatus('user:zhibushi').isLocked, false, '过期后第 1 次失败不应立刻重锁');
  });

  it('login_attempts 有 UNIQUE 约束 (并发写不再各写各的计数)', () => {
    const sql = db.prepare("SELECT sql FROM sqlite_master WHERE name='idx_login_attempts_ident'").get() as any;
    assert.ok(sql, '唯一索引应存在');
    assert.match(sql.sql, /UNIQUE/i);
  });
});

/**
 * 渠道 PATCH 的"清空"语义: 显式 null / 空串都要真的把字段清成 NULL,
 * 而不是被 String(null) 变成字面量 "null" 或被 undefined 跳过。
 */
describe('渠道 PATCH 清空语义', () => {
  let db: DatabaseSync, channelId: number;
  beforeEach(async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hub-patch-'));
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
    const p = providers.createProvider({ name: 'p1', base_url: 'https://p1.test/v1' });
    channelId = channels.createChannel({ provider_id: p.id, multi_key_mode: 'sticky' } as any).id;
  });

  it('repo 层: null 值能落库 (部分更新只跳过 undefined)', async () => {
    const channels = await import('../../src/db/repos/channels.js');
    db.prepare('UPDATE channels SET models = ?, tag = ? WHERE id = ?').run('a,b', 't1', channelId);
    channels.updateChannel(channelId, { models: null, tag: null } as any);
    const row = db.prepare('SELECT models, tag FROM channels WHERE id = ?').get(channelId) as any;
    assert.equal(row.models, null, 'models 应被清空 (通配所有模型)');
    assert.equal(row.tag, null, 'tag 应被清空, 而不是字符串 "null"');
  });
});

/**
 * models 传数组时要拍平成 CSV — 否则 String(['a','b']) 之前的 JSON.stringify 会把
 * '["a","b"]' 写进 CSV 列, 渠道之后永不可路由。
 */
describe('models 数组拍平', () => {
  it('PATCH: 数组 → CSV; null/空串 → NULL; 字符串原样', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hub-csv-'));
    process.env.HUB_DATA_DIR = dataDir;
    process.env.HUB_PORT = '0';
    process.env.HUB_SKIP_SEED = process.env.HUB_SKIP_SEED ?? '1';
    const { runMigrations } = await import('../../src/db/migrations/runner.js');
    const db = new DatabaseSync(join(dataDir, 'hub.db'));
    runMigrations(db);
    const conn = await import('../../src/db/connection.js');
    conn.setDbForTest(db);
    const providers = await import('../../src/db/repos/providers.js');
    const channels = await import('../../src/db/repos/channels.js');
    const p = providers.createProvider({ name: 'p1', base_url: 'https://p1.test/v1' });
    const id = channels.createChannel({ provider_id: p.id, multi_key_mode: 'sticky' } as any).id;
    channels.updateChannel(id, { models: 'a,b' } as any);
    assert.equal((db.prepare('SELECT models FROM channels WHERE id = ?').get(id) as any).models, 'a,b');
    channels.updateChannel(id, { models: null } as any);
    assert.equal((db.prepare('SELECT models FROM channels WHERE id = ?').get(id) as any).models, null);
  });
});
