/**
 * ESM 相对导入必须带 .js 后缀
 *
 * 背景: dist 里是严格 ESM, 不带后缀的相对导入 (如 `from '../db/connection'`)
 * **tsc --noEmit 查不出来**(tsconfig 未用 NodeNext), 测试跑 tsx 也能解析,
 * 只有容器里启动那一刻才炸 `ERR_MODULE_NOT_FOUND` → 容器重启循环。
 * 已经踩过一次 (modelAlias.ts), 这里把它钉死。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '../../src');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts') && !p.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

describe('ESM 相对导入后缀', () => {
  it('src 下所有相对导入必须以 .js / .json 结尾', () => {
    const offenders: string[] = [];
    const re = /from\s+['"](\.[^'"]*)['"]/g;
    for (const file of walk(SRC)) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(re)) {
        const spec = m[1];
        if (!spec.endsWith('.js') && !spec.endsWith('.json') && !spec.endsWith('.css')) {
          offenders.push(`${file.replace(SRC, 'src')}: ${spec}`);
        }
      }
    }
    assert.deepEqual(offenders, [],
      `以下相对导入缺 .js 后缀, dist 启动会 ERR_MODULE_NOT_FOUND:\n${offenders.join('\n')}`);
  });
});
