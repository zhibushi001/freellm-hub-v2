/**
 * Usage 日志服务
 * 详见 docs/DESIGN.md §3.1 usage_logs / usage_daily
 */
import { getDb } from '../db/connection.js';

export interface UsageInput {
  hub_key_id?: number | null;
  key_id?: number | null;
  provider_name?: string | null;
  request_model?: string;
  routed_model?: string;
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  latency_ms?: number;
  status: 'success' | 'error';
  error_code?: number | null;
  error_type?: string | null;
  error_message?: string | null;
  stream: 0 | 1;
  virtual_model_id?: number | null;
  candidate_id?: number | null;
}

export function recordUsage(u: UsageInput): void {
  getDb()
    .prepare(
      `INSERT INTO usage_logs
       (hub_key_id, key_id, provider_name, request_model, routed_model,
        prompt_tokens, completion_tokens, total_tokens,
        latency_ms, status, error_code, error_type, error_message, stream,
        virtual_model_id, candidate_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      u.hub_key_id ?? null,
      u.key_id ?? null,
      u.provider_name ?? null,
      u.request_model ?? null,
      u.routed_model ?? null,
      u.prompt_tokens ?? null,
      u.completion_tokens ?? null,
      u.total_tokens ?? null,
      u.latency_ms ?? null,
      u.status,
      u.error_code ?? null,
      u.error_type ?? null,
      u.error_message ?? null,
      u.stream,
      u.virtual_model_id ?? null,
      u.candidate_id ?? null,
      Date.now(),
    );
}

