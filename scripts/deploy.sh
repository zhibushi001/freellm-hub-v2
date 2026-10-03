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

# 显式钉住 buildx builder, 不吃环境的默认 —— 本机默认的 mybuilder 是
# docker-container 驱动且 inactive, 启动它要从 Docker Hub 拉 buildkit 镜像,
# 国内网络直接超时 → 构建失败。想要 docker-container 驱动自行设 BUILDX_BUILDER。
# 默认选 docker 驱动: daemon 侧已配 registry-mirrors, 不依赖额外网络。
: "${BUILDX_BUILDER:=default}"
export BUILDX_BUILDER
# 预检: 静默用到 inactive builder 正是"构建失败还以为是别的问题"的来源。
# 注意 `docker buildx inspect` 对 inactive 的 builder **退出码仍是 0**, 必须解析 Status 字段
# (本机 mybuilder 就是这么骗过了第一版预检)。
: "${BUILDX_BUILDER:=default}"
export BUILDX_BUILDER
if ! builder_status=$(docker buildx inspect "$BUILDX_BUILDER" 2>/dev/null | awk '/^Status:/ {print $2; exit}'); then
  builder_status=""
fi
if [ "$builder_status" != "running" ]; then
  echo "[deploy] ✗ builder '$BUILDX_BUILDER' 状态为 '${builder_status:-不存在}' — 先修它, 或改 BUILDX_BUILDER 环境变量"
  echo "[deploy]   可用的 builder:"
  docker buildx ls 2>/dev/null | awk 'NR>1 && $1 ~ /^[a-z]/ {n=$1; sub(/\*$/,"",n); print n}' \
    | while read -r b; do
        s=$(docker buildx inspect "$b" 2>/dev/null | awk '/^Status:/ {print $2; exit}')
        echo "             $b  [$s]"
      done
  exit 1
fi
log "     builder $BUILDX_BUILDER: $builder_status"

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
# 把当前 commit 打进镜像标签 → 部署完一条命令就能确认"线上跑的就是刚提交的这份"
GIT_SHA=$(git rev-parse --short HEAD 2>/dev/null || echo unknown)
export GIT_SHA
log "     镜像将标记 commit ${GIT_SHA} (builder: ${BUILDX_BUILDER})"
if ! docker compose build; then
  echo "[deploy] ✗ 镜像构建失败 — 容器未被改动, 线上仍是旧版本"
  exit 1
fi

log "5/6 应用新镜像 (镜像变了 compose 自动重建容器; 没变则为 no-op)"
docker compose up -d

log "6/6 健康门禁 (30s)"
# 门禁查 migrations_pending + migrations_modified:
#   pending  = 有迁移没跑完
#   modified = **已应用的迁移文件被事后改动 → 它再也不会重跑** (最危险的一类, 改个
#              WHERE 就以为"修好了"实际是永久 no-op), 必须挡住部署
# 刻意**不**对 migrations_orphaned 亮红: 台账体检跑在迁移循环**之前**, 所以"应用
# 清理孤儿行的迁移"那次启动仍报旧值 (038 就是这样, 应用当次仍报 3, 下次启动才归零)。
# 对它亮红会让**恰恰是修孤儿的那次部署**被判失败并自动回滚。改为放行后告警 ——
# 孤儿的清理由迁移显式处理 (038), 不靠门禁兜底。
for i in $(seq 1 30); do
  sleep 1
  body=$(curl -sf -m 2 "$HEALTH_URL" 2>/dev/null || true)
  if echo "$body" | grep -q '"migrations_pending":0' \
     && echo "$body" | grep -q '"migrations_modified":0'; then
    orph=$(echo "$body" | grep -o '"migrations_orphaned":[0-9]*' | cut -d: -f2)
    [ "${orph:-0}" != "0" ] && log "  ⚠ migrations_orphaned=$orph — 台账有磁盘上没有的记录; 如为已知历史项可忽略, 新增则查 src/db/migrations"
    log "✓ 部署成功 (${i}s) — healthy, migrations_pending=0, migrations_modified=0"
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
