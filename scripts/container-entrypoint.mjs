#!/usr/bin/env node
/**
 * 容器 entrypoint — root 启动 → 自动校正数据卷归属 → 降权到 node 用户运行服务
 *
 * 为什么必须 root 启动: 数据卷 (named volume / bind mount) 的文件属主取决于
 * "第一次写入它的容器"。2026-10-03 踩过一次: 镜像从 USER root 换成 USER node 后,
 * 卷里 `master.key` 仍是 `0600 root:root` → 新容器读不到 → 启动即崩;
 * 更糟的是崩溃循环让 deploy 的 docker exec 也用不了, 只能手工 chown 数据卷恢复。
 * 这里把"修归属"变成每次启动的自检, 以后容器 UID 怎么变都不再需要人工介入。
 *
 * 硬约束: **服务进程永远不以 root 运行** —— 修完归属必须降权到 node 用户;
 * 连 node 用户都解析不出来时直接退出 (宁可不启动, 也不带 root 跑业务)。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const DATA_DIR = process.env.HUB_DATA_DIR || '/app/data';
const BACKUP_DIR = process.env.HUB_BACKUP_DIR || '/app/backups';

/** 从 /etc/passwd 解析用户名 → {uid, gid} */
function resolveUser(name) {
  try {
    for (const line of fs.readFileSync('/etc/passwd', 'utf8').split('\n')) {
      const p = line.split(':');
      if (p[0] === name) return { uid: Number(p[2]), gid: Number(p[3]) };
    }
  } catch { /* 没有 passwd → 走下面的失败分支 */ }
  return null;
}

/**
 * 递归 chown (lchown 不跟符号链接, 防止把链接目标改到树外)
 * 返回改动条目数 — 0 表示本来就对, 跳过 (启动热路径上不能每次都全量改)
 */
function chownTree(path, target) {
  let st;
  try { st = fs.lstatSync(path); } catch { return 0; }
  let changed = 0;
  if (st.uid !== target.uid || st.gid !== target.gid) {
    try { fs.lchownSync(path, target.uid, target.gid); changed++; }
    catch (e) { console.error(`[entrypoint] chown 失败 ${path}: ${e.code ?? e.message}`); }
  }
  if (st.isDirectory()) {
    for (const name of fs.readdirSync(path)) changed += chownTree(`${path}/${name}`, target);
  }
  return changed;
}

const target = resolveUser('node');
const amRoot = typeof process.getuid === 'function' && process.getuid() === 0;

if (amRoot) {
  if (!target) {
    console.error('[entrypoint] ✗ 无法从 /etc/passwd 解析 node 用户 — 拒绝以 root 运行服务');
    process.exit(1);
  }

  // 数据卷: 属主不对就修正 (含 db/master.key/session.secret 及子目录)
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch { /* 已存在 */ }
  const changed = chownTree(DATA_DIR, target);
  console.log(changed > 0
    ? `[entrypoint] 数据卷归属已自动修正 ${changed} 项 → uid=${target.uid} gid=${target.gid}`
    : `[entrypoint] 数据卷归属正确 (uid=${target.uid}), 无需修正`);

  // 备份目录: 宿主 bind mount, 属主归宿主所有 —— 只保证 node 可进入/可写 (权限位), 不动属主
  try {
    const st = fs.statSync(BACKUP_DIR);
    if ((st.mode & 0o007) !== 0o007) {
      fs.chmodSync(BACKUP_DIR, st.mode | 0o077);
      console.log(`[entrypoint] 备份目录权限已放开 (原 ${st.mode.toString(8)})`);
    }
  } catch {
    try {
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
      fs.chownSync(BACKUP_DIR, target.uid, target.gid);
    } catch (e) { console.error(`[entrypoint] 备份目录不可用 ${BACKUP_DIR}: ${e.code ?? e.message}`); }
  }
} else if (target && process.getuid() !== target.uid) {
  // 非 root 且身份不匹配: chown 必然失败, 早说清楚, 让启动错误好读
  console.error(`[entrypoint] ⚠ 当前 uid=${process.getuid()} 不是 node(${target.uid}), 无法校正归属`);
}

const argv = process.argv.slice(2);
if (argv.length === 0) {
  console.error('[entrypoint] ✗ 缺少要运行的脚本 (CMD)');
  process.exit(1);
}

const dropTo = amRoot && target ? { uid: target.uid, gid: target.gid } : null;
console.log(dropTo
  ? `[entrypoint] 降权运行服务 → uid=${dropTo.uid} gid=${dropTo.gid} (${argv.join(' ')})`
  : `[entrypoint] 运行服务 (${argv.join(' ')})`);

const child = spawn(process.execPath, argv, {
  stdio: 'inherit',
  cwd: process.cwd(),
  ...(dropTo ? { uid: dropTo.uid, gid: dropTo.gid } : {}),
});

// PID1 要把信号转给真正的服务进程, 否则 docker stop 只杀 entrypoint, 服务被 SIGKILL
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { try { child.kill(sig); } catch { /* 子进程可能已退出 */ } });
}

child.on('error', (e) => {
  console.error('[entrypoint] ✗ 启动服务失败:', e.message ?? e);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
