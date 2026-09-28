/**
 * 运维通知服务 — 健康事件 → Webhook (设计改进 #1)
 *
 * 配置优先级: settings.notify_webhook_url > 环境变量 HUB_NOTIFY_WEBHOOK > 未配置(静默)
 * 载荷按 URL 自动识别:
 *   - open.feishu.cn            → { msg_type:'text', content:{ text } }
 *   - qyapi.weixin.qq.com       → { msgtype:'text', text:{ content } }
 *   - oapi.dingtalk.com         → { msgtype:'text', text:{ content } }
 *   - 其他 (自定义/通用)         → { title, content, level, time }
 * dedupKey 10 分钟去重: 同类告警不刷屏 (key 抖动时每10分钟最多一条)。
 * 通知是旁路: 任何失败只记 warn 日志, 绝不影响主业务。
 */
import { getSetting } from '../db/repos/settings.js';
import { logger } from '../util/logger.js';

const DEDUP_MS = 10 * 60 * 1000;
const lastSentAt = new Map<string, number>();

export interface NotifyEvent {
  level?: 'info' | 'warn' | 'error';
  title: string;
  text?: string;
  /** 相同 key 在 DEDUP_MS 内只发一条 */
  dedupKey?: string;
}

/** 按 webhook URL 选择目标平台的载荷格式 (导出便于单测) */
export function buildPayload(url: string, content: string, level: string): unknown {
  if (url.includes('open.feishu.cn')) return { msg_type: 'text', content: { text: content } };
  if (url.includes('qyapi.weixin.qq.com')) return { msgtype: 'text', text: { content } };
  if (url.includes('oapi.dingtalk.com')) return { msgtype: 'text', text: { content } };
  return { title: content.split('\n')[0], content, level, time: new Date().toISOString() };
}

type SendFn = (url: string, body: string) => Promise<{ ok: boolean; status: number }>;

const defaultSend: SendFn = async (url, body) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    signal: AbortSignal.timeout(5000),
  });
  return { ok: res.ok, status: res.status };
};

let sendFn: SendFn = defaultSend;
/** 测试注入: 传 null 恢复真实实现 */
export function _setSendForTest(fn: SendFn | null): void {
  sendFn = fn ?? defaultSend;
}
/** 测试注入: url 覆盖; undefined=走真实配置; ''=视为未配置 */
let urlOverride: string | undefined;
export function _setUrlForTest(url: string | undefined): void {
  urlOverride = url;
}
export function _resetDedupForTest(): void {
  lastSentAt.clear();
}

export async function notify(ev: NotifyEvent): Promise<void> {
  try {
    // 去重放最前: 抑制窗口内的重复事件不碰数据库
    if (ev.dedupKey) {
      const last = lastSentAt.get(ev.dedupKey);
      if (last && Date.now() - last < DEDUP_MS) return;
    }
    const url = (urlOverride !== undefined
      ? urlOverride
      : (getSetting('notify_webhook_url') || '').trim() || (process.env.HUB_NOTIFY_WEBHOOK || '').trim()
    ).trim();
    if (!url) return;
    if (ev.dedupKey) lastSentAt.set(ev.dedupKey, Date.now());

    const level = ev.level ?? 'info';
    const icon = level === 'error' ? '🔴' : level === 'warn' ? '⚠️' : 'ℹ️';
    const content = `${icon} [FreeLLM Hub] ${ev.title}${ev.text ? `\n${ev.text}` : ''}`;
    const r = await sendFn(url, JSON.stringify(buildPayload(url, content, level)));
    if (!r.ok) logger.warn({ status: r.status }, 'webhook notify non-2xx');
  } catch (e: any) {
    logger.warn({ err: e?.message }, 'webhook notify failed');
  }
}

/** 同步钩子用: fire-and-forget, notify 内部全捕获不会 reject */
export function fire(ev: NotifyEvent): void {
  void notify(ev);
}

/** 管理端"发送测试": 用显式 url (可测未保存的地址), 结果返回给调用方 */
export async function sendTest(
  url: string,
): Promise<{ ok: boolean; status?: number; error?: string }> {
  try {
    const content = `ℹ️ [FreeLLM Hub] 测试通知\n${new Date().toLocaleString('zh-CN')} — 看到这条说明 webhook 配置成功`;
    const r = await sendFn(url, JSON.stringify(buildPayload(url, content, 'info')));
    return { ok: r.ok, status: r.status };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}
