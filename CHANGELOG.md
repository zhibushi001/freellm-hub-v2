# Changelog

所有本项目的显著变更都记录在此。格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。


## [开发中 / 迭代记录] - 2026-10-01 ~ 2026-10-03

> 模型挑选弹窗三处入口补全、免费渠道对表 freellm.net、可疑端点实测、BACKLOG 作业清单落盘、路由第二轮修复 R1-R6 + 冷却策略 R7/R8 + 部署踩坑两则 + 台账孤儿行清理。

### 迁移台账: 3 条孤儿行清理 (2026-10-03)

- **现象**: `/health` 自台账体检 (e446e36) 上线起就长期报 `migrations_orphaned: 3`。
  字段一直非零, 久而久之没人再看 —— 等于把一个本该可信的漂移信号废掉了
- **根因不是"删文件忘删记录"**: `git log --diff-filter=A/D` 查 `004_seed_providers` /
  `005_channel_newapi_fields` / `006_model_routes` 三个文件, **新增和删除都查不到** ——
  它们**从未进过 git**。2026-09-29 01:39~01:43 服务端跑在一个未提交的工作副本上,
  那份副本含这三个文件 (编号还是 `004_provider_fields` 插队之前的旧号), 跑完把记录
  写进了 `schema_migrations`, 事后文件从仓库消失 → 记录成了孤儿
- **修复 (迁移 038)**: 删除这 3 行记录。三者与现行 005/006/007 是同一批逻辑的重复,
  SQL 在 09-29 当天已执行, 表结构无恙; runner 按**磁盘文件名**决定是否重跑, 这三个
  文件不存在 → 删记录不触发任何迁移重跑; 现行 005/006/007 各自有独立记录保持 applied;
  新库从零跑本迁移是幂等 no-op
- **为何是迁移文件而不是直接改生产库**: 直接改库的账本不进 git, 恢复旧备份时问题复发
  且无人知情。写成迁移意味着这次清理本身也被台账记录、可复现
- **验证** (先用生产库副本连跑两次 runner 模拟两次启动): 第一次 40→38 (删 3 增 038),
  无意外删除; 第二次 38→38 无迁移重跑, health 报 `orphaned: 0`。全量单测 185 通过
- **行为说明**: 台账体检在**迁移循环之前**执行 (runner.ts), 所以应用 038 的那次
  启动仍会报 3, **需再重启一次** health 才转 0。不是 bug, 是检查顺序决定的
- **删除会拆掉安全栓 → 用 `RETIRED_MIGRATIONS` denylist 补上**: 那 3 行的另一个作用是
  "行还在 → 文件从旧副本恢复时 runner 跳过它"。删行等于拆掉这层保护, 而本项目真出过
  `006_model_routes.sql` 躺在容器 dist 里被重放导致启动崩溃的事故。故 runner 增加
  `RETIRED_MIGRATIONS` 名单: 这 3 个文件**即使重新出现在磁盘上也永不执行**, 并且
  不静默 —— 一旦检测到重现就打印告警 (文件重现说明有人恢复了旧副本, 正是事故前置条件)。
  退役判据写进注释: 逻辑已被现行同名序号迁移取代且 schema 已含其全部效果
- **顺带消除一处逻辑重复**: `runMigrations` 与 `getMigrationStatus` 原先各自复制一份
  过滤逻辑 (seed 跳过), 改走共用的 `listMigrationFiles()`, 避免两处将来漂移
- **测试**: 新增"退役文件重现也绝不执行"用例 —— 往迁移目录塞一个会建表的
  `006_model_routes.sql`, 断言表没被建、台账没被写、且**不抛异常** (抛异常 = 重放 =
  服务起不来)。已验证该用例有效: 临时关掉 denylist 后它确实失败
  (`退役文件被执行了 —— 安全栓失效`)。全量单测 186 通过
- **顺带修正**: BACKLOG 的「迁移 checksum」条目此前仍标未完成, 实际 e446e36 已实现
  (`checksumOf` + `checksum` 列 + health 暴露), 本次一并勾掉

## 熔断器 + EWMA 动态权重 (审计后的能力升级: 第一项)

审计结论: 选 Key 靠固定评分 + "错了歇一会" 的固定冷却 —— **没有**成功率/延迟驱动的
自适应, **没有**熔断, **没有**跨模型降级。现在补上前两个。

**熔断器 (新增迁移 035 + `src/db/repos/circuitBreaker.ts`)**
- 按 **(Key × 上游模型)** 记状态, 不是按 Key: 一把 Key 在 A 模型上超时, 在 B 模型上完全正常
  (免费聚合渠道尤其如此), Key 级熔断会把好模型一起拖下水。
- `closed → open → half_open` 状态机: 连续 3 次**熔断级失败** (5xx / 429 / 408 / 连接失败;
  4xx 客户端错误与 401/402/403 不算 —— 那些是 Key 级问题, 由冷却和状态机负责) → open,
  本次彻底不参与选池; 到期放**一个**探测请求 (`probe_in_flight_at` 保证同刻只有一个探测,
  60s TTL 防探测位被半死不活的上游永久占住), 成功归零回场, 失败按 30s→1m→2m…退避到 15m 封顶。
- 与既有冷却的分工写进了代码注释: 冷却是硬门槛 (有明确证据), 熔断是软自适应 (不需要读错误文本)。

**EWMA 动态权重**
- `ewma_latency_ms` / `ewma_fail_rate` (alpha=0.3) 替代 Key 级累计平均喂进评分函数的
  `avg_latency_ms` / `success_count` / `failure_count` 三个输入 —— 评分数学没改, 只是
  喂进去的数从"这把 Key 有史以来"变成"这把 Key 对这个模型的最近表现"。
- samples < 2 不参与 (刚上线的一两次采样不左右排序)。
- 半开探测 ×0.3 降权: 只有确实没别的选择时才用它。

实测: 部署后真实流量已经在学 —— key27 / space-bunny EWMA 延迟 2721ms, key17 / 商汤
12294ms (商汤本来就慢, 以前只能靠人工权重猜, 现在系统自己会拉开差距)。

测试: 新增 `test/unit/circuitBreaker.test.ts` 6 例 (阈值熔断 / 单探测位 / 探测成功归零与
失败退避 / 4xx 不熔断 / 按模型隔离 / 熔断出池 + EWMA 降权)。全量 exit=0。

## 成本与配额 — 做完后撤回 (个人自用场景用不到)

这一版先按"付费 Key 也得有账本"的思路做了完整实现 (价格目录 / 成本随请求落库 / 成本看板 /
月日预算硬限 / rpm 限流), 部署验证后被明确否掉: **本项目是纯个人自用, 全部走免费渠道**。
没有付费 Key 就没有成本, 成本看板只会永远是 $0; 而"给自己限额度/限 token"也没有意义 ——
唯一使用者就是自己, 跑飞了自己知道。相应地 `rate_limit_rpm` 也恢复成"存着但不执行"的
历史状态 (那本来就是它的原始状态)。

因此本次撤回: 价格表/成本看板/美元预算的界面与接口、`usage_logs.cost_usd`/`price_ref`、
`hub_keys.daily_budget_usd`/`monthly_budget_usd` 全部移除 (迁移 037 清理 036 建出来的
表与列)。保留的是同一轮里与钱无关的部分: 熔断器 + EWMA (技术稳定性), 以及用量页照旧从
`usage_logs` 实时聚合 (本来就如此, 不依赖被废弃的 `usage_daily`)。

教训: "给多渠道网关加成本核算" 是**面向多用户/多调用方/付费上游**的需求, 不是个人自用
的需求。个人自用真正需要的是**可靠性** (熔断、冷却、故障转移、数据不丢), 那部分本轮做完并保留。


## 迁移台账体检 (审计 P0 项收尾)

