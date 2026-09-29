# Security Policy

## 支持版本

| 版本 | 支持状态 |
|---|---|
| v2.0.x | ✅ 积极维护 |
| v1.x | ❌ 不再维护 |

## 报告漏洞

**请勿** 在公开 GitHub issue 中报告安全漏洞。

发送邮件到：`security@freellm-hub.example.com`（占位，请替换成你的实际邮箱）

请包含：

- 漏洞描述
- 复现步骤
- 影响范围
- 建议的修复方案（如果有）

我们会在 48 小时内确认收到，并在 7 天内给出处理计划。

## 安全特性

FreeLLM Hub v2 内置以下安全措施：

### 数据加密
- **API Key 加密存储**: 所有上游 Provider API Key 使用 AES-256-GCM 加密，密钥从 `master.key` 派生
- **管理员密码**: argon2id 哈希（不是 bcrypt）
- **Hub Key 存储**: 鉴权走 `key_hash`（SHA-256），**但 `plain_key` 列同时以明文保存** —— 渠道测试需要回显。已知取舍：数据卷泄露即泄露全部 Hub Key，请按对待上游 Key 的级别保护 `data/`
- **master.key 丢失保护**: 启动时若 `master.key` 缺失但库内已有加密 Key，服务会拒绝启动而不是静默生成新钥；每次备份旁都会复制 `master.key` / `session.secret`
- **Session Secret**: 64 字节随机密钥，签名防篡改

### 访问控制
- **Admin 鉴权**: 基于 cookie session（无独立 CSRF token，依赖同源/反代部署假设）
- **Hub Key 鉴权**: 基于 `Authorization: Bearer fh_...` / `x-api-key` header；路径按 Fastify 路由模式判断，百分号编码不可绕过
- **登录限流**: `@fastify/rate-limit`（`rateLimit.loginMax` / `windowMs` 可配置）+ 同名账号连续失败锁定 15 分钟
- **Per-Key 模型白名单**: Hub Key 和 Channel Key 都可限定可调用的模型
- **权限拒绝在配额检查之前**: 拒绝的请求不消耗上游 quota

### 传输安全
- **TLS 推荐**: 反向代理层强制 HTTPS（生产环境必做）
- **Cookie secure flag**: 部署在 HTTPS 后面时应设为 `true`
- **CORS**: `/v1/*` 允许跨域 + 凭证；admin API 同源访问

### 内容安全
- **护栏系统**: 输入过滤（已接入 `/v1` 文本链路：chat / messages / responses）、输出过滤、关键词拦截、PII 检测、长度限制（输出侧尚未接入）
- **日志脱敏**: API Key 在日志中显示为前缀 + `•••••`

## 推荐部署实践

1. **不要把 3030 端口直接暴露到公网** —— 必须通过反向代理 + HTTPS
2. **定期更换 admin 密码**
3. **定期审查 Hub Key** —— 删除不再使用的，启用 allowed_models 限制
4. **启用内容护栏** —— 至少开启 PII 检测
5. **定期审查使用日志** —— 检测异常调用模式
6. **异地备份 `data/` 目录** —— 包含 `master.key`，请加密后传输
7. **限制 Docker 网络访问** —— 用 iptables / ufw 限制 3030 端口只对内网开放

## 已知限制

- **本地流量不加密**: 默认配置假设部署在反代后面。反代负责 TLS。
- **`master.key` 不可恢复**: 丢失后所有上游 API Key 都不可解密，必须重新输入。启动时有防静默换钥守卫；备份目录内每次都有配套副本。
- **Session secret 不可恢复**: 丢失后所有 admin 会被强制退出。
- **Hub Key 明文列**: 见上文 `plain_key` 说明。
- **`rate_limit_rpm` 仅存储未执行**: Hub Key 的 RPM 字段目前只保存配置，网关不会按它限流（每请求限流走登录用的全局 rate-limit）。

## 披露时间线

1. 收到漏洞报告（48 小时内确认）
2. 评估严重性 + 制定修复计划（7 天内）
3. 修复 + 测试（视严重性 1-30 天）
4. 发布补丁版本
5. 在 CHANGELOG 中致谢（如果报告者愿意）

## 历史漏洞

目前无已公开披露的安全漏洞。
