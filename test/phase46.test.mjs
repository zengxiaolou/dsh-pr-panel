// test/phase46.test.mjs - Phase 46 · 版本号递增约定
//
// 约定（见 PROJECT.md 版本号约定）：默认只加最后一位；中间位只留给大的功能改动。
// 这条测试守两件事：
// 1. scripts/bump.mjs 的递增逻辑正确（patch/minor/major、进位后归零、非法输入）
// 2. 仓库当前状态满足不变量：package.json 与 src/version.ts 同版、且是 x.y.z
//
// 为什么值得单独测：版本号藏在两个文件里，手改必漂移；而「顺手加 minor」这种事
// 只有机械约束能防住。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dirname = path.dirname(fileURLToPath(import.meta.url));
let pass = 0; let total = 0; const fails = [];
function ok(cond, name, detail) {
  total += 1;
  if (cond) { pass += 1; console.log('✅ PASS: ' + name); }
  else { fails.push(name); console.error('❌ FAIL: ' + name + (detail ? ' — ' + detail : '')); }
}
function eq(a, b, name) { ok(a === b, name, `期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`); }

const { nextVersion } = await import('../scripts/bump.mjs');

console.log('\n--- 1. 默认只加补丁位 ---');
eq(nextVersion('0.6.0', 'patch'), '0.6.1', '0.6.0 → 0.6.1');
eq(nextVersion('0.6.1', 'patch'), '0.6.2', '0.6.1 → 0.6.2');
eq(nextVersion('0.6.9', 'patch'), '0.6.10', '补丁位可进位到两位数');
eq(nextVersion('0.6.0'), '0.6.1', '不传参数时默认 patch（防手滑加 minor）');

console.log('\n--- 2. 中间位/主版本位才进位并归零 ---');
eq(nextVersion('0.6.3', 'minor'), '0.7.0', 'minor：0.6.3 → 0.7.0（补丁位归零）');
eq(nextVersion('0.6.3', 'major'), '1.0.0', 'major：0.6.3 → 1.0.0');
eq(nextVersion('1.2.3', 'minor'), '1.3.0', 'minor 不动主版本位');

console.log('\n--- 3. 非法输入不猜 ---');
eq(nextVersion('0.6', 'patch'), null, '两段版本号 → null');
eq(nextVersion('v0.6.0', 'patch'), null, '带 v 前缀 → null（版本字段不写 v）');
eq(nextVersion('0.6.0', 'weird'), null, '未知递增类型 → null');
eq(nextVersion('', 'patch'), null, '空串 → null');

console.log('\n--- 4. 仓库不变量 ---');
const pkg = JSON.parse(fs.readFileSync(path.join(dirname, '../package.json'), 'utf8'));
const verSrc = fs.readFileSync(path.join(dirname, '../src/version.ts'), 'utf8');
const m = verSrc.match(/CURRENT_PLUGIN_VERSION\s*=\s*'([^']+)'/);
ok(!!m, 'src/version.ts 里有 CURRENT_PLUGIN_VERSION');
eq(m && m[1], pkg.version, 'package.json 与 src/version.ts 同版');
ok(/^\d+\.\d+\.\d+$/.test(pkg.version), '版本是 x.y.z 形式');

console.log('\n━━━━━━━━━ phase46 汇总 ━━━━━━━━━');
console.log(`通过 ${pass}/${total}`);
if (fails.length > 0) { console.error('失败项：\n- ' + fails.join('\n- ')); process.exit(1); }
