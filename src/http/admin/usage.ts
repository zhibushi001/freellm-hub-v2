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
import { getDb } from '../../db/connection.js';
import { listPrices, upsertPrice, deletePrice } from '../../services/pricing.js';

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
  // ══ 成本与价格 ══════════════════════════════════════════════════════

  // GET /api/admin/usage/cost?days=30&groupBy=key|model|hub_key|provider|day
  // 从 usage_logs 实时聚合 (不依赖 usage_daily —— 那张表从来没人读写)
  app.get('/api/admin/usage/cost', { preHandler: requireAdmin }, async (req, reply) => {
    const q = req.query as any;
    const days = clampDays(q.days, 30);
    const since = Date.now() - days * 86_400_000;
    const groupBy = ['key', 'model', 'hub_key', 'provider', 'day'].includes(q.groupBy) ? q.groupBy : 'provider';
    const dimMap: Record<string, string> = {
      key: 'u.key_id', model: 'COALESCE(u.routed_model, u.request_model)',
      provider: "COALESCE(u.provider_name, '未知')",
      day: "strftime('%Y-%m-%d', u.created_at / 1000, 'unixepoch')",
    };
    const dim = dimMap[groupBy];

    const rows = getDb()
      .prepare(
        `SELECT ${dim} AS bucket,
                COUNT(*) AS requests,
                SUM(CASE WHEN u.status = 'success' THEN 1 ELSE 0 END) AS successes,
                COALESCE(SUM(u.prompt_tokens), 0) AS prompt_tokens,
                COALESCE(SUM(u.completion_tokens), 0) AS completion_tokens,
                COALESCE(SUM(u.total_tokens), 0) AS total_tokens,
                COALESCE(SUM(u.cost_usd), 0) AS cost_usd,
                COUNT(DISTINCT u.price_ref) AS priced_variants
           FROM usage_logs u
          WHERE u.created_at >= ?
          GROUP BY bucket
          ORDER BY cost_usd DESC, requests DESC`,
      )
      .all(since) as unknown as Array<Record<string, unknown>>;

    // 汇总行 + 未定价提示 (没配价格表的渠道成本恒 0, 看板要能看出来)
    const totals = getDb()
      .prepare(
        `SELECT COUNT(*) AS requests,
                COALESCE(SUM(cost_usd), 0) AS cost_usd,
                COALESCE(SUM(total_tokens), 0) AS total_tokens,
                SUM(CASE WHEN price_ref IS NULL THEN 1 ELSE 0 END) AS unpriced_requests
           FROM usage_logs WHERE created_at >= ?`,
      )
      .get(since) as unknown as Record<string, unknown>;

    return reply.send({ ok: true, days, groupBy, rows, totals });
  });

  // GET /api/admin/pricing — 价格表
  app.get('/api/admin/pricing', { preHandler: requireAdmin }, async (_req, reply) => {
    return reply.send({ ok: true, prices: listPrices() });
  });

  // POST /api/admin/pricing — 新增/更新 (provider_name + model_pattern 唯一)
  app.post('/api/admin/pricing', { preHandler: requireAdmin }, async (req, reply) => {
    const b = req.body as any;
    const provider = typeof b?.provider_name === 'string' ? b.provider_name.trim() : '';
    const pattern = typeof b?.model_pattern === 'string' ? b.model_pattern.trim() : '';
    const pin = Number(b?.input_price_per_m);
    const pout = Number(b?.output_price_per_m);
    if (!pattern) return reply.code(400).send({ ok: false, error: 'model_pattern 必填 (可用前缀通配, 如 gpt-4o*)' });
    if (!Number.isFinite(pin) || pin < 0 || !Number.isFinite(pout) || pout < 0) {
      return reply.code(400).send({ ok: false, error: '单价必须是非负数字 (美元 / 每百万 token)' });
    }
    const row = upsertPrice({
      provider_name: provider || '*',
      model_pattern: pattern,
      input_price_per_m: pin,
      output_price_per_m: pout,
      note: typeof b?.note === 'string' ? b.note : null,
      enabled: b?.enabled === 0 ? 0 : 1,
    });
    return reply.send({ ok: true, price: row });
  });

  // DELETE /api/admin/pricing/:id
  app.delete('/api/admin/pricing/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const id = parseInt((req.params as any).id, 10);
    if (!deletePrice(id)) return reply.code(404).send({ ok: false, error: '价格条目不存在' });
    return reply.send({ ok: true });
  });

}
