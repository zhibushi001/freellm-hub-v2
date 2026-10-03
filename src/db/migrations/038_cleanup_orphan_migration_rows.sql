-- 清理迁移台账里的 3 条孤儿行
--
-- 背景: 台账体检 (e446e36) 报 /health 永久 migrations_orphaned: 3。
-- 这三条记录来自 2026-09-29 01:39~01:43 —— 当时服务端跑在一个**从未进过 git** 的
-- 工作副本上, 那份副本里有 004_seed_providers / 005_channel_newapi_fields /
-- 006_model_routes 三个文件 (编号还是 004_provider_fields 插队之前的旧号), 跑完
-- 记录进了 schema_migrations。事后文件从仓库消失, 记录成了孤儿。
-- `git log --diff-filter=A/D` 三个文件都查不到, 可确认不是"删文件忘删记录"。
--
-- 为什么删是安全的:
--   1) 这三条与现行 005/006/007 是同一批逻辑的重复, SQL 在 09-29 当天已执行过,
--      表结构无恙 (系统已稳定运行 4 天)。
--   2) runner 按**磁盘文件名**决定要不要重跑, 这三个文件不存在 → 删记录不触发
--      任何迁移重跑。
--   3) 现行 005_seed_providers.sql (09-15) / 006_channel_newapi_fields.sql (09-15) /
--      007_model_routes.sql (09-15) 各自都有独立记录, 保持 applied, 不会重复执行。
--   4) 新库 (从零跑) 根本不会有这三条, 本迁移是幂等 no-op。
--
-- 顺带说明: 这三条的 checksum 是 NULL —— 它们早于校验和机制, 而 runner 的补记逻辑
-- 只给磁盘上存在的文件补指纹, 孤儿行被 continue 跳过, 所以永远补不上, 只能清掉。

DELETE FROM schema_migrations WHERE name IN (
  '004_seed_providers.sql',
  '005_channel_newapi_fields.sql',
  '006_model_routes.sql'
);
