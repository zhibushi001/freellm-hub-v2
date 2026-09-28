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