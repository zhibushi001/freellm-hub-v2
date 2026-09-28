/**
 * Providers repo
 */
import { getDb } from '../connection.js';

export interface Provider {
  id: number;
  name: string;
  display_name: string | null;
  base_url: string;
  protocol: string;
  api_path: string;
  models_path: string;
  extra_config: string | null;
  signup_url: string | null;
  notes: string | null;
  enabled: number;
  is_free: number;
  category: string | null;
  docs_url: string | null;
  created_at: number;
  updated_at: number;
  /** 多套餐 JSON 数组. null = 单 base_url (向后兼容). 形如: [{ id, label, base_url, api_path, models_path, key_prefix, notes, protocol? }] */
  plans: string | null;
}

/** Plan 多套餐结构. 来自 providers.plans 解析后的对象 */
export interface ProviderPlan {
  id: string;
  label: string;
  base_url: string;
  api_path?: string;
  models_path?: string;
  protocol?: string;
  key_prefix?: string;
  notes?: string;
}

/** 解析 provider.plans JSON, 返回数组. plans 为空时返回 []. */
export function parseProviderPlans(provider: Provider | null | undefined): ProviderPlan[] {
  if (!provider?.plans) return [];
  try {
    const parsed = JSON.parse(provider.plans);
    if (Array.isArray(parsed)) return parsed.filter(p => p && typeof p.base_url === 'string');
  } catch { /* intentional empty */ }
  return [];
}

/** 根据 plan_id 查找 plan. 找不到返回 null. */
export function findProviderPlan(provider: Provider, planId: string | null | undefined): ProviderPlan | null {
  if (!planId) return null;
  const plans = parseProviderPlans(provider);
  return plans.find(p => p.id === planId) ?? null;
}

export interface CreateProviderInput {
  name: string;
  display_name?: string;
  base_url: string;
  protocol?: string;
  api_path?: string;
  models_path?: string;
  extra_config?: string;
  signup_url?: string;
  notes?: string;
  plans?: string | null;
}

export function listProviders(): Provider[] {
  return getDb()
    .prepare('SELECT * FROM providers ORDER BY name')
    .all() as unknown as Provider[];
}

export function getProvider(id: number): Provider | null {
  const row = getDb().prepare('SELECT * FROM providers WHERE id = ?').get(id);
  return (row as unknown as Provider) ?? null;
}

export function getProviderByName(name: string): Provider | null {
  const row = getDb().prepare('SELECT * FROM providers WHERE name = ?').get(name);
  return (row as unknown as Provider) ?? null;
}

export function createProvider(input: CreateProviderInput): Provider {
  const now = Date.now();
  const info = getDb()
    .prepare(
      `INSERT INTO providers
       (name, display_name, base_url, protocol, api_path, models_path, extra_config, signup_url, notes, enabled, created_at, updated_at, plans)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    )
    .run(
      input.name,
      input.display_name ?? null,
      input.base_url,
      input.protocol ?? 'openai',
      input.api_path ?? '/chat/completions',
      input.models_path ?? '/models',
      input.extra_config ?? null,
      input.signup_url ?? null,
      input.notes ?? null,
      now,
      now,
      input.plans ?? null,
    );
  return getProvider(Number(info.lastInsertRowid))!;
}

export function updateProvider(
  id: number,
  patch: Partial<CreateProviderInput> & { enabled?: number },
): Provider | null {
  const fields: string[] = [];
  const values: any[] = [];
  const allowed: Array<keyof CreateProviderInput | 'enabled'> = [
    'display_name', 'base_url', 'protocol', 'api_path', 'models_path',
    'extra_config', 'signup_url', 'notes', 'enabled', 'plans',
  ];
  for (const k of allowed) {
    if (patch[k] !== undefined) {
      fields.push(`${k} = ?`);
      values.push(patch[k]);
    }
  }
  if (fields.length === 0) return getProvider(id);
  fields.push('updated_at = ?');
  values.push(Date.now(), id);
  getDb().prepare(`UPDATE providers SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  return getProvider(id);
}

export function deleteProvider(id: number): void {
  getDb().prepare('DELETE FROM providers WHERE id = ?').run(id);
}

/** UI 用, 包含 is_free / category, 按 is_free 升序(免费在前), name 升序 */
export function listProvidersForAdmin(): Provider[] {
  return getDb()
    .prepare('SELECT * FROM providers ORDER BY is_free DESC, name ASC')
    .all() as unknown as Provider[];
}
