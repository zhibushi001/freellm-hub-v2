/**
 * notifierService 单测 — 载荷格式识别 / dedup 去重 / 未配置静默 / 发送失败降级
 * 全程注入 sendFn + url 覆盖: 不碰数据库、不发真实网络请求。
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPayload, notify, sendTest,
  _setSendForTest, _setUrlForTest, _resetDedupForTest,
} from '../../src/services/notifierService.js';

let sent: Array<{ url: string; body: string }> = [];

beforeEach(() => {
  sent = [];
  _setSendForTest(async (url, body) => {
    sent.push({ url, body });
    return { ok: true, status: 200 };
  });
  _setUrlForTest('https://example.com/hook');
  _resetDedupForTest();
});

test('buildPayload: 飞书 / 企业微信 / 钉钉 / 通用 四种格式', () => {
  assert.deepEqual(
    buildPayload('https://open.feishu.cn/open-apis/bot/v2/hook/x', 'hello', 'info'),
    { msg_type: 'text', content: { text: 'hello' } },
  );
  assert.deepEqual(
    buildPayload('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x', 'hello', 'info'),
    { msgtype: 'text', text: { content: 'hello' } },
  );
  assert.deepEqual(
    buildPayload('https://oapi.dingtalk.com/robot/send?access_token=x', 'hello', 'info'),
    { msgtype: 'text', text: { content: 'hello' } },
  );
  const generic = buildPayload('https://example.com/hook', '标题行\n正文', 'error') as any;
  assert.equal(generic.title, '标题行');
  assert.equal(generic.content, '标题行\n正文');
  assert.equal(generic.level, 'error');
  assert.ok(typeof generic.time === 'string');
});

test('notify: 发送一次 + 同 dedupKey 10 分钟内去重', async () => {
  await notify({ title: 't1', dedupKey: 'k1' });
  await notify({ title: 't1 again', dedupKey: 'k1' });
  await notify({ title: 't1 third', dedupKey: 'k1' });
  assert.equal(sent.length, 1, '同 dedupKey 窗口内只发一条');

  await notify({ title: 't2', dedupKey: 'k2' });
  assert.equal(sent.length, 2, '不同 dedupKey 独立计数');
});

test('notify: 无 dedupKey 每次都发', async () => {
  await notify({ title: 'a' });
  await notify({ title: 'b' });
  assert.equal(sent.length, 2);
});

test('notify: 未配置 url 静默不发', async () => {
  _setUrlForTest('');
  await notify({ title: 'nobody hears this' });
  assert.equal(sent.length, 0);
});

test('notify: 发送器抛错不外溢 (旁路原则)', async () => {
  _setSendForTest(async () => { throw new Error('network down'); });
  await notify({ title: 'x' }); // 不应 reject
});

test('notify: error 级别带 🔴 图标', async () => {
  await notify({ level: 'error', title: 'Key 挂了' });
  assert.equal(sent.length, 1);
  const body = JSON.parse(sent[0].body) as any;
  const text = body.content ?? body.text?.content; // 通用格式 or 企业微信格式
  assert.ok(String(text).includes('🔴'), `payload: ${sent[0].body}`);
});

test('sendTest: 成功返回 ok+status', async () => {
  const r = await sendTest('https://example.com/hook');
  assert.deepEqual(r, { ok: true, status: 200 });
  assert.equal(sent.length, 1);
});

test('sendTest: 发送器抛错 → 返回 {ok:false, error} 不外溢', async () => {
  _setSendForTest(async () => { throw new Error('ECONNREFUSED'); });
  const r = await sendTest('https://example.com/hook');
  assert.equal(r.ok, false);
  assert.ok(r.error?.includes('ECONNREFUSED'));
});
