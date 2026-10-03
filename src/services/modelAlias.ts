/**
 * 模型别名 / 虚拟模型解析 (请求路径)
 *
 * 审计发现: `model_mappings` (全局别名表)、`virtual_models` + `model_candidates`、
 * `channels.model_mapping` 三套设施**都只有管理端 CRUD, 请求路径一个都没读** ——
 * 界面配好、预览看着对, 真实请求仍然按原名路由; 而按别名发请求必然 400 model_not_found。
 * 这里把它们接进 selectFirstCandidate。
 *
 * 两条硬规则 (不能破):
 * 1. **只解析单段名**。带斜杠的名字是上游字面 ID (如 `org/model`、三段 `provider/key/model`
 *    pin), 那是用户明确指定的上游模型名, 改写它会破坏刚修好的字面路由语义。
 * 2. **没配置 = 零行为变化**。查询只在单段名上做一次 EXISTS 短路, 没配就直接返回 null,
 *    走原来的路径 —— 这是所有这些特性上线的安全前提。
 *
 * 优先级: 虚拟模型 (name 精确匹配) > 全局别名链。两者都未命中 → 原样返回。
 */
import { getDb } from '../db/connection.js';

/** 别名链最大跳数: 正常配置 1-2 跳; 设上限避免管理员配出超长链拖慢每个请求 */
const MAX_HOPS = 10;

export interface VirtualCandidate {
  keyId: number;
  upstreamModel: string;
  /** 是否当前可用 (key 启用 + 通道启用 + 状态正常); 不可用的排在后面但仍保留, 便于报错说明 */
  usable: boolean;
  unusableReason?: string;
}

export interface ResolvedAlias {
  source: 'virtual' | 'mapping';
  /** 实际用于路由的模型名。virtual 时是首个可用候选的 upstream_model */
  model: string;
  /** 映射链 (原名 → ... → 最终名), 报错与调试用 */
  chain: string[];
  /** 仅 virtual: 按 pinned/priority/weight 排好序的候选 */
  candidates: VirtualCandidate[];
}

/** 是否单段名 (可被别名/虚拟模型解析)。斜杠名一律不解析 */
function isAliasable(model: string): boolean {
  return typeof model === 'string' && model.length > 0 && !model.includes('/');
}

/**
 * 全局别名链解析 (model_mappings.from_model → to_model)
 * 带环检测与跳数上限: 管理员配出 a→b→a 这种循环时, 这里不能无限转。
 */
export function resolveMappingChain(name: string): { model: string; chain: string[]; cyclic: boolean } | null {
  const db = getDb();
  const first = db
    .prepare('SELECT to_model FROM model_mappings WHERE from_model = ? AND enabled = 1')
    .get(name) as { to_model: string } | undefined;
  if (!first) return null;

  const visited = new Set<string>([name]);
  const chain: string[] = [name];
  let current = first.to_model;

  for (let hop = 0; hop < MAX_HOPS; hop++) {
    if (visited.has(current)) {
      console.warn(`[model-alias] 映射循环: ${[...chain, current].join(' → ')} — 本次按原名处理`);
      return { model: name, chain: [...chain, current], cyclic: true };
    }
    visited.add(current);
    chain.push(current);
    const next = db
      .prepare('SELECT to_model FROM model_mappings WHERE from_model = ? AND enabled = 1')
      .get(current) as { to_model: string } | undefined;
    if (!next) return { model: current, chain, cyclic: false };
    current = next.to_model;
  }
  console.warn(`[model-alias] 映射链超过 ${MAX_HOPS} 跳 (从 ${name} 起) — 截断`);
  return { model: current, chain, cyclic: false };
}

