-- Phase 6.2: 引入 provider 多套餐机制 (plans JSON 列)
-- 用途: 一个 provider 可有多种 base_url/api_path 变体 (如 Xiaomi MiMo 的按量付费 / Batch / Token Plan)
-- 后向兼容: 现有 provider 不填 plans, 走原来的单一 base_url 流程
-- 前端: provider 有 plans 时, 创建渠道表单展示"套餐"下拉, 选定后自动填充 base_url 等

ALTER TABLE providers ADD COLUMN plans TEXT;

-- 删除 Phase 6.1 引入的 3 个独立 MiMo provider (无 channel 引用, 安全)
DELETE FROM providers WHERE name IN ('xiaomi-mimo', 'xiaomi-mimo-batch', 'xiaomi-mimo-token');

-- 插入统一 Xiaomi MiMo provider, plans JSON 包含 3 种套餐
-- 注意: 顶层 base_url/protocol/api_path/models_path 保留第一个套餐 (按量付费) 作为默认值,
--       前端/后端在用户选定其他套餐时会用 plans 里的值覆盖.
INSERT INTO providers
  (name, display_name, base_url, protocol, api_path, models_path, category, is_free, signup_url, docs_url, notes, enabled, created_at, updated_at, plans)
VALUES
  ('xiaomi-mimo', 'Xiaomi MiMo',
   'https://api.xiaomimimo.com/v1', 'openai', '/chat/completions', '/models',
   'paid', 0,
   'https://platform.xiaomimimo.com/#/console/api-keys',
   'https://mimo.mi.com/docs/zh-CN/quick-start/summary/first-api-call',
   '小米 MiMo 大模型 API. 支持 3 种套餐: 按量付费 / 批量推理 (Batch) / Token Plan 订阅. 创建渠道时下拉选择, 每种套餐独立 base_url 与 key 格式.',
   1,
   strftime('%s','now')*1000, strftime('%s','now')*1000,
   '[
       {"id":"payg","label":"按量付费","base_url":"https://api.xiaomimimo.com/v1","api_path":"/chat/completions","models_path":"/models","protocol":"openai","key_prefix":"sk-","notes":"key 格式 sk-xxxxx, 主力模型: mimo-v2.6-pro / mimo-v2.6-flash / mimo-v2.6-pro-ultraspeed / mimo-v2.5-tts / mimo-v2.5-asr"},
       {"id":"batch","label":"批量推理 (Batch)","base_url":"https://batch-api-cn.xiaomimimo.com/v1","api_path":"/chat/completions","models_path":"/models","protocol":"openai","key_prefix":"sk-","notes":"需从控制台获取专属 Base URL, key 格式 sk-xxxxx"},
       {"id":"token","label":"Token Plan (订阅)","base_url":"https://token-plan-cn.xiaomimimo.com/v1","api_path":"/chat/completions","models_path":"/models","protocol":"openai","key_prefix":"tp-","notes":"key 格式 tp-xxxxx (个人版) / ttp-xxxxx (团队版)"}
     ]');