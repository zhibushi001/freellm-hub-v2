# Build stage 1: 编译 React 前端
FROM cgr.dev/chainguard/node:latest-dev AS client-builder
WORKDIR /app/client
USER root
RUN apk add --no-cache curl 2>/dev/null || true
USER node
COPY --chown=node:node freellm-hub-client/package*.json ./
# 依赖装在构建容器里 (克隆下来的仓库没有 node_modules, 不能 COPY 本机的)
RUN npm ci --no-audit --no-fund
COPY --chown=node:node freellm-hub-client/ ./
RUN npm run build

# Build stage 2: 编译 TypeScript 后端
FROM cgr.dev/chainguard/node:latest-dev AS builder
WORKDIR /app
USER root
RUN apk add --no-cache curl 2>/dev/null || true
USER node
COPY --chown=node:node package*.json ./
RUN npm ci --no-audit --no-fund
COPY --chown=node:node tsconfig.json ./
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node src ./src
RUN npm run build && npm prune --omit=dev --no-audit

# Production stage
FROM cgr.dev/chainguard/node:latest AS production
# 线上跑的是哪个 commit —— 一条命令就能问, 不用再 grep 镜像内容 + 比对时间戳推理。
# docker inspect freellm-hub --format '{{index .Config.Labels "org.opencontainers.image.revision"}}'
ARG GIT_SHA=unknown
LABEL org.opencontainers.image.revision="${GIT_SHA}"
WORKDIR /app
USER root
RUN apk add --no-cache curl 2>/dev/null || true
USER node
COPY --chown=node:node package*.json ./
# 运行时依赖来自 builder (已 prune 掉 devDeps; 原生模块在 -dev 镜像里编译更稳)
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
# 后端编译产物
COPY --from=builder --chown=node:node /app/dist ./dist
# 把 package.json 也复制到 dist/ 同级, 让运行时的 __dirname 能读到版本
COPY --chown=node:node package.json ./dist/package.json
COPY --chown=node:node package.json ./
COPY --from=builder --chown=node:node /app/src/db/migrations ./dist/db/migrations
# Keep old SSR CSS/JS for setup page
# COPY --from=builder --chown=node:node /app/src/public ./dist/public
# React 前端构建产物
COPY --from=client-builder --chown=node:node /app/client/dist ./dist/public/admin
# 数据目录归 node 用户 (compose 挂载 named volume 时由镜像内属主决定初始权限)
RUN mkdir -p /app/data && chown -R node:node /app/data /app/dist
# entrypoint 必须是 root 属主: 它要校正数据卷归属后降权 (见文件内注释)
COPY --chown=root:root scripts/container-entrypoint.mjs /app/entrypoint.mjs
# root 启动**只是为了**自动修数据卷归属 (容器 UID 变化后 master.key/hub.db 会 EACCES,
# 2026-10-03 为此崩溃循环); entrypoint 修完立即降权到 node —— 服务进程永远不是 root。
USER root
EXPOSE 3030
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3030/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/node", "/app/entrypoint.mjs"]
CMD ["dist/server.js"]
