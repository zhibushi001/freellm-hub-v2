/**
 * Discovered models repo
 */
import { getDb } from '../connection.js';
import { listKeysByChannel } from './keys.js';

export interface DiscoveredModel {
  id: number;
  key_id: number;
  upstream_id: string;
  discovered_at: number;
  test_status?: string | null;  // 'ok' | 'error' | null(未测试)
  test_latency_ms?: number | null;
  test_error?: string | null;
  tested_at?: number | null;
}

export function getDiscoveredModelsForKey(keyId: number): DiscoveredModel[] {
  return getDb()
    .prepare('SELECT * FROM discovered_models WHERE key_id = ? ORDER BY upstream_id')
    .all(keyId) as unknown as DiscoveredModel[];
}


/**
 * 该上游模型被哪些 Key 实际发现过 — discovered 是比人工模型列表更强的证据
 * (聚合平台如商汤能跑几十个模型, 手工列表往往只填了三五个)。
 * 字面量路由 (OpenRouter 的 org/model 形式) 必须同时认这两种证据。
 */
export function getDiscoveredModelKeys(upstreamId: string): number[] {
  const rows = getDb()
    .prepare('SELECT DISTINCT key_id FROM discovered_models WHERE upstream_id = ?')
    .all(upstreamId) as Array<{ key_id: number }>;
  return rows.map(r => Number(r.key_id));
}

export function upsertDiscoveredModel(keyId: number, upstreamId: string): void {
  getDb()
    .prepare(
      `INSERT INTO discovered_models (key_id, upstream_id, discovered_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key_id, upstream_id) DO UPDATE SET discovered_at = excluded.discovered_at`,
    )
    .run(keyId, upstreamId, Date.now());
}

export function clearDiscoveredModelsForKey(keyId: number): void {
  getDb().prepare('DELETE FROM discovered_models WHERE key_id = ?').run(keyId);
}


/** 批量更新模型测试结果 */
export function bulkUpdateModelTestResults(keyId: number, results: Array<{
  upstreamId: string;
  status: 'ok' | 'error' | 'skip';
  latencyMs: number;
  error?: string;
}>): void {
  const stmt = getDb().prepare(
    `UPDATE discovered_models 
     SET test_status = ?, test_latency_ms = ?, test_error = ?, tested_at = ?
     WHERE key_id = ? AND upstream_id = ?`,
  );
  for (const r of results) {
    stmt.run(r.status, r.latencyMs, r.error ?? null, Date.now(), keyId, r.upstreamId);
  }
}


/** 删除 key 下所有测试失败的模型. 返回被删除的模型名列表 (供调用方同步清理 channels.models) */
export function deleteFailedModelsForKey(keyId: number): { deleted: number; failedModels: string[] } {
  const failed = getDb()
    .prepare("SELECT upstream_id FROM discovered_models WHERE key_id = ? AND test_status = 'error'")
    .all(keyId) as Array<{ upstream_id: string }>;
  const failedNames = failed.map(r => r.upstream_id);
  const result = getDb()
    .prepare("DELETE FROM discovered_models WHERE key_id = ? AND test_status = 'error'")
    .run(keyId);
  return { deleted: Number(result.changes), failedModels: failedNames };
}

/** 从 JSON 数组字符串里移除指定名字. 返回 [newJson, removedCount] */
function removeNamesFromJsonArray(json: string | null, namesToRemove: Set<string>): { json: string | null; removed: number } {
  if (!json) return { json: null, removed: 0 };
  let arr: string[];
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return { json, removed: 0 };
    arr = parsed.filter((x: any) => typeof x === 'string');
  } catch { return { json, removed: 0 }; }
  const filtered = arr.filter(name => !namesToRemove.has(name));
  const removed = arr.length - filtered.length;
  return { json: filtered.length > 0 ? JSON.stringify(filtered) : null, removed };
}

/** 删除 channel 下所有 key 中测试失败的模型 (跨 key). 同时清理所有"允许列表"中的对应模型名 */
export function deleteFailedModelsForChannel(channelId: number): {
  deleted: number;
  removedFromChannelList: number;
  removedFromKeyLists: number;
  removedFromHubKeyLists: number;
} {
  const keys = listKeysByChannel(channelId);
  let totalDeleted = 0;
  const allFailedNames = new Set<string>();
  for (const key of keys) {
    const { deleted, failedModels } = deleteFailedModelsForKey(key.id);
    totalDeleted += deleted;
    for (const m of failedModels) allFailedNames.add(m);
  }

  if (allFailedNames.size === 0) {
    return { deleted: totalDeleted, removedFromChannelList: 0, removedFromKeyLists: 0, removedFromHubKeyLists: 0 };
  }

  // 1. channels.models (逗号分隔)
  let removedFromChannelList = 0;
  const channelRow = getDb()
    .prepare('SELECT models FROM channels WHERE id = ?')
    .get(channelId) as { models: string | null } | undefined;
  if (channelRow?.models) {
    const originalList = channelRow.models;
    const filteredList = channelRow.models
      .split(',')
      .map(s => s.trim())
      .filter(name => name && !allFailedNames.has(name));
    removedFromChannelList = originalList.split(',').filter(s => s.trim()).length - filteredList.length;
    if (removedFromChannelList > 0) {
      getDb()
        .prepare("UPDATE channels SET models = ?, updated_at = ? WHERE id = ?")
        .run(filteredList.join(',') || null, Date.now(), channelId);
    }
  }

  // 2. 每个 key 的 allowed_models (JSON 数组)
  let removedFromKeyLists = 0;
  for (const key of keys) {
    const row = getDb()
      .prepare('SELECT allowed_models FROM keys WHERE id = ?')
      .get(key.id) as { allowed_models: string | null } | undefined;
    if (!row?.allowed_models) continue;
    const { json, removed } = removeNamesFromJsonArray(row.allowed_models, allFailedNames);
    if (removed > 0) {
      getDb()
        .prepare("UPDATE keys SET allowed_models = ?, updated_at = ? WHERE id = ?")
        .run(json, Date.now(), key.id);
      removedFromKeyLists += removed;
    }
  }

  // 3. hub_keys.allowed_models (JSON 数组) — 只清掉出现在 channels.models 历史上的 (即当前 channels.models 仍含的或曾含的)
  //    这里我们只清掉含失败模型名的, 不论 channels.models 当前是否还含 (简化处理)
  let removedFromHubKeyLists = 0;
  for (const hk of getDb().prepare('SELECT id, allowed_models FROM hub_keys WHERE allowed_models IS NOT NULL').all() as Array<{ id: number; allowed_models: string }>) {
    const { json, removed } = removeNamesFromJsonArray(hk.allowed_models, allFailedNames);
    if (removed > 0) {
      // hub_keys 没有 updated_at 列, 只更新 allowed_models
      getDb()
        .prepare("UPDATE hub_keys SET allowed_models = ? WHERE id = ?")
        .run(json, hk.id);
      removedFromHubKeyLists += removed;
    }
  }

  return { deleted: totalDeleted, removedFromChannelList, removedFromKeyLists, removedFromHubKeyLists };
}

/** 清除 key 下所有模型的测试结果 */
export function clearTestResultsForKey(keyId: number): void {
  getDb()
    .prepare("UPDATE discovered_models SET test_status = NULL, test_latency_ms = NULL, test_error = NULL, tested_at = NULL WHERE key_id = ?")
    .run(keyId);
}
