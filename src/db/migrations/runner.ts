/**
 * Migration runner
 * 启动时按文件名顺序执行 SQL migration 文件
 * 已执行的 migration 记录在 schema_migrations 表中
 */
import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MIGRATIONS_DIR = join(__dirname);

/**
 * 永久退役的迁移文件名 —— **磁盘上即使重新出现也一律不执行**。
 *
 * 这三个文件从未进过 git (git log --diff-filter=A/D 都查不到): 2026-09-29 服务端
 * 曾跑在一个未提交的工作副本上, 执行了它们并写进台账, 事后文件从仓库消失。
 * 其台账行已由迁移 038 清理, /health 的 orphaned 归零 —— 但那 3 行的**另一个作用**
 * 是安全栓: 只要行还在, 文件一旦被人从旧副本/归档里恢复, runner 就会跳过它们。
 *
 * 删行会拆掉这个安全栓, 所以这里补一道显式 denylist 顶上。理由不是洁癖:
 * 本项目真出过 "006_model_routes.sql 早被删除却躺在容器 dist 里被重放 → 启动崩溃"
 * 的事故 (见 CHANGELOG)。退役 = SQL 早已执行完毕且被后续迁移取代, 重放只会
 * 撞上已存在的表/列, 而 runner 对非 idempotent 失败是回滚并抛异常 → 服务起不来。
 *
 * 退役判据: 该迁移的逻辑已被现行同名序号的迁移取代, 且 schema 已包含其全部效果。
 * 新增退役项必须写明"被哪个现行迁移取代 + 为何重放不安全"。
 */
const RETIRED_MIGRATIONS = new Set([
  '004_seed_providers.sql',           // 取代者: 005_seed_providers.sql (台账行已由 038 清理)
  '005_channel_newapi_fields.sql',    // 取代者: 006_channel_newapi_fields.sql
  '006_model_routes.sql',             // 取代者: 007_model_routes.sql
]);

/** 迁移文件清单 (runMigrations 与 getMigrationStatus 共用, 避免两处过滤逻辑漂移) */
function listMigrationFiles(): string[] {
  const onDisk = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));
  for (const f of onDisk) {
    if (RETIRED_MIGRATIONS.has(f)) {
      // 不静默: 文件重现意味着有人恢复了旧副本, 正是当年 006 事故的前置条件
      console.warn(
        `[migration] 🚫 ${f} 已在退役名单中, 不会执行 (其效果早已并入现行迁移; ` +
        `重复出现的文件是当年"迁移重放 → 启动崩"事故的前置条件, 请从当前仓库重新同步)`,
      );
    }
  }
  return onDisk
    // 测试用: 跳过 seed (避免 'minimax' / 'ollama' 等固定名与测试冲突)
    .filter((f) => !(f.startsWith('00') && f.includes('seed') && process.env.HUB_SKIP_SEED === '1'))
    .filter((f) => !RETIRED_MIGRATIONS.has(f))
    .sort();
}

/** 迁移文件内容指纹 —— 已应用的迁移文件被改动 = 静默失效 (改 WHERE 条件根本不会再跑) */
function checksumOf(sql: string): string {
  return createHash('sha256').update(sql).digest('hex').slice(0, 32);
}

/** 迁移台账异常 (漂移 / 孤儿行): 由 /health 暴露, 不阻断启动 */
let integrityIssues: Array<{ name: string; kind: 'modified' | 'orphaned'; expected?: string; actual?: string }> = [];
export function getMigrationIntegrityIssues() {
  return integrityIssues;
}

