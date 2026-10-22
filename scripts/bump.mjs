#!/usr/bin/env node
/**
 * 版本号递增：`node scripts/bump.mjs [patch|minor|major] [--dry-run]`（默认 patch）。
 *
 * 为什么要脚本：版本号分散在 package.json 与 src/version.ts，两处必须同版
 * （构建脚本会校验，不一致直接失败）。手改两处的结局迟早是漂移，
 * 而且很容易顺手把 minor 也加了 —— 默认值定成 patch 就是在防这件事。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkgPath = path.join(root, 'package.json');
const verPath = path.join(root, 'src/version.ts');

/** 纯函数：算出下一个版本（导出供测试） */
export function nextVersion(current, kind = 'patch') {
  const m = String(current || '').match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  let [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (kind === 'major') { major += 1; minor = 0; patch = 0; }
  else if (kind === 'minor') { minor += 1; patch = 0; }
  else if (kind === 'patch') { patch += 1; }
  else return null;
  return `${major}.${minor}.${patch}`;
}

const isCli = !process.argv[1] || /bump\.mjs$/.test(process.argv[1]);
if (!isCli) {
  // 被测试 import 时只导出纯函数，不触碰文件
} else {
const args = process.argv.slice(2);
const kind = args.find((a) => ['patch', 'minor', 'major'].includes(a)) || 'patch';
const dryRun = args.includes('--dry-run');

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const current = String(pkg.version || '');
const m = current.match(/^(\d+)\.(\d+)\.(\d+)$/);
if (!m) {
  console.error(`[bump] 当前版本不是 x.y.z 形式：${current}`);
  process.exit(1);
}
let [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
if (kind === 'major') { major += 1; minor = 0; patch = 0; }
else if (kind === 'minor') { minor += 1; patch = 0; }
else { patch += 1; }
const next = `${major}.${minor}.${patch}`;

const verSrc = fs.readFileSync(verPath, 'utf8');
if (!/CURRENT_PLUGIN_VERSION\s*=\s*'/.test(verSrc)) {
  console.error('[bump] src/version.ts 里找不到 CURRENT_PLUGIN_VERSION');
  process.exit(1);
}

console.log(`[bump] ${current} → ${next}（${kind}）`);
if (kind !== 'patch') {
  console.log('[bump] 注意：中间位/主版本位只该用于大的功能改动或破坏性变更（见 PROJECT.md 版本号约定）');
}
if (dryRun) {
  console.log('[bump] --dry-run：未写入任何文件');
  process.exit(0);
}

pkg.version = next;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
fs.writeFileSync(verPath, verSrc.replace(/(CURRENT_PLUGIN_VERSION\s*=\s*')([^']+)(')/, `$1${next}$3`), 'utf8');
console.log('[bump] 已同步写入 package.json 与 src/version.ts');
}
