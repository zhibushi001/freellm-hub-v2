# FreeLLM Hub v2 架构与二次开发指南

> 目标读者: 想基于此项目二次开发或贡献代码的工程师  
> 阅读时间: 30 分钟  
> 推荐先看: [README.md](./README.md) + [DEPLOY.md](./DEPLOY.md) 了解"它是什么 / 怎么跑"

---

## 一、TL;DR — 一句话架构

**Fastify (Node 22+)** 后端 + **React + Vite** 前端 + **SQLite (node:sqlite)** 单文件 DB. 一个 `/v1/chat/completions` 请求进来 → 鉴权 → 解析 model → 在 Pool 里挑一个 healthy key → 转发给上游 → 失败分类 → 写 cooldown → 换 key 重试 → 全失败才返回错误.

**核心设计原则**: **不存用户对话数据**, 只是个"协议网关 + 路由网关". 客户端 SDK (OpenAI / Anthropic / Responses) → 我们的 hub → 真实上游 (MiniMax/SenseNova/Agnes/MiniMax/etc).

---

## 二、目录速览

```
freellm-hub-v2/
├── src/                       # 后端 (Node + TypeScript + Fastify)
│   ├── server.ts             # 入口; 启 buildApp + 启后台任务 + 注册 graceful shutdown
│   ├── app.ts                # 路由注册 (client + admin), 中间件, setErrorHandler
│   │
│   ├── auth/                  # 鉴权
│   │   ├── adminAuth.ts       # admin 登录 + 改密 (bcrypt + argon2)
│   │   ├── hubKeyAuth.ts      # Hub Key 鉴权 (authenticateHubKey + 模型白名单)
│   │   └── sessionStore.ts    # SQLite-backed session 存储 (替代默认内存)
│   │
│   ├── config/
│   │   └── env.ts             # 集中读取环境变量 (process.env.*)
│   │
│   ├── crypto/
│   │   ├── kek.ts             # Master Key 派生 (PBKDF2 → AES key)
│   │   ├── apiKeyCrypto.ts     # 上游 API Key 加密 / 解密 (AES-256-GCM)
│   │   └── password.ts        # 管理员密码 hash (argon2id)
│   │
│   ├── db/
│   │   ├── connection.ts      # 单例 node:sqlite DatabaseSync; WAL mode
│   │   ├── migrations/        # 27 个迁移, 按文件名顺序执行
│   │   └── repos/             # 13 个 repo (每个表一个文件), 纯 SQL 查询
│   │       ├── channels.ts, keys.ts, hubKeys.ts, providers.ts,
│   │       ├── cooldowns.ts (轮询熔断), sessions.ts,
│   │       ├── usageLogs.ts, requestAttempts.ts,
│   │       └── ...
│   │
│   ├── http/
│   │   ├── client/           # 客户端 API 路由 (/v1/chat/completions 等)
│   │   │   ├── chat.ts        # OpenAI 兼容 + /v1/models
│   │   │   ├── anthropic.ts   # /v1/messages (Claude 兼容)
│   │   │   ├── responses.ts   # /v1/responses (OpenAI Responses API)
│   │   │   ├── images.ts      # /v1/images/generations, /v1/images/edits
│   │   │   ├── audio.ts       # /v1/audio/speech, /v1/audio/transcriptions
│   │   │   ├── embeddings.ts  # /v1/embeddings
│   │   │   └── video.ts       # /v1/videos/generations, /v1/videos/tasks/:taskId
│   │   ├── admin/            # 后台管理 API (需 admin session)
│   │   │   ├── channels.ts, keys.ts, hubKeys.ts
│   │   │   ├── usage.ts (用量统计)
│   │   │   ├── cache.ts (响应缓存管理)
│   │   │   ├── modelMappings.ts, virtualModels.ts, modelRoutes.ts
│   │   │   ├── fallback.ts, guardrails.ts
│   │   │   ├── requestTracking.ts
│   │   │   └── ...
│   │   └── validation.ts      # 所有 admin 接口的 zod schema 集中点
│   │
│   ├── routing/               # 请求路由核心
│   │   ├── resolver.ts       # model 字符串 → (key, upstreamModel) 对
│   │   ├── scorer.ts         # 评分 (in-flight penalty 等)
│   │   ├── selector.ts        # 候选池选择 (selectCandidatePool)
│   │   └── failover.ts        # 主循环: 选 key → 失败分类 → cooldown → 换 key 重试
│   │
│   ├── services/              # 业务逻辑层
│   │   ├── chatService.ts     # chatCompletion + chatStream
│   │   ├── backgroundJobs.ts  # 健康检查 + cooldown 探测 + 日志清理 + DB 备份
│   │   ├── keyHealth.ts       # 状态机 (healthy / degraded / failed)
│   │   ├── degradation.ts     # 全局降级状态机
│   │   ├── cacheService.ts    # 响应缓存 (model + messages hash)
│   │   ├── guardrailsService.ts
│   │   ├── usageStatsService.ts
│   │   ├── mediaService.ts    # MiniMax / Agnes 视频生成适配器
│   │   ├── conversationService.ts
│   │   └── ...
│   │
│   ├── adapters/              # 上游 Provider 协议适配器
│   │   ├── client.ts          # 底层 HTTP (fetch + AbortSignal)
│   │   ├── openai.ts          # OpenAI 格式构造 (buildUpstreamRequest/Url)
│   │   ├── anthropic.ts       # Anthropic 格式 ↔ OpenAI 格式互转
│   │   ├── anthropicTools.ts  # Anthropic tool_use ↔ OpenAI tool_calls
│   │   └── responses.ts       # OpenAI Responses API 适配
│   │
│   ├── providers/             # 上游 provider 元数据 (16+ 个, 见 providers 表)
│   │
│   ├── util/                  # 工具
│   │   ├── logger.ts          # pino 结构化日志
│   │   ├── body.ts            # body 解析工具
│   │   ├── endpoints.ts       # API 文档元数据
│   │   └── json.ts            # parseJsonSafe (统一 JSON 解析)
│   │
│   └── views/                 # SSR 老式 HTML 页面 (登录/setup 等)
│
├── freellm-hub-client/        # 前端 (React 18 + Vite + Tailwind)
│   └── src/
│       ├── api.ts             # 后端 API 客户端 (类型 + fetch 封装)
│       ├── App.tsx            # 路由 + Auth Guard
│       ├── components/
│       │   └── Layout.tsx     # 侧边栏 + header + footer (全局布局)
│       └── pages/             # 14 个页面 (按路由 1 文件 1 页)
│           ├── Login.tsx
│           ├── Dashboard.tsx
│           ├── Channels.tsx
│           ├── HubKeys.tsx
│           ├── ModelRoutes.tsx
│           ├── VirtualModels.tsx
│           ├── ModelMappings.tsx
│           ├── Fallback.tsx
│           ├── Usage.tsx
│           ├── Playground.tsx
│           ├── Chat.tsx
│           ├── API.tsx
│           ├── Guardrails.tsx
│           ├── Cache.tsx
│           └── Profile.tsx
│
├── scripts/                   # 构建 / DB 备份 / Docker
│   └── copy-assets.mjs        # 把前端的 dist/ 拷到后端的 dist/public/admin
│
├── Dockerfile                 # 三阶段构建: client-builder → builder → production
├── docker-compose.yml
├── package.json
├── package-lock.json
└── tsconfig.json
```