审计发现 `schema_migrations` **只按文件名记账, 没有内容指纹**: 已应用的迁移文件被改动后
是**永久 no-op** (改一个 `WHERE` 条件以为修好了, 实际根本不会再执行), 而 `/health` 照样返回
200、部署门禁照样通过。同时台账里"磁盘上已不存在的孤儿行"完全不可见 —— 本项目就藏着 3 条
(历史上 004/005/006 被改名或删除, `scripts/deploy.sh` 里还留着 006 孤儿导致启动崩溃的事故注释)。

现在:
- `schema_migrations` 加 `checksum` 列 (sha256 前 32 位), 新迁移写入指纹; 老库启动时自动补列
  并给每条补记当前指纹 —— 升级无感, 之后就能检测改动。
- 每次启动做台账体检: 已应用文件内容与台账不符 → `modified`; 台账有而磁盘无 → `orphaned`。
- `/health` 暴露 `migrations_modified` / `migrations_orphaned`, 默认**不阻断启动**
  (孤儿行不该让服务起不来), 需要严格门禁时设 `HUB_STRICT_MIGRATIONS=1` 启动即失败。
- 实测当前实例: `migrations_pending=0, migrations_modified=0, migrations_orphaned=3` ——
  那 3 条历史孤儿行第一次变得可见 (先保留不删: 删台账行后若有人恢复同名旧文件, 会触发
  当年 006 那种"迁移重放 → 启动崩"的事故)。

顺带删掉前端 `api.getUsageDaily()`: 它指向的 `/api/admin/usage/daily` 后端**从来没有这个
路由**, 调了必 404。趋势图用的是 `/api/admin/usage/trend`, 本来就从 `usage_logs` 实时聚合。

测试: 新增 `test/unit/migrationIntegrity.test.ts` 4 例 (幂等 / 检测改动 / 检出孤儿行不阻断 /
老库自动补列补记)。全量 exit=0。
## 模型别名 / 虚拟模型接入请求路径 (审计 P1 收尾)

审计 P1 里风险最高的一条: 三套映射设施**都只有管理端 CRUD, 请求路径一个都没读** ——
界面「模型映射」「虚拟模型」配好、预览看着对, 真实请求仍按原名路由; 而用户按别名发请求
必然 400 model_not_found。等于**配得越多越不可用**。现在三套全部接进 `selectFirstCandidate`:

1. **虚拟模型** (`virtual_models` + `model_candidates`): 按 pinned → priority → weight 选候选,
   逐个验证可用性 (冷却/熔断由既有 `selectKeyPool` 判定, 不重写健康逻辑)。
   首选候选被故障转移跳过 → 自动换下一个; 全部不可用 → 报**具体原因** (`虚拟模型 X 没有可用候选
   (上游 Key #7 已禁用; ...)`), 不再是含糊的 model_not_found。
2. **全局别名** (`model_mappings`): 链解析带环检测与 10 跳上限 —— 配出 a→b→a 这种循环时按
   原名处理并告警, 请求不会卡死。管理端「预览」端点改为**复用同一份解析**, 预览所见即所路由。
3. **渠道级** (`channels.model_mapping`): 本渠道把对外名翻译成上游真实名; 支持 JSON 对象与
   `alias=real` 两种写法, 坏 JSON/未配置一律视为"没映射", 不会把请求带崩。
   由 `listKeys()` 同一 join 带出, **零额外查询**。

**两条硬规则 (测试钉死):**
- **只解析单段名**: 带斜杠的是上游字面 ID (`org/model`、三段 pin), 改写它会破坏本轮刚修好的
  字面路由语义 —— 即使同名配了别名也绝不动。
- **没配置 = 零行为变化**: 单段名先做一次 EXISTS 短路, 没命中直接走原路径。

**踩坑一发 (部署门禁救场)**: 新写的 `modelAlias.ts` 相对导入漏了 `.js` 后缀 ——
`tsc --noEmit` 查不出来 (tsconfig 未用 NodeNext), 测试跑 tsx 也能解析, 只有容器启动那一刻
`ERR_MODULE_NOT_FOUND` → 重启循环 → deploy.sh 的 shell 检查拒绝继续, **线上是坏的**。
绕行: 镜像本身多阶段自建 dist, 重建镜像重建容器恢复。已加 `test/unit/esmImports.test.ts`
守门: 扫描 `src/**` 所有相对导入, 缺后缀直接测试失败, 这类"只有容器里才炸"的错误从此进不了提交。

测试: 新增 `modelAlias.test.ts` 15 例 (零变化前提 / 链与环 / 虚拟候选排序与降级 / 渠道映射)
+ `aliasRouting.test.ts` 8 例 (真实 `selectFirstCandidate` 上的端到端选择结果) +
`esmImports.test.ts` 守门。全量 exit=0。

**又踩一坑 (这次是运维层, 恢复服务花了 30 分钟)**: 修完 `.js` 后缀重建镜像后容器仍在
崩溃循环 —— `EACCES /app/data/master.key`。根因是两条**早就埋下**的事实叠加:

1. 之前几轮审计把 Dockerfile 改成 `USER node`(非 root) **一直没真正生效** ——
   `deploy.sh` 只推 dist、从不重建镜像, 线上跑的还是三周前 `USER root` 的旧镜像。
2. 今天第一次真正重建镜像, 容器用户从 root 变成 node(65532), 而数据卷里 `master.key`
   是 `0600 root:root` → 读不到 → 启动即崩。

处置 (保持非 root 硬化, 不回退成 root): 用一次性 root 容器把 `/app/data` 卷与备份目录的
属主全部交给 65532, 宿主备份目录放开权限 → 重启一次即恢复。**教训**: 改 Dockerfile 的
运行用户后, 必须同步处理既有数据卷的属主, 且要知道"推 dist 部署"与"重建镜像"是两件事。

## 部署链路三条缺口收尾 (BACKLOG 遗留)

昨天记录的三条部署缺口一次补齐 —— 它们联手制造了 2026-10-03 的两起线上事故。

**1. Dockerfile 改动不再"静默不生效"**
旧 deploy.sh 只把本地 dist 用 tar 推进"运行中的容器", **从不重建镜像** —— 审计里
"Dockerfile 改非 root" 因此改了三周没生效, 直到有人手动重建镜像, 第一次生效就撞上数据卷
属主问题。新流程每次部署都 `docker compose build` (BuildKit 有缓存, 源码没变时秒过),
Dockerfile / 依赖 / 源码改动一律当次生效, 不再依赖"有人记得重建"。

**2. 运行时 dist 只有镜像里这一份**
旧流程下"容器内 dist"与"镜像 dist"是两份东西: 部署推送只改前者, 容器一旦重建
(force-recreate / 换机 / 宿主重启) 就会**倒回镜像里的旧代码** —— 一次静默回退。
现在 deploy 删掉了"推进容器 + 清残留"整套 (006 孤儿迁移崩溃的根源正是那套残留),
部署后 容器内容 == 镜像内容, 而镜像永远由当次源码构建。崩溃循环的容器也只需
`docker compose up -d` 重建即可恢复 (新流程不再依赖往容器里 exec, 死锁不可能出现)。

**3. 数据卷归属自愈 (`scripts/container-entrypoint.mjs`)**
容器启动时: root → 自动校正 `/app/data` 归属 (容器 UID 变化后 `master.key`/`hub.db`
会 EACCES, 就是昨天的崩溃原因) → **立即降权到 node 用户**再跑服务;
解析不出 node 用户直接拒绝启动 —— **服务进程永远不是 root** (硬约束写在文件头)。
SIGTERM/SIGINT 转发给服务进程, `docker stop` 仍然优雅退出。

实测三连:
- 服务进程 `/proc` 确认 `Uid: 65532` (entrypoint 是 pid 1/root, 服务 pid 非 root);
- 手工把 `master.key` 改回 `0600 root:root` 复现昨天故障 → 重启日志
  "数据卷归属已自动修正 1 项" → **1s 恢复健康**;
- `docker compose up -d --force-recreate` → 健康 + 探针 200/400 正常 (缺口 2 的场景)。

