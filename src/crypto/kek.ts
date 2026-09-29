/**
 * 主加密密钥 (KEK - Key Encryption Key) 管理
 *
 * - 首次启动：随机生成 32 字节主密钥，存到 data/master.key
 * - 后续启动：从文件读取
 * - 丢失此文件 = 失去所有加密的上游 API Key（必须重新输入所有 Key）
 */
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { config } from '../config/env.js';
import { getDb } from '../db/connection.js';

const KEY_FILE = config.masterKeyPath;
let _key: Buffer | null = null;

function countEncryptedKeys(): number {
  try {
    const row = getDb().prepare('SELECT COUNT(*) AS n FROM keys WHERE api_key_enc IS NOT NULL').get() as
      | { n: number }
      | undefined;
    return Number(row?.n ?? 0);
  } catch {
    return 0; // 表还没建 = 全新安装
  }
}

/**
 * 获取（或初始化）主加密密钥
 */
export function getMasterKey(): Buffer {
  if (_key) return _key;

  if (existsSync(KEY_FILE)) {
    const buf = readFileSync(KEY_FILE);
    if (buf.length !== 32) {
      throw new Error(
        `master.key 文件长度异常 (期望 32 字节, 实际 ${buf.length}). ` +
          '可能是文件损坏或被截断. 恢复后会失去所有上游 API Key.',
      );
    }
    _key = buf;
    return _key;
  }

  // 防"静默换钥" (运维审计 #1): 库里已有加密的上游 key 而 master.key 缺失 →
  // 生成新钥 = 所有旧 Key 永久不可解. 拒绝启动, 必须先恢复 master.key 或清空数据目录.
  const encrypted = countEncryptedKeys();
  if (encrypted > 0) {
    throw new Error(
      `master.key 丢失 (${KEY_FILE}), 但数据库中已有 ${encrypted} 个加密的上游 API Key。` +
        '拒绝生成新密钥 (会导致所有上游 Key 永久不可解)。' +
        '请从备份恢复 master.key 文件 (每次备份旁都有副本), 或清空数据目录后重新配置。',
    );
  }

  // 首次启动：生成
  const key = randomBytes(32);
  writeFileSync(KEY_FILE, key, { mode: 0o600 });
  chmodSync(KEY_FILE, 0o600);
  _key = key;
  console.log(`[kek] 已生成主加密密钥: ${KEY_FILE}`);
  console.log(`[kek] ⚠️  请务必备份此文件！丢失 = 所有上游 API Key 不可解密`);
  return _key;
}