---

## 三、一次请求的生命周期 (核心)

以 `POST /v1/chat/completions` 为例:

```
1. authenticateHubKey (src/auth/hubKeyAuth.ts)
   ├─ 检查 Authorization: Bearer fh_xxx
   ├─ SHA-256 哈希 → 查 hub_keys 表
   ├─ 校验 enabled, expires_at, allowed_models
   └─ req.hubKey = {id, name, prefix, allowed_models}

2. POST /v1/chat/completions 路由 (src/http/client/chat.ts:98)
   ├─ 校验 body.model, body.messages
   └─ 调 chatCompletion(body, hubKey.id)

3. chatCompletion (src/services/chatService.ts)
   └─ 调 chatWithFailover (主循环)

4. chatWithFailover (src/routing/failover.ts)
   for attempt in 1..maxCandidates:
     ├─ selectFirstCandidate → 选 (key, upstreamModel) 对
     ├─ tryOnce: buildUpstreamUrl + buildUpstreamRequest + httpSend
     ├─ 收到上游响应 → classifyError(status, body)
     │   ├─ 401       → key_auth     → skipKey + 5min cooldown → continue
     │   ├─ 402/quota → key_quota    → skipKey + 24h cooldown → continue
     │   ├─ 403       → key_tier     → skipModel 24h cooldown
     │   ├─ 429       → rate_limit   → skipKey + escalation ladder
     │   ├─ 5xx       → provider_error → skipPlatform 30s
     │   ├─ 400 "invalid_request_error" → provider_error (NEW: 试下一个 key)
     │   └─ 400 + missing/required/must be → client_error (真正的请求错)
     └─ decision:
         ├─ 'continue'   → 跳到下一个候选
         ├─ 'stop'       → 没有候选了 → 返回 error
         └─ 'onFatal'     → 立即返回错误 (4xx 真错)

5. 返回结果
   ├─ success → 透传上游 body, 加 X-Hub-* headers
   ├─ model_not_found → 400 + 提示模型不存在
   └─ 全失败 → 最后一个错误
```

