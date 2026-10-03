#!/usr/bin/env bash
# FreeLLM Hub 一键部署 — 干净构建 → 一致性校验 → 备份 → 推送 → 健康门禁 (失败自动回滚)
#
# 用法: ./scripts/deploy.sh          (在仓库根目录)
# 需要: docker (容器 freellm-hub 已存在)、node/npm
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
HEALTH_URL=http://localhost:${HUB_HOST_PORT:-3030}/health
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

# 清理旧回滚点: 只保留最近 2 个。dist 可由 git + npm run build 完整重建, 不必无限堆积
ls -1t .deploy-backups/dist-*.tgz 2>/dev/null | tail -n +3 | xargs -r rm -f

log "6/7 推送新 dist (先清前端缓存目录, 防旧 hash 残留)"
docker exec "$CONTAINER" rm -rf /app/dist/public/admin
tar -C dist -cf - . | docker exec -i "$CONTAINER" tar -C /app/dist -xf -

# 清残留: 删掉容器 dist 里"本地已不存在"的文件。
# 曾因此类残留 (db/migrations/006_model_routes.sql 孤儿) 被迁移重放, 启动直接崩。
# 白名单 package.json: 由 Dockerfile 烘焙进 dist/ 供 app.ts 读版本, 本地 dist 里没有。
(cd dist && find . -type f | sed 's|^.\./||' | LC_ALL=C sort) > /tmp/dist-list.txt
docker cp /tmp/dist-list.txt "$CONTAINER":/tmp/dist-list.txt
docker exec "$CONTAINER" sh -c '
  cd /app/dist || exit 1
  find . -name "._*" -delete 2>/dev/null
  find . -type f | sed "s|^.\./||" | LC_ALL=C sort > /tmp/remote.txt
  comm -23 /tmp/remote.txt /tmp/dist-list.txt | grep -v "^package.json$" > /tmp/stale.txt || true
  n=0; while IFS= read -r f; do [ -n "$f" ] && rm -rf -- "$f" && n=$((n+1)); done < /tmp/stale.txt
  find . -type d -empty -delete 2>/dev/null
  rm -f /tmp/dist-list.txt /tmp/remote.txt /tmp/stale.txt
  echo "  清残留: 删除 $n 个本地已不存在的文件"
'

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
# 先把 dist 挪空再解包: tar 解包只覆盖"包内有的路径", 不会删除本次部署新增的文件,
# 直接解包会留下一个既不属于旧版本也不属于新版本的混合 dist (且前向路径的清残留
# 只在正向执行, 回滚不跑)。用临时目录解包再整体换, 保证回滚后的 dist 就是那个 tgz 的内容。
docker exec "$CONTAINER" sh -c '
  set -e
  rm -rf /app/dist.rollback && mkdir -p /app/dist.rollback
  cd /app/dist.rollback && tar -xzf -
  cd /app
  rm -rf /app/dist.old && mv /app/dist /app/dist.old
  mv /app/dist.rollback /app/dist
  rm -rf /app/dist.old
' < "$BACKUP_TGZ"
docker restart "$CONTAINER" >/dev/null
log "已回滚并重启; 请检查 docker logs $CONTAINER"
exit 1
