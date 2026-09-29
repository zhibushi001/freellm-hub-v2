## 用户拍板三件套落地 (failed回炉 / priority看状态 / 备份外置+演练)

### ① failed 键 30 分钟自动回炉
- listKeys 读路径懒恢复: status=failed 且锁满30分钟 (COALESCE(status_since, updated_at)) → degraded + 清零连续失败计数 + 回炉原因
- 任何入口 (resolver/后台/UI) 读到即恢复; 探测成功本来就可立即恢复 (既有逻辑保留)
- failed 告警文案同步改为"30分钟后自动回炉"
- 单测3例 + 线上实测 (强制failed+31min → listKeys → degraded/count=0)

### ② priority 策略照常看状态 (方案 a)
- 手动排序只在"干净" key 之间生效; 冷却中或配额<20% 的 key 自动靠后 (不移除)
- Dashboard 选项文案: "手动排序 (优先级为主, 冷却/低额度自动靠后)"
- 单测4例 + 线上冒烟 (切priority聊天200, 已还原balanced)

### ③ 备份外置 + 恢复演练
- docker-compose.yml: 新增宿主机挂载 hub-backups → /app/backups + HUB_BACKUP_DIR; **卷名必须 external:true** (裸名被 compose 加项目前缀曾短暂指向空卷 — 已修正、数据完好核验 hub_keys2/channels5/keys9/usage_logs9418)
- 容器经 docker commit 固化现有代码后由 compose 重建 (stop_grace_period:60s 与 TZ 同时生效; 镜像 tag backup-precompose 留作回滚)
- 演练通过: 备份三件套 → 独立容器1秒健康 → 数据计数一致 → master.key 解密 OK → 清理
- 新增 docs/RESTORE.md 恢复手册 (含验证清单与注意事项)

### 验证
- npm test 全绿 (exit 0); deploy.sh 部署1秒过门禁; 聊天200; 备份已落卷外目录

---

## 线上故障修复: 护栏输入过滤误杀大上下文 (用户报告)

- **现象**: 用户全部调用报"供应商错误"; 实测小请求200、大请求400 `输入内容超过最大长度限制 (15000 > 8000)`
- **根因**: 护栏行 `enabled=1, input_filter=1, max_input_length=8000` 是历史"测试护栏"配置, 且 `checkInputContent` 此前零调用点=从未生效; B10 契约修复把它接入 chatService 入口后, 该配置**首次真实生效** → 所有>8000字符的 agent/大上下文请求被400拦截
- **处置**: `input_filter=0` (恢复到修复前的实际行为; 行、关键词、限长配置原样保留, 后台"内容护栏"页可随时再开)
- **验证**: 15000字符非流式200 / 屏蔽词内容200 / 20000+字符流式200
- **教训**: 部署清单里标注过"护栏生效属行为变化"的风险, 但最终报告未向用户明示 — 已写入此记录

---

## 设计改进 #1/#2: 告警通知 + 一键部署 (本轮)

### #1 关键事件 → Webhook 告警 (此前系统没有任何通知机制, 键全死也没人知道)
- 新增 `notifierService`: settings.notify_webhook_url / 环境变量 HUB_NOTIFY_WEBHOOK 配置; 载荷按 URL 自动识别 (飞书/企业微信/钉钉/通用 JSON); 同 dedupKey 10 分钟去重; 通知是旁路, 失败只记日志绝不影响主流程
- 告警事件: key 被标记 failed (resolver 永久跳过前让人知道) / 上游401 / 额度耗尽 / 全部 Key 不可用 (5分钟健康检查发现) / 备份失败
- Admin API: GET/PUT `/api/admin/notify/config` + POST `/api/admin/notify/test` (均需登录)
- Dashboard 新增「告警通知 (Webhook)」卡片: 填地址 → 保存 → 发送测试
- 验证: 单测8例全绿; 线上 E2E 容器→宿主机 webhook 实测送达+去重+配置读写
- 设计说明: `notify()` 读 settings 是运行时热配置, 页面保存后立即生效, 无需重启

