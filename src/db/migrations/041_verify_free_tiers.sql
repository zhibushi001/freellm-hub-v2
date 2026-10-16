-- 041: 免费层数据核实 + 额度信息 + 名称清理
--
-- 背景: 逐个实测 50 个免费 provider 的 /v1/models (2026-10-09), 结果分三类:
--   * 域名已无 DNS 解析 / 被 Cloudflare 封禁 / 完全无响应 -> 删除
--   * 200 且无需 key -> 真 keyless 免费, 标注 barrier=none
--   * 401/403 -> 存活但需注册, 标注 barrier=registration
--
-- 同时新增 free_quota 列 (免费额度), 并清理 display_name 里的"免费/试用"字样
-- (provider 本身就在免费类目下, 名称里再写一遍是冗余)。

-- ---------------------------------------------------------------------------
-- 1. 删除失效 provider (全部已确认无 channel 引用)
-- ---------------------------------------------------------------------------

-- api.router9.ai   DNS 无解析
-- api.sail.com     DNS 无解析
-- api.experiential.ai  DNS 无解析
-- api.septor.ai    DNS 无解析
DELETE FROM providers
WHERE name IN ('router9', 'sail', 'experiential', 'septor');

-- api.routeway.ai  Cloudflare "error code: 1005" (ASN 封禁), API 不可达
DELETE FROM providers WHERE name = 'routeway';

-- b.ai / api.b.ai  DNS 指向 185.60.216.50 但全站无响应 (根域与 /v1 均超时)
DELETE FROM providers WHERE name = 'bai';

-- router.bynara.id 连接超时, /v1/models 无响应
DELETE FROM providers WHERE name = 'nara-router';

