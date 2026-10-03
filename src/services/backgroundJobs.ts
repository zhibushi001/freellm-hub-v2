/**
 * 后台任务调度
 * 详见 docs/DESIGN.md §4 + freellmapi cooldown-probe.ts
 *
 * 五个任务:
 *   1. health-check     (每 5 min)  探测所有 enabled key, 更新 status
 *   2. cooldown-probe   (每 1 min)  探测 heuristic cooldown 早恢复
 *   3. degradation-update(每 5 min)  更新全局降级状态
 *   4. db-backup        (每 24h)    VACUUM INTO 备份 + 清理过期
 *   5. log-cleanup      (每 24h)    清理过期 usage_logs / media_tasks
 */
import { listKeys, recoverExpiredFailedKeys } from '../db/repos/keys.js';
import { getDecryptedApiKey } from '../db/repos/keys.js';
import { httpSend } from '../adapters/client.js';
import { transitionKeyStatus } from './keyHealth.js';
import { upsertDiscoveredModel, clearDiscoveredModelsForKey } from '../db/repos/discoveredModels.js';
import { getProbeableCooldowns, clearCooldown } from '../db/repos/cooldowns.js';
import { updateDegradationState } from './degradation.js';
import { backupDatabase, pruneBackups } from './backupService.js';
import { getDb } from '../db/connection.js';
import { logger } from '../util/logger.js';
import { parseJsonSafe } from '../util/json.js';
import { fire } from './notifierService.js';

// 模拟 setInterval 包装, 便于测试时关闭
const timers: NodeJS.Timeout[] = [];

const LOG_RETENTION_DAYS = parseInt(process.env.HUB_LOG_RETENTION_DAYS || '90', 10);

export function startBackgroundJobs(): void {
  // 所有 interval 回调都兜底: setInterval 的 async 拒绝/sync 抛错 = unhandledRejection/uncaughtException
  // → Node 默认直接退出进程 (运维审计 #2)
  // 健康检查 - 5 分钟
  timers.push(setInterval(() => {
    runHealthCheck().catch(e => logger.error({ e }, 'health check failed'));
  }, 5 * 60 * 1000));
  // Cooldown 探测 - 1 分钟
  timers.push(setInterval(() => {
    runCooldownProbe().catch(e => logger.error({ e }, 'cooldown probe failed'));
  }, 60 * 1000));
  // Degradation 更新 - 5 分钟 (跟 health-check 错开, 共用结果)
  timers.push(setInterval(() => {
    try { updateDegradationState(); } catch (e) { logger.error({ e }, 'degradation update failed'); }
  }, 5 * 60 * 1000));
  // DB 备份 - 24 小时
  timers.push(setInterval(runBackup, 24 * 60 * 60 * 1000));
  // 日志清理 - 24 小时
  timers.push(setInterval(() => {
    try { runLogCleanup(); } catch (e) { logger.error({ e }, 'log cleanup failed'); }
  }, 24 * 60 * 60 * 1000));

  // 启动时先跑一次 — 备份/清理不再只挂在24h定时器上:
  // 服务如果比24h重启更频繁, 定时器永远轮不到 → 备份静默地一次都不跑 (运维审计 #5)
  setTimeout(() => {
    runHealthCheck().catch(e => logger.error({ e }, 'health check startup failed'));
    runCooldownProbe().catch(e => logger.error({ e }, 'cooldown probe startup failed'));
    try { updateDegradationState(); } catch (e) { logger.error({ e }, 'degradation startup failed'); }
    runBackup();
    try { runLogCleanup(); } catch (e) { logger.error({ e }, 'log cleanup startup failed'); }
  }, 5_000);
  logger.info('Background jobs started');
}

export function stopBackgroundJobs(): void {
  for (const t of timers) clearInterval(t);
  timers.length = 0;
}

