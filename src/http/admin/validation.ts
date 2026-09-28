/**
 * Admin API 输入验证 schemas
 */
import { z } from 'zod';
import type { FastifyRequest, FastifyReply } from 'fastify';

/** 通用验证结果 */
export interface ValidationResult<T = unknown> {
  data?: T;
  errors?: Array<{ field: string; message: string }>;
}

/**
 * 验证 body，返回 { data } 或 { errors }
 */
export function validateBody<T>(
  req: FastifyRequest,
  schema: z.ZodType<T>,
): ValidationResult<T> | null {
  const result = schema.safeParse(req.body);
  if (!result.success) {
    const errors = result.error.errors.map(e => ({
      field: e.path.join('.'),
      message: e.message,
    }));
    return { errors };
  }
  return { data: result.data };
}

/** 渠道创建 */
export const CreateChannelSchema = z.object({
  provider_id: z.union([z.string(), z.number()]).optional(),
  /** 当 provider 有多套餐 (plans) 时, 从下拉选定. 形如 "payg" / "token". */
  plan_id: z.string().max(64).optional(),
  name: z.string().min(1, 'name 必填').max(128),
  base_url: z.string().min(1, 'base_url 必填').url('base_url 必须是有效 URL').max(512),
  api_path: z.string().optional(),
  models_path: z.string().optional(),
  protocol: z.string().optional(),
  label: z.string().optional(),
  provider_label: z.string().optional(),
  key_label: z.string().optional(),
  api_key: z.string().optional(),
  api_keys_batch: z.string().optional(),
  test_model: z.string().optional(),
  multi_key_mode: z.enum(['random', 'sequential', 'polling', 'sticky']).optional(),
  models: z.union([z.array(z.string()), z.string()]).optional(),
  enabled: z.boolean().optional(),
  weight: z.number().int().min(1).max(100).optional(),
  priority: z.number().int().min(0).max(100).optional(),
});

/** 渠道更新 */
export const UpdateChannelSchema = z.object({
  label: z.string().max(128).nullable().optional(),
  models: z.string().nullable().optional(),
  excluded_models: z.string().nullable().optional(),
  test_model: z.string().max(128).nullable().optional(),
  priority: z.number().int().min(0).max(100).optional(),
  weight: z.number().int().min(1).max(100).optional(),
  multi_key_mode: z.enum(['random', 'sequential', 'polling', 'sticky']).optional(),
  // 前端 toggle 发 enabled: 0/1 (数字), 兼容 boolean — 只收 boolean 会让渠道启用/禁用按钮必失败
  enabled: z.union([z.boolean(), z.number().int().min(0).max(1)]).optional(),
  capabilities: z.string().nullable().optional(),
  tag: z.string().max(64).nullable().optional(),
});

/** Key 创建 */
export const CreateKeySchema = z.object({
  api_key: z.string().min(1, 'api_key 必填'),
  key_label: z.string().max(128).optional(),
  // 前端不限制模型时显式发 models: null (handler 支持 null), schema 不收 null 会让"添加 Key"必400
  models: z.union([z.array(z.string()), z.string(), z.null()]).optional(),
});

/** Key 更新 */
export const UpdateKeySchema = z.object({
  label: z.string().max(128).nullable().optional(),
  // 前端发 enabled: 0/1 (数字), 兼容 boolean — 之前只收 boolean 导致"限制可用模型"保存必失败
  enabled: z.union([z.boolean(), z.number().int().min(0).max(1)]).optional(),
  allowed_models: z.union([z.array(z.string()), z.null()]).optional(),
});

/** 获取模型列表 */
export const FetchModelsSchema = z.object({
  base_url: z.string().min(1, 'base_url 必填').url('base_url 必须是有效 URL').max(512),
  models_path: z.string().optional(),
  api_key: z.string().min(1, 'api_key 必填'),
});