**回滚机制同步更换**: 部署前自动打 `rollback-<ts>` 镜像 tag (保留最近 2 个), 门禁失败
自动打回; 成功输出会打印手动回滚命令。不再有 dist tgz (`.deploy-backups/*.tgz` 是历史遗留)。
README / DEPLOY.md 的部署与回滚说明已同步。

### 全项目审计修复 · 第三轮: 部署 / 镜像 / 文档 / 接口契约 (6 项)

17. **部署回滚改为整目录还原**
    原回滚 `tar -xzf -` 只覆盖"包内有的路径", 本次部署新增的文件不会被删 → 回滚出一个
    既不属于旧版本也不属于新版本的混合 dist (前向路径的"清残留"只在正向跑)。现在解到
    临时目录再整体切换, 回滚后的 dist 就是那个 tgz 的内容。
18. **`engines` 改成 `>=22.5`**
    代码用 Node 22+ 内置 `node:sqlite`, 但 `engines` 和 README 徽章都写 `>=20` ——
    照着装的 Node 20 在 `getDb()` 直接启动失败。
19. **生产镜像以 `node` 用户运行**
    Dockerfile 末尾是 `USER root` (chainguard 基础镜像默认 root), 已改为 `USER node`
    并把 `/app/data`、`/app/dist` 属主交给 node。
20. **USER_GUIDE 的安装步骤原本跑不通**
    它只 `curl` 一个 `docker-compose.yml` 就 `up -d`, 但 compose 是 `build: context: .` ——
    目录里没有 Dockerfile 直接构建失败; 而且数据卷是 `external: true`, 文档从没让用户
    `docker volume create` (README 里有, 两份文档互相矛盾)。已补上建卷步骤并顺延编号。
21. **`/v1/embeddings` 不再把上游失败包装成 200**
    `httpSend` 不会因 4xx/5xx 抛错, 原代码直接 `reply.send(body)` —— 上游 401/429/500
    全部以 HTTP 200 返回给客户端, 而且不记 Key 健康, 失效的嵌入 Key 永远不会被摘掉。
    现在: 透传上游状态码 + `recordUsage` 记 error + 交给 Key 健康逻辑冷却。
22. **`models` 传数组不再毁掉渠道**
    schema 允许 `string[]`, 而 `toStrBody` 会把数组 `JSON.stringify` 成 `'["gpt-4o"]'`
    写进 CSV 列 → 该渠道 100% 路由失败, 界面却一切正常。现在创建/PATCH 都先拍平成 CSV。

测试: `dataRetention.test.ts` 增至 6 例 (新增 models 数组拍平 + PATCH 清空)。全量 exit=0,
前后端 tsc 干净, 部署健康。

### 全项目审计修复 · 第二轮: 数据留存 / 安全 / 接口 / 前端 (9 项)

8. **删 Key 不再抹掉用量历史** (新增迁移 033)
   审计发现删除路径上有 4 处 `DELETE FROM usage_logs WHERE key_id = ?` —— 因为外键是
   NO ACTION 会阻塞删除, 干脆硬删历史。删一把废弃 Key = 这把 Key 名下 (含同 Hub Key 其他
   Key 的) 全部 token/延迟/错误记录不可恢复, 而 `usage_logs` 是唯一的用量记录
   (`usage_daily` / `request_attempts` 都没人写)。迁移重建表, 把 `key_id` / `hub_key_id` /
   `virtual_model_id` / `candidate_id` 都改成 `ON DELETE SET NULL`, 删除路径不再预删。
   实测迁移后 8224 行历史全部保留, 删除后历史行仍在、指针置空。
9. **登录锁定: 锁定期过期即作废计数** (可被永久锁死)
   第 5 次失败后 `attempts` 永远 ≥5, 之后每次失败都立刻重新上锁 15 分钟 —— 任何人每隔
   一会儿试错一次, 就能让这个网关 (只有一个管理员账号) 长期锁在 423 里, 只能改数据库
   恢复。现在锁定期一过, 计数从 0 重新算。顺带把 `ip:<addr>` 维度接进登录校验
   (一直在写却没人读 = 文档里的 IP 限流是死的), 并加 UNIQUE 索引 (迁移 034) + 去重,
   消除并发写各写各的计数。
10. **`listKeys()` 不再是写操作** (每请求抢写锁)
   它在每个请求的路由路径上被调用 (chat/selector/failover), 里面却跑着
   `UPDATE keys ... 'failed 自动回炉'` —— 每个请求抢一次 SQLite 全局写锁。回炉扫描
   独立成 `recoverExpiredFailedKeys()`, 由后台健康检查 (5 分钟一次) 调用。测试同步加了一条
   "listKeys 是纯读"的断言。
11. **备份保留策略不被份数架空**
   `MAX_BACKUPS=7` 无条件截断, `RETENTION_DAYS=30` 形同虚设 —— 实测备份目录 7 份里 4 份是
   同一天。现在兜底上限 90, 并额外"同一天只留最新一份", 把名额让给更早的日期。
12. **分页参数一律 clamp** (`?limit=-1` = 导出全表)
   SQLite 里 `LIMIT -1` 就是不限量, `usage_logs.error_message` 存着上游错误原文。
   `react-compat.ts` / `admin/chat.ts` / `admin/usage.ts` 的 limit 全部夹到 [1,500],
   5 处 days 参数夹到 [1,365]。
13. **流式响应尊重写背压**
   `for await (chunk) reply.raw.write(chunk)` 丢弃 write 返回值, 客户端读得慢时会把整个
   响应以全速堆进 Node 堆内存 —— 一把 Hub Key + 一个慢客户端就能打爆进程。现在
   `write` 返回 false 时 `await once(reply.raw, 'drain')`。
14. **Channel PATCH: "清空"真的清空**
   前端 `x || undefined` + 后端"跳过 undefined" = 清空模型列表/标签/测试模型是**无声的
   不生效**, 却弹"更新成功"。前端改发显式 null, 后端加 `textOrNull()` 归一化
   (`String(null) === 'null'`, 直接 String() 会把 null 写成字符串 "null")。
15. **模型路由支持多通道**
   创建/编辑都只有一个"目标通道 ID"数字框, 保存时 `channel_ids` 被覆盖成单元素 ——
   编辑一次描述就能把多通道路由悄悄塌缩成一个。现在是勾选列表 (不勾 = 任意通道),
   编辑时全量载入原有通道。
16. **冷却 reason 词汇统一** (见上一轮第 7 项, 本轮一并落地 `transient_error`)

**修正一条审计误报**: 子审计报"编辑弹窗的渠道名称写入 label 导致改名无效"—— 实际
`channels` 表**没有** `name` 列, 列表显示的就是 `label`, 改名一直是好的。未改动。

测试: 新增 `test/unit/dataRetention.test.ts` (5 例: 删 Key/删 Hub Key 保留历史 ×2、
锁定过期清零、UNIQUE 索引、PATCH 清空语义), `priorityAndRecovery` 两条回炉测试改为
调用新函数并新增"读路径不写库"断言。全量 exit=0 (15 文件), 前后端 tsc 均干净。

### 全项目审计修复 · 第一轮: 路由正确性 (7 项)

用户要求做**全项目审计** (此前只审了 F1/F2 两个文件)。六个方向并行审计共报 ~30 项,
高危项逐条读代码核实无一虚报, 分批修复。第一轮修路由与冷却的 7 项:

1. **字面量路由认 discovered 证据** (上轮 F2 修复的副作用, 用户实测发现)
   修复前多段模型名 (OpenRouter 的 `org/model`) 只认通道模型列表, 而该列表是人工填的
   —— 实测 OpenRouter 通道 465 个已发现模型里 **453 个不可路由**。现在 discovered_models
   与人工列表等价: `aion-labs/aion-3.0-mini` 实测已能转发到上游。
