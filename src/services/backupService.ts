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
import { resolve, join, basename } from 'node:path';
import { existsSync, mkdirSync, readdirSync, unlinkSync, statSync, copyFileSync } from 'node:fs';
import { config } from '../config/env.js';
import { getDb } from '../db/connection.js';
import { logger } from '../util/logger.js';

const BACKUP_DIR = process.env.HUB_BACKUP_DIR
  ? resolve(process.env.HUB_BACKUP_DIR)
  : resolve(config.dataDir, 'backups');
const MAX_BACKUPS = parseInt(process.env.HUB_MAX_BACKUPS || '7', 10);
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
 * 清理过期备份 (超过 RETENTION_DAYS 天) 和超量备份 (超过 MAX_BACKUPS 个)
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

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const tooOld = now - f.mtime > maxAgeMs;
    const tooMany = i >= MAX_BACKUPS;
    if (tooOld || tooMany) {
      unlinkSync(f.path);
      // 同时删掉配套的 master.key / session.secret 副本
      const base = f.path.slice(0, -3);
      for (const side of [`${base}.master.key`, `${base}.session.secret`]) {
        try { if (existsSync(side)) unlinkSync(side); } catch { /* intentional empty */ }
      }
      deleted++;
      logger.info({ file: f.name, reason: tooOld ? 'expired' : 'excess' }, 'Backup pruned');
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