-- aihorde: 双重问题
--   1) base_url 指向 AI Horde 自家原生 API (/api/v2), 而非 OpenAI 兼容层,
--      其 models_path='/models' 在该路径下 404 —— 配置本身是错的
--   2) 实测期间服务多次无响应 (根域 200, /api/v2/* 000, 复测全部 000)
DELETE FROM providers WHERE name = 'aihorde';

-- ---------------------------------------------------------------------------
-- 2. 新增免费额度列
-- ---------------------------------------------------------------------------
ALTER TABLE providers ADD COLUMN free_quota TEXT;

-- 无需 key, 直接可用 (实测 /v1/models 返回 200)
UPDATE providers
SET requires_card = 0,
    signup_barrier = 'none',
    free_quota = '无需 API Key, 直接调用 (实测 /v1/models 可公开访问)'
WHERE name IN ('pollinations', 'electronhub', 'orca-router', 'navyai',
               'xkiro', 'bazaarlink', 'ainative', 'ovh-ai');

-- 存活但需注册 (实测返回 401/403)
UPDATE providers SET requires_card = 0, signup_barrier = 'registration'
WHERE name IN ('sea-lion', 'uno-router', 'anyapi', 'reka', 'amd-radeon',
               'baidu-qianfan', 'volcengine-ark', 'iflytek-spark', 'longcat');

-- ---------------------------------------------------------------------------
-- 3. 免费额度 (来源: freellm.net / awesome-freellm-apis, 2026-10-09)
--    仅填有明确来源的, 其余保持 NULL
-- ---------------------------------------------------------------------------
UPDATE providers SET free_quota = '30 RPM, 14,400 RPD'
WHERE name = 'groq-free';

UPDATE providers SET free_quota = '最高 40 RPM'
WHERE name = 'nvidia-nim';

UPDATE providers SET free_quota = '15 RPM, 1,500 RPD (按模型不同)'
WHERE name = 'gemini-free';

UPDATE providers SET free_quota = '20 RPM'
WHERE name = 'cohere-trial';

UPDATE providers SET free_quota = '10 RPM, 100 RPD, 1M TPD'
WHERE name = 'cerebras';

UPDATE providers SET free_quota = '按 credit 计费, 有免费额度'
WHERE name = 'huggingface';

UPDATE providers SET free_quota = '1 个并发请求'
WHERE name = 'zhipu-free';

UPDATE providers SET free_quota = '约 1 RPS, 500K TPM'
WHERE name = 'mistral-free';

UPDATE providers SET free_quota = '2 RPM (匿名调用)'
WHERE name = 'ovh-ai';

UPDATE providers SET free_quota = '15 RPM, 20K TPD'
WHERE name = 'aion-labs';

UPDATE providers SET free_quota = '60 RPM, 250 req/hr'
WHERE name = 'llm7';

UPDATE providers SET free_quota = '200 req/hr'
WHERE name = 'kilo';

UPDATE providers SET free_quota = '免费层 200 req/day (因模型而异)'
WHERE name = 'openrouter-free';

UPDATE providers SET free_quota = '按会话 / 周限额'
WHERE name = 'ollama-cloud';

UPDATE providers SET free_quota = '20 RPM, 20 RPD, 200K TPD'
WHERE name = 'sambanova';

UPDATE providers SET free_quota = '30 RPM, 60K TPM'
WHERE name = 'siliconflow';

UPDATE providers SET free_quota = '30 RPM'
WHERE name = 'agnes-ai';

UPDATE providers SET free_quota = '社区众包, 无硬性限额'
WHERE name = 'chutes';

UPDATE providers SET free_quota = '按套餐分级'
WHERE name = 'nebius';

UPDATE providers SET free_quota = '公平使用 (fair-use)'
WHERE name = 'nscale';

UPDATE providers SET free_quota = '10K neurons/day (账号共享)'
WHERE name = 'cloudflare-ai';

UPDATE providers SET free_quota = '2,000 RPD 总量'
WHERE name = 'modelscope';

UPDATE providers SET free_quota = '200 RPM, 10 RPS'
WHERE name = 'ai21';

-- ---------------------------------------------------------------------------
-- 4. 清理 display_name 里的"免费 / 试用 / 实验"字样
--    这些 provider 已经在"免费"类目下, 名称里不必重复
-- ---------------------------------------------------------------------------
UPDATE providers SET display_name = 'Groq'          WHERE name = 'groq-free';
UPDATE providers SET display_name = 'Gemini'        WHERE name = 'gemini-free';
UPDATE providers SET display_name = 'Cohere'        WHERE name = 'cohere-trial';
UPDATE providers SET display_name = 'OpenRouter'    WHERE name = 'openrouter-free';
UPDATE providers SET display_name = '智谱 GLM'      WHERE name = 'zhipu-free';
UPDATE providers SET display_name = 'Mistral'       WHERE name = 'mistral-free';
UPDATE providers SET display_name = 'SenseNova (商汤)' WHERE name = 'sensenova-free';
UPDATE providers SET display_name = 'SenseNova (海外)' WHERE name = 'SenseNova (海外)';
UPDATE providers SET display_name = 'Kilo Gateway'  WHERE name = 'kilo';
UPDATE providers SET display_name = 'OVH AI Endpoints' WHERE name = 'ovh-ai';
UPDATE providers SET display_name = 'Alibaba Cloud Model Studio' WHERE name = 'bailian';
UPDATE providers SET display_name = 'Claude / Anthropic' WHERE name = 'anthropic';
UPDATE providers SET display_name = 'Google AI Studio' WHERE name = 'google';
UPDATE providers SET display_name = 'Groq (付费)'    WHERE name = 'groq';
UPDATE providers SET display_name = 'Mistral (付费)' WHERE name = 'mistral';
UPDATE providers SET display_name = 'Cohere (付费)'  WHERE name = 'cohere';
UPDATE providers SET display_name = '智谱 GLM (付费)' WHERE name = 'zhipu';
UPDATE providers SET display_name = '阿里 DashScope (通义)' WHERE name = 'dashscope';
UPDATE providers SET display_name = '请求路由' WHERE name = 'requesty-free';
