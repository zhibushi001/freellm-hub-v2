-- 040: 免费层增强 (数据来源: freellm.net / awesome-freellm-apis, 2026-10-09 核对)
--
-- 1. 新增"注册门槛 / 是否需要信用卡"字段 —— 免费层用户最关心的信息
-- 2. 清理: 已下线的 provider + 重复条目
-- 3. 补全 aion-labs / ai21 的元数据 (两条已存在, 不是新增)
-- 4. 修正 cohere 免费层的 base_url (v1 -> v2)
--
-- 注: requires_card / signup_barrier 只对**有数据来源**的 provider 赋值,
--     其余保持 NULL(未知) —— 不猜. 没有来源的宁可显示"未知"也不能误导用户。

-- ---------------------------------------------------------------------------
-- 1. 新增字段
--    requires_card : 0=不需要信用卡, 1=需要, NULL=未知
--    signup_barrier: none=无需注册 / phone=需手机验证 / registration=需注册 / NULL=未知
-- ---------------------------------------------------------------------------
ALTER TABLE providers ADD COLUMN requires_card INTEGER;
ALTER TABLE providers ADD COLUMN signup_barrier TEXT;

-- ---------------------------------------------------------------------------
-- 2. 清理
-- ---------------------------------------------------------------------------

-- github-models (id=26): GitHub Models 已于 2026-07-30 永久退役.
-- 实测 models.github.ai/inference/models 仅返回字符串 "OK", 已无模型列表.
-- 已确认无 channel 引用.
DELETE FROM providers WHERE id = 26 AND name = 'github-models';

-- cloudflare (id=156) 与 cloudflare-ai (id=63) 同名同 base_url, 重复条目.
-- 保留 cloudflare-ai (id=63, enabled=1); 两条均已确认无 channel 引用.
DELETE FROM providers WHERE id = 156 AND name = 'cloudflare';

-- ---------------------------------------------------------------------------
-- 3. 补全 aion-labs (id=55) / ai21 (id=161) —— 两条早已存在, 此处只补元数据
-- ---------------------------------------------------------------------------
UPDATE providers
SET signup_url = 'https://www.aionlabs.ai/app/api-keys/',
    docs_url   = 'https://docs.aionlabs.ai/',
    notes      = '免费层 11 个模型, 最大上下文 131K, 限速 15 RPM / 20K TPD. 主力 aion-labs/aion-2.0 / aion-3.0 / aion-rp-llama-3.1-8b.',
    updated_at = strftime('%s','now')*1000
WHERE name = 'aion-labs';

UPDATE providers
SET docs_url   = 'https://docs.ai21.com/',
    notes      = '免费层 2 个模型, 256K 上下文, 200 RPM / 10 RPS. 主力 jamba-large-1-7 / jamba-mini-2. 来源 freellm.net.',
    updated_at = strftime('%s','now')*1000
WHERE name = 'ai21';

-- ---------------------------------------------------------------------------
-- 4. cohere 免费层 base_url: /v1 -> /v2
--    Cohere v1 已进入 legacy, 官方文档与 freellm.net 均标注 v2.
--    cohere-trial 已确认无 channel 引用; 付费的 cohere (id=14) 保持不变.
-- ---------------------------------------------------------------------------
UPDATE providers
SET base_url   = 'https://api.cohere.com/v2',
    notes      = 'Cohere 免费层试用. 已切到 v2 端点 (v1 为 legacy). 限速 20 RPM, 主力 command-a-218b / command-a-111b / command-r.',
    updated_at = strftime('%s','now')*1000
WHERE name = 'cohere-trial';

-- ---------------------------------------------------------------------------
-- 5. 回填注册门槛 / 信用卡要求
--    仅覆盖 freellm.net 有明确标注的 provider
-- ---------------------------------------------------------------------------

-- 无需信用卡 + 无需任何注册 (keyless / 邮箱注册即可用)
UPDATE providers SET requires_card = 0, signup_barrier = 'none'
WHERE name IN (
  'cerebras', 'gemini-free', 'groq-free', 'cohere-trial', 'huggingface',
  'zhipu-free', 'cloudflare-ai', 'kilo', 'llm7'
);

-- 无需信用卡, 但需手机验证
UPDATE providers SET requires_card = 0, signup_barrier = 'phone'
WHERE name IN ('nvidia-nim', 'mistral-free');

-- 无需信用卡, 需注册
UPDATE providers SET requires_card = 0, signup_barrier = 'registration'
WHERE name IN (
  'modelscope', 'opencode-zen', 'ollama-cloud', 'aion-labs', 'agnes-ai',
  'bailian', 'sambanova', 'siliconflow', 'chutes', 'glhf', 'ai21',
  'nscale', 'nebius', 'openrouter-free'
);

-- 需信用卡的付费 provider (OpenRouter 免费层部分模型需 $10 一次性充值才能用 Anthropic 模型)
UPDATE providers SET requires_card = 1, signup_barrier = 'registration'
WHERE name IN ('openrouter');
