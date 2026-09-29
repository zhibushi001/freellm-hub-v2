# 恢复手册 (Restore Runbook)

> 演练记录: 2026-09-29 已在本机完整演练一次 — 备份三件套 → 独立容器启动 → 数据清点 → master.key 解密全部通过。

## 备份在哪

- **位置**: `/vol1/@appshare/fn-deepseek-harness/hub-backups/`（宿主机目录，**数据卷之外** — 卷丢不影响备份）
- **组成**: 每次备份是**三件套**，缺一不可：
  - `hub-<时间戳>.db` — 数据库快照 (VACUUM INTO, 自含 WAL)
  - `hub-<时间戳>.master.key` — 上游 API Key 的加密主密钥（**丢了它，库里所有上游 Key 永久无法解密**）
  - `hub-<时间戳>.session.secret` — 会话签名密钥
- **频率**: 每次启动后5秒 + 每24小时；保留最近7份（自动清理）
- **目录环境变量**: `HUB_BACKUP_DIR`（docker-compose.yml 中指向 `/app/backups` → 宿主机 `hub-backups/`）

## 恢复步骤（在新机器 / 重装后）

```bash
# 1. 准备目录 (三件套放一起)
mkdir -p /path/to/data

# 2. 拷贝备份三件套 (文件是 root600, 用 root 拷)
cp hub-backups/hub-2026-09-29T15-35-06.db            /path/to/data/hub.db
cp hub-backups/hub-2026-09-29T15-35-06.master.key     /path/to/data/master.key
cp hub-backups/hub-2026-09-29T15-35-06.session.secret /path/to/data/session.secret

# 3. 启动 (docker compose 的 volumes 已配好; 或手动:)
docker run -d --name freellm-hub --restart unless-stopped \
  -p 3303:3030 \
  -v freellm-hub-data:/app/data \
  -v /srv/hub-backups:/app/backups \
  -e HUB_BACKUP_DIR=/app/backups \
  freellm-hub-v2:latest

# 4. 健康门禁 (migrations_pending 必须为 0)
for i in $(seq 1 30); do
  sleep 1
  curl -s http://localhost:3303/health | grep -q '"migrations_pending":0' && echo OK && break
done

# 5. 验证
curl -s http://localhost:3303/v1/models -H "Authorization: Bearer <你的hub key>" | head -c 200
```

## 验证清单（演练已全部通过）

- [x] 独立容器从三件套启动,1 秒过健康门禁
- [x] 数据完整 (hub_keys / channels / keys / usage_logs 计数与生产一致)
- [x] `master.key` 真实解密上游 Key 成功 (getDecryptedApiKey 返回明文)
- [x] 启动迁移无待办 (migrations_pending=0)

## 注意事项

1. **三件套必须来自同一次备份**（同时间戳）— 配错组合 = 解密失败或签名失效
2. **永远不要用 `docker compose down -v`** — `-v` 会连数据卷一起删
3. 启动后系统会自动跑迁移和启动备份, 无需手动
4. 建议定期把 `hub-backups/` 同步到**另一台机器**（当前只防卷丢，不防整机丢）
