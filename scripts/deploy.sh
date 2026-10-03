#!/usr/bin/env bash
# FreeLLM Hub 一键部署 — 本地构建校验 → 标记回滚镜像 → 构建镜像 → 应用 → 健康门禁 (失败自动回滚)
#
# ── 与旧流程的区别 (2026-10-03 改, 起因见 CHANGELOG 同日两起事故) ──
# 旧: 把本地 dist 用 tar 推进"运行中的容器", 容器 dist 与镜像 dist 是两份东西, 会漂移;
#     而且 Dockerfile 改了没人重建镜像就永远不生效 —— "非 root" 改动三周没生效,
#     第一次真正重建镜像就因为数据卷属主崩溃循环。
# 新: 运行时 dist **只有镜像里这一份**。每次部署都 docker compose build (BuildKit 有缓存,
#     无变化时秒过), Dockerfile / 依赖 / 源码改动一律当次生效; 容器重建 (force-recreate、
#     换机、宿主重启) 拿到的永远是最近一次部署构建的 dist, 不会倒退回旧镜像里的旧代码。
#     也彻底删掉了"推进容器 + 清残留"那套 (006 孤儿迁移崩溃的根源)。
# 回滚: 部署前自动打 rollback-<ts> 镜像 tag, 门禁失败自动打回 (保留最近 2 个)。
set -euo pipefail
cd "$(dirname "$0")/.."

# 读取本地 .env (端口等个人配置, .gitignore 忽略); 没有则默认 3030
if [ -f .env ]; then
  set -a
  # shellcheck source=/dev/null
  . ./.env
  set +a
fi

CONTAINER=freellm-hub
IMAGE=freellm-hub-v2:latest
HEALTH_URL=http://localhost:${HUB_HOST_PORT:-3030}/health
TS=$(date +%Y%m%d-%H%M%S)
ROLLBACK_TAG="freellm-hub-v2:rollback-${TS}"
log() { echo "[deploy] $*"; }

log "1/6 本地构建 (tsc + vite + copy-assets) — 编译错误在这里快速失败"
npm run build >/dev/null
(cd freellm-hub-client && npx vite build >/dev/null)
node scripts/copy-assets.mjs >/dev/null

log "2/6 校验 dist 与 src 迁移一致 (孤儿文件防线)"
if ! diff <(ls src/db/migrations/*.sql | xargs -n1 basename | sort) \
          <(ls dist/db/migrations/*.sql | xargs -n1 basename | sort); then
  echo "[deploy] ✗ dist/db/migrations 与 src 不一致 — 拒绝部署 (dist 存在孤儿/缺失迁移)"
  exit 1
fi

log "3/6 标记回滚镜像 ${IMAGE} → rollback-${TS}"
if docker image inspect "$IMAGE" >/dev/null 2>&1; then
  docker tag "$IMAGE" "$ROLLBACK_TAG"
fi
# 只保留最近 2 个回滚点 (镜像层共享, 成本低, 但不必无限堆积)
for old in $(docker images --format '{{.Repository}}:{{.Tag}}' | grep 'freellm-hub-v2:rollback-' | sort -r | tail -n +3); do
  docker rmi "$old" >/dev/null 2>&1 || true
done

log "4/6 构建镜像 (BuildKit 缓存; Dockerfile/依赖/源码改动都在这里生效)"
if ! docker compose build; then
  echo "[deploy] ✗ 镜像构建失败 — 容器未被改动, 线上仍是旧版本"
  exit 1
fi

log "5/6 应用新镜像 (镜像变了 compose 自动重建容器; 没变则为 no-op)"
docker compose up -d

log "6/6 健康门禁 (30s)"
for i in $(seq 1 30); do
  sleep 1
  body=$(curl -sf -m 2 "$HEALTH_URL" 2>/dev/null || true)
  if echo "$body" | grep -q '"migrations_pending":0'; then
    log "✓ 部署成功 (${i}s) — healthy, migrations_pending=0"
    if docker image inspect "$ROLLBACK_TAG" >/dev/null 2>&1; then
      log "  回滚命令: docker tag $ROLLBACK_TAG $IMAGE && docker compose up -d"
    fi
    exit 0
  fi
done

log "✗ 健康门禁失败 — 自动回滚"
if docker image inspect "$ROLLBACK_TAG" >/dev/null 2>&1; then
  docker tag "$ROLLBACK_TAG" "$IMAGE"
  docker compose up -d
  log "已回滚到上一镜像并重启; 请检查 docker logs $CONTAINER"
fi
exit 1