---

## 四、关键数据模型 (28 张表)

只列二开最常碰的几张 (完整 SQL 在 `src/db/migrations/`):

### `channels` — 上游 Provider 渠道
```sql
CREATE TABLE channels (
  id, provider_id, label, enabled,
  base_url (运行时 join providers 算), api_path, models_path,
  weight, priority, tag,
  models TEXT (逗号分隔, e.g. "gpt-4o,claude-3.5"),
  capabilities JSON (chat/image/video/...),
  multi_key_mode TEXT (random/round_robin/priority)
);
```

### `keys` — 上游 API Key
```sql
CREATE TABLE keys (
  id, channel_id, label, enabled,
  status TEXT (healthy / degraded / failed),
  api_key_enc TEXT (AES-256-GCM 加密),
  rpm_used, rpd_used, tpm_used, tpd_used, -- 限流追踪
  success_count, failure_count, last_used_at
);
```

### `hub_keys` — 客户端 Key
```sql
CREATE TABLE hub_keys (
  id, key_hash (SHA-256), key_prefix, name,
  enabled, rate_limit_rpm, expires_at,
  allowed_models TEXT (JSON 数组, null=不限制)
);
```

### `cooldowns` — 熔断状态
```sql
CREATE TABLE cooldowns (
  key_id, upstream_model (null = 该 key 全部 model),
  reason (auth/quota/tier/rate_limit/transient),
  source (heuristic/credit/tier/authoritative),
  recoverable, expires_at, created_at
);
-- 同请求内不写; 跨请求才写
```

### `usage_logs` — 调用记录 (P50/P95/慢请求查询的数据源)
```sql
CREATE TABLE usage_logs (
  hub_key_id, virtual_model_id, candidate_id, key_id,
  provider_name, request_model, routed_model,
  prompt_tokens, completion_tokens, total_tokens,
  latency_ms, status (success/error),
  error_code, error_type, error_message,
  stream, created_at
);
```

---

## 五、扩展点 — 想加新东西改哪里

| 想做的事 | 改哪里 | 难度 |
|---|---|---|
| 加新上游 Provider (e.g. Anthropic 直连) | `src/db/migrations/` 加 seed provider + `src/adapters/` 加 adapter | 中 |
| 加新的 client API 端点 (e.g. /v1/audio) | 新建 `src/http/client/foo.ts`, 在 `src/app.ts` `registerClientRoutes(foo)` | 低 |
| 加新的 admin 后台页 | 新建 `src/http/admin/foo.ts` + `freellm-hub-client/src/pages/Foo.tsx` + `src/App.tsx` 加路由 + `components/Layout.tsx` 加 navItem | 低 |
| 改 Failover 策略 (e.g. 加 latency 权重) | `src/routing/{resolver,selector,failover}.ts` | 中 |
| 加新的错误分类 (e.g. 5xx 细分) | `src/routing/failover.ts: classifyError` 加 case, `handleFailure` 加对应分支 | 低 |
| 加新的后台任务 (e.g. 配额告警) | `src/services/backgroundJobs.ts` | 低 |
| 改缓存策略 | `src/services/cacheService.ts` | 中 |
| 改鉴权 (e.g. 加 OAuth) | `src/auth/adminAuth.ts` | 中 |
| 改前端布局/主题 | `freellm-hub-client/src/components/Layout.tsx` + `src/index.css` | 低 |

