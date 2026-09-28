#!/usr/bin/env bash
# FreeLLM Hub 一键部署 — 干净构建 → 一致性校验 → 备份 → 推送 → 健康门禁 (失败自动回滚)
#
# 用法: ./scripts/deploy.sh          (在仓库根目录)
# 需要: docker (容器 freellm-hub 已存在)、node/npm
set -euo pipefail
cd "$(dirname "$0")/.."

CONTAINER=freellm-hub
HEALTH_URL=http://localhost:3303/health
TS=$(date +%Y%m%d-%H%M%S)
log() { echo "[deploy] $*"; }

log "1/7 构建后端 (tsc + copy-assets)"
npm run build >/dev/null

log "2/7 构建前端 (vite) 并同步静态资源"
(cd freellm-hub-client && npx vite build >/dev/null)
node scripts/copy-assets.mjs >/dev/null

log "3/7 校验 dist 与 src 一致 (孤儿文件防线)"
if ! diff <(ls src/db/migrations/*.sql | xargs -n1 basename | sort) \
          <(ls dist/db/migrations/*.sql | xargs -n1 basename | sort); then
  echo "[deploy] ✗ dist/db/migrations 与 src 不一致 — 拒绝部署 (dist 存在孤儿/缺失迁移)"
  exit 1
fi
INDEX_HASH=$(grep -o 'index-[A-Za-z0-9_-]*\.js' dist/public/admin/index.html | head -1)
log "   前端入口: ${INDEX_HASH}"

log "4/7 确保容器可运行"
if ! docker start "$CONTAINER" >/dev/null 2>&1; then
  echo "[deploy] ✗ 容器无法启动 — docker logs $CONTAINER"
  exit 1
fi
sleep 2
if ! docker exec "$CONTAINER" true 2>/dev/null; then
  echo "[deploy] ✗ 容器内 shell 不可用 (可能正在崩溃循环, 先看日志)"
  exit 1
fi

log "5/7 备份容器当前 dist → .deploy-backups/"
mkdir -p .deploy-backups
BACKUP_TGZ=".deploy-backups/dist-${TS}.tgz"
docker exec "$CONTAINER" tar -C /app/dist -czf - . > "$BACKUP_TGZ"
log "   $BACKUP_TGZ ($(du -h "$BACKUP_TGZ" | cut -f1))"

log "6/7 推送新 dist (先清前端缓存目录, 防旧 hash 残留)"
docker exec "$CONTAINER" rm -rf /app/dist/public/admin
tar -C dist -cf - . | docker exec -i "$CONTAINER" tar -C /app/dist -xf -

log "7/7 重启 + 健康门禁 (30s)"
docker restart "$CONTAINER" >/dev/null
for i in $(seq 1 30); do
  sleep 1
  body=$(curl -sf -m 2 "$HEALTH_URL" 2>/dev/null || true)
  if echo "$body" | grep -q '"migrations_pending":0'; then
    log "✓ 部署成功 (${i}s) — healthy, migrations_pending=0"
    log "  回滚点: $BACKUP_TGZ"
    exit 0
  fi
done

log "✗ 健康门禁失败 — 回滚到 $TS"
docker exec -i "$CONTAINER" tar -C /app/dist -xzf - < "$BACKUP_TGZ"
docker restart "$CONTAINER" >/dev/null
log "已回滚并重启; 请检查 docker logs $CONTAINER"
exit 1