/** 虚拟模型候选 (join keys/channels 判断基础可用性; 冷却由路由池负责) */
function loadVirtualCandidates(virtualModelId: number): VirtualCandidate[] {
  const rows = getDb()
    .prepare(
      `SELECT mc.key_id, mc.upstream_model, mc.pinned, mc.priority, mc.weight,
              k.enabled AS key_enabled, k.status AS key_status,
              c.enabled AS channel_enabled
         FROM model_candidates mc
         JOIN keys k ON k.id = mc.key_id
         JOIN channels c ON c.id = k.channel_id
        WHERE mc.virtual_model_id = ? AND mc.enabled = 1`,
    )
    .all(virtualModelId) as Array<{
    key_id: number; upstream_model: string; pinned: number; priority: number; weight: number;
    key_enabled: number; key_status: string; channel_enabled: number;
  }>;

  return rows
    .map((r): VirtualCandidate & { pinned: number; priority: number; weight: number } => {
      const usable = r.key_enabled === 1 && r.channel_enabled === 1 && r.key_status !== 'disabled';
      let reason: string | undefined;
      if (r.key_enabled !== 1) reason = `上游 Key #${r.key_id} 已禁用`;
      else if (r.channel_enabled !== 1) reason = `Key #${r.key_id} 所在通道已禁用`;
      else if (r.key_status === 'disabled') reason = `上游 Key #${r.key_id} 状态为 disabled`;
      return {
        keyId: r.key_id, upstreamModel: r.upstream_model, usable, unusableReason: reason,
        pinned: r.pinned, priority: r.priority, weight: r.weight,
      };
    })
    // pinned → priority → weight → keyId (与界面里的候选排序语义一致)
    .sort((a, b) => {
      if (a.usable !== b.usable) return a.usable ? -1 : 1;
      if (a.pinned !== b.pinned) return b.pinned - a.pinned;
      if (a.priority !== b.priority) return b.priority - a.priority;
      if (a.weight !== b.weight) return b.weight - a.weight;
      return a.keyId - b.keyId;
    })
    .map(({ keyId, upstreamModel, usable, unusableReason }) => ({ keyId, upstreamModel, usable, unusableReason }));
}

/**
 * 请求模型名解析: 虚拟模型 → 全局别名链 → 原样
 * 返回 null 表示"没有任何配置命中", 调用方应走原路径。
 */
export function resolveRequestAlias(requestModel: string): ResolvedAlias | null {
  if (!isAliasable(requestModel)) return null;

  const db = getDb();

  // 虚拟模型优先: 名字精确匹配
  const vm = db
    .prepare('SELECT id, name FROM virtual_models WHERE name = ? AND enabled = 1')
    .get(requestModel) as { id: number; name: string } | undefined;
  if (vm) {
    const candidates = loadVirtualCandidates(vm.id);
    const usable = candidates.filter((c) => c.usable);
    return {
      source: 'virtual',
      model: (usable[0] ?? candidates[0])?.upstreamModel ?? requestModel,
      chain: [requestModel],
      candidates,
    };
  }

  // 全局别名链
  const mapped = resolveMappingChain(requestModel);
  if (!mapped) return null;
  if (mapped.cyclic) return null;  // 循环 = 配置错误, 按原名处理 (请求会正常报"没有该模型")
  return { source: 'mapping', model: mapped.model, chain: mapped.chain, candidates: [] };
}

/**
 * 渠道级 model_mapping: 本渠道把"对外名"翻译成"上游真实名"
 * 接受两种写法: JSON 对象 ({"alias":"real"}) 或每行 alias=real。
 * 返回 null 表示该渠道没有配置, 或没有这条映射 → 调用方用原名。
 */
export function applyChannelModelMapping(raw: string | null | undefined, upstreamModel: string): string | null {
  if (!raw) return null;
  const text = raw.trim();
  if (!text) return null;

  if (text.startsWith('{')) {
    try {
      const obj = JSON.parse(text) as Record<string, unknown>;
      const v = obj[upstreamModel];
      return typeof v === 'string' && v.trim() ? v.trim() : null;
    } catch {
      return null;  // 坏 JSON = 没配, 不能让它把请求带崩
    }
  }

  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim();
    if (k === upstreamModel && v) return v;
  }
  return null;
}