---

## 六、添加新上游 Provider (完整示例)

假设加 "Anthropic" 直连作为新渠道.

### Step 1: 数据库 seed

新建迁移 `src/db/migrations/028_anthropic_provider.sql`:

```sql
INSERT OR IGNORE INTO providers
  (name, display_name, base_url, protocol, api_path, models_path, signup_url, docs_url, notes, enabled, is_free, category)
VALUES
  ('anthropic-direct', 'Anthropic Direct', 'https://api.anthropic.com',
   'anthropic', '/v1/messages', '/v1/models',
   'https://console.anthropic.com', 'https://docs.anthropic.com',
   '直连 Anthropic API', 1, 0, 'paid');
```

### Step 2: 添加 Adapter

新建 `src/adapters/anthropic-direct.ts`:

```ts
import type { KeyWithChannel } from '../db/repos/keys.js';

export interface AnthropicChatRequest {
  model: string;
  messages: { role: string; content: string }[];
  max_tokens?: number;
  temperature?: number;
  system?: string;
  [k: string]: any;
}

export function buildAnthropicRequest(
  clientRequest: any,
  upstreamModel: string,
): AnthropicChatRequest {
  // OpenAI messages → Anthropic (system 单独, 没有 system role message)
  const systemMsg = clientRequest.messages?.find((m: any) => m.role === 'system');
  const userMsgs = clientRequest.messages?.filter((m: any) => m.role !== 'system') ?? [];
  return {
    model: upstreamModel,
    system: systemMsg?.content,
    messages: userMsgs.map((m: any) => ({ role: m.role, content: m.content })),
    max_tokens: clientRequest.max_tokens ?? 1024,
    temperature: clientRequest.temperature,
  };
}
```

### Step 3: 注册路由

在 `src/http/client/anthropic.ts` 加 `app.post('/v1/anthropic-direct/messages', ...)`, 复用 anthropic adapter 即可.

### Step 4: 后台配置

1. 启 hub → `/admin/channels` → 选 "Anthropic Direct" → 填 API Key
2. 设 `models: claude-3.5-sonnet,claude-3-haiku`

---

## 七、Failover 行为详解 (写测试前必读)

### 错误分类 (src/routing/failover.ts: 94-152)

| 上游返回 | 分类 | 行为 |
|---|---|---|
| 401 Unauthorized | `key_auth` | skipKey + **5min heuristic** cooldown → continue |
| 402 / "insufficient_quota" / "balance" / "credit" | `key_quota` | skipKey + **24h credit** cooldown → continue (重试该 key 必失败) |
| 403 | `key_tier` | skipModel (不是换 key, 是该 key 不支持该 model) + 24h cooldown |
| 404 | `provider_error` | skipPlatform 30s cooldown → continue |
| 400 + "unknown model" / "model not found" | `provider_error` | skipPlatform → continue |
| 400 + "balance" / "credit" / "quota" / "rate limit" | `key_quota` | skipKey + 24h cooldown → continue |
| 400 + `error.type === "invalid_request_error"` 且无 client_error 关键词 | `provider_error` | skipPlatform → continue (NEW) |
| 400 + "missing" / "required" / "must be" / "invalid parameter" | `client_error` | **不重试**, 立即返回 400 |
| 413 | `context_too_large` | skipModel (所有 key 都装不下) → continue |
| 429 | `rate_limit` | skipKey + 90s heuristic 或 Retry-After → continue |
| 5xx | `provider_error` | skipPlatform 30s + local endpoint 5s → continue |
| 200 | - | success |

### 429 升级阶梯 (rate limit escalation ladder)

如果同一 key 反复 429, cooldown 时长会逐级升级:
```
90s (heuristic) → 5min → 30min → 2h → 24h
```
由 `src/routing/failover.ts: handleFailure` case 'rate_limit' 计算.

### 同请求内 retry 机制