2. **三段式 `provider/key/model` 真的用指定的 Key**
   之前 pin 的 Key 被 `selectKeyPool` 选出的同通道其他 Key 顶掉 —— "指定付费 Key"
   静默失效 (实测 `sensenova-free/ly/...` 实际打到 `zbs`)。现在只认 pin 的那把。
3. **model 级冷却只作用同模型**
   冷却查询不区分作用域, 于是 A 模型的 429/403 会把该 Key 对**所有**模型停 24h。
   新增 `getCooldownScopeForKey`: key 级 (auth/额度) 仍全局, model 级只作用同模型。
4. **额度封禁按模型记, 且不被任意成功调用抹掉**
   (现场发现的连锁 bug) 原设计里 402 → 整把 Key 封 24h, 而 `keyHealth` 又会在**任意一次
   成功后清除**这条"不可恢复"封禁 —— OpenRouter 这类"免费模型能跑、付费模型 402"的 Key
   于是刚封上就被免费模型的成功解掉, 反复抖动。现在: 封禁记在出错的模型上 (免费模型不受影响),
   成功只清 `recoverable=1` 的冷却; 真余额耗尽会逐模型各记一条, 效果等同整把停用。
5. **400 分类不再误封健康 Key**
   `insufficient`/`rate limit` 这类宽泛词把普通 400 (如 `insufficient permissions`)
   判成额度耗尽 → 24h 永久封禁。现在只认确凿额度字眼; 400 里的限流字眼归 `rate_limit`
   (可恢复阶梯冷却)。
6. **`not a valid model` 认作"模型不存在"**
   OpenRouter 的原话 `X is not a valid model ID` 之前落进客户端错误分支, 不 failover
   直接失败 —— 正是今天排查到的那次故障形态。
7. **冷却 reason 词汇统一**
   `transient` (failover) 与 `transient_error` (keyHealth) 各写各的, `UNIQUE(key_id, reason, model)`
   去不了重, 同一 (Key, 模型) 会存两条冷却。

测试: 新增 `test/unit/cooldownPolicy.test.ts` (3 例), `fallbackPool.test.ts` 补 5 例
(discovered 证据 ×2 / 三段式 pin / 冷却作用域 / 错误分类), 更新 phase2 额度封禁断言。
全量 14 文件 exit=0。实测: discovered 模型可路由 · 免费模型在付费模型欠费时照常可用 · 三条原报错模型行为符合预期。

### 路由修复 第二轮: R1-R6 (2026-10-03, F1/F2 后续)

> 上一轮 F1+F2 收紧了 failover 与斜杠模型 ID, 但线上仍间歇性"大模型连不上"。
> 本轮从候选池构造、Key 选择、冷却作用域、错误分类四处补齐。

- **R1 (resolver.ts / selector.ts / discoveredModels.ts)**: 聚合平台 (商汤等) 实际能跑几十个模型,
  人工「模型列表」往往只填了三五个 → 字面量路由 (OpenRouter `org/model` 形式) 之前只认人工列表,
  大量真实可用模型被误判 `model_not_found`。新增 `getDiscoveredModelKeys()`, 把
  `discovered_models` 的实际发现记录与人工列表**等价**对待: 命中任一证据即可路由
- **R2 (failover.ts)**: 三段式 pin (`provider/key/model`) 之前只是"记下"指定 Key, 实际仍从同通道
  评分选出另一把 → "指定付费 / 独立限流 Key"**静默失效**。现在只认 pin 的那把;
  该 Key 若已被禁用/失败/不在该通道, 给出明确报错而不是悄悄换人
- **R3 (cooldowns.ts / selector.ts)**: 冷却作用域拆分 —— key 级 (auth / 额度耗尽) 对该 Key
  所有模型生效, model 级 (A 模型被限流) **只影响同模型**, 不再连累 B 模型。
  新增 `getCooldownScopeForKey()`, 选 Key 与 multi_key_mode 择优统一改用它
- **R4/R6 (failover.ts `classifyError`)**: 错误分类两处误判, 都会**误封健康 Key**——
  - OpenRouter 的 `X is not a valid model ID` 未被识别 → 当客户端错误直接失败, 不换渠道重试
  - `insufficient` 匹配过宽: `insufficient permissions` 这类普通 400 被判成额度耗尽 → **24h 永久封禁**。
    收窄为 `insufficient balance`, 并把 `rate limit` 独立归到 `rate_limit` (可恢复阶梯冷却, 非永久封)
- **测试**: `test/unit/fallbackPool.test.ts` 补 5 例回归防线 (R1 x2 / R2 / R3 / R4+R6);
  全量单测 141 通过, `tsc --noEmit` 干净
- **现场症状对照**: 部署前线上日志可见 `Key 24h cooldown: quota exhausted` 与 `Key 5min cooldown: 401`
  成片出现 —— 即 R6 误封与 auth 反复触发的直接证据

### 冷却策略: 不可恢复封禁不再被成功调用抹掉 + reason 名归一 (2026-10-03, R7/R8)

> R1-R6 部署后的现场数据发现的新问题: key#27 (openrouter-free) 的 24h 信用封禁
> `started_at=03:26:30.792` / `cleared_at=03:26:31.293` —— **封上 501ms 就被一次
> 成功调用解掉**, 在"封-解"之间反复抖动。

- **R7 (cooldowns.ts / keyHealth.ts)**: 新增 `clearCooldownIfRecoverable()`,
  成功调用只清 `recoverable=1` 的冷却。24h 信用封禁 (`recoverable=0`) 改走
  自然过期 / 探针 / 手动恢复 —— 因为"某次成功"并不能证明余额回来了: OpenRouter 这类
  **混搭 Key** 免费模型照样成功、付费模型仍 402, 用成功去解封会让它在封与解之间反复抖动。
  替换掉原先无条件 `clearCooldown(keyId,'quota',...)` 的 F9 逻辑
- **R8 (failover.ts)**: `handleFailure` 写的 reason 名 `'transient'` 与 keyHealth 的
  `'transient_error'` 不一致 → 同一个 (key, model) 因两个 reason 名各写一行冷却,
  `UNIQUE(key_id, reason, model)` 去不了重, 阶梯升级被稀释。统一为 `'transient_error'`
  (即 `cooldowns.ts` 头部注释早已声明的规范名, 本次让代码对齐自己的契约)
- **测试**: 新增 `test/unit/cooldownPolicy.test.ts` (2 例) —— 不可恢复封禁不被成功清除 /
  可恢复照常清; model 级不连累其他模型 / key 级全模型生效。全量单测 143 通过, `tsc --noEmit` 干净

### 部署踩坑两则 (2026-10-03)

- **"连不上"的真正原因**: R1-R6 写完且测试全绿, 但**既没提交也没部署**, 线上镜像
  `freellm-hub-v2:latest` 仍是 3 天前的构建 (停在 38b651f)。代码是对的, 只是没上线 ——
  所以症状表现为间歇性抽风而非彻底断, 排查时容易误判成上游或平台的问题
- **构建静默失败**: `docker compose build hub` 实际失败, 却被
  `... 2>&1 | tail -30 && echo "BUILD OK"` 盖掉了退出码并打印假成功。真实原因是默认
  builder `mybuilder` (`docker-container` 驱动) 处于 `inactive`, 启动它要拉
  `moby/buildkit:buildx-stable-1` 而本机网络超时。改用 `default` (`docker` 驱动,
  daemon 侧已配 registry-mirrors) 构建成功。注意 `buildkitd.toml` 的 mirrors 配置
  **对 `docker-container` 驱动不生效**, 指望它兜底会再次踩坑
- **来源不明的并发写入**: 提交 R1-R6 之后, `cooldowns.ts` / `failover.ts` /
  `keyHealth.ts` + 新增 `cooldownPolicy.test.ts` 于 03:29:04 被另一会话写入。
  核验其完整、测试全绿、reason 名归一无孤儿引用后一并收尾提交 (b5a10a6),
  但**提交他人半成品 / 漏提交 / 互相覆盖**的风险已记入 `docs/BACKLOG.md`
