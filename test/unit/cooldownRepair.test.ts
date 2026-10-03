/**
 * 2026-10-03 事故修复回归测试
 *
 * 现场: OpenRouter 免费模型每日额度用尽 (free-models-per-day-stealth),
 * 但 rate_limit 冷却因 setCooldown upsert 不重置 cleared_at 而**静默失效**,
 * 客户端 1 小时重试 17 次 → 连续失败把唯一 Key 打进 30 分钟封禁;
 * 随后故障被报成误导性的 no_keys "Key 全被禁用或失败" (404/503 两路径还互相矛盾)。
 *
 * 覆盖:
 *   1. 冷却被 clear 后再次启用必须重新可见 (核心 bug)
 *   2. 迁移 038 修复存量"假已清除"冷却行
 *   3. resolveModel 逐 Key 诊断: 封禁/冷却/禁用各自的真实原因 + 恢复时间 (keys_cooling)
 *   4. 每日额度类 429 → 冷却到 UTC 午夜; 普通 429 → 90s
 *   5. chatService: 流式不再误拒别名模型; no_keys/keys_cooling 统一 503 + Retry-After 透传
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

describe('冷却重启 + 迁移修复 + 临时不可用诊断', () => {
  let db: DatabaseSync;
  let setCooldown: typeof import('../../src/db/repos/cooldowns.js').setCooldown;
  let clearCooldown: typeof import('../../src/db/repos/cooldowns.js').clearCooldown;
  let getActiveCooldown: typeof import('../../src/db/repos/cooldowns.js').getActiveCooldown;
  let listKeys: typeof import('../../src/db/repos/keys.js').listKeys;
  let resolveModel: typeof import('../../src/routing/resolver.js').resolveModel;

  beforeEach(async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hub-coolrep-'));
    process.env.HUB_DATA_DIR = dataDir;
    process.env.HUB_PORT = '0';
    process.env.HUB_SKIP_SEED = process.env.HUB_SKIP_SEED ?? '1';
    const { runMigrations } = await import('../../src/db/migrations/runner.js');
    db = new DatabaseSync(join(dataDir, 'hub.db'));
    runMigrations(db);
    const conn = await import('../../src/db/connection.js');
    conn.setDbForTest(db);
    ({ setCooldown, clearCooldown, getActiveCooldown } = await import('../../src/db/repos/cooldowns.js'));
    ({ listKeys } = await import('../../src/db/repos/keys.js'));
    ({ resolveModel } = await import('../../src/routing/resolver.js'));
  });

  /** 建 provider/channel/key, 返回各 id; status 默认 active */
  function mkUpstream(name: string, modelsCsv: string) {
    db.prepare(`INSERT INTO providers (name, base_url, enabled, created_at, updated_at) VALUES (?, 'https://x', 1, 1, 1)`).run(name);
    const pid = (db.prepare('SELECT id FROM providers WHERE name = ?').get(name) as any).id;
    db.prepare(`INSERT INTO channels (provider_id, label, models, enabled, created_at, updated_at)
                VALUES (?, ?, ?, 1, 1, 1)`).run(pid, `${name}-ch`, modelsCsv);
    const cid = (db.prepare('SELECT id FROM channels WHERE provider_id = ?').get(pid) as any).id;
    db.prepare(`INSERT INTO keys (channel_id, api_key_enc, api_key_hint, label, enabled, status, created_at, updated_at)
                VALUES (?, ?, ?, ?, 1, 'active', 1, 1)`).run(cid, Buffer.from(`e-${name}`), 'sk-h', `${name}-k`);
    const kid = (db.prepare('SELECT id FROM keys WHERE label = ?').get(`${name}-k`) as any).id;
    return { providerId: pid, channelId: cid, keyId: kid };
  }

  // ── 1. 核心 bug: 冷却 clear 后再次启用必须可见 ──────────────────────────
  it('被清除的冷却再次 setCooldown 后重新生效 (cleared_at 必须重置)', () => {
    const { keyId } = mkUpstream('p1', 'm1');
    setCooldown({ keyId, reason: 'rate_limit', durationMs: 60_000, recoverable: true, source: 'heuristic' });
    assert.ok(getActiveCooldown(keyId, 'rate_limit', null), '首次设置应可见');
    clearCooldown(keyId, 'rate_limit', null, 'call_succeeded');
    assert.equal(getActiveCooldown(keyId, 'rate_limit', null), null, '清除后应不可见');
    // 再次触发限流 → upsert 同一行
    setCooldown({ keyId, reason: 'rate_limit', durationMs: 60_000, recoverable: true, source: 'heuristic' });
    assert.ok(
      getActiveCooldown(keyId, 'rate_limit', null),
      '重新启用后必须可见 —— 这是事故根因: 旧行为永远隐身, 冷却静默失效',
    );
  });

  it('迁移 038 修复 cleared_at < started_at 的脏行, 正常行不动', () => {
    const { keyId } = mkUpstream('p2', 'm2');
    // 脏行: 先被清除 (1000), 后又被重新启用 (2000) 却没清标记
    db.prepare(`INSERT INTO cooldowns (key_id, reason, source, upstream_model, recoverable, started_at, expires_at, cleared_at, cleared_reason)
                VALUES (?, 'rate_limit', 'heuristic', '', 1, 2000, 3000, 1000, 'call_succeeded')`).run(keyId);
    // 正常已清除行: cleared_at(5000) > started_at(4000)
    db.prepare(`INSERT INTO cooldowns (key_id, reason, source, upstream_model, recoverable, started_at, expires_at, cleared_at, cleared_reason)
                VALUES (?, 'transient_error', 'heuristic', '', 1, 4000, 5000, 6000, 'call_succeeded')`).run(keyId);
    const sql = readFileSync(join(import.meta.dirname, '../../src/db/migrations/038_repair_stale_cooldowns.sql'), 'utf8');
    db.exec(sql);
    const rows = db.prepare('SELECT reason, cleared_at FROM cooldowns WHERE key_id = ? ORDER BY reason').all(keyId) as any[];
    const bad = rows.find(r => r.reason === 'rate_limit');
    const ok = rows.find(r => r.reason === 'transient_error');
    assert.equal(bad?.cleared_at, null, '脏行应被修复 (cleared_at 清空)');
    assert.equal(ok?.cleared_at, 6000, '正常已清除行不应被改动');
  });

  // ── 3. resolveModel 诊断: 真实原因 + 恢复时间 ──────────────────────────
  it('唯一 Key 被封禁 → keys_cooling + 封禁截止时间 + Retry-After 秒数', () => {
    const { keyId } = mkUpstream('p3', 'm3');
    const now = Date.now();
    db.prepare('UPDATE keys SET status = ?, status_reason = ?, status_since = ? WHERE id = ?')
      .run('failed', '连续 6 次失败', now, keyId);
    const r = resolveModel('m3', listKeys());
    assert.ok('error' in r, '应报错');
    assert.equal(r.errorKind, 'keys_cooling', `临时不可用应是 keys_cooling, got ${JSON.stringify(r)}`);
    assert.match(r.error, /封禁至/);
    assert.match(r.error, /Key#/, '应指出是哪把 Key');
    const retry = (r as any).retryAfterSec as number;
    assert.ok(retry >= 60 && retry <= 1800, `Retry-After 应在 60s~30min, got ${retry}`);
  });

  it('封禁时附带底层原因: 每日额度冷却一并说清', () => {
    const { keyId } = mkUpstream('p4', 'm4');
    db.prepare('UPDATE keys SET status = ?, status_since = ? WHERE id = ?')
      .run('failed', Date.now(), keyId);
    setCooldown({ keyId, reason: 'rate_limit', upstreamModel: 'm4', durationMs: 10 * 3600_000, recoverable: true, source: 'authoritative' });
    const r = resolveModel('m4', listKeys());
    assert.ok('error' in r);
    assert.match(r.error, /封禁至/, '应报封禁');
    assert.match(r.error, /每日额度限制/, '应报底层的每日额度原因');
    assert.match(r.error, /冷却至/, '应带冷却截止时间');
  });

  it('别的模型的冷却不混进当前模型的诊断', () => {
    const { keyId } = mkUpstream('p5', 'm5');
    db.prepare('UPDATE keys SET status = ?, status_since = ? WHERE id = ?')
      .run('failed', Date.now(), keyId);
    setCooldown({ keyId, reason: 'rate_limit', upstreamModel: 'other-model', durationMs: 10 * 3600_000, recoverable: true, source: 'authoritative' });
    const r = resolveModel('m5', listKeys());
    assert.ok('error' in r);
    assert.match(r.error, /封禁至/);
    assert.doesNotMatch(r.error, /每日额度/, '其他模型的冷却不该出现在这里');
  });

  it('Key 全被禁用 (永久) → 仍是 no_keys, 且说清谁被禁用', () => {
    const { keyId } = mkUpstream('p6', 'm6');
    db.prepare('UPDATE keys SET enabled = 0 WHERE id = ?').run(keyId);
    const r = resolveModel('m6', listKeys());
    assert.ok('error' in r);
    assert.equal(r.errorKind, 'no_keys');
    assert.match(r.error, /已禁用/);
    assert.equal((r as any).retryAfterSec, undefined, '永久禁用不该给 Retry-After');
  });

  // ── 4. 每日额度 429 ─────────────────────────────────────────────────────
  it('每日额度类 429 → 冷却到下一个 UTC 午夜; 状态原因写明', async () => {
    const { keyId } = mkUpstream('p7', 'm7');
    const { transitionKeyStatus, isDailyQuotaMessage, dailyQuotaCooldownMs } =
      await import('../../src/services/keyHealth.js');
    assert.equal(isDailyQuotaMessage('Rate limit exceeded: free-models-per-day-stealth.'), true);
    assert.equal(isDailyQuotaMessage({ error: { message: 'daily limit reached' } }), true);
    assert.equal(isDailyQuotaMessage('Slow down'), false);

    const before = Date.now();
    transitionKeyStatus(keyId, {
      status: 429,
      body: { error: { message: 'Rate limit exceeded: free-models-per-day-stealth.' } },
      upstreamModel: 'stealth/space-bunny-alpha',
    });
    const cd = getActiveCooldown(keyId, 'rate_limit', 'stealth/space-bunny-alpha');
    assert.ok(cd, '每日额度 429 必须产生可见冷却');
    const left = cd.expires_at - before;
    assert.ok(left >= 10 * 60_000, `冷却至少 10 分钟, got ${Math.round(left / 1000)}s`);
    assert.ok(left <= 24 * 3600_000 + 120_000, '冷却不超过 24 小时');
    const nextMidnight = Math.floor(before / 86_400_000 + 1) * 86_400_000;
    assert.ok(Math.abs(cd.expires_at - nextMidnight) < 3 * 60_000, '应落在下一个 UTC 午夜附近');
    const key = db.prepare('SELECT status, status_reason FROM keys WHERE id = ?').get(keyId) as any;
    assert.equal(key.status, 'cooldown');
    assert.match(key.status_reason, /每日额度/);
    // helper 自身
    const ms = dailyQuotaCooldownMs(before);
    assert.equal(ms, cd.expires_at - before, 'helper 与实际写入一致');
  });

  it('普通 429 → 仍是 90s 短冷却', async () => {
    const { keyId } = mkUpstream('p8', 'm8');
    const { transitionKeyStatus } = await import('../../src/services/keyHealth.js');
    const before = Date.now();
    transitionKeyStatus(keyId, { status: 429, body: 'Slow down', upstreamModel: 'm8' });
    const cd = getActiveCooldown(keyId, 'rate_limit', 'm8');
    assert.ok(cd, '普通 429 也要有冷却');
    const left = cd.expires_at - before;
    assert.ok(left <= 95_000, `普通 429 应 ~90s, got ${Math.round(left / 1000)}s`);
    const key = db.prepare('SELECT status_reason FROM keys WHERE id = ?').get(keyId) as any;
    assert.equal(key.status_reason, '429 rate_limit');
  });

  // ── 5. chatService: 流式别名放行 + 503 统一 + Retry-After ───────────────
  it('流式请求虚拟模型不再被提前判 model_not_found (400) — 放行到别名解析', async () => {
    db.prepare(`INSERT INTO virtual_models (name, enabled, created_at, updated_at) VALUES ('v-x', 1, 1, 1)`).run();
    const { chatStream } = await import('../../src/services/chatService.js');
    const r: any = await chatStream({ model: 'v-x', messages: [{ role: 'user', content: 'hi' }] }, null);
    assert.ok(r && 'error' in r, `应返回错误, got ${JSON.stringify(r)}`);
    assert.notEqual(r.status, 400, `不该 400 model_not_found: ${r.error}`);
    assert.equal(r.status, 503, `无可用候选应 503, got ${r.status}`);
    assert.match(r.error, /虚拟模型 'v-x'/, '错误应来自别名层, 证明放行成功');
  });

  it('非流式: 封禁中 → 503 + errorKind=keys_cooling + retryAfterSec (不再 404)', async () => {
    const { keyId } = mkUpstream('p9', 'm9');
    db.prepare('UPDATE keys SET status = ?, status_since = ? WHERE id = ?')
      .run('failed', Date.now(), keyId);
    const { chatCompletion } = await import('../../src/services/chatService.js');
    const r: any = await chatCompletion({ model: 'm9', messages: [{ role: 'user', content: 'hi' }] }, null);
    assert.ok(r && 'error' in r, `应返回错误, got ${JSON.stringify(r)}`);
    assert.equal(r.status, 503, `临时不可用应 503 (与流式统一), got ${r.status}`);
    assert.equal(r.details?.errorKind, 'keys_cooling');
    assert.ok((r.details?.retryAfterSec ?? 0) >= 60, '应带 retryAfterSec 供路由写 Retry-After 头');
    assert.match(r.error, /暂时没有可用 Key/);
  });

  it('非流式: 模型未配置 → 仍 400 (客户端错误语义不变)', async () => {
    const { chatCompletion } = await import('../../src/services/chatService.js');
    const r: any = await chatCompletion({ model: 'ghost/definitely-not-configured', messages: [{ role: 'user', content: 'hi' }] }, null);
    assert.ok(r && 'error' in r);
    assert.equal(r.status, 400, `未配置模型应 400, got ${r.status}`);
    assert.equal(r.details?.errorKind, 'model_not_found');
  });
});
