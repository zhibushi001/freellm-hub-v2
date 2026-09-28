-- Phase 6.1: 添加小米 MiMo Provider (3 种套餐)
-- 官方文档: https://mimo.mi.com/docs/zh-CN/quick-start/summary/first-api-call
-- 账号体系: 小米账号 (id.mi.com), 控制台 platform.xiaomimimo.com
-- 兼容协议: OpenAI Chat Completions + Anthropic Messages (此 migration 仅注册 OpenAI 协议 base_url)

-- 1) 按量付费 (Pay-as-you-go) - key 格式 sk-xxxxx
INSERT OR IGNORE INTO providers (name, display_name, base_url, protocol, api_path, models_path, category, is_free, signup_url, docs_url, notes, enabled, created_at, updated_at) VALUES
  ('xiaomi-mimo', 'Xiaomi MiMo (按量付费)', 'https://api.xiaomimimo.com/v1', 'openai', '/chat/completions', '/models', 'paid', 0,
   'https://platform.xiaomimimo.com/#/console/api-keys',
   'https://mimo.mi.com/docs/zh-CN/quick-start/summary/first-api-call',
   '小米 MiMo 按量付费, key 格式 sk-xxxxx, 主力模型: mimo-v2.6-pro / mimo-v2.6-flash / mimo-v2.6-pro-ultraspeed / mimo-v2.5-tts / mimo-v2.5-asr',
   1, strftime('%s','now')*1000, strftime('%s','now')*1000);

-- 2) 批量推理 (Batch API) - key 格式 sk-xxxxx, 需专属 Base URL
INSERT OR IGNORE INTO providers (name, display_name, base_url, protocol, api_path, models_path, category, is_free, signup_url, docs_url, notes, enabled, created_at, updated_at) VALUES
  ('xiaomi-mimo-batch', 'Xiaomi MiMo Batch (批量推理)', 'https://batch-api-cn.xiaomimimo.com/v1', 'openai', '/chat/completions', '/models', 'paid', 0,
   'https://platform.xiaomimimo.com/console/batch',
   'https://mimo.mi.com/docs/zh-CN/quick-start/usage-guide/text-generation/batch-api',
   '小米 MiMo 批量推理, key 格式 sk-xxxxx, 需从控制台获取专属 Base URL 替换',
   1, strftime('%s','now')*1000, strftime('%s','now')*1000);

-- 3) Token Plan (订阅套餐) - key 格式 tp-xxxxx (个人) / ttp-xxxxx (团队)
INSERT OR IGNORE INTO providers (name, display_name, base_url, protocol, api_path, models_path, category, is_free, signup_url, docs_url, notes, enabled, created_at, updated_at) VALUES
  ('xiaomi-mimo-token', 'Xiaomi MiMo Token Plan (订阅)', 'https://token-plan-cn.xiaomimimo.com/v1', 'openai', '/chat/completions', '/models', 'paid', 0,
   'https://platform.xiaomimimo.com/#/console/plan-manage',
   'https://mimo.mi.com/docs/zh-CN/tokenplan/Token Plan/subscription',
   '小米 MiMo 订阅套餐, key 格式 tp-xxxxx (个人版) / ttp-xxxxx (团队版), 含 MiMo Claw / Desktop / Code 产品权益',
   1, strftime('%s','now')*1000, strftime('%s','now')*1000);