### #2 一键部署 `scripts/deploy.sh` (手工 docker cp 时代结束, 孤儿迁移事故根因封堵)
- 流程: 干净构建(tsc+vite+同步静态) → **dist 与 src 迁移清单一致性校验 (孤儿文件防线, 违背即拒绝部署)** → 备份容器当前 dist 到 .deploy-backups/ (回滚点) → 清前端缓存目录再推送 → 重启 → /health 门禁 (healthy + migrations_pending=0, 30s) → 失败自动回滚并重启
- 首次实战即通过 (1 秒过门禁)
- git 初始化: baseline `93ea180`, .gitignore 已含 data//master.key/构建产物/回滚点 (暂存区验证无密钥)

---

## 四审计批量修复 (安全 / 运维 / 路由 / 前后端契约)

四个只读审计 agent 并行审查后的修复批量; 全部经 npm test 全绿 (exit 0)。

### 安全 (已在线复现的先修)
- **F1 CRITICAL 百分号编码绕过鉴权** — hooks 用原始 `req.url` 判 `/v1/` 前缀而 Fastify 按解码路径匹配, `POST /%761/chat/completions` 未鉴权直通; chat.ts/embeddings.ts 改用 `req.routeOptions?.url`; responses.ts 从"Bearer 存在即可"升级为真实 requireHubKey
- **F2 HIGH probe 接口无鉴权** — `POST /api/admin/probe/:keyId` + `/probe-all` 补 admin session 校验
- **F6 MEDIUM 视频任务 IDOR** — `GET /v1/videos/tasks/:taskId` 补 hub_key 所属校验 (旧数据 hub_key_id=null 放行)
- **F11 responses usage 全 NULL** — hubKeyId 改读 `req.hubKey.id`
- **F13 SECURITY.md** — 修正 bcrypt→argon2id、hub_keys 明文列、无 CSRF token、rate_limit_rpm 未执行等失实声明

### 运维可靠性
- **进程兜底** — server.ts 加 unhandledRejection(记录保活) / uncaughtException(明确退出由 docker 拉起); backgroundJobs 全部 interval 回调包 try/catch — 之前一个 DB 抖动就是进程直接退出 (线上16:13事故同类)
- **启动 fail-fast** — 监听前 getDb()+迁移+master.key 校验; 迁移失败不再表现为"健康但全500"
- **防静默换钥** — master.key 缺失但库内有加密 Key 时拒绝生成新钥 (拒绝启动)
- **备份补全** — 每次备份旁复制 master.key + session.secret (恢复 hub.db 没有它=上游Key全废); HUB_BACKUP_DIR 支持外置目录; 启动5s后即跑一次备份+清理 (原来只挂24h定时器, 频繁重启=永远不备份)
- **清理补全** — runLogCleanup 增加: 过期 cooldowns 删除 (原来无限膨胀, key23 曾堆1955行) + login_attempts 24h 清理
- **/health 深检** — quick_check + 迁移待办数, 异常返回503 (原来纯静态字面量, DB挂了也200)
- **cooldowns 哨兵** — key 级行 upstream_model NULL→'' (迁移032); UNIQUE 冲突真正生效, upsert 不再每次插一行; recoverable MAX→MIN (权威行不再被探测清掉); started_at 随刷新 (探测半衰期按最后写入)
- **docker-compose 对齐** — named volume 替代陈旧 ./data 绑定 (仓库 data 的 master.key 与容器卷不同!); stop_grace_period 60s; 移除会让日志变 JSON 的 NODE_ENV

### 路由正确性 (routing 审计 F1-F21 的 HIGH/MED)
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

### 前后端契约 (contract 审计 breaks-user-flow)
- B1 通道启停 enabled 数字→boolean 兼容 (上批); B2 create-key models:null 兼容 (上批); B9 tag 编辑落库 (上批)
- **B3/B4/L4 ModelRoutes 整页对齐后端** — 原来永远400 (发 model_pattern 等后端不存在的字段); 现映射 request_model/channel_ids/notes; 列表渲染真实 channel_ids; 删除后端不存的 priority/key 伪字段
- **B5/B6 Usage 页** — 失败表原恒空 (status===0 vs TEXT 'error'); CSV/model列改读 request_model/prompt_tokens/completion_tokens; usage/logs 后端 LEFT JOIN 带出 channel_id
- **B7 Chat 页恒401** — 直连 /v1 无 Hub Key header; 改走 /api/admin/chat/test-completion (session)
- **B8 登录错误体** — 401 先读后抛 (原 锁号提示/剩余次数 全丢, 只显示 Unauthorized); 423 同样处理
- **B10 护栏输入侧接入** — checkInputContent 原零调用; 现挂 chatService 入口, /v1 chat+messages+responses 全覆盖 (输出侧未接)
- L2 priority/weight 输入加0-100/1-100钳制; L3 hub-keys expires_in_days 兼容 null; L7/N7 错误信封 string/.message 双兼容; L9 Profile 密码规则对齐服务端 (10+字母+数字); L10 capabilities 字段名; N5 TTS 错误解析 JSON; N6 json() 加 catch

