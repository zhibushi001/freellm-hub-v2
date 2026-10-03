/**
 * 登录失败锁定
 * 双维度: username + IP, 防暴力破解
 *
 * 规则:
 *   - 同一 username 连续失败 5 次 → 锁定 15 分钟
 *   - 同一 IP 连续失败 20 次 → 锁定 1 小时 (防分布式爆同 username)
 *   - 锁定期间: 即便密码正确也返回 423 Locked
 *   - 登录成功: 清零计数
 */

import { getDb } from '../connection.js';

const MAX_USERNAME_ATTEMPTS = 5;
const LOCKOUT_USERNAME_MS = 15 * 60 * 1000; // 15 分钟

const MAX_IP_ATTEMPTS = 20;
const LOCKOUT_IP_MS = 60 * 60 * 1000; // 1 小时

export interface LoginAttemptStatus {
  lockedUntil: number | null;
  remainingAttempts: number;
  isLocked: boolean;
}

/** 获取当前状态 */
export function getLoginStatus(identifier: string): LoginAttemptStatus {
  const row = getDb()
    .prepare('SELECT attempts, locked_until FROM login_attempts WHERE identifier = ?')
    .get(identifier) as { attempts: number; locked_until: number | null } | undefined;
  if (!row) {
    return { lockedUntil: null, remainingAttempts: MAX_USERNAME_ATTEMPTS, isLocked: false };
  }
  const locked = row.locked_until && row.locked_until > Date.now();
  // 锁定期一过, 计数就作废 (重新从 0 起算)。
  // 之前不清零: 第 5 次失败后 attempts 永远 >= 5, 之后每次失败都立刻重新上锁,
  // 任何人每隔一会儿试错一次就能让单账号网关长期锁在 423 里 (本项目只有 1 个管理员)。
  const effectiveAttempts = !locked && row.locked_until !== null ? 0 : row.attempts;
  return {
    lockedUntil: locked ? row.locked_until : null,
    remainingAttempts: Math.max(0, MAX_USERNAME_ATTEMPTS - effectiveAttempts),
    isLocked: !!locked,
  };
}

/** 记录一次失败, 并判断是否需要锁定 */
export function recordFailedLogin(input: {
  identifier: string;
  ip?: string;
  userAgent?: string;
}): LoginAttemptStatus {
  const now = Date.now();
  const db = getDb();

  // 1. Username 维度
  const existing = db
    .prepare('SELECT id, attempts, locked_until FROM login_attempts WHERE identifier = ?')
    .get(input.identifier) as { id: number; attempts: number; locked_until: number | null } | undefined;

  // 与 getLoginStatus 同规则: 上一次锁定已过期 → 从 0 重新计数
  const stale = existing?.locked_until != null && existing.locked_until <= now;
  const baseAttempts = !existing || stale ? 0 : existing.attempts;
  let newAttempts = baseAttempts + 1;
  let newLockedUntil: number | null = stale ? null : (existing?.locked_until ?? null);

  if (newAttempts >= MAX_USERNAME_ATTEMPTS) {
    newLockedUntil = now + LOCKOUT_USERNAME_MS;
  }

  if (existing) {
    db.prepare(
      'UPDATE login_attempts SET attempts = ?, locked_until = ?, last_attempt = ?, last_ip = ?, last_user_agent = ? WHERE id = ?',
    ).run(newAttempts, newLockedUntil, now, input.ip ?? null, input.userAgent ?? null, existing.id);
  } else {
    db.prepare(
      'INSERT INTO login_attempts (identifier, attempts, locked_until, last_attempt, last_ip, last_user_agent) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(input.identifier, newAttempts, newLockedUntil, now, input.ip ?? null, input.userAgent ?? null);
  }

  // 2. IP 维度 (独立计数, 防分布式爆破同一 username)
  if (input.ip) {
    const ipId = `ip:${input.ip}`;
    const ipRow = db
      .prepare('SELECT id, attempts, locked_until FROM login_attempts WHERE identifier = ?')
      .get(ipId) as { id: number; attempts: number; locked_until: number | null } | undefined;

    const ipStale = ipRow?.locked_until != null && ipRow.locked_until <= now;
    let ipAttempts = (!ipRow || ipStale ? 0 : ipRow.attempts) + 1;
    let ipLocked = ipStale ? null : (ipRow?.locked_until ?? null);

    if (ipAttempts >= MAX_IP_ATTEMPTS) {
      ipLocked = now + LOCKOUT_IP_MS;
    }

    if (ipRow) {
      db.prepare(
        'UPDATE login_attempts SET attempts = ?, locked_until = ?, last_attempt = ? WHERE id = ?',
      ).run(ipAttempts, ipLocked, now, ipRow.id);
    } else {
      db.prepare(
        'INSERT INTO login_attempts (identifier, attempts, locked_until, last_attempt) VALUES (?, ?, ?, ?)',
      ).run(ipId, ipAttempts, ipLocked, now);
    }
  }

  return getLoginStatus(input.identifier);
}

/** 登录成功, 清零 */
export function clearLoginAttempts(identifier: string): void {
  getDb().prepare('DELETE FROM login_attempts WHERE identifier = ?').run(identifier);
}

/** 管理员手动解锁 */
export function unlockLoginAttempts(identifier: string): void {
  getDb().prepare('DELETE FROM login_attempts WHERE identifier = ?').run(identifier);
}

/** 列出所有被锁定的 (admin 页面用) */
export function listLockedAccounts(): Array<{
  identifier: string;
  attempts: number;
  locked_until: number;
  last_attempt: number;
  last_ip: string | null;
}> {
  return getDb()
    .prepare(
      'SELECT identifier, attempts, locked_until, last_attempt, last_ip FROM login_attempts WHERE locked_until > ? ORDER BY locked_until DESC',
    )
    .all(Date.now()) as any;
}
