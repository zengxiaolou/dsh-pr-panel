// test/phase45.test.mjs - Phase 45 · 流水线阶段与泳道分组
//
// 为什么要有这条：阶段泳道是「顺序即进度」的功能，判错一个分支名就会把
// 一个功能标到错误的阶段上，而界面上看起来「挺正常」。所以判定规则、排序、
// 功能归组三件事都要有断言。
//
// 覆盖：
// 1. 分支名 → 阶段（含不该误判的命名）
// 2. Host 排序：Dev → Test → Release → Prod，阶段内待审在前
// 3. 功能归组：同一 head 收成一条，取走得最远的阶段
// 4. 样式真的进了 bundle（漏登记在运行期只会表现为「没有分组」）

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

const {
  resolvePipelineStage, sortPrsByStage, groupPrsByFeature, PIPELINE_STAGES,
} = await import('../lib/pipeline-stage.js');
const lanes = await import('../lib/ui/pr-lanes.js');

console.log('\n--- 1. 分支名 → 阶段 ---');
eq(resolvePipelineStage({ baseRefName: 'dev' }).id, 'dev', 'dev → Dev');
eq(resolvePipelineStage({ baseRefName: 'develop' }).id, 'dev', 'develop → Dev');
eq(resolvePipelineStage({ baseRefName: 'qa' }).id, 'test', 'qa → Test');
eq(resolvePipelineStage({ baseRefName: 'release/1.2' }).id, 'release', 'release/1.2 → Release');
eq(resolvePipelineStage({ baseRefName: 'release_v1.0.80' }).id, 'release', 'release_v1.0.80 → Release（本项目真实分支名）');
eq(resolvePipelineStage({ baseRefName: 'main' }).id, 'prod', 'main → Prod');
eq(resolvePipelineStage({ baseRefName: 'origin/dev' }).id, 'dev', 'origin/dev 也认');
eq(resolvePipelineStage({ baseRefName: 'release-notes-bot' }).id, 'other', 'release-notes-bot 不误判');
eq(resolvePipelineStage({ baseRefName: 'feature/dev-tools' }).id, 'other', 'feature/dev-tools 不误判');
eq(resolvePipelineStage({}).id, 'other', '空输入 → other');

console.log('\n--- 2. 排序：顺序即进度 ---');
const rows = [
  { number: 1, baseRefName: 'main', state: 'OPEN' },
  { number: 2, baseRefName: 'dev', state: 'OPEN', updatedAt: '2026-10-22T01:00:00Z' },
  { number: 3, baseRefName: 'qa', state: 'OPEN' },
  { number: 4, baseRefName: 'release_v1.0.80', state: 'OPEN' },
];
const sorted = sortPrsByStage(rows);
eq(sorted.map((r) => r.stage.id).join(','), 'dev,test,release,prod', 'Dev → Test → Release → Prod');
ok(sorted.every((r) => r.stageId === r.stage.id), 'stageId 与 stage.id 一致（渲染层两处都用）');
eq(PIPELINE_STAGES.length, 5, '阶段表 5 段');

console.log('\n--- 3. 功能归组 ---');
const feats = groupPrsByFeature([
  { number: 10, headRefName: 'feat/login', baseRefName: 'dev', state: 'OPEN', stage: { id: 'dev', order: 10 } },
  { number: 11, headRefName: 'feat/login', baseRefName: 'qa', state: 'OPEN', stage: { id: 'test', order: 20 } },
  { number: 12, headRefName: 'feat/pay', baseRefName: 'dev', state: 'MERGED', mergedAt: '2026-10-21T00:00:00Z', stage: { id: 'dev', order: 10 } },
]);
eq(feats.length, 2, '两条功能泳道');
const login = feats.find((f) => f.key === 'feat/login');
eq(login.items.length, 2, '同一 head 的两个 PR 收成一条');
eq(login.furthest.id, 'test', '取走得最远的阶段');
eq(login.done, false, '还有未合并 → 未完成');

console.log('\n--- 4. 泳道描述（两种模式同形） ---');
const stageLanes = lanes.buildLanes(sorted, 'stage');
eq(stageLanes.length, 4, '阶段模式 4 段');
eq(stageLanes[0].chip, 'Dev', '阶段模式 chip 是阶段名');
const featLanes = lanes.buildLanes(sorted.concat([]), 'feature');
ok(featLanes.every((l) => typeof l.count === 'number' && Array.isArray(l.items)), '两种模式同一形状');

console.log('\n--- 4.5 功能归组：按版本聚合，而不是按 head ---');
const chain = lanes.groupItemsByFeature([
  { number: 1, headRefName: 'fix/backfill-v1.0.67-into-v1.0.68', baseRefName: 'release_v1.0.68', title: 'fix(release): 回填 v1.0.67 未进入 v1.0.68 的 13 个提交', state: 'OPEN', stage: { id: 'release', order: 30 } },
  { number: 2, headRefName: 'sync/release-v1.0.67-backfill-to-main', baseRefName: 'main', title: 'fix(release): main 补回 v1.0.67 缺失的 13 个提交', state: 'OPEN', stage: { id: 'prod', order: 40 } },
  { number: 3, headRefName: 'feat/login', baseRefName: 'dev', title: 'feat: 登录页', state: 'OPEN', stage: { id: 'dev', order: 10 } },
  { number: 4, headRefName: 'feat/pay', baseRefName: 'dev', title: 'feat: 支付页', state: 'OPEN', stage: { id: 'dev', order: 10 } },
]);
eq(chain.length, 3, '同版本的两个不同 head 收成一条，没版本号的按 head 分开');
const v67 = chain.find((g) => g.key === 'v1.0.67');
ok(!!v67, '版本键是 v1.0.67');
eq(v67.items.length, 2, '两个分支上的同版本 PR 收在一组');
eq(v67.furthest.id, 'prod', '取走得最远的阶段（Prod）');
// Host 与客户端两套归组必须同一口径，否则「未来谁接错了」会静默分组错
const hostChain = groupPrsByFeature([
  { number: 1, headRefName: 'fix/backfill-v1.0.67-into-v1.0.68', baseRefName: 'release_v1.0.68', state: 'OPEN' },
  { number: 2, headRefName: 'sync/release-v1.0.67-backfill-to-main', baseRefName: 'main', state: 'OPEN' },
]);
eq(hostChain.length, 1, 'Host 侧归组同样按版本聚合');
eq(hostChain[0].key, 'v1.0.67', 'Host 侧键也是 v1.0.67');

console.log('\n--- 5. 样式与模块真的进了 bundle ---');
const client = fs.readFileSync(path.join(dirname, '../lib/client.js'), 'utf8');
ok(client.includes('// ---- [Bundled: pr-lanes.js] ----'), 'pr-lanes 已打进 bundle');
ok(client.includes('.ghsp-lane-chip'), '泳道标签样式已打包');
ok(client.includes('.ghsp-mode-btn.active'), '视图切换样式已打包');
ok(/\.ghsp-head\{[^}]*border-radius:12px/.test(client), '头部卡片圆角规则已打包（与内容卡片同宽同圆角）');
const routes = fs.readFileSync(path.join(dirname, '../lib/api/routes-actions.js'), 'utf8');
ok(routes.includes('resolvePipelineStage'), '路由已解析阶段');
ok(routes.includes('sortPrsByStage'), '路由已按阶段排序');

console.log('\n━━━━━━━━━ phase45 汇总 ━━━━━━━━━');
console.log(`通过 ${pass}/${total}`);
if (fails.length > 0) { console.error('失败项：\n- ' + fails.join('\n- ')); process.exit(1); }
