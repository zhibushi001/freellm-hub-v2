/**
 * FreeLLM Hub v2 server entry
 */
import { buildApp } from './app.js';
import { config } from './config/env.js';
import { logger } from './util/logger.js';
import { startBackgroundJobs, stopBackgroundJobs } from './services/backgroundJobs.js';
import { closeDb, getDb } from './db/connection.js';
import { getMasterKey } from './crypto/kek.js';

// ── 进程级兜底 (运维审计 #2): 之前没有任何 handler, 后台任务的一个 DB 错误
// (磁盘满/锁) 就是 unhandledRejection → Node 默认直接退出 → 服务中断
process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'unhandledRejection — 已记录, 进程继续服务');
});
process.on('uncaughtException', (err) => {
  // 明确退出交给 docker restart=unless-stopped 拉起 — 比留在未知状态继续服务安全
  logger.fatal({ err }, 'uncaughtException — 主动退出, 由 docker 自动拉起');
  console.error(err);
  setTimeout(() => process.exit(1), 300);
});

async function main() {
  // Fail fast: 监听前先连库 + 跑迁移 + 校验 master.key。
  // 之前这些都是懒加载, 迁移失败要等首个请求才暴露 → "健康但全部500" (运维审计 #7);
  // master.key 丢失但库里有加密 key 时 getMasterKey 会拒绝启动 (防静默换钥, 运维审计 #1)
  getDb();
  getMasterKey();
  logger.info('Database + master key ready');

  const app = await buildApp();
  try {
    await app.listen({ port: config.port, host: config.host });
    logger.info(`FreeLLM Hub v2 listening on http://${config.host}:${config.port}`);
    startBackgroundJobs();
  } catch (err) {
    logger.error(err);
    process.exit(1);
  }

  // 优雅停机: 收到 SIGTERM/SIGINT 后先停止接受新请求,
  // 等待进行中的请求完成, 再关闭后台任务和数据库连接
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Graceful shutdown started');

    stopBackgroundJobs();

    try {
      await app.close();
      logger.info('HTTP server closed');
    } catch (e: any) {
      logger.error({ e }, 'Error closing HTTP server');
    }

    closeDb();
    logger.info('Database closed');
    logger.info('Graceful shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
