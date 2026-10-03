/**
 * SQLite 数据库备份
 *
 * node:sqlite 是同步 API, 直接 copy 文件可能拿到 WAL 未 checkpoint 的旧数据。
 * 用 VACUUM INTO 生成一个干净的、完全自包含的备份副本。
 *
 * 每次备份旁会复制 master.key + session.secret (运维审计 #1):
 * 恢复 hub.db 没有 master.key = 所有上游 Key 永久不可解。
 * 备份目录默认在数据卷内, 用 HUB_BACKUP_DIR 指到卷外 (另一块盘/NFS/挂载点) 才防整卷丢失。
 */
import { resolve, join } from 'node:path';
import { existsSync, mkdirSync, readdirSync, unlinkSync, statSync, copyFileSync } from 'node:fs';
import { config } from '../config/env.js';
import { getDb } from '../db/connection.js';
import { logger } from '../util/logger.js';

const BACKUP_DIR = process.env.HUB_BACKUP_DIR
  ? resolve(process.env.HUB_BACKUP_DIR)
  : resolve(config.dataDir, 'backups');
// 份数上限只作兜底 (磁盘救场), 真正的保留策略是"保留多少天"。
// 原值 7 会把 RETENTION_DAYS=30 完全架空: 一天内多几次部署就把 7 个位置用光,
// 30 天历史只剩几小时 (实测备份目录 7 份里 4 份是同一天)。
const MAX_BACKUPS = parseInt(process.env.HUB_MAX_BACKUPS || '90', 10);
const RETENTION_DAYS = parseInt(process.env.HUB_BACKUP_RETENTION_DAYS || '30', 10);

/**
 * 执行一次完整备份, 返回备份文件路径
 */
export function backupDatabase(): string {
  mkdirSync(BACKUP_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupPath = join(BACKUP_DIR, `hub-${ts}.db`);

  const db = getDb();
  // VACUUM INTO: 生成一个干净的、紧凑的完整副本 (含所有 WAL 数据)
  db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);

  // 加密钥 + 会话密钥旁车副本 (与 hub-<ts>.db 同名配对, 恢复时成对拷回)
  const base = backupPath.slice(0, -3);
  const sidecars: Array<[string, string]> = [
    [config.masterKeyPath, `${base}.master.key`],
    [config.sessionSecretPath, `${base}.session.secret`],
  ];
  for (const [src, dst] of sidecars) {
    try {
      if (existsSync(src)) copyFileSync(src, dst);
    } catch (e: any) {
      logger.warn({ src, err: e?.message }, 'Sidecar copy failed (backup db itself is fine)');
    }
  }

  const size = statSync(backupPath).size;
  logger.info({ backupPath, sizeKB: Math.round(size / 1024) }, 'Database backup created');
  return backupPath;
}

/**
 * 清理过期备份: 超过 RETENTION_DAYS 天的, 以及超出兜底份数上限的。
 * 同一天内的多份备份只保留最新的一份 —— 一天一个还原点就够, 把名额让给更早的日期。
 */
export function pruneBackups(): number {
  if (!existsSync(BACKUP_DIR)) return 0;
  const files = readdirSync(BACKUP_DIR)
    .filter((f) => f.startsWith('hub-') && f.endsWith('.db'))
    .map((f) => {
      const path = join(BACKUP_DIR, f);
      const stat = statSync(path);
      return { name: f, path, mtime: stat.mtimeMs, size: stat.size };
    })
    .sort((a, b) => b.mtime - a.mtime); // 最新的在前

  const now = Date.now();
  const maxAgeMs = RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let deleted = 0;
  const keptToday = new Set<string>();

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const dayKey = new Date(f.mtime).toISOString().slice(0, 10);
    const tooOld = now - f.mtime > maxAgeMs;
    const tooMany = i >= MAX_BACKUPS;
    // 同日冗余: 只留当天最新一份 (files 已按新→旧排序)
    const sameDayOlder = keptToday.has(dayKey);
    if (!tooOld && !tooMany && !sameDayOlder) keptToday.add(dayKey);
    if (tooOld || tooMany || sameDayOlder) {
      unlinkSync(f.path);
      // 同时删掉配套的 master.key / session.secret 副本
      const base = f.path.slice(0, -3);
      for (const side of [`${base}.master.key`, `${base}.session.secret`]) {
        try { if (existsSync(side)) unlinkSync(side); } catch { /* intentional empty */ }
      }
      deleted++;
      logger.info(
        { file: f.name, reason: tooOld ? 'expired' : tooMany ? 'excess' : 'same-day' },
        'Backup pruned',
      );
    }
  }
  return deleted;
}

/**
 * 列出现有备份
 */
export function listBackups(): Array<{ name: string; size: number; mtime: string }> {
  if (!existsSync(BACKUP_DIR)) return [];
  return readdirSync(BACKUP_DIR)
    .filter((f) => f.startsWith('hub-') && f.endsWith('.db'))
    .map((f) => {
      const stat = statSync(join(BACKUP_DIR, f));
      return { name: f, size: stat.size, mtime: new Date(stat.mtimeMs).toISOString() };
    })
    .sort((a, b) => b.mtime.localeCompare(a.mtime));
}
