# Backlog — 已拍板、还没做的事

## 作业规则

1. **用户点名哪条，我做哪条** —— 不点名不自动开工。
2. 做完：本文件打勾划掉 → 变更记入 [`CHANGELOG.md`](../CHANGELOG.md) → 随代码提交。
3. 中途方案变化：直接改写对应条目，保持这里永远是最新真实状态。

## 待办

- [ ] **修 buildx builder（构建会静默失败）** — 当前默认 builder `mybuilder` 是
      `docker-container` 驱动且状态 `inactive`，启动它要从 Docker Hub 拉
      `moby/buildkit:buildx-stable-1`，本机网络拉不动直接超时 → `docker compose build`
      整个失败。`default`（`docker` 驱动，daemon 侧已配 registry-mirrors）是好的，
      临时解法 `BUILDX_BUILDER=default docker compose build hub`。
      待定：① 删掉坏掉的 `mybuilder` 改用 default ② 或给 container driver 配好
      `buildkitd.toml` 镜像源 ③ 或预拉 buildkit 镜像
      **附带**: 这次 `... 2>&1 | tail -30 && echo "BUILD OK"` 打印了假成功 ——
      管道尾命令的退出码盖掉了 buildkit 的失败。约定：构建**不要**接 `&&`，
      单独判 `BUILD_EXIT=$?`；`buildkitd.toml` 的 mirrors 对 `docker-container`
      驱动不生效，别指望它兜底
- [ ] **同仓库并发写入的提交纪律** — 2026-10-03 实测：我在提交 R1-R6 之后，
      `cooldowns.ts` / `failover.ts` / `keyHealth.ts` + 新增 `cooldownPolicy.test.ts`
      在 03:29:04 被**另一个会话**写入（我全程没碰这四个文件），内容是合理的续作
      （R7/R8），但来源不明、时机撞车
      风险：① 提交到自己不知道来源的半成品 ② 漏提交别人已写好的续作 ③ 两边同时改
      同一文件互相覆盖
      待定做法：提交前先 `git status` 看有没有"我没改过却变了"的文件；有就先查
      mtime + 问清来源再决定；长期看可给每个会话一个 worktree / 分支
- [ ] **配置大扫除** — 清理历史遗留配置项与废弃字段
- [ ] **全局限流 + `@fastify/rate-limit`** — 入口层按 IP/Key 限流，与现有按渠道冷却互补
- [ ] **统一错误信封** — 后端错误响应统一 `{ok:false, error, code}` 结构
- [ ] **usage 聚合趋势页** — 用量页加按日 / 按模型聚合趋势图
- [ ] **路由 explain=1** — 模型路由支持 explain 参数，返回本次命中的通道 / Key / 原因
- [ ] **迁移 checksum** — schema 迁移记录带校验和，防外部改库导致漂移
- [ ] **index.html 热读 + legacy 迁出** — 静态页热加载改造与旧路径迁移
- [ ] **备份外置另一台机器** — hub-backups 定期同步到独立机器，防单机故障
- [ ] **freellm.net 定期对照** — 你说“对照下 freellm”时：拉它的 RSS/Changelog +
      官方速查表 → diff 本库 `providers` → 报告新增/下架候选 → 你点头后执行
      （不做自动定时：网页结构易变，且需容器常年出网）
      首次对照已完成（2026-10-03：+7 提供商 / 停用 4 问题条目，见 CHANGELOG）

## 进行中

（无）

## 已完成

> 完成项不留档，全部见 [`CHANGELOG.md`](../CHANGELOG.md)。

## 审计后仍未完成项 (2026-10-03 全项目审计遗留)

- [ ] **model_mapping / virtual_models 在请求路径未生效** (审计 P1, 潜在风险最高)
      配了映射/虚拟模型, 请求却按原名路由 —— 界面看着配好了, 实际不生效, 甚至把可用模型配没了。
      0 行配置, 修起来要动 resolver 主路径, 需要专门一轮 + 回归验证。
- [ ] **PUT /api/admin/channels/:id 与 batch-edit 缺 schema 校验** (PATCH 有, 这两个没有)
- [ ] **GitHub Actions CI** (公开仓库目前零 CI: PR 上不跑 tsc/测试)
- [ ] **Docker 加日志轮转与内存上限**; 端口 0.0.0.0 的取舍写进文档
- [ ] **模型测试接口无上限** (400 模型 × 15s ≈ 2.3 小时阻塞一个 HTTP 请求)
- [ ] **基础镜像 tag 浮动** (chainguard 为保最新; 是否钉死待定)
- [ ] **3 条孤儿迁移台账行的人工核对** (已可见, 保留不删; 见 CHANGELOG 说明)