```
同一次 chatWithFailover 调用:
  for i = 0..maxCandidates:     // 默认 5 (config.maxCandidates)
    ├─ selectFirstCandidate(...) → (key, upstreamModel)
    ├─ tryOnce → classifyError → handleFailure → decision
    │   ├─ 'continue':  break retry loop → 试下一个 candidate
    │   ├─ 'stop':      跳出外层, 返回最后的错
    │   └─ 'onFatal':   立即返回错 (4xx 真的错)
    └─ retry 同一个 key (最多 maxRetriesPerKey=2 次, 仅 5xx/网络)

跨请求: cooldown 表记住每个 (key, model) 的状态
```

---

## 八、前端二次开发要点

### 路由结构 (src/App.tsx)
```
/login                  → pages/Login.tsx
/admin/*                → Layout.tsx (带 sidebar 的所有后台页)
  /admin/dashboard
  /admin/channels
  /admin/hub-keys
  /admin/routes
  /admin/virtual-models
  /admin/mappings
  /admin/fallback
  /admin/usage
  /admin/playground
  /admin/chat
  /admin/api
  /admin/guardrails
  /admin/cache
  /admin/profile
```

加新页的 4 步:
1. `src/http/admin/foo.ts` — zod schema + handler (admin 路由)
2. `freellm-hub-client/src/api.ts` — 加 `getFoo()` 方法
3. `freellm-hub-client/src/pages/Foo.tsx` — UI
4. `src/App.tsx` — `<Route path="foo" element={<Foo />} />` + `src/components/Layout.tsx` 加 navItem

### 主题/移动端

所有 `*.tsx` 页面都应该遵循:
- **响应式**: `grid-cols-1 sm:grid-cols-2 lg:grid-cols-4` (堆叠 → 双列 → 四列)
- **暗色模式**: `dark:` 前缀 (Tailwind 自动)
- **flex 容器**: 子元素加 `min-w-0` + `shrink-0` (防溢出)
- **移动端优先**: 小屏先写, 桌面端用 `md:` `lg:` 扩展
- **图标**: `lucide-react`, `<Icon size={18} />`
- **颜色**: 蓝色 `indigo-500/600`, 绿 `emerald-500`, 红 `red-500`, 灰 `slate-*`

### 性能 / 调试技巧

- DevTools Network 面板看 `/api/admin/*` 请求 — 所有都带 `Set-Cookie: hub_session`
- React DevTools 看组件 re-render (Sidebar 应该只 re-render 在 sidebarOpen 改变时)
- 移动端调试: Chrome DevTools → Toggle Device Toolbar → iPhone 12 Pro
- 后端 log: `docker logs -f freellm-hub | pino-pretty` (pino 自动格式化)

---

## 九、常见定制场景速查

### 9.1 想给某个模型加额外参数 (e.g. DeepSeek 加 `top_p` 默认 0.95)

`src/http/client/chat.ts:98` 路由处理 body 处, 或 `src/services/chatService.ts: chatCompletion`:

```ts
const upstreamReq = {
  ...body,
  model: resolved.upstreamModel,
  // 模型级默认值
  ...(resolved.upstreamModel.startsWith('deepseek-') && { top_p: 0.95 }),
};
```

### 9.2 想加一个 /v1/messages (Anthropic) 之外的协议, e.g. Google Gemini

新建 `src/adapters/gemini.ts`, 在 `src/http/client/gemini.ts` 注册:

```ts
app.post('/v1/gemini/generate', async (req, reply) => {
  // ... 转 Gemini 协议
});
```

在 `src/app.ts` 加 `await registerGeminiRoutes(app)`.

### 9.3 想改 cooldown 时长

`src/routing/failover.ts: handleFailure` 各 case 里改 `durationMs`. 也可在 `src/config/env.ts` 加 `process.env.HUB_COOLDOWN_*` 变量.

### 9.4 想限流 (rate_limit)

`src/db/repos/keys.ts` 已跟踪 `rpm_used/rpd_used/tpm_used/tpd_used`. 加上 middleware 就行:

```ts
// src/middleware/rateLimit.ts (新文件)
import { FastifyRequest } from 'fastify';

export async function rateLimitMiddleware(req: FastifyRequest) {
  if (!req.hubKey) return;
  // 检查当前分钟 / 天 / 月用量
  // 超出 → 抛 429
}
```

在 `src/http/client/chat.ts:98` 加 `preHandler: rateLimitMiddleware`.

### 9.5 想加 Prometheus / OTLP metrics

