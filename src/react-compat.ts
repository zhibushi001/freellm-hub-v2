import { FastifyInstance } from 'fastify';
import { getDb } from './db/connection.js';
import { listChannels } from './db/repos/channels.js';
import { listKeys } from './db/repos/keys.js';

export function registerReactCompatRoutes(app: FastifyInstance): void {
  const requireAdmin = async (req: any, reply: any) => {
    if (!req.session?.adminId) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  };

  app.get('/api/admin/dashboard/stats', { preHandler: requireAdmin }, async (_req, reply) => {
    const channels = listChannels();
    const allKeys = listKeys();    const db = getDb();
    const last24h = db.prepare(`
      SELECT COUNT(*) AS total_requests,
        SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) AS successes,
        COALESCE(SUM(prompt_tokens), 0) AS input_tokens,
        COALESCE(SUM(completion_tokens), 0) AS output_tokens,
        COALESCE(AVG(latency_ms), 0) AS avg_latency
      FROM usage_logs
      WHERE created_at >= (strftime('%s', 'now') * 1000 - 86400000)
    `).get() as any;
    return reply.send({
      totalRequests: last24h?.total_requests ?? 0,
      totalTokens: (last24h?.input_tokens ?? 0) + (last24h?.output_tokens ?? 0),
      activeChannels: channels.filter((c: any) => c.enabled === 1).length,
      activeKeys: allKeys.filter((k: any) => k.enabled).length,
      successRate: last24h?.total_requests > 0 ? ((last24h.successes / last24h.total_requests) * 100) : 100,
      avgLatency: last24h?.avg_latency ?? 0,
    });
  });

  app.get('/api/admin/usage/daily', { preHandler: requireAdmin }, async (req, reply) => {
    const days = parseInt((req.query as any).days ?? '7', 10);
    const db = getDb();
    const rows = db.prepare(`
      SELECT date(created_at / 1000, 'unixepoch') AS date,
        COUNT(*) AS total_requests,
        COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS total_tokens,
        SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) AS success_count,
        SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) AS failure_count,
        ROUND(AVG(latency_ms), 0) AS avg_latency_ms
      FROM usage_logs
      WHERE created_at >= (strftime('%s', 'now') * 1000 - (? * 86400000))
      GROUP BY date ORDER BY date ASC
    `).all(days);
    return reply.send({ ok: true, daily: rows });
  });

  app.get('/api/admin/usage/logs', { preHandler: requireAdmin }, async (req, reply) => {
    // clamp: SQLite 里 LIMIT 传负数 = 不限量, ?limit=-1 可把整表 usage_logs 拖走
    // (含上游错误原文)。分页参数一律夹到 [1, 500]。
    const limit = Math.min(500, Math.max(1, parseInt((req.query as any).limit ?? '50', 10) || 50));
    const offset = Math.max(0, parseInt((req.query as any).offset ?? '0', 10) || 0);
    const status = (req.query as any).status as string | undefined;
    const model = (req.query as any).model as string | undefined;
    const db = getDb();

    // 支持 status / model 过滤 (前端 Usage 页的筛选下拉)
    const where: string[] = [];
    const params: any[] = [];
    if (status) { where.push('u.status = ?'); params.push(status); }
    if (model) { where.push('u.request_model = ?'); params.push(model); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    // B6: 带出 channel_id (CSV 导出的渠道列), 并把列全部用 u. 限定避免与 keys.status 歧义
    const rows = db.prepare(
      `SELECT u.*, ch.id as channel_id
       FROM usage_logs u
       LEFT JOIN keys k ON k.id = u.key_id
       LEFT JOIN channels ch ON ch.id = k.channel_id
       ${whereSql} ORDER BY u.created_at DESC LIMIT ? OFFSET ?`,
    ).all(...params, limit, offset);
    const totalRow = db.prepare(`SELECT COUNT(*) AS total FROM usage_logs u ${whereSql}`).get(...params) as any;

    return reply.send({ ok: true, logs: rows, total: totalRow?.total ?? rows.length });
  });
}