async function runHealthCheck(): Promise<void> {
  // 外层兜底: listKeys()/degradation 的 DB 错误不能变成 unhandledRejection (interval 无 catch)
  try {
    // failed 键 30 分钟自动回炉 —— 从 listKeys 的读路径挪到这里 (每 5 分钟一次即可,
    // 不该每个请求都抢一次 SQLite 写锁)
    const recovered = recoverExpiredFailedKeys();
    if (recovered > 0) logger.info({ recovered }, 'Recovered expired failed keys');
    const keys = listKeys().filter(k => k.enabled === 1);
    logger.info({ count: keys.length }, 'Health check starting');
    for (const key of keys) {
      try {
        const apiKey = getDecryptedApiKey(key.id);
        const url = `${key.base_url.replace(/\/$/, '')}${key.models_path}`;
        const res = await httpSend(url, apiKey, { method: 'GET', timeoutMs: 15_000 });
        transitionKeyStatus(key.id, { status: res.status, body: parseJsonSafe(res.body) });
        if (res.status >= 200 && res.status < 300) {
          const models = parseModels(res.body);
          clearDiscoveredModelsForKey(key.id);
          for (const m of models) upsertDiscoveredModel(key.id, m);
        }
      } catch (e: any) {
        transitionKeyStatus(key.id, { status: 0, error: e.message });
      }
    }
    // 跑完后更新 degradation
    try { updateDegradationState(); } catch (e) { logger.error({ e }, 'degradation update failed'); }
    // 全部 Key 同时不可用 = 系统已不可服务 → 告警 (排除 unknown: 新 key 未探测不算)
    const UNAVAILABLE = ['failed', 'quota_exhausted', 'disabled', 'cooldown'];
    const down = keys.filter(k => UNAVAILABLE.includes(k.status));
    if (keys.length > 0 && down.length === keys.length) {
      fire({
        level: 'error',
        title: `全部 ${keys.length} 个 Key 均不可用`,
        text: down.map(k => `${k.label ?? `#${k.id}`}(${k.status})`).join(', '),
        dedupKey: 'all-keys-down',
      });
    }
    logger.info('Health check done');
  } catch (e: any) {
    logger.error({ e }, 'Health check failed');
  }
}

/**
 * Cooldown 早恢复 - 探测式
 *
 * 规则 (照搬 freellmapi cooldown-probe.ts):
 *   - 只探测 recoverable=1 (heuristic) 的 cooldown
 *   - 跳过 authoritative (quota_exhausted, auth_invalid)
 *   - 已过半 + 还剩 > 1min
 *   - 单次最多 3 个探测 (防 thundering herd)
 *   - 探测失败**不延长** cooldown, 只把下次探测延后 (我们 Phase 2 简化: 不实现 backoff 调度, 失败就放过)
 */
const PROBE_BUDGET_PER_PASS = 3;

async function runCooldownProbe(): Promise<void> {
  // 外层兜底: getProbeableCooldowns 的 DB 错误不能变成 unhandledRejection
  let candidates;
  try {
    candidates = getProbeableCooldowns(PROBE_BUDGET_PER_PASS);
  } catch (e: any) {
    logger.error({ e }, 'Cooldown probe query failed');
    return;
  }
  if (candidates.length === 0) return;
  logger.info({ count: candidates.length }, 'Cooldown probe starting');

  for (const c of candidates) {
    try {
      const apiKey = getDecryptedApiKey(c.key_id);
      const url = `${c.key_base_url.replace(/\/$/, '')}${c.key_models_path ?? c.key_api_path ?? '/models'}`;
      const res = await httpSend(url, apiKey, { method: 'GET', timeoutMs: 10_000 });
      if (res.status >= 200 && res.status < 300) {
        // 探测成功 - 清掉 cooldown
        clearCooldown(c.key_id, c.reason, c.upstream_model, 'probe_success');
        logger.info({ keyId: c.key_id, reason: c.reason, model: c.upstream_model }, 'Cooldown cleared by probe');
      } else {
        // 探测失败 - 不延长 cooldown, 只是记录
        logger.debug({ keyId: c.key_id, status: res.status }, 'Cooldown probe failed, leaving cooldown');
      }
    } catch (e: any) {
      logger.debug({ keyId: c.key_id, error: e.message }, 'Cooldown probe error, leaving cooldown');
    }
  }
}

function parseModels(body: string): string[] {
  const j = parseJsonSafe(body);
  if (!j) return [];
  if (Array.isArray(j.data)) return j.data.map((m: any) => m.id).filter((x: any) => typeof x === 'string');
  if (Array.isArray(j)) return j.map((m: any) => m.id ?? m.name ?? m).filter((x: any) => typeof x === 'string');
  return [];
}

/**
 * 数据库备份: VACUUM INTO 生成干净副本 + 清理过期/超量备份
 */
function runBackup(): void {
  try {
    backupDatabase();
    const pruned = pruneBackups();
    if (pruned > 0) logger.info({ pruned }, 'Old backups pruned');
  } catch (e: any) {
    logger.error({ e }, 'Database backup failed');
    fire({ level: 'error', title: '数据库备份失败', text: String(e?.message ?? e), dedupKey: 'backup-fail' });
  }
}

/**
 * 日志清理: 删除超过保留期的 usage_logs / media_tasks / request_attempts / 过期 cooldowns / 过期登录尝试
 */
function runLogCleanup(): void {
  try {
    const db = getDb();
    const now = Date.now();
    const cutoff = now - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const r1 = db.prepare('DELETE FROM usage_logs WHERE created_at < ?').run(cutoff);
    const r2 = db.prepare('DELETE FROM media_tasks WHERE created_at < ?').run(cutoff);
    const r3 = db.prepare('DELETE FROM request_attempts WHERE created_at < ?').run(cutoff);
    // cooldowns: 之前从不清理, 且 key 级 (原 NULL model) 行每次错误插一行 → 无限膨胀 (运维审计 #4)
    const r4 = db.prepare('DELETE FROM cooldowns WHERE expires_at < ?').run(now);
    // login_attempts: 只在同 identifier 成功/解锁时删, 暴力破解行永久残留 (运维审计 #10)
    const r5 = db
      .prepare('DELETE FROM login_attempts WHERE last_attempt < ? AND (locked_until IS NULL OR locked_until < ?)')
      .run(now - 24 * 60 * 60 * 1000, now);
    const total = Number(r1.changes) + Number(r2.changes) + Number(r3.changes) + Number(r4.changes) + Number(r5.changes);
    if (total > 0) {
      logger.info({
        usage_logs: r1.changes,
        media_tasks: r2.changes,
        request_attempts: r3.changes,
        cooldowns: r4.changes,
        login_attempts: r5.changes,
        retention_days: LOG_RETENTION_DAYS,
      }, 'Old logs cleaned');
    }
  } catch (e: any) {
    logger.error({ e }, 'Log cleanup failed');
  }
}