- **回滚点**: 两次部署前的库快照留存在 `.deploy-backups/`
  (`hub-pre-R1R6-20261003-032830.db` / `hub-pre-R7R8-20261003-033439.db`),
  每次 `docker compose up -d --force-recreate` 前后各留一份

### 渠道模型挑选: 三处入口补全 (2026-10-03)

- **新建向导** (cf95d70): 「自动获取」不再一次性灌入几百个模型, 改为可搜索挑选弹窗 — 已有模型默认勾上 (标"已有"), 支持搜索 / 全选筛选项 / 反选 / 清空, 只应用勾选项
- **编辑弹窗**: 新增「模型列表」区 (此前只能看测试模型下拉, 无法改) — 可手动编辑, 点「获取并筛选」用渠道已有 Key 探测上游并弹同一挑选窗
- **列表行「发现模型」按钮**: 从 alert 提示升级为挑选弹窗, 应用后直接 PATCH 保存该渠道 `models` — 清理被灌爆的渠道三次点击完成
- **实现**: 抽出共用 `ModelPickerModal` 组件三处复用, 删除创建弹窗内联重复代码; `tsc`(双端) / `vite build` / 健康门禁全绿

### 免费渠道对表 freellm.net (2026-10-03, 用户拍板执行)

- **来源**: freellm.net (488 模型 / 30 提供商 / 每日核验) 及其开源仓库 `open-free-llm-api/awesome-freellm-apis` 的官方端点速查表
- **新增 7 个免费提供商**: 阿里云百炼 (国内站, 国际站写入备注)、SambaNova、Chutes.ai、AI21 Labs、Nscale、Nebius 等; xAI / DeepSeek 已有条目不重复建; 全部端点冒烟实测通过
- **停用 4 个问题条目**: GitHub Models (2026-07-30 官方退役)、Cloudflare 重复导入条目 (保留 id63)、Glhf.chat (本机仅 IPv6 解析且无 v6 路由)、Cohere Trial (全路径 403 疑似地区拦截, 有可用 key 验证后再启用)
- **可疑端点实测**: SiliconFlow 切国内站 `api.siliconflow.cn/v1` (0.05s vs `.com` 1.97s, 两站账号不通用已备注); Kilo 两种写法均 200 → 不动
- **结果**: 启用中免费提供商 47 → **50**; `providers` 表改动前全表快照 `.pw-rollback/providers_before.json` (600)

### 路由修复: failover 跨通道乱砸 + 斜杠模型 ID 误判 (2026-10-03, F1+F2, 含一轮自审)

- **现象**: 商汤上游超时后请求被 failover 扔给小米 MIMO / OpenRouter 通道 → `Unsupported model` / `is not a valid model ID` 等迷惑报错; `stealth/space-bunny-alpha` 直接 503 `Provider 'stealth' 下没有可用 Key`
- **F1 (failover.ts / selector.ts)**: 废除两处 "any enabled key" 退化 — 精确候选池不可用时只兜底到"模型列表显式含该模型 (或列表为空=通配)"的通道; 配了 model_routes 的模型全程限定在路由通道内, 越界即明确报错
- **F2 (resolver.ts)**: 斜杠前缀只有在真实存在同名提供商**且有可用 Key** 时才按 `provider/model` 指定语义解析; 否则按完整字面量在通道模型列表精确匹配 — OpenRouter 的 org/model 形式 ID 直接可用
- **自审发现并补上的缺口**: 我们预置的 provider 名与 OpenRouter 组织名有 10 个完全相同 (openai / anthropic / google / deepseek / cohere / minimax / openrouter / perplexity / fireworks / aion-labs, 均无 Key), 第一版 F2 会被 pin 分支劫持并报错 → 补充"pin 找不到 Key 就落到字面量", `openrouter/free`、`deepseek/…` 一类 ID 恢复可用; provider 有 Key 时 pin 语义不变
- **旁路确认**: images / audio 端点不走 failover (单 Key 一次调用), 无跨通道风险; chat 流式与非流式共用 selectFirstCandidate, 均被 F1 覆盖
- **数据核查**: discovered_models 无跨通道污染 (0 条); 483 行"通道列表外"记录是商汤 ch15 真实提供的聚合模型 (deepseek-flash / kimi-k3 等), 属有效证据, 保留
- **测试**: 新增 `test/unit/fallbackPool.test.ts` (4 例) + resolver 新增 4 例 (字面量精确匹配 / 撞名回退 / pin 优先); 全量套件 exit 0
- **实测**: `stealth/space-bunny-alpha` 200 / `openrouter/free` 200 / `sensenova-6.8-flash-lite` 200 / 未配模型快速 400 model_not_found

### 作业机制: docs/BACKLOG.md 落盘 (2026-10-03, 用户选 A)

- 已拍板未动工事项从对话记忆移入仓库文件; 规则: 点名执行 → 完成进 CHANGELOG → 清单划掉

## [开发中 / 迭代记录] - 2026-09-22 ~ 2026-09-30

> 本节为 2026-09 迭代的过程记录 (按时间倒序), 来自四审计批量修复、用户拍板决策与线上故障处置。

### 发布前整备: GitHub 就绪审计 (2026-09-30)

- **测试可移植性**: 8 个测试文件里写死的本机绝对路径全部改为相对导入, `ROOT` 常量改由 `import.meta.url` 推导 — 别人克隆后 `npm test` 才跑得起来
- **Docker 自包含**: Dockerfile 不再 COPY 本机 node_modules (克隆下来的仓库没有它, 构建必挂) → 构建阶段 `npm ci`, builder 编译后 `npm prune --omit=dev`, 生产阶段跨阶段复用; .dockerignore 排除依赖与构建产物
- **lockfile 归一化**: 根 package-lock 中 1 处 `@fastify/cors` 的 resolved 指向 npmmirror, 容器内 npm ci 报 EALLOWREMOTE → 统一官方源 (宿主机镜像配置对官方源透明改写, 不受影响)
- **前端类型修复**: `ModelRoute.channel_ids` 如实标注 (响应=JSON 字符串 / 请求=number[]), API.tsx errText 收敛 — `tsc && vite build` 恢复全绿
- **去本机化**: compose 端口/备份目录参数化 (新增 `.env.example`, 本机 `.env` 已 gitignore), deploy.sh 健康检查端口读 .env (默认 3030), vite 开发代理默认 3030
- **文档替换**: README / INSTALL / DEPLOY / RESTORE / USER_GUIDE / ARCHITECTURE / SECURITY 中的 3303、/vol1 私有路径、不存在的 ghcr 镜像与 docker pull 全部替换为源码构建流程; 快速开始改为 git clone + docker compose
- **发布物**: README 双语升级 (bcrypt→Argon2id 事实修正 + 告警/一键部署特性), `docs/product/index.html` 中英双语产品介绍单页

### 废弃代码与残留清理 (2026-09-30, 用户拍板后执行)

#### 清理前三路备份 (用户要求"先备份避免误操作")
- git tag + branch `pre-cleanup-20260929` → fd206bc
- 磁盘快照 `freellm-snapshot-pre-cleanup-20260929-235022.tar.gz` (12M, 仓库外, 含 .git)
- 镜像 tag `freellm-hub-v2:pre-cleanup-20260929`; 数据库按备份策略自动留存

#### A. 容器运行时残留 11 个 (最危险, 直接清)
- `db/migrations/006_model_routes.sql` —— 早被删除的迁移文件还躺在容器 dist 里, 就是它曾被重放导致启动崩溃
- `004_seed_providers.sql` / `005_channel_newapi_fields.sql` 同类孤儿; `db/migrations/runner.ts` (源文件混进 dist)
- `services/videoService.{js,d.ts,js.map}` —— 模块早删, 编译产物还在跑
- AppleDouble 垃圾 `._assets` / `._index.html`; `public/css/app.css.bak`
- 清理后镜像重新固化 (docker commit)