新建 `src/util/metrics.ts` (用 prom-client), 在关键路径 `incrementCounter('chat_requests', {model, status})`, 暴露 `/metrics` endpoint.

### 9.6 想换数据库 (Postgres)

`src/db/connection.ts` 换成 pg.Pool, `src/db/repos/*.ts` 改 SQL (sqlite → postgres 语法), 改 `src/db/migrations/runner.ts`. 工作量大, 但因为用了纯 SQL 不难.

---

## 十、部署 + 调试速查

```bash
# 查看日志
docker logs -f freellm-hub | pino-pretty

# 看 cooldown
docker exec freellm-hub node -e "
const db = require('node:sqlite');
const d = new db.DatabaseSync('/app/data/hub.db');
for (const c of d.prepare('SELECT * FROM cooldowns WHERE expires_at > ? ORDER BY expires_at DESC LIMIT 20').all(Date.now())) {
  console.log(c.key_id, c.reason, c.upstream_model, Math.round((c.expires_at - Date.now())/1000) + 's');
}
"

# 看 slow requests (P95)
docker exec freellm-hub node -e "
const db = require('node:sqlite');
const d = new db.DatabaseSync('/app/data/hub.db');
const arr = d.prepare('SELECT latency_ms FROM usage_logs WHERE latency_ms IS NOT NULL ORDER BY latency_ms ASC').all().map(r => r.latency_ms);
console.log('P50:', arr[Math.floor(arr.length*0.5)], 'P95:', arr[Math.floor(arr.length*0.95)]);
"

# 健康检查
curl http://localhost:3303/health

# 触发 DB 备份
curl -X POST -H "Cookie: hub_session=$COOKIE" http://localhost:3303/api/admin/backup
```

---

## 十一、测试

```bash
# 单元测试 (独立测试 class)
cd test/unit && npm test

# E2E 测试 (启 docker, 跑完整请求)
cd test/e2e && npm test

# 手动集成测试脚本
node --import tsx --test test/integration/failover.test.ts
```

`src/db/migrations/` 加新表后, 必须重启 hub 让 migration 自动跑.

---

## 十二、版本约定

| 部分 | 版本约定 |
|---|---|
| 后端 API | OpenAI v1 (`/v1/chat/completions` 等) + Anthropic Messages API |
| 模型名 | `provider/model` 形式 (e.g. `minimax/MiniMax-M3`) 或纯模型名 (自动匹配) |
| 错误码 | OpenAI 兼容: `invalid_request_error`, `authentication_error`, `rate_limit_error` 等 |
| API Key 格式 | Hub Key: `fh_<64hex>`. 上游 Key: 各 provider 原生格式 |
| 数据库迁移 | `NNN_description.sql`, 严格按编号顺序, 永不删除历史迁移 |
| 前端 API | REST + JSON, 类型在 `freellm-hub-client/src/api.ts` 集中定义 |

---

## 十三、代码风格

- **TypeScript strict mode**, 不用 `any` (尽量用 `unknown` + 类型守卫)
- **后端**: ES module (`.js` 后缀导入, 即使源码是 `.ts`)
- **前端**: `React.createElement(...)`, 不用 JSX (Vite 不编译)
- **命名**: 函数 camelCase, 类型/接口 PascalCase, 常量 UPPER_SNAKE
- **错误处理**: 永远 catch + log + 友好错误响应, 不静默吞
- **日志**: 用 `logger.info({model, status})` 而不是 `console.log`
- **PR 前**: 跑 `npm run build` 确保 TS 通过, 跑测试, 跑 `docker build` 确保镜像能 build

---

## 十四、Roadmap (v2.1+)

| 功能 | 优先级 | 工作量 |
|---|---|---|
| OpenAPI/Swagger 文档 | 高 | 中 |
| Prometheus metrics | 中 | 中 |
| IP 白名单 / 地域限制 (Hub Key) | 中 | 低 |
| 配额告警邮件 (P0-4 后台) | 中 | 低 |
| Hub Key 自动轮询 (round_robin) | 低 | 低 |
| 批量导入 Hub Key | 低 | 低 |
| 模型成本分析 (按 USD 折算) | 低 | 中 |
| Admin SSO / OAuth | 低 | 中 |

---

