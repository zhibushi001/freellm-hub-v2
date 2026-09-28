-- Phase 6.3: 清理 provider 表的脏数据
-- 规则 (按用户确认):
--   * 免费 (is_free=1) 和付费 (is_free=0) 保持分离, 不合并
--   * 付费有多个套餐的可以合一下拉 (029 已为 Xiaomi MiMo 实现)
--   * 重复 / 别名: 删除
--   * 错分类: 修正

-- 1. 删除别名: groq-cloud (id=22) 是 groq-free 的别名 (display_name "Groq Cloud (同 groq-free)")
--    无 channel / key 引用, 可安全删除
DELETE FROM providers WHERE id = 22 AND name = 'groq-cloud';

-- 2. 修正错分类: SenseNova (海外) (id=108) 之前 category=null, is_free=0
--    但 display_name 错写成 "商汤 SenseNova (免费)". 它实际是付费渠道, 应在 "收费" 标签页.
--    ch#21 + keys #21/#23 都引用它, 不可删除. 在原位修正.
UPDATE providers
SET
  display_name = 'SenseNova (海外)',
  category     = 'paid',
  docs_url     = 'https://docs.sensenova.cn',
  notes        = 'SenseNova 海外版, base_url 不同 (token.sensenova.ai vs cn), 不是免费层'
WHERE id = 108;