#### B. 部署清残留防线 (根因修复)
- deploy.sh 推送后新增: 删除容器 dist 里"本地已不存在"的文件 (白名单 package.json; 两侧 LC_ALL=C 排序防 collation 误判)
- 根因: `tar 推送` 只增不删, 删掉的文件会永远躺在容器里

#### C. dist/package.json 版本读取 (本轮引入又当场修掉)
- 清理时误删了容器里的 dist/package.json → /health 版本变成 unknown
- 根治: copy-assets 把 package.json 复制进 dist/ 成为单一来源, 每次推送都带
- 验证: version 恢复 2.0.0

#### D. 死代码: 22 个零引用导出函数/常量, 308 行, 14 个文件
- 判据: 跨全仓库 (src/前端/test/scripts) 零引用 **且** 同文件内部也零使用; notifier 的测试钩子核实仍被测试引用 → 未删
- 涉及 channels/providers/discoveredModels/kek/adminAuth/selector/openai/usageService/requestTracking/cache/tags/degradation/probe/keyHealth
- 顺带清 1 个孤儿 import (`createHash`)
- 验证: tsc 0 错误, npm test 240 通过 / 0 失败, 线上聊天 200 + 大请求 200

#### E. 仓库垃圾
- 删除 12 个 AppleDouble `._*` 文件; .gitignore 加 `._*`
- 剩余 2 个 dist/assets/._* 属 li 用户所有, 无权限删 (下次构建自然消失)
- 回滚点仅 2 个无需清理; TODO/FIXME 零个

#### 有意保留 (核实过不是废弃)
- 50 个 TS 类型/接口零引用 —— 接口文档性质
- `src/services/degradation.ts` 仍被 backgroundJobs 调 (updateDegradationState)
- `@fastify/rate-limit` 依赖已装未用 —— 留作全局限流, 删了以后还要装回来
- `src/public/js/admin-common.js` + `css/app.css` —— layout.ts 的 COMMON_SCRIPTS 正在引用
- `src/public/admin/` —— 正在跑的后台 UI 构建产物

---

### 用户拍板三件套落地 (failed回炉 / priority看状态 / 备份外置+演练)

#### ① failed 键 30 分钟自动回炉
- listKeys 读路径懒恢复: status=failed 且锁满30分钟 (COALESCE(status_since, updated_at)) → degraded + 清零连续失败计数 + 回炉原因
- 任何入口 (resolver/后台/UI) 读到即恢复; 探测成功本来就可立即恢复 (既有逻辑保留)
- failed 告警文案同步改为"30分钟后自动回炉"
- 单测3例 + 线上实测 (强制failed+31min → listKeys → degraded/count=0)

#### ② priority 策略照常看状态 (方案 a)
- 手动排序只在"干净" key 之间生效; 冷却中或配额<20% 的 key 自动靠后 (不移除)
- Dashboard 选项文案: "手动排序 (优先级为主, 冷却/低额度自动靠后)"
- 单测4例 + 线上冒烟 (切priority聊天200, 已还原balanced)

#### ③ 备份外置 + 恢复演练
- docker-compose.yml: 新增宿主机挂载 hub-backups → /app/backups + HUB_BACKUP_DIR; **卷名必须 external:true** (裸名被 compose 加项目前缀曾短暂指向空卷 — 已修正、数据完好核验 hub_keys2/channels5/keys9/usage_logs9418)
- 容器经 docker commit 固化现有代码后由 compose 重建 (stop_grace_period:60s 与 TZ 同时生效; 镜像 tag backup-precompose 留作回滚)
- 演练通过: 备份三件套 → 独立容器1秒健康 → 数据计数一致 → master.key 解密 OK → 清理
- 新增 docs/RESTORE.md 恢复手册 (含验证清单与注意事项)

#### 验证
- npm test 全绿 (exit 0); deploy.sh 部署1秒过门禁; 聊天200; 备份已落卷外目录

---

### 线上故障修复: 护栏输入过滤误杀大上下文 (用户报告)

- **现象**: 用户全部调用报"供应商错误"; 实测小请求200、大请求400 `输入内容超过最大长度限制 (15000 > 8000)`
- **根因**: 护栏行 `enabled=1, input_filter=1, max_input_length=8000` 是历史"测试护栏"配置, 且 `checkInputContent` 此前零调用点=从未生效; B10 契约修复把它接入 chatService 入口后, 该配置**首次真实生效** → 所有>8000字符的 agent/大上下文请求被400拦截
- **处置**: `input_filter=0` (恢复到修复前的实际行为; 行、关键词、限长配置原样保留, 后台"内容护栏"页可随时再开)
- **验证**: 15000字符非流式200 / 屏蔽词内容200 / 20000+字符流式200
- **教训**: 部署清单里标注过"护栏生效属行为变化"的风险, 但最终报告未向用户明示 — 已写入此记录

---

### 设计改进 #1/#2: 告警通知 + 一键部署 (本轮)

#### #1 关键事件 → Webhook 告警 (此前系统没有任何通知机制, 键全死也没人知道)
- 新增 `notifierService`: settings.notify_webhook_url / 环境变量 HUB_NOTIFY_WEBHOOK 配置; 载荷按 URL 自动识别 (飞书/企业微信/钉钉/通用 JSON); 同 dedupKey 10 分钟去重; 通知是旁路, 失败只记日志绝不影响主流程
- 告警事件: key 被标记 failed (resolver 永久跳过前让人知道) / 上游401 / 额度耗尽 / 全部 Key 不可用 (5分钟健康检查发现) / 备份失败
- Admin API: GET/PUT `/api/admin/notify/config` + POST `/api/admin/notify/test` (均需登录)
- Dashboard 新增「告警通知 (Webhook)」卡片: 填地址 → 保存 → 发送测试
- 验证: 单测8例全绿; 线上 E2E 容器→宿主机 webhook 实测送达+去重+配置读写
- 设计说明: `notify()` 读 settings 是运行时热配置, 页面保存后立即生效, 无需重启

#### #2 一键部署 `scripts/deploy.sh` (手工 docker cp 时代结束, 孤儿迁移事故根因封堵)
- 流程: 干净构建(tsc+vite+同步静态) → **dist 与 src 迁移清单一致性校验 (孤儿文件防线, 违背即拒绝部署)** → 备份容器当前 dist 到 .deploy-backups/ (回滚点) → 清前端缓存目录再推送 → 重启 → /health 门禁 (healthy + migrations_pending=0, 30s) → 失败自动回滚并重启
- 首次实战即通过 (1 秒过门禁)
- git 初始化: baseline `93ea180`, .gitignore 已含 data//master.key/构建产物/回滚点 (暂存区验证无密钥)

---

### 四审计批量修复 (安全 / 运维 / 路由 / 前后端契约)

四个只读审计 agent 并行审查后的修复批量; 全部经 npm test 全绿 (exit 0)。

#### 安全 (已在线复现的先修)
- **F1 CRITICAL 百分号编码绕过鉴权** — hooks 用原始 `req.url` 判 `/v1/` 前缀而 Fastify 按解码路径匹配, `POST /%761/chat/completions` 未鉴权直通; chat.ts/embeddings.ts 改用 `req.routeOptions?.url`; responses.ts 从"Bearer 存在即可"升级为真实 requireHubKey
- **F2 HIGH probe 接口无鉴权** — `POST /api/admin/probe/:keyId` + `/probe-all` 补 admin session 校验
- **F6 MEDIUM 视频任务 IDOR** — `GET /v1/videos/tasks/:taskId` 补 hub_key 所属校验 (旧数据 hub_key_id=null 放行)
- **F11 responses usage 全 NULL** — hubKeyId 改读 `req.hubKey.id`
- **F13 SECURITY.md** — 修正 bcrypt→argon2id、hub_keys 明文列、无 CSRF token、rate_limit_rpm 未执行等失实声明

