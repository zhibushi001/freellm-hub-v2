# Changelog

所有本项目的显著变更都记录在此。格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。


## [开发中 / 迭代记录] - 2026-10-01 ~ 2026-10-03

> 模型挑选弹窗三处入口补全、免费渠道对表 freellm.net、可疑端点实测、BACKLOG 作业清单落盘。

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
