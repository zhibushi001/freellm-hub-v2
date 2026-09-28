-- Phase 6.4: 清理 Xiaomi MiMo plans.notes 里的冗余信息
--   * "key 格式 sk-xxxxx" 等 — 已经在 API Key 输入框 placeholder 暗示, 冗余
--   * 保留有用的: 主力模型清单, 批量 API 的专属 URL 提示

UPDATE providers
SET plans = '[
    {"id":"payg","label":"按量付费","base_url":"https://api.xiaomimimo.com/v1","api_path":"/chat/completions","models_path":"/models","protocol":"openai","key_prefix":"sk-","notes":"主力模型: mimo-v2.6-pro / mimo-v2.6-flash / mimo-v2.6-pro-ultraspeed / mimo-v2.5-tts / mimo-v2.5-asr"},
    {"id":"batch","label":"批量推理 (Batch)","base_url":"https://batch-api-cn.xiaomimimo.com/v1","api_path":"/chat/completions","models_path":"/models","protocol":"openai","key_prefix":"sk-","notes":"需从控制台获取专属 Base URL"},
    {"id":"token","label":"Token Plan (订阅)","base_url":"https://token-plan-cn.xiaomimimo.com/v1","api_path":"/chat/completions","models_path":"/models","protocol":"openai","key_prefix":"tp-","notes":"个人版 key 前缀 tp-, 团队版 ttp-"}
  ]',
    updated_at = strftime('%s','now')*1000
WHERE name = 'xiaomi-mimo';