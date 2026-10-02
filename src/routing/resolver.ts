/**
 * 模型路由 resolver
 * 详见 docs/DESIGN.md §4.2
 *
 * Phase 1 简化版: 单 Key 直传, 不做候选池/评分
 * Phase 2 起: 加 candidate 池、key 池、failover、冷却
 * Phase 5.E: 加 model_routes 显式路由 (用户配置的 "gpt-4o" → channel_ids 顺序)
 */
import type { KeyWithChannel } from '../db/repos/keys.js';
import { getModelRouteByName } from '../db/repos/modelRoutes.js';
import { getChannel } from '../db/repos/channels.js';
import { getProviderByName } from '../db/repos/providers.js';

export type ResolveResult =
  | { key: KeyWithChannel; upstreamModel: string }
  | { error: string; errorKind?: 'model_not_found' | 'no_keys' };

/**
 * 解析 model 字段 → (key, upstreamModel) 对
 *
 * 规则:
 *   'minimax/M3'           → 在 minimax provider 下选第一个可用 key, upstream=M3
 *   'minimax/A1/M3'        → 强制 provider=minimax, key 标签 A1, upstream=M3 (Phase 2)
 *   'M3'                   → 找第一个可用 key, upstream=M3
 *   'stealth/space-bunny-alpha' → 前缀不是真实提供商 (OpenRouter org/model 形式)
 *                                → 按完整字面量在通道模型列表中精确匹配
 *   'deepseek/xxx' 且 deepseek 是已注册 provider → 先按 pin 解析; 若该 provider 无可用 Key,
 *                                则继续按完整字面量匹配 (provider 名与上游组织名撞名的情形)
 *   其他                    → Phase 1 不支持
 *
 * Phase 5.E 增强: 如果有 model_routes 配置, 优先按 route 选 channel,
 *   在该 channel 的 keys 中按 priority/weight 选一个
 */
/**
 * 检查 key 是否可以服务此 upstream model
 * - key.allowed_models 为 null 或 '[]' 或空数组: 不限制
 * - 否则 key.allowed_models JSON 数组必须包含此 model
 */
export function isKeyEligibleForModel(key: KeyWithChannel, upstreamModel: string): boolean {
  const raw = key.allowed_models;
  if (!raw) return true;
  let list: string[] = [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) list = parsed.filter((m: any) => typeof m === 'string');
  } catch { return true; }
  if (list.length === 0) return true;
  return list.includes(upstreamModel);
}

