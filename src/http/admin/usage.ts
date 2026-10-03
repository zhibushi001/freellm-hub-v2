/**
 * Admin 用量统计增强路由
 */
import type { FastifyInstance } from 'fastify';

/** days 参数兜底: 1..365, 挡住 days=-1 / days=99999 */
function clampDays(v: any, dflt: number): number {
  const n = parseInt(v ?? String(dflt), 10);
  return Math.min(365, Math.max(1, Number.isFinite(n) && n > 0 ? n : dflt));
}
import {
  getModelStats,
  getChannelStats,
  getErrorStats,
  getUsageOverview,
  getSlowRequests,
} from '../../services/usageStatsService.js';

export async function registerUsageAdminRoutes(app: FastifyInstance): Promise<void> {
  const requireAdmin = async (req: any, reply: any) => {
    if (!(req.session as any).adminId) {
      return reply.code(401).send({ ok: false, error: 'unauthorized' });
    }
  };

  // GET /api/admin/usage/overview
  app.get('/api/admin/usage/overview', { preHandler: requireAdmin }, async (req, reply) => {
    const days = clampDays((req.query as any).days, 7);
    const overview = getUsageOverview(days);
    return reply.send({ ok: true, overview });
  });

  // GET /api/admin/usage/model-stats
  app.get('/api/admin/usage/model-stats', { preHandler: requireAdmin }, async (req, reply) => {
    const days = clampDays((req.query as any).days, 7);
    const stats = getModelStats(days);
    return reply.send({ ok: true, stats });
  });

  // GET /api/admin/usage/channel-stats
  app.get('/api/admin/usage/channel-stats', { preHandler: requireAdmin }, async (req, reply) => {
    const days = clampDays((req.query as any).days, 7);
    const stats = getChannelStats(days);
    return reply.send({ ok: true, stats });
  });

  // GET /api/admin/usage/error-stats
  app.get('/api/admin/usage/error-stats', { preHandler: requireAdmin }, async (req, reply) => {
    const days = clampDays((req.query as any).days, 7);
    const stats = getErrorStats(days);
    return reply.send({ ok: true, stats });
  });

  // P3-4: 慢请求明细 (Top N by latency_ms)
  app.get('/api/admin/usage/slow-requests', { preHandler: requireAdmin }, async (req, reply) => {
    const days = clampDays((req.query as any).days, 7);
    // clamp: SQLite 里 LIMIT 传负数 = 不限量, ?limit=-1 可把整表 usage_logs 拖走
    // (含上游错误原文)。分页参数一律夹到 [1, 500]。
    const limit = Math.min(500, Math.max(1, parseInt((req.query as any).limit || '20', 10) || 20));
    const slow = getSlowRequests(days, Math.min(100, Math.max(1, limit)));
    return reply.send({ ok: true, requests: slow });
  });

  // GET /api/admin/usage/logs is already defined in react-compat.ts
}
