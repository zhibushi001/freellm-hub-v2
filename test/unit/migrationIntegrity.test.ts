/**
 * 迁移台账完整性测试
 * - 已应用的迁移被改动 → 检测出来 (否则改 WHERE 是永久 no-op, 而且 /health 照样 200)
 * - 台账有磁盘无的孤儿行 → 检测出来
 * - 老库没有 checksum 列 → 自动补记, 从此能检测改动
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const MIG_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../src/db/migrations');

describe('迁移台账完整性', () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'hub-mig-'));
    process.env.HUB_DATA_DIR = dataDir;
    process.env.HUB_PORT = '0';
    process.env.HUB_SKIP_SEED = '1';
  });
  afterEach(() => { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* noop */ } });

  it('正常路径: 无台账异常, 重复运行幂等', async () => {
    const { runMigrations, getMigrationStatus } = await import('../../src/db/migrations/runner.js');
    const db = new DatabaseSync(join(dataDir, 'hub.db'));
    runMigrations(db);
    const st = getMigrationStatus(db);
    assert.equal(st.pending, 0);
    assert.equal(st.modified, 0, '刚应用完不应有改动异常');
    runMigrations(db); // 幂等
    assert.equal(getMigrationStatus(db).pending, 0);
  });

  it('已应用的迁移被改动 → 台账体检报 modified', async () => {
    const { runMigrations, getMigrationStatus, getMigrationIntegrityIssues } = await import('../../src/db/migrations/runner.js');
    const db = new DatabaseSync(join(dataDir, 'hub.db'));
    runMigrations(db);
    const applied = (db.prepare('SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1').get() as any).name as string;
    const path = join(MIG_DIR, applied);
    const original = readFileSync(path, 'utf8');
    try {
      // 模拟"有人事后改了已应用的迁移" —— 最危险的情况: 它再也不会执行
      writeFileSync(path, `${original}\n-- tampered after apply\n`, 'utf8');
      // checksum 列已记录 → 重启体检应发现
      const conn = await import('../../src/db/connection.js');
      conn.setDbForTest(db);
      const { getMigrationIntegrityIssues: gi } = await import('../../src/db/migrations/runner.js');
      // runMigrations 已在上一次跑过, 这里手动重算: 通过删除 checksum 再跑一次体检
      db.prepare('UPDATE schema_migrations SET checksum = ? WHERE name = ?').run('deadbeef', applied);
      // 重新执行体检路径
      const mod = await import('../../src/db/migrations/runner.js');
      mod.runMigrations(db);
      const st = mod.getMigrationStatus(db);
      assert.ok(st.modified >= 1, `应检测到被改动的迁移, got ${JSON.stringify(st)} issues=${JSON.stringify(gi())}`);
      const iss = mod.getMigrationIntegrityIssues().find((i) => i.kind === 'modified');
      assert.ok(iss, '应有 modified 类型问题');
      assert.equal(iss!.name, applied);
      assert.equal(iss!.expected, 'deadbeef');
    } finally {
      writeFileSync(path, original, 'utf8');
    }
  });

  it('孤儿台账行 (磁盘无文件) → orphaned, 且不阻断启动', async () => {
    const { runMigrations, getMigrationStatus, getMigrationIntegrityIssues } = await import('../../src/db/migrations/runner.js');
    const db = new DatabaseSync(join(dataDir, 'hub.db'));
    runMigrations(db);
    db.prepare('INSERT INTO schema_migrations (name, applied_at, checksum) VALUES (?, ?, NULL)')
      .run('999_ghost_migration.sql', Date.now());
    // 重新体检
    const mod = await import('../../src/db/migrations/runner.js?recheck=1');
    // 直接复用已加载模块: runMigrations 会重算 integrityIssues
    mod.runMigrations(db);
    const st = mod.getMigrationStatus(db);
    assert.equal(st.pending, 0);
    assert.ok(st.orphaned >= 1, `应检测到孤儿行, got ${JSON.stringify(st)}`);
    assert.ok(mod.getMigrationIntegrityIssues().some((i) => i.name === '999_ghost_migration.sql'));
  });

  it('退役迁移文件即使重新出现也绝不执行 (038 删台账行后重建安全栓)', async () => {
    const { runMigrations } = await import('../../src/db/migrations/runner.js');
    const db = new DatabaseSync(join(dataDir, 'hub.db'));
    runMigrations(db);

    // 模拟"有人从旧副本/归档里恢复了 006_model_routes.sql" —— 当年 006 孤儿重放
    // 导致启动崩溃的就是这个场景。用会炸的 SQL: 一旦被执行, 后续断言立刻暴露。
    const retired = '006_model_routes.sql';
    const path = join(MIG_DIR, retired);
    const existed = existsSync(path);
    const original = existed ? readFileSync(path, 'utf8') : null;
    try {
      writeFileSync(path, 'CREATE TABLE this_should_never_be_created (x INTEGER);\n', 'utf8');
      // 关键: 不能抛异常 (重放会让服务起不来), 也不能建表
      runMigrations(db);

      const t = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='this_should_never_be_created'",
      ).get();
      assert.equal(t, undefined, '退役文件被执行了 —— 安全栓失效');
      const rec = db.prepare('SELECT name FROM schema_migrations WHERE name = ?').get(retired);
      assert.equal(rec, undefined, '退役文件不应写入台账');
    } finally {
      if (original !== null) writeFileSync(path, original, 'utf8');
      else rmSync(path, { force: true });
    }
  });

  it('老库没有 checksum 列 → 自动补列并补记指纹, 不炸不阻断', async () => {
    const { runMigrations } = await import('../../src/db/migrations/runner.js');
    const db = new DatabaseSync(join(dataDir, 'hub.db'));
    // 先正常建库 (拿到真实的表结构), 再把台账"降级"回旧格式 (无 checksum 列)
    runMigrations(db);
    const names = (db.prepare('SELECT name FROM schema_migrations').all() as any[]).map((r) => r.name);
    db.exec(`DROP TABLE schema_migrations;
             CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);`);
    for (const n of names) {
      db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, 1)').run(n);
    }
    // 老库升级: 应补列 + 给每条补记当前指纹
    runMigrations(db);
    const cols = (db.prepare('PRAGMA table_info(schema_migrations)').all() as any[]).map((c) => c.name);
    assert.ok(cols.includes('checksum'), '应补上 checksum 列');
    const rows = db.prepare('SELECT name, checksum FROM schema_migrations').all() as any[];
    assert.equal(rows.length, names.length);
    assert.ok(rows.every((r) => typeof r.checksum === 'string' && r.checksum.length > 0), '每条都应补记指纹');
    // 补记后再体检: 没有 modified 异常
    const mod = await import('../../src/db/migrations/runner.js');
    assert.equal(mod.getMigrationStatus(db).modified, 0);
  });
});
