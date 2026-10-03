/**
 * 成本与配额测试
 * - 价格匹配优先级: provider 精确 > provider 通配 > 全局精确 > 全局通配
 * - 成本按上游模型算; 没配价格 → 0 (免费渠道常态)
 * - recordUsage 落库带 cost_usd / price_ref
 * - 月/日预算硬限 + RPM 限流 (之前 rpm 字段从不执行)
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

describe('成本与配额', () => {
  let db: DatabaseSync, hubKeyId: number;

  beforeEach(async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hub-cost-'));
    process.env.HUB_DATA_DIR = dataDir;
    process.env.HUB_PORT = '0';
    process.env.HUB_SKIP_SEED = process.env.HUB_SKIP_SEED ?? '1';
    const { runMigrations } = await import('../../src/db/migrations/runner.js');
    db = new DatabaseSync(join(dataDir, 'hub.db'));
    runMigrations(db);
    const conn = await import('../../src/db/connection.js');
    conn.setDbForTest(db);
    const hubKeys = await import('../../src/db/repos/hubKeys.js');
    hubKeyId = hubKeys.createHubKey({ name: 'H1' }).id;
  });

  it('价格匹配优先级: provider 精确 > provider 通配 > 全局精确 > 全局通配', async () => {
    const { upsertPrice, resolvePrice } = await import('../../src/services/pricing.js');
    upsertPrice({ provider_name: '*', model_pattern: 'gpt-*', input_price_per_m: 1, output_price_per_m: 1 });
    upsertPrice({ provider_name: '*', model_pattern: 'gpt-5.2', input_price_per_m: 2, output_price_per_m: 2 });
    upsertPrice({ provider_name: 'openrouter', model_pattern: 'gpt-5.2*', input_price_per_m: 3, output_price_per_m: 3 });
    upsertPrice({ provider_name: 'openrouter', model_pattern: 'gpt-5.2', input_price_per_m: 4, output_price_per_m: 4 });
    // 1) provider + 模型精确
    assert.equal(resolvePrice('openrouter', 'gpt-5.2')!.input_per_m, 4);
    // 2) provider + 前缀通配
    assert.equal(resolvePrice('openrouter', 'gpt-5.2-mini')!.input_per_m, 3);
    // 3) 全局 + 模型精确
    assert.equal(resolvePrice('other', 'gpt-5.2')!.input_per_m, 2);
    // 4) 全局 + 通配
    assert.equal(resolvePrice('other', 'gpt-5.2-mini')!.input_per_m, 1);
    // 未命中 → null (成本记 0)
    assert.equal(resolvePrice('other', 'llama-3'), null);
    assert.equal(resolvePrice(null, null), null);
  });

  it('成本按上游模型计算, 没配价格记 0', async () => {
    const { upsertPrice, computeCostUsd } = await import('../../src/services/pricing.js');
    upsertPrice({ provider_name: 'openai', model_pattern: 'gpt-5.2', input_price_per_m: 2, output_price_per_m: 10 });
    // 1M 输入 + 1M 输出 = 2 + 10 = 12 美元
    const c = computeCostUsd('openai', 'gpt-5.2', 1_000_000, 1_000_000);
    assert.equal(c.cost_usd, 12);
    assert.equal(c.price_ref, 'openai/gpt-5.2');
    // 免费渠道 (没配价) → 0, 不是错误
    const free = computeCostUsd('sensenova', 'sensenova-6.8', 1_000_000, 1_000_000);
    assert.equal(free.cost_usd, 0);
    assert.equal(free.price_ref, null);
    // token 缺失也不瞎猜
    assert.equal(computeCostUsd('openai', 'gpt-5.2', null, null)!.cost_usd, 0);
  });

  it('recordUsage 落库带成本与价格引用', async () => {
    const { upsertPrice } = await import('../../src/services/pricing.js');
    const { recordUsage } = await import('../../src/services/usageService.js');
    upsertPrice({ provider_name: 'openai', model_pattern: 'gpt-5.2', input_price_per_m: 2, output_price_per_m: 10 });
    recordUsage({
      hub_key_id: hubKeyId, provider_name: 'openai', request_model: '别名', routed_model: 'gpt-5.2',
      prompt_tokens: 1_000_000, completion_tokens: 500_000, status: 'success', stream: 0,
    });
    const row = db.prepare('SELECT cost_usd, price_ref FROM usage_logs ORDER BY id DESC LIMIT 1').get() as any;
    assert.equal(row.cost_usd, 7, '1M in * 2 + 0.5M out * 10 = 7');
    assert.equal(row.price_ref, 'openai/gpt-5.2', '应记下命中的价格条目');
  });

  it('月预算超限 → 拒绝; 预算内 → 放行', async () => {
    const { upsertPrice } = await import('../../src/services/pricing.js');
    const { recordUsage } = await import('../../src/services/usageService.js');
    const { checkHubKeyQuota, clearRpmWindows } = await import('../../src/services/quota.js');
    clearRpmWindows();
    upsertPrice({ provider_name: 'openai', model_pattern: 'gpt-5.2', input_price_per_m: 10, output_price_per_m: 10 });
    let d = checkHubKeyQuota(hubKeyId, { monthly_budget_usd: 5 });
    assert.equal(d.allowed, true, '没花钱时放行');
    // 烧掉 6 美元
    recordUsage({ hub_key_id: hubKeyId, provider_name: 'openai', routed_model: 'gpt-5.2',
      prompt_tokens: 1_000_000, completion_tokens: 500_000, status: 'success', stream: 0 });
    d = checkHubKeyQuota(hubKeyId, { monthly_budget_usd: 5 });
    assert.equal(d.allowed, false);
    assert.equal(d.code, 'monthly_budget_exceeded');
    assert.ok(d.retry_after_sec && d.retry_after_sec > 0);
    // 未设预算 = 不限
    assert.equal(checkHubKeyQuota(hubKeyId, {}).allowed, true);
    assert.equal(checkHubKeyQuota(hubKeyId, { monthly_budget_usd: null, daily_budget_usd: null }).allowed, true);
  });

  it('日预算超限 → 拒绝 (月预算还够)', async () => {
    const { upsertPrice } = await import('../../src/services/pricing.js');
    const { recordUsage } = await import('../../src/services/usageService.js');
    const { checkHubKeyQuota, clearRpmWindows } = await import('../../src/services/quota.js');
    clearRpmWindows();
    upsertPrice({ provider_name: 'openai', model_pattern: 'gpt-5.2', input_price_per_m: 10, output_price_per_m: 10 });
    recordUsage({ hub_key_id: hubKeyId, provider_name: 'openai', routed_model: 'gpt-5.2',
      prompt_tokens: 1_000_000, completion_tokens: 500_000, status: 'success', stream: 0 });
    const d = checkHubKeyQuota(hubKeyId, { daily_budget_usd: 5, monthly_budget_usd: 1000 });
    assert.equal(d.allowed, false);
    assert.equal(d.code, 'daily_budget_exceeded');
  });

  it('RPM 限流: 超速拒绝, 窗口重置后恢复', async () => {
    const { checkHubKeyQuota, clearRpmWindows } = await import('../../src/services/quota.js');
    clearRpmWindows();
    const t0 = 1_700_000_000_000;
    for (let i = 0; i < 3; i++) {
      assert.equal(checkHubKeyQuota(hubKeyId, { rate_limit_rpm: 3 }, t0 + i).allowed, true, `第 ${i + 1} 次应放行`);
    }
    const over = checkHubKeyQuota(hubKeyId, { rate_limit_rpm: 3 }, t0 + 3);
    assert.equal(over.allowed, false);
    assert.equal(over.code, 'rate_limited');
    // 下一分钟窗口
    assert.equal(checkHubKeyQuota(hubKeyId, { rate_limit_rpm: 3 }, t0 + 61_000).allowed, true);
    // 没配 rpm = 不限
    clearRpmWindows();
    for (let i = 0; i < 50; i++) assert.equal(checkHubKeyQuota(hubKeyId, {}, t0 + i).allowed, true);
  });
});