export function runMigrations(db: DatabaseSync): void {
  // 创建迁移表
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        TEXT PRIMARY KEY,
      applied_at  INTEGER NOT NULL,
      checksum    TEXT
    );
  `);
  // 已有库补列 (ALTER 对已存在的列报 duplicate column, 容忍)
  try { db.exec(`ALTER TABLE schema_migrations ADD COLUMN checksum TEXT`); } catch (e: any) {
    if (!/duplicate column/i.test(e?.message || '')) throw e;
  }

  const appliedRows = db
    .prepare('SELECT name, checksum FROM schema_migrations')
    .all() as Array<{ name: string; checksum: string | null }>;
  const applied = new Map(appliedRows.map((r) => [r.name, r.checksum ?? null]));

  const files = listMigrationFiles();

  const insertMigration = db.prepare(
    'INSERT INTO schema_migrations (name, applied_at, checksum) VALUES (?, ?, ?)',
  );

  // 台账体检: 已应用的迁移文件被改动过 = 该迁移永远不会重跑 (曾经踩过:
  // 改一个 WHERE 就以为"修好了", 实际是永久 no-op); 台账里有磁盘上不存在的孤儿行 = 历史事故残留
  integrityIssues = [];
  const known = new Set(appliedRows.map((r) => r.name));
  for (const [name, sum] of applied) {
    if (!known.has(name)) continue;
    if (!files.includes(name)) { integrityIssues.push({ name, kind: 'orphaned' }); continue; }
    const actual = checksumOf(readFileSync(join(MIGRATIONS_DIR, name), 'utf8'));
    if (sum && sum !== actual) {
      integrityIssues.push({ name, kind: 'modified', expected: sum, actual });
    } else if (!sum) {
      // 旧库没有 checksum: 补记当前指纹, 从此开始能检测改动
      db.prepare('UPDATE schema_migrations SET checksum = ? WHERE name = ?').run(actual, name);
      applied.set(name, actual);
    }
  }
  for (const iss of integrityIssues) {
    console.warn(
      `[migration] ⚠ 台账异常: ${iss.name} ${iss.kind === 'modified'
        ? `内容已被改动 (台账 ${iss.expected} ≠ 磁盘 ${iss.actual}) — 该迁移不会重跑, 确认数据库结构是否与文件一致`
        : '台账有此记录但磁盘上没有对应文件 (历史残留, 建议人工核对)'}`,
    );
  }
  // 默认不阻断启动 (老库的孤儿行不该让服务起不来); 严格模式用于部署门禁
  if (integrityIssues.some((i) => i.kind === 'modified') && process.env.HUB_STRICT_MIGRATIONS === '1') {
    throw new Error('迁移文件被改动过 (HUB_STRICT_MIGRATIONS=1): ' + JSON.stringify(integrityIssues));
  }

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    db.exec('BEGIN');
    try {
      // 拆分 statements (按 ;) 然后 逐个执行, 忽略 "duplicate column" 错误 (idempotent ALTER)
      const statements = sql
        .split(/;\s*(?=\n|$)/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      for (const stmt of statements) {
        try {
          db.exec(stmt);
        } catch (e: any) {
          // 容忍 idempotent ADD COLUMN (新表可能已有该列)
          if (e.code === 'ERR_SQLITE_ERROR' && /duplicate column/i.test(e.message || '')) {
            console.log(`[migration] skipped (dup column): ${file}`);
            continue;
          }
          throw e;
        }
      }
      insertMigration.run(file, Date.now(), checksumOf(sql));
      db.exec('COMMIT');
      console.log(`[migration] applied: ${file}`);
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

/**
 * 迁移状态 (供 /health 使用): applied = 已执行数, pending = 待执行数
 * 与 runMigrations 使用相同的文件过滤规则 (含 HUB_SKIP_SEED)
 */
export function getMigrationStatus(db: DatabaseSync): { applied: number; pending: number; modified: number; orphaned: number } {
  const appliedRows = db
    .prepare('SELECT name FROM schema_migrations')
    .all() as Array<{ name: string }>;
  const applied = new Set(appliedRows.map((r) => r.name));
  const files = listMigrationFiles();
  let pending = 0;
  for (const f of files) if (!applied.has(f)) pending++;
  return {
    applied: applied.size,
    pending,
    // modified = 迁移文件被改动 (危险); orphaned = 台账有磁盘无 (历史残留)
    modified: integrityIssues.filter((i) => i.kind === 'modified').length,
    orphaned: integrityIssues.filter((i) => i.kind === 'orphaned').length,
  };
}