## 十五、FAQ

**Q: 为什么用 SQLite 不上 Postgres?**
A: 个人 / 小团队场景 SQLite 足够 (单文件, 零运维, 性能足够百万级调用). 上 Postgres 是配置 `HUB_DATABASE_URL=postgres://...` + 替换 `src/db/connection.ts` 即可.

**Q: 为什么用 Fastify 不上 Express?**
A: Fastify 原生支持 async/await, schema validation 更快, 内置 logging. 我们的请求路径全程 async, Fastify 比 Express 在高并发下表现好.

**Q: 怎么调试请求路径 (从 API 到上游)?**
A: `docker logs -f freellm-hub | grep <hub_key_id>`, 然后看 pino 的 request_id 日志.

**Q: 上游 API Key 加密的 key 存在哪?**
A: `data/master.key` (PBKDF2 派生 master), hub 启动时读, 上游 API Key 用 master 派生的 AES key 加密存数据库.

**Q: 怎么导出 Hub Key 给用户?**
A: 用户在后台创建时**一次性**展示明文, 之后只能查看明文 (走 `/api/admin/hub-keys/:id/plain`). 没有"忘记明文"的恢复路径 (设计上强制重新创建).

**Q: 怎么禁止某个 Hub Key 用特定模型?**
A: 创建 Hub Key 时填 `allowed_models` 列表, 或 `rate_limit_rpm`. 后台 `/admin/hub-keys` 创建弹窗支持.

**Q: 想加一个模型维度 (e.g. 按 region 路由)?**
A: 加 `provider.region` 字段, resolver 时 `req.headers['x-region']` → 选对应 region 的 channel.

---

## 十六、贡献指南

1. **Fork** → 新分支 (`git checkout -b feature/xxx`)
2. **改** → 跑 `npm run build` + 测试
3. **Commit** → 用 Conventional Commits (`feat:`, `fix:`, `refactor:`)
4. **PR** → 描述问题 + 截图 + 关联 issue
5. **Review** → 维护者审核, 通常 1-3 天反馈

主要维护者: [@zhibushi](https://github.com/zhibushi)

---

## 附录 A: 关键 SQL 查询

```sql
-- 最近 24h 失败率
SELECT
  request_model,
  COUNT(*) AS total,
  SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) AS ok,
  ROUND(100.0 * SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) / COUNT(*), 1) AS success_pct
FROM usage_logs
WHERE created_at > strftime('%s','now')*1000 - 86400000
GROUP BY request_model
ORDER BY total DESC LIMIT 20;

-- P95 延迟 (按 model)
SELECT
  request_model,
  latency_ms
FROM usage_logs
WHERE latency_ms IS NOT NULL
ORDER BY latency_ms ASC
LIMIT 1 OFFSET (SELECT COUNT(*)*95/100 FROM usage_logs WHERE latency_ms IS NOT NULL);

-- 当前所有 active cooldown
SELECT
  c.key_id, k.label, c.reason, c.upstream_model,
  datetime(c.expires_at/1000, 'unixepoch') AS expires
FROM cooldowns c
LEFT JOIN keys k ON k.id = c.key_id
WHERE c.expires_at > strftime('%s','now')*1000
ORDER BY c.expires_at;

-- Hub Key 用量排行
SELECT
  hk.name, hk.key_prefix,
  COUNT(*) AS calls,
  SUM(ul.total_tokens) AS tokens
FROM usage_logs ul
JOIN hub_keys hk ON hk.id = ul.hub_key_id
WHERE ul.created_at > strftime('%s','now')*1000 - 86400000
GROUP BY hk.id
ORDER BY tokens DESC;
```

## 附录 B: Token / 成本估算

`usage_logs.prompt_tokens + completion_tokens = total_tokens`. 当前没有自动按 USD 折算成本 (Roadmap 计划). 要加可以:

1. `src/db/migrations/028_pricing.sql` 加 `model_pricing(model TEXT PK, input_per_million_cents INT, output_per_million_cents INT)`
2. 后台任务每天聚合 `usage_logs` 按 model 算成本
3. `/api/admin/usage/cost` 端点返回每日成本

---

**反馈**: 发现文档错误或缺失? 提 Issue 或发邮件. 这是个**活文档**, 会随代码演进.