#### 运维可靠性
- **进程兜底** — server.ts 加 unhandledRejection(记录保活) / uncaughtException(明确退出由 docker 拉起); backgroundJobs 全部 interval 回调包 try/catch — 之前一个 DB 抖动就是进程直接退出 (线上16:13事故同类)
- **启动 fail-fast** — 监听前 getDb()+迁移+master.key 校验; 迁移失败不再表现为"健康但全500"
- **防静默换钥** — master.key 缺失但库内有加密 Key 时拒绝生成新钥 (拒绝启动)
- **备份补全** — 每次备份旁复制 master.key + session.secret (恢复 hub.db 没有它=上游Key全废); HUB_BACKUP_DIR 支持外置目录; 启动5s后即跑一次备份+清理 (原来只挂24h定时器, 频繁重启=永远不备份)
- **清理补全** — runLogCleanup 增加: 过期 cooldowns 删除 (原来无限膨胀, key23 曾堆1955行) + login_attempts 24h 清理
- **/health 深检** — quick_check + 迁移待办数, 异常返回503 (原来纯静态字面量, DB挂了也200)
- **cooldowns 哨兵** — key 级行 upstream_model NULL→'' (迁移032); UNIQUE 冲突真正生效, upsert 不再每次插一行; recoverable MAX→MIN (权威行不再被探测清掉); started_at 随刷新 (探测半衰期按最后写入)
- **docker-compose 对齐** — named volume 替代陈旧 ./data 绑定 (仓库 data 的 master.key 与容器卷不同!); stop_grace_period 60s; 移除会让日志变 JSON 的 NODE_ENV

#### 路由正确性 (routing 审计 F1-F21 的 HIGH/MED)
- **F1 model_routes 渠道序生效** — 非流式路径补 preferredChannelId (原 resolver 选定渠道被丢弃); applyMultiKeyMode 单 key 渠道也提升 (原 `group.length<=1` 提前返回)
- **F2 非流式错误语义** — 全部失败时返回最后错误分类 (原恒为 no_candidates→客户端一律404, 与流式502/429不一致); phase2 断言改为 auth_invalid (与其标题一致)
- **F3 同 key 重试复活** — maxRetriesPerKey 原是死配置 (retry=0 必 break); 现 5xx/网络同 key 重试1次, 404/400 类确定性错误不浪费重试
- **F4 禁用渠道即刻停路由** — listKeys 暴露 channel_enabled, resolver 三层 + selector SQL/回退全加 `ch.enabled=1` (原来只关渠道开关, key 继续接活)
- **F5 403 跳过范围** — 单 key 档位403 只跳该 key (原 state.models 全局跳, 一次403杀光跨渠道 failover)
- **F6 Retry-After 生效** — classifyError 增加 headers 参数, 权威冷却从死代码变可用
- **F7 流式成功清 ladder** — 原来只有非流式清429计数, 纯流式服务 cooldown 稳定爬24h
- **F9 quota 恢复** — 成功即清 quota cooldown (原要等24h自然过期)
- **F11 流头超时** — timeoutMs 0→30s (原 undici headersTimeout 禁用, 上游不回包=永久挂起)
- **F12 解密异常兜底** — getDecryptedApiKey 抛错按 key_auth 跳过+5min冷却 (原直接500且不计失败)
- **F13/F14 multi_key_mode** — 渠道内按 key id 稳定排序 (sticky 原来≈random); 全渠道冷却不做提升
- **F19 Anthropic 配额头** — quotaTracker 识别 anthropic-ratelimit-* (原 Anthropic 渠道配额比永远观测不到)

#### 前后端契约 (contract 审计 breaks-user-flow)
- B1 通道启停 enabled 数字→boolean 兼容 (上批); B2 create-key models:null 兼容 (上批); B9 tag 编辑落库 (上批)
- **B3/B4/L4 ModelRoutes 整页对齐后端** — 原来永远400 (发 model_pattern 等后端不存在的字段); 现映射 request_model/channel_ids/notes; 列表渲染真实 channel_ids; 删除后端不存的 priority/key 伪字段
- **B5/B6 Usage 页** — 失败表原恒空 (status===0 vs TEXT 'error'); CSV/model列改读 request_model/prompt_tokens/completion_tokens; usage/logs 后端 LEFT JOIN 带出 channel_id
- **B7 Chat 页恒401** — 直连 /v1 无 Hub Key header; 改走 /api/admin/chat/test-completion (session)
- **B8 登录错误体** — 401 先读后抛 (原 锁号提示/剩余次数 全丢, 只显示 Unauthorized); 423 同样处理
- **B10 护栏输入侧接入** — checkInputContent 原零调用; 现挂 chatService 入口, /v1 chat+messages+responses 全覆盖 (输出侧未接)
- L2 priority/weight 输入加0-100/1-100钳制; L3 hub-keys expires_in_days 兼容 null; L7/N7 错误信封 string/.message 双兼容; L9 Profile 密码规则对齐服务端 (10+字母+数字); L10 capabilities 字段名; N5 TTS 错误解析 JSON; N6 json() 加 catch

#### 已知未修 (报告待决策)
- F11b fallback_config/model_mappings/virtual_models/channel.model_mapping 配置页对请求路径零影响 (整个特性未接线, 接线是设计决策)
- B11 同上 (Fallback 页)
- 平台级跳过仍过激 (单 provider 下第一个5xx后同渠道兄弟 key 不再试; F3 已修同 key 重试)
- rate_limit_rpm 仅存储不执行; status=failed 解析器硬封锁可永久锁死 (models_path 异常时); priority 策略绕过全部护栏; 输出护栏未接

---

### 本次会话更新日志

#### Schema 迁移 (已应用)
- 028 — Xiaomi MiMo 初始 3 个独立
- 029 — 合并 + plans JSON 列
- 030 — 清理 (groq-cloud, SenseNova 分类)
- 031 — MiMo plans notes 清理

#### 路由四大 Bug 修复 (本轮)
- **#1 in-flight 排序方向反了** — failover.ts 里 idle-first 排序 (b-a), 原来 a-b 反而优先挑最忙的
- **#2 流式无 failover** — chatStream 重写为与非流式同构的重试循环: 连接失败/非 2xx 分类后按 skip 三层换 key/渠道, 流开始 (2xx 首包) 后不再切换
- **#3 multi_key_mode 死配置** — selector 新增 applyMultiKeyMode (random/polling/sequential/sticky), failover 选池后生效; UI 增加 Sticky 选项
- **#4 配额护栏硬编码** — 新增 quotaTracker (rate-limit 头 → 10min TTL 内存比值), rankPool 接入 remaining_quota_ratio; scorer 加冷却护栏 cooldown_remaining>0 → ×0.2

#### 评分排序配对 Bug (#5, 本轮最大发现)
- rankPool 排序后用 keys[i] 对齐排序下标 → 分数与 key 错位, **评分路由从未生效过** (顺序永远=输入序)
- 修复: 按 key_id Map 回配; 此后 Thompson 探索/冷却降权/配额护栏才真正影响选 key 顺序
- 测试确定性: phase2/integration 固定 routing_strategy=priority + polling 模式

#### 保存失败修复
- 限制可用模型保存: 前端发 `enabled:1` (数字), UpdateKeySchema 要求 boolean → 400
- 修复: z.union([boolean, int0|1]); multi_key_mode enum 补 polling/sticky

#### 统计计数修复
- 双记: failover.ts httpSend 已内部记 usage 又手动记 → tryOnce 改传 null
- probe 从不记统计 (被双记掩盖): probeKey 补 recordKeyUsage, 新增 updateStatus:false 只计数不碰 status

#### e2e 契约修复 (既有断裂, 与本轮改动无关的先坏的)
- POST /api/admin/channels 响应补顶层 channel_id/key_id/channel{base_url}
- hub-keys 响应补 camelCase 别名 plainKey (create/regenerate)
- hub-keys toggle 补顶层 enabled 布尔值
- integration: failure_count 期望2→1 (原2 双记凑出来的)
- 结果: **npm test 全绿 (113 单测 + 14 e2e suites)**

