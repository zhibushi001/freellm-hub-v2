# Backlog — 已拍板、还没做的事

## 作业规则

1. **用户点名哪条，我做哪条** —— 不点名不自动开工。
2. 做完：本文件打勾划掉 → 变更记入 [`CHANGELOG.md`](../CHANGELOG.md) → 随代码提交。
3. 中途方案变化：直接改写对应条目，保持这里永远是最新真实状态。

## 待办

- [x] ~~修 buildx builder（构建会静默失败）~~ — **部署链路已加固** (ece59c1): `deploy.sh`
      显式钉 `BUILDX_BUILDER=default`（可用环境变量覆盖）并加预检, 不再吃环境的默认值。
      **踩坑**: 第一版预检用 `docker buildx inspect` 的退出码, 实测 inactive 的 builder
      **退出码仍是 0** (mybuilder 骗过去了), 必须解析 `Status:` 字段; 预检失败会列出
      所有 builder 及状态。
      `a01d71b` 也已把 `deploy.sh` 改成 `if ! docker compose build` (不再被管道 `&&` 盖掉)。
      **仍余**: 坏掉的 `mybuilder` 本体还留在机器上 (未删), 只是不再被用到;
      `buildkitd.toml` 的 mirrors 对 `docker-container` 驱动不生效, 那份配置目前是摆设
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

- [x] ~~model_mapping / virtual_models 在请求路径未生效~~ (审计 P1) — **已修**, 见 CHANGELOG。
- [ ] **PUT /api/admin/channels/:id 与 batch-edit 缺 schema 校验** (PATCH 有, 这两个没有)
- [ ] **GitHub Actions CI** (公开仓库目前零 CI: PR 上不跑 tsc/测试)
- [ ] **Docker 加日志轮转与内存上限**; 端口 0.0.0.0 的取舍写进文档
- [ ] **模型测试接口无上限** (400 模型 × 15s ≈ 2.3 小时阻塞一个 HTTP 请求)
- [ ] **基础镜像 tag 浮动** (chainguard 为保最新; 是否钉死待定)
- [x] ~~`deploy.sh` 只推 dist 不重建镜像~~ — **已修**: 新流程每次部署都 `docker compose build`,
      Dockerfile/依赖/源码改动当次生效。
- [x] ~~重建镜像需同步 chown 数据卷~~ — **已修**: `scripts/container-entrypoint.mjs`
      root 启动 → 自动校正 /app/data 归属 → 立即降权到 node (解析不出用户则拒绝启动)。
      实测复现 master.key 被改回 root → 重启 1s 自愈。
- [x] ~~镜像内 dist 与本地 dist 两份构建路径~~ — **已修**: 运行时 dist 只有镜像里这一份,
      deploy 不再向容器推文件 (006 孤儿残留那类问题从结构上消失)。
- [x] ~~3 条孤儿迁移台账行的人工核对~~ — **已清理** (2026-10-03): 核对结果是这三个文件
      **从未进过 git** (`git log --diff-filter=A/D` 新增/删除都查不到), 系 2026-09-29
      一个未提交的工作副本跑出来的。台账行已由迁移 038 删除, `/health` orphaned 归零。
      删除会拆掉"行还在 → 文件重现时被跳过"的安全栓, 故在 runner 加了
      `RETIRED_MIGRATIONS` denylist 顶上: 这 3 个文件即使重新出现也**永不执行**,
      并有测试证明 (关掉 denylist 该用例会失败)。见 CHANGELOG
