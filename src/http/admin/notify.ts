/**
 * Admin 告警通知 (webhook) 配置路由
 */
import type { FastifyInstance } from 'fastify';
import { getSetting, setSetting, deleteSetting } from '../../db/repos/settings.js';
import { sendTest } from '../../services/notifierService.js';

const SETTING_KEY = 'notify_webhook_url';

export async function registerNotifyAdminRoutes(app: FastifyInstance): Promise<void> {
  const requireAdmin = async (req: any, reply: any) => {
    if (!(req.session as any).adminId) {
      return reply.code(401).send({ ok: false, error: 'unauthorized' });
    }
  };

  // GET /api/admin/notify/config
  app.get('/api/admin/notify/config', { preHandler: requireAdmin }, async (_req, reply) => {
    const setting = (getSetting(SETTING_KEY) || '').trim();
    const env = (process.env.HUB_NOTIFY_WEBHOOK || '').trim();
    return reply.send({
      ok: true,
      url: setting || env,
      source: setting ? 'setting' : env ? 'env' : '',
    });
  });

  // PUT /api/admin/notify/config  { url: string }  — 空串 = 清除配置
  app.put('/api/admin/notify/config', { preHandler: requireAdmin }, async (req, reply) => {
    const body = (req.body ?? {}) as { url?: string };
    const url = (body.url ?? '').trim();
    if (url && !/^https?:\/\//i.test(url)) {
      return reply.code(400).send({ ok: false, error: 'webhook 必须是 http(s) 地址' });
    }
    if (url) setSetting(SETTING_KEY, url);
    else deleteSetting(SETTING_KEY);
    return reply.send({ ok: true, url });
  });

  // POST /api/admin/notify/test  { url?: string }  — 不传 url 用已保存配置
  app.post('/api/admin/notify/test', { preHandler: requireAdmin }, async (req, reply) => {
    const body = (req.body ?? {}) as { url?: string };
    const url = (body.url ?? '').trim()
      || (getSetting(SETTING_KEY) || '').trim()
      || (process.env.HUB_NOTIFY_WEBHOOK || '').trim();
    if (!url) return reply.code(400).send({ ok: false, error: '尚未配置 webhook 地址' });
    const r = await sendTest(url);
    if (!r.ok) {
      return reply.send({ ok: false, status: r.status, error: r.error ?? `webhook 返回 HTTP ${r.status}` });
    }
    return reply.send({ ok: true, status: r.status });
  });
}