#### Backend
- providers.repo: plans + helpers
- validation: plan_id, provider_id 兼容
- channels.ts: plan_id → base_url 覆盖
- discoveredModels.repo: delete 同时清理 channels.models + keys.allowed_models + hub_keys.allowed_models
- resolver: isKeyEligibleForModel 导出; selectKeyPool/selectCandidatePool 强制 allowed_models 过滤

#### Frontend
- api.ts: Provider.plans, ProviderPlan 接口; deleteFailedModels 双计数; updateKey enabled 支持数字
- Channels.tsx: 套餐下拉 (URL/prefix 去掉); 清理失败模型四行统计; multi_key_mode Sticky 选项
- BenchmarkModal: 样式统一
- index.css: form 字体继承

#### Provider: 65 / Channel: 5

---

## [v2.0.0] - 2026-09-19

首个正式发布版。从内测版 (v1.x) 演进而来，包含完整功能集与生产化加固。

### 核心网关功能

- **多 Provider 路由**: OpenAI / Anthropic / Gemini / Mistral / DeepSeek / Moonshot / 智谱 / 硅基流动 / 商汤 / Agnes / MiniMax / Cohere 等统一接入
- **故障转移 (Fallback)**: 主模型 → 备用模型链，支持顺序 / 加权 / 优先级三种策略，可配置最大重试次数与间隔
- **Cooldown 机制**: 上游 429/5xx 自动冷却，1 分钟探测早恢复，避免雪崩
- **全局降级 (Degradation)**: 实时计算健康 key 比例，自动进入 / 退出降级状态
- **请求追踪**: 每次请求写入 `usage_logs` + `request_attempts`，完整记录重试链

### 模型路由

- **模型映射**: 请求模型名 → 上游模型名，支持链式映射 (A→B→C)，实时预览解析结果
- **虚拟模型**: 一个虚拟模型挂多个上游候选 (Key + 模型 + 优先级 + 权重 + 置顶)
- **模型路由**: 按请求模型配置 channel 列表 (顺序 = failover 顺序)

### 安全 & 权限

- **Admin 鉴权**: bcrypt 密码哈希 + SQLite session 存储，7 天过期
- **Hub Key 鉴权**: API Key 加密存储 (`AES-256-GCM` + master key)
- **Per-Channel-Key 模型白名单**: 每个上游 Key 可限定服务哪些模型
- **Per-Hub-Key 模型白名单**: 每个客户端 Key 可限定调用哪些模型
- **内容护栏 (Guardrails)**: 输入 / 输出过滤、关键词拦截、PII 检测、长度限制
- **登录限流**: 5 次 / 3 分钟 (配置可调)

### 性能与稳定性

- **响应缓存**: 相同 (model + messages) 命中后直接返回，可配置 TTL
- **Hub Key 鉴权在配额检查之前**: 拒绝的请求不消耗上游 quota
- **故障 Key 自动隔离**: 上游错误自动封禁 (heuristic vs authoritative)
- **请求级超时**: 所有上游调用 `AbortSignal.timeout()` 强制超时
- **优雅停机**: SIGTERM/SIGINT → 停后台任务 → 关 HTTP → 关 DB
- **全局错误处理**: 5xx 记录日志 + 返回通用错误，避免泄露内部信息

### 多模态

- **文生图 / 图生图**: OpenAI / Agnes / MiniMax / DeepSeek / Stability 等
- **文生视频 / 图生视频**: MiniMax (Hailuo 2.3) / Agnes (v2.0/2.5)
- **视频任务轮询**: `GET /v1/videos/tasks/:taskId` 查询异步任务状态 + 取回结果
- **语音合成 (TTS) / 语音转文字 (STT)**: 通过 `/v1/audio/*`
- **Embeddings**: 统一的向量嵌入接口

### 管理后台

完整的 React SPA (14 个页面)，全部移动端适配、暗色模式、代码分割懒加载：

| 页面 | 路由 | 功能 |
|---|---|---|
| 总览 | `/admin/dashboard` | 系统状态、24h 请求趋势、路由策略 |
| 渠道管理 | `/admin/channels` | 渠道 CRUD、Key CRUD、批量操作、模型测速、Probe |
| 模型路由 | `/admin/routes` | 路由规则 CRUD |
| 虚拟模型 | `/admin/virtual-models` | 虚拟模型 + 候选管理 |
| 模型映射 | `/admin/mappings` | 模型别名映射 + 链式预览 |
| Hub Keys | `/admin/hub-keys` | 客户端 Key 管理 + 模型白名单 |
| 故障转移 | `/admin/fallback` | 主备模型链配置 |
| 用量统计 | `/admin/usage` | 总览 / 模型统计 / 渠道统计 / 错误分析 / 日志明细 |
| 内容护栏 | `/admin/guardrails` | 过滤规则配置 |
| 响应缓存 | `/admin/cache` | 缓存开关 + 命中率 + 清理 |
| 测试场 | `/admin/playground` | 多轮对话 |
| 聊天 | `/admin/chat` | 多对话管理 |
| API 测试 | `/admin/api` | 全部 `/v1/*` 接口在线测试 |
| 个人资料 | `/admin/profile` | 修改密码 |

### 部署运维

- **Docker**: 单镜像部署，多阶段构建 (client-builder → builder → production)
- **数据持久化**: `data/` volume 挂载 (SQLite + master key + session secret)
- **数据库自动备份**: VACUUM INTO 每天备份一次，最多保留 7 份 / 30 天
- **日志自动清理**: 每天清理 90 天前的 `usage_logs` / `media_tasks` / `request_attempts`
- **健康检查**: Docker 内置 healthcheck (基于 Node http 调用)
- **运维接口**: `GET /api/admin/backup` 列备份、`POST /api/admin/backup` 立即触发
- **CORS**: `/v1/*` 允许跨域 (Origin 反射 + 凭证支持)
- **环境变量**: 所有配置集中在 `src/config/env.ts`

### 客户端 API

完整的 OpenAI 兼容 + Anthropic 兼容 + Responses API：

| 端点 | 兼容性 |
|---|---|
| `POST /v1/chat/completions` | OpenAI |
| `POST /v1/messages` | Anthropic |
| `POST /v1/responses` | OpenAI Responses |
| `POST /v1/embeddings` | OpenAI |
| `POST /v1/images/generations` | OpenAI |
| `POST /v1/images/edits` | OpenAI |
| `POST /v1/audio/speech` | OpenAI TTS |
| `POST /v1/audio/transcriptions` | OpenAI Whisper |
| `POST /v1/videos/generations` | 自定义 (MiniMax / Agnes) |
| `POST /v1/videos/edits` | 自定义 (MiniMax / Agnes) |
| `GET /v1/videos/tasks/:taskId` | 视频任务轮询 |
| `GET /v1/models` | OpenAI |

### 已知限制

- **MiniMax API**: 旧版 `sk-cp-` key 无任务查询权限，提示 `2013 access denied` (上游限制，非代码问题)
- **Agnes 免费层**: 限流较严 (429 rate_limit_exceeded)
- **API 文档**: 无内置 OpenAPI/Swagger，需参考此 CHANGELOG 或源码

### 升级说明

从 v1.x 升级：
1. 备份现有 `data/` 目录
2. 拉取新镜像 `freellm-hub-v2:v2.0.0`
3. 启动容器并挂载 `data/` volume
4. 首次启动会自动执行数据库迁移 (26 个 migration 文件)
5. 旧的 session secret 不兼容，所有 admin 需重新登录

### 镜像标签

- `freellm-hub-v2:latest` - 始终指向最新稳定版
- `freellm-hub-v2:stable` - 锁定为最后一个经过验证的稳定版
- `freellm-hub-v2:v2.0.0` - 锁定 v2.0.0 版本 (当前发布版)