### 已知未修 (报告待决策)
- F11b fallback_config/model_mappings/virtual_models/channel.model_mapping 配置页对请求路径零影响 (整个特性未接线, 接线是设计决策)
- B11 同上 (Fallback 页)
- 平台级跳过仍过激 (单 provider 下第一个5xx后同渠道兄弟 key 不再试; F3 已修同 key 重试)
- rate_limit_rpm 仅存储不执行; status=failed 解析器硬封锁可永久锁死 (models_path 异常时); priority 策略绕过全部护栏; 输出护栏未接

---

## 本次会话更新日志

### Schema 迁移 (已应用)
- 028 — Xiaomi MiMo 初始 3 个独立
- 029 — 合并 + plans JSON 列
- 030 — 清理 (groq-cloud, SenseNova 分类)
- 031 — MiMo plans notes 清理

### 路由四大 Bug 修复 (本轮)
- **#1 in-flight 排序方向反了** — failover.ts 里 idle-first 排序 (b-a), 原来 a-b 反而优先挑最忙的
- **#2 流式无 failover** — chatStream 重写为与非流式同构的重试循环: 连接失败/非 2xx 分类后按 skip 三层换 key/渠道, 流开始 (2xx 首包) 后不再切换
- **#3 multi_key_mode 死配置** — selector 新增 applyMultiKeyMode (random/polling/sequential/sticky), failover 选池后生效; UI 增加 Sticky 选项
- **#4 配额护栏硬编码** — 新增 quotaTracker (rate-limit 头 → 10min TTL 内存比值), rankPool 接入 remaining_quota_ratio; scorer 加冷却护栏 cooldown_remaining>0 → ×0.2

### 评分排序配对 Bug (#5, 本轮最大发现)
- rankPool 排序后用 keys[i] 对齐排序下标 → 分数与 key 错位, **评分路由从未生效过** (顺序永远=输入序)
- 修复: 按 key_id Map 回配; 此后 Thompson 探索/冷却降权/配额护栏才真正影响选 key 顺序
- 测试确定性: phase2/integration 固定 routing_strategy=priority + polling 模式

### 保存失败修复
- 限制可用模型保存: 前端发 `enabled:1` (数字), UpdateKeySchema 要求 boolean → 400
- 修复: z.union([boolean, int0|1]); multi_key_mode enum 补 polling/sticky

### 统计计数修复
- 双记: failover.ts httpSend 已内部记 usage 又手动记 → tryOnce 改传 null
- probe 从不记统计 (被双记掩盖): probeKey 补 recordKeyUsage, 新增 updateStatus:false 只计数不碰 status

### e2e 契约修复 (既有断裂, 与本轮改动无关的先坏的)
- POST /api/admin/channels 响应补顶层 channel_id/key_id/channel{base_url}
- hub-keys 响应补 camelCase 别名 plainKey (create/regenerate)
- hub-keys toggle 补顶层 enabled 布尔值
- integration: failure_count 期望2→1 (原2 双记凑出来的)
- 结果: **npm test 全绿 (113 单测 + 14 e2e suites)**

### Backend
- providers.repo: plans + helpers
- validation: plan_id, provider_id 兼容
- channels.ts: plan_id → base_url 覆盖
- discoveredModels.repo: delete 同时清理 channels.models + keys.allowed_models + hub_keys.allowed_models
- resolver: isKeyEligibleForModel 导出; selectKeyPool/selectCandidatePool 强制 allowed_models 过滤

### Frontend
- api.ts: Provider.plans, ProviderPlan 接口; deleteFailedModels 双计数; updateKey enabled 支持数字
- Channels.tsx: 套餐下拉 (URL/prefix 去掉); 清理失败模型四行统计; multi_key_mode Sticky 选项
- BenchmarkModal: 样式统一
- index.css: form 字体继承

### Provider: 65 / Channel: 5