export function resolveModel(requestModel: string, allKeys: KeyWithChannel[]): ResolveResult {
  if (!requestModel) return { error: 'model 字段必填' };

  const parts = requestModel.split('/').filter(Boolean);

  // F2: 斜杠前缀只有在真实存在同名提供商时才按"指定提供商"解析。
  // OpenRouter 等上游的模型 ID 是 org/model 形式 — 前缀是组织名不是提供商,
  // 之前会被误判成 pin → 报 "Provider 'stealth' 下没有可用 Key"。
  const providerPinned = parts.length >= 2 && getProviderByName(parts[0]) !== null;

  // 0. Phase 5.E: 显式 model_routes 优先
  // 只对纯 model 名 (1 段) 触发, 避免与 provider/model 形式冲突
  if (parts.length === 1) {
    const route = getModelRouteByName(requestModel);
    if (route && route.enabled === 1) {
      let channelIds: number[] = [];
      try {
        const parsed = JSON.parse(route.channel_ids);
        if (Array.isArray(parsed)) channelIds = parsed.filter((n: any) => Number.isFinite(n));
      } catch { /* intentional empty */ }
      if (channelIds.length > 0) {
        // 按 route 顺序遍历 channel_ids, 找第一个有 enabled key 的
        for (const cid of channelIds) {
          const ch = getChannel(cid);
          if (!ch || !ch.enabled) continue;
          const chKey = allKeys.find((k) => k.channel_id === cid && k.enabled === 1 && k.status !== 'failed' && isKeyEligibleForModel(k, requestModel));
          if (chKey) {
            return { key: chKey, upstreamModel: requestModel };
          }
        }
        return { error: `model_routes 配置的 channel ${channelIds.join(',')} 全无 enabled key`, errorKind: 'no_keys' };
      }
      // channel_ids = [] 表示 "走默认 resolver" (fall through)
    }
  }

  // 1. 三段式: provider/key/model (Phase 2 完整支持, Phase 1 部分支持)
  if (parts.length === 3 && providerPinned) {
    const [providerName, keyRef, upstream] = parts;
    const candidates = allKeys.filter(
      k => k.provider_name === providerName && k.enabled === 1 && (k.channel_enabled ?? 1) === 1 && k.status !== 'failed' && isKeyEligibleForModel(k, upstream),
    );
    if (candidates.length === 0) {
      return { error: `Provider '${providerName}' 下没有可用 Key (启用且服务此模型)` };
    }
    // keyRef 可能是 label 或 id
    const target = candidates.find(k =>
      (k.label && slugify(k.label) === slugify(keyRef)) || String(k.id) === keyRef,
    );
    if (!target) {
      return { error: `Provider '${providerName}' 下没有 Key '${keyRef}' (或被模型限制排除)` };
    }
    return { key: target, upstreamModel: upstream };
  }

  // 2. 两段式: provider/model
  // provider 存在且有可用 Key → 按 pin 解析 (用户显式指定);
  // provider 存在但无可用 Key → 不直接报错, 继续按完整字面量匹配 —
  //   处理"provider 名与上游组织名撞名" (如我们预置了 deepseek/google/anthropic 等空壳 provider,
  //   而用户要的是 OpenRouter 上的 deepseek/… 真实模型)。三段式强制 pin 仍是硬语义, 不受影响。
  if (parts.length === 2 && providerPinned) {
    const [providerName, upstream] = parts;
    const candidates = allKeys.filter(
      k => k.provider_name === providerName && k.enabled === 1 && (k.channel_enabled ?? 1) === 1 && k.status !== 'failed' && isKeyEligibleForModel(k, upstream),
    );
    if (candidates.length > 0) {
      // 简单选第一个 (Phase 2 会按 priority/weight 评分)
      return { key: candidates[0], upstreamModel: upstream };
    }
    // candidates 为空 → 落入下方字面量路径
  }

  // 3. 字面模型名 — 走到这里说明斜杠前缀不是真实提供商 (F2), 按完整字面量匹配。
  //    多段 ID 只允许"通道模型列表显式包含它"或"列表为空=通配"的通道命中, 防止宽松乱选。
  const upstream = parts.length === 1 ? parts[0] : requestModel;
  const literalSlash = parts.length > 1;
  const candidates = allKeys.filter(k => {
    if (k.enabled !== 1 || (k.channel_enabled ?? 1) !== 1 || k.status === 'failed') return false;
    if (!isKeyEligibleForModel(k, upstream)) return false;
    if (!literalSlash) return true;
    const ch = getChannel(k.channel_id);
    if (!ch) return false;
    const models = (ch.models ?? '').split(',').map(s => s.trim()).filter(Boolean);
    return models.length === 0 || models.includes(upstream);
  });
  if (candidates.length === 0) {
    // 区分: 模型名在系统中是否存在 vs 仅是当前没可用 Key
    // 注: channels.models 是 CSV 字符串 (逗号分隔), 不是 JSON
    const knownUpstreamModels = new Set<string>();
    for (const k of allKeys) {
      const ch = getChannel(k.channel_id);
      if (!ch || !ch.enabled || !ch.models) continue;
      ch.models.split(',').map(s => s.trim()).filter(Boolean).forEach(m => knownUpstreamModels.add(m));
    }
    if (!knownUpstreamModels.has(upstream)) {
      return { error: `模型 '${upstream}' 未配置。请检查模型列表或在「渠道」中添加该模型`, errorKind: 'model_not_found' };
    }
    return { error: `模型 '${upstream}' 已配置，但没有可用的 Key (Key 全被禁用或失败)`, errorKind: 'no_keys' };
  }
  // Phase 1: 简单选第一个
  return { key: candidates[0], upstreamModel: upstream };
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9-]/g, '-');
}
