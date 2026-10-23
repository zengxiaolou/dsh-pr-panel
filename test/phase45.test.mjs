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
const login = feats.find((f) => f.label === 'feat/login');
eq(login.items.length, 2, '同一 head 的两个 PR 收成一条（短名也合并）');
eq(login.furthest.id, 'test', '取走得最远的阶段');
eq(login.done, false, '还有未合并 → 未完成');

console.log('\n--- 4. 泳道描述（两种模式同形） ---');
const stageLanes = lanes.buildLanes(sorted, 'stage');
eq(stageLanes.length, 4, '阶段模式 4 段');
eq(stageLanes[0].chip, 'Dev', '阶段模式 chip 是阶段名');
const featLanes = lanes.buildLanes(sorted.concat([]), 'feature');
ok(featLanes.every((l) => typeof l.count === 'number' && Array.isArray(l.items)), '两种模式同一形状');

console.log('\n--- 4.4b 泳道头 tag：完成度而不是环境 ---');
const mk = (num, head, state, merged) => ({ number: num, headRefName: head, baseRefName: 'main', state: state, mergedAt: merged ? '2026-10-22T00:00:00Z' : '' });
const statusOf = (rows) => lanes.buildLanes(rows, 'feature')[0].chip;
eq(statusOf([mk(1, 'fix/solo-a', 'OPEN')]), 'PENDING', '单个未合并 → PENDING');
eq(statusOf([mk(2, 'fix/solo-b', 'MERGED', true)]), 'DONE', '单个已合并 → DONE');
eq(statusOf([mk(3, 'fix/solo-c', 'CLOSED')]), 'CLOSED', '单个已关闭 → CLOSED');
eq(statusOf([mk(4, 'fix/pair-open-a', 'OPEN'), mk(5, 'fix/pair-open-b', 'MERGED', true)]), 'PENDING', '多个里有一个没完成 → PENDING');
eq(statusOf([mk(6, 'fix/pair-closed-a', 'CLOSED'), mk(7, 'fix/pair-closed-b', 'CLOSED')]), 'CLOSED', '全部关闭 → CLOSED');
eq(statusOf([mk(8, 'fix/pair-done-a', 'MERGED', true), mk(9, 'fix/pair-done-b', 'MERGED', true)]), 'DONE', '全部合并 → DONE');
eq(statusOf([mk(10, 'fix/mixboth-case-a', 'MERGED', true), mk(11, 'fix/mixboth-case-b', 'CLOSED')]), 'DONE', '已合并 + 已关闭 → DONE（改动已经进去了）');
// 排序：pending → done → closed
const ordered = lanes.buildLanes([
  mk(20, 'fix/zz-closed', 'CLOSED'),
  mk(21, 'fix/zz-done', 'MERGED', true),
  mk(22, 'fix/zz-open', 'OPEN'),
], 'feature').map((l) => l.chip);
eq(ordered.join(','), 'PENDING,DONE,CLOSED', '泳道排序：要处理的在前，已关闭在最后');

console.log('\n--- 4.5 功能归组：同一条链的分支名必须收成一组 ---');
// 真实数据（2026-10-22 会话 12 条 PR）：同一条链的 head 名一定不同，
// 提交信息与标题也会被改写，只能靠分支名结构判断。
const realRows = [
  { number: 4111, headRefName: 'fix/ci-new-branch-base', baseRefName: 'release_v1.0.80', state: 'OPEN', stage: { id: 'release', order: 30 } },
  { number: 4112, headRefName: 'sync/release-v1.0.80-ci-new-branch-base-20261022', baseRefName: 'main', state: 'OPEN', stage: { id: 'prod', order: 40 } },
  { number: 1989, headRefName: 'fix/backfill-v1.0.67-into-v1.0.68', baseRefName: 'release_v1.0.68', state: 'OPEN', stage: { id: 'release', order: 30 } },
  { number: 1988, headRefName: 'sync/release-v1.0.67-backfill-to-main-20261022', baseRefName: 'main', state: 'OPEN', stage: { id: 'prod', order: 40 } },
  { number: 1621, headRefName: 'fix/backfill-0.1.49-into-0.1.50', baseRefName: 'release_0.1.50', state: 'OPEN', stage: { id: 'release', order: 30 } },
  { number: 1622, headRefName: 'sync/release-0.1.49-backfill-to-main-20261022', baseRefName: 'main', state: 'OPEN', stage: { id: 'prod', order: 40 } },
  { number: 2093, headRefName: 'chore/ci-no-tests-release-0.1.61', baseRefName: 'release_0.1.61', state: 'OPEN', stage: { id: 'release', order: 30 } },
  { number: 4107, headRefName: 'chore/ci-no-tests-release-v1.0.79', baseRefName: 'release_v1.0.79', state: 'OPEN', stage: { id: 'release', order: 30 } },
  { number: 4109, headRefName: 'sync/release-v1.0.79-to-main-20261021', baseRefName: 'main', state: 'OPEN', stage: { id: 'prod', order: 40 } },
  { number: 1620, headRefName: 'sync/release-0.1.49-ci-cleanup', baseRefName: 'main', state: 'OPEN', stage: { id: 'prod', order: 40 } },
  { number: 1618, headRefName: 'release_0.1.49', baseRefName: 'main', state: 'OPEN', stage: { id: 'prod', order: 40 } },
  { number: 4108, headRefName: 'release_v1.0.79', baseRefName: 'main', state: 'OPEN', stage: { id: 'prod', order: 40 } },
];
const realGroups = lanes.groupItemsByFeature(realRows);
eq(realGroups.length, 5, '12 条真实 PR → 5 条功能泳道');
const byKey = (k) => realGroups.find((g) => g.key === k);
eq(byKey('ci-new-branch-base') ? byKey('ci-new-branch-base').items.length : 0, 2, 'ci-new-branch-base 收 2 条（4111 + 4112）');
eq(byKey('ci-new-branch-base') ? byKey('ci-new-branch-base').label : '', 'fix/ci-new-branch-base', '泳道标签用原始功能分支名');
eq(byKey('release-0.1.49') ? byKey('release-0.1.49').items.length : 0, 4, 'release-0.1.49 收 4 条');
eq(byKey('release-v1.0.79') ? byKey('release-v1.0.79').items.length : 0, 3, 'release-v1.0.79 收 3 条');
eq(byKey('ci-no-tests-release-0.1.61') ? byKey('ci-no-tests-release-0.1.61').items.length : 0, 1, '不同版本的同名清理不合并');
ok(realGroups.every((g) => g.items.length > 0), '没有空组');
// Host 与客户端必须同口径，否则以后谁接错都不会报错
const hostGroups = groupPrsByFeature(realRows);
eq(hostGroups.length, 5, 'Host 侧同样是 5 组');
eq(hostGroups.map((g) => g.key).sort().join('|'), realGroups.map((g) => g.key).sort().join('|'), 'Host 与客户端组名完全一致');

console.log('\n--- 4.4 兄弟分支：同一前缀 + 不同后缀 -------------');
// 真实数据（2026-10-22 第二批 12 条）：同一条链的分支是「兄弟名」，
// 互不包含，只共享前缀。这批是靠公共词串聚起来的。
const siblings = [
  { number: 2094, headRefName: 'chore/remove-orphan-vcc-contract-development', baseRefName: 'development', state: 'OPEN', stage: { id: 'dev', label: 'Dev', order: 10 } },
  { number: 2095, headRefName: 'chore/remove-orphan-vcc-contract-test', baseRefName: 'test', state: 'OPEN', stage: { id: 'test', label: 'Test', order: 20 } },
  { number: 2097, headRefName: 'chore/remove-orphan-vcc-contract-release-0.1', baseRefName: 'release_0.1.62', state: 'OPEN', stage: { id: 'release', label: 'Release', order: 30 } },
  { number: 2096, headRefName: 'chore/remove-orphan-vcc-contract-main', baseRefName: 'main', state: 'OPEN', stage: { id: 'prod', label: 'Prod', order: 40 } },
  { number: 2099, headRefName: 'sync/release-0.1.62-orphan-cleanup-to-main-20261022', baseRefName: 'main', state: 'OPEN', stage: { id: 'prod', label: 'Prod', order: 40 } },
  { number: 4120, headRefName: 'ci/main-gate-on-release', baseRefName: 'release_v1.0.80', state: 'OPEN', stage: { id: 'release', label: 'Release', order: 30 } },
  { number: 4116, headRefName: 'sync/release-v1.0.80-main-gate-20261022-v3', baseRefName: 'main', state: 'OPEN', stage: { id: 'prod', label: 'Prod', order: 40 } },
  { number: 4115, headRefName: 'sync/release-v1.0.80-main-gate-20261022-v2', baseRefName: 'main', state: 'OPEN', stage: { id: 'prod', label: 'Prod', order: 40 } },
  { number: 4114, headRefName: 'sync/release-v1.0.80-main-gate-20261022', baseRefName: 'main', state: 'OPEN', stage: { id: 'prod', label: 'Prod', order: 40 } },
  { number: 1990, headRefName: 'chore/ci-drop-dead-jobs-release', baseRefName: 'release_v1.0.68', state: 'OPEN', stage: { id: 'release', label: 'Release', order: 30 } },
  { number: 1991, headRefName: 'chore/ci-drop-dead-jobs-main', baseRefName: 'main', state: 'OPEN', stage: { id: 'prod', label: 'Prod', order: 40 } },
  { number: 1993, headRefName: 'sync/release-v1.0.68-ci-cleanup-to-main-2026', baseRefName: 'main', state: 'OPEN', stage: { id: 'prod', label: 'Prod', order: 40 } },
];
const sib = lanes.groupItemsByFeature(siblings);
eq(sib.length, 3, '第二批 12 条 → 3 条功能泳道');
const sibBy = (k) => sib.find((g) => g.key === k);
eq(sibBy('remove-orphan-vcc-contract') ? sibBy('remove-orphan-vcc-contract').items.length : 0, 5, 'remove-orphan-vcc-contract 收 5 条（含 sync 那条）');
eq(sibBy('main-gate') ? sibBy('main-gate').items.length : 0, 4, 'main-gate 收 4 条');
eq(sibBy('ci-drop-dead-jobs') ? sibBy('ci-drop-dead-jobs').items.length : 0, 3, 'ci-drop-dead-jobs 收 3 条（含 v1.0.68 的 sync）');
// 反向保证：不能靠 sync 套话误并两条无关的链
const falsePair = lanes.groupItemsByFeature([
  { number: 1, headRefName: 'sync/release-0.1.62-orphan-cleanup-to-main-20261022', baseRefName: 'main', state: 'OPEN' },
  { number: 2, headRefName: 'sync/release-v1.0.68-ci-cleanup-to-main-2026', baseRefName: 'main', state: 'OPEN' },
]);
eq(falsePair.length, 2, 'cleanup-to-main 这种套话不能把两条无关链并在一起');
const hostSib = groupPrsByFeature(siblings);
eq(hostSib.length, 3, 'Host 侧同样 3 组');
eq(hostSib.map((g) => g.key).sort().join('|'), sib.map((g) => g.key).sort().join('|'), 'Host 与客户端组名一致');

console.log('\n--- 4.6 标签优先：feature:<名> 高于分支名推断 ---');
const withLabels = [
  // 两条完全无关的分支，但同一个功能标签
  { number: 20, headRefName: 'fix/login-crash', baseRefName: 'release_v1.0.90', labels: ['feature:login-v2'], state: 'OPEN', stage: { id: 'release', order: 30 } },
  { number: 21, headRefName: 'sync/hotfix-xyz-to-main', baseRefName: 'main', labels: [{ name: 'feature:login-v2' }], state: 'OPEN', stage: { id: 'prod', order: 40 } },
  // 同分支不同标签：必须分开
  { number: 22, headRefName: 'fix/shared-branch', baseRefName: 'dev', labels: ['feature:a'], state: 'OPEN', stage: { id: 'dev', order: 10 } },
  { number: 23, headRefName: 'fix/shared-branch', baseRefName: 'dev', labels: ['feature:b'], state: 'OPEN', stage: { id: 'dev', order: 10 } },
  // 一个有标签、一个没有：标签隔离，不按分支名合并
  { number: 24, headRefName: 'fix/ci-new-branch-base', baseRefName: 'dev', labels: ['feature:c'], state: 'OPEN', stage: { id: 'dev', order: 10 } },
  { number: 25, headRefName: 'fix/ci-new-branch-base-extra', baseRefName: 'dev', labels: [], state: 'OPEN', stage: { id: 'dev', order: 10 } },
];
const lab = lanes.groupItemsByFeature(withLabels);
const g1 = lab.filter((g) => g.source === 'label');
eq(g1.length, 4, '带标签的四条各自成组（login-v2 / a / b / c）');
const loginV2 = lab.find((g) => g.key === 'label:login-v2');
ok(!!loginV2, '标签组键为 label:login-v2');
eq(loginV2.items.length, 2, '无关分支但同标签 → 并成一组');
eq(loginV2.label, 'login-v2', '展示名用标签值');
eq(loginV2.furthest.id, 'prod', '取最远阶段');
eq(lab.find((g) => g.key === 'label:a').items.length, 1, '同分支不同标签不合并（a 独组）');
eq(lab.find((g) => g.key === 'label:b').items.length, 1, '同分支不同标签不合并（b 独组）');
eq(lab.find((g) => g.key === 'label:c').items.length, 1, '有标签的那条不被无标签的同名分支带走');
ok(lab.some((g) => g.source === 'branch'), '无标签的仍然走分支名归组');
// 标签写法：feature/x、FEATURE=x 都认
eq(lanes.featureLabelOfItem({ labels: ['feature/pay-v2'] }), 'pay-v2', 'feature/ 前缀可识别');
eq(lanes.featureLabelOfItem({ labels: ['FEATURE=pay-v2'] }), 'pay-v2', '大小写与 = 分隔可识别');
eq(lanes.featureLabelOfItem({ labels: ['bug', 'p1'] }), '', '普通标签不算功能标签');
// Host 与客户端同口径
const hostLab = groupPrsByFeature(withLabels);
eq(hostLab.filter((g) => g.source === 'label').length, 4, 'Host 侧同样是 4 个标签组');
eq(hostLab.find((g) => g.key === 'label:login-v2').items.length, 2, 'Host 侧同标签也并组');
// 真实数据没有标签，结果必须与之前一致
ok(realGroups.every((g) => g.source === 'branch'), '真实 12 条没有标签 → 全部按分支链归组');

console.log('\n--- 4.7 浮窗 CI/CD 紧凑条：一行说清状态 ---');
const { ciWorkflowLine } = await import('../lib/ui/session-pr-panel.js');
const ago = (min) => new Date(Date.now() - min * 60000).toISOString();
eq(ciWorkflowLine({ name: 'A', latest: { status: 'in_progress', active: { stepsDone: 2, stepsTotal: 13, stepName: '运行测试' } } }).text, '3/13 步', '运行中给「第 n/m 步」');
eq(ciWorkflowLine({ name: 'A', latest: { status: 'in_progress' } }).text, '运行中', '没有 steps 时只说运行中');
eq(ciWorkflowLine({ name: 'B', latest: { status: 'completed', conclusion: 'success', completedAt: ago(12) } }).text, '12m 前', '通过给「多久前完成」');
eq(ciWorkflowLine({ name: 'C', latest: { status: 'completed', conclusion: 'failure', completedAt: ago(5) } }).text, '失败 · 5m 前', '失败要显眼');
eq(ciWorkflowLine({ name: 'D', latest: { status: 'queued' } }).text, '排队中', '排队态');
eq(ciWorkflowLine({ name: 'E', latest: { status: 'completed', conclusion: 'cancelled', completedAt: ago(3) } }).text, '已取消 · 3m 前', '取消态');
ok(ciWorkflowLine({ name: 'C', latest: { status: 'completed', conclusion: 'failure' } }).tone === 'fail', '失败态 tone=fail（渲染层据此上色）');

console.log('\n--- 4.8 项目 / worktree 解析 ---');
const { parseGitWorktreeList } = await import('../lib/executor/git-parser.js');
const wtRaw = [
  'worktree /Users/ruler/Documents/work/dsh-github-flow',
  'HEAD 6d177e6abc',
  'branch refs/heads/local/aggregate-root',
  '',
  'worktree /private/tmp/dsh-pub2',
  'HEAD 4c7a7fabcd',
  'branch refs/heads/tmp/pub2',
  'prunable gitdir file points to non-existent location',
  '',
].join('\n');
const wts = parseGitWorktreeList(wtRaw);
eq(wts.length, 2, '解析出 2 个 worktree');
eq(wts[0].branch, 'local/aggregate-root', 'branch 去掉 refs/heads/ 前缀');
eq(wts[0].prunable, false, '普通 worktree 不是 prunable');
eq(wts[1].prunable, true, '识别 prunable（陈旧、目录已不存在）');
eq(wts[1].head.slice(0, 7), '4c7a7fa', 'head 截断由上层做，解析层保留原值');
const detached = parseGitWorktreeList(['worktree /tmp/det', 'HEAD deadbeef', 'detached', ''].join('\n'));
eq(detached[0].detached, true, 'detached 识别');
eq(detached[0].branch, '', 'detached 没有 branch');
const locked = parseGitWorktreeList(['worktree /tmp/lk', 'HEAD abc', 'branch refs/heads/x', 'locked', ''].join('\n'));
eq(locked[0].locked, true, 'locked 识别');
eq(parseGitWorktreeList('').length, 0, '空输入不炸');

console.log('\n--- 4.9 项目 / worktree：多项目 + 截断 ---');
const { limitWorktrees } = await import('../lib/ui/session-pr-panel.js');
const many = Array.from({ length: 14 }, (_, i) => ({ name: 'wt' + i, isCurrent: i === 7, isMain: i === 0 }));
const limited = limitWorktrees(many, 8);
eq(limited.shown.length, 8, '最多展示 8 个');
eq(limited.hidden, 6, '其余折成「另 N 个」');
eq(limited.shown[0].name, 'wt7', '当前 worktree 排第一');
eq(limited.shown[1].name, 'wt0', '主 worktree 排第二');
eq(limitWorktrees([{ name: 'a' }], 8).hidden, 0, '不超上限时没有隐藏项');
eq(limitWorktrees(null, 8).shown.length, 0, '空输入不炸');

console.log('\n--- 4.9b 当前 worktree 选择：分支 > cwd > 主 ---');
const { pickPrimaryWorktree } = await import('../lib/workspace.js');
const wtList = [
  { path: '/w/stars', branch: 'main', name: 'stars' },
  { path: '/w/worktrees/a', branch: 'fix/a', name: 'a' },
  { path: '/w/worktrees/b', branch: 'fix/b', name: 'b' },
];
const byBranch = pickPrimaryWorktree(wtList, ['fix/b', 'fix/a'], '/w/stars');
eq(byBranch.match, 'branch', '有分支线索时按分支命中');
eq(byBranch.primary.name, 'b', '按线索顺序取第一个（最近更新的 PR 在前）');
eq(byBranch.usedCount, 2, '同一会话用到两个 worktree 时计数为 2');
const byCwd = pickPrimaryWorktree(wtList, [], '/w/worktrees/a');
eq(byCwd.match, 'cwd', '没有分支线索时按 cwd 命中');
eq(byCwd.primary.name, 'a', 'cwd 落在哪个 worktree 就是哪个');
const none = pickPrimaryWorktree(wtList, [], '/elsewhere');
eq(none.match, 'none', '两者都没有时不假装正在用');
eq(none.primary.name, 'stars', '退回主 worktree 供参考');
eq(pickPrimaryWorktree([], ['fix/a'], '/w').primary, null, '空列表不炸');
const nested = pickPrimaryWorktree([
  { path: '/w/app', branch: 'x' },
  { path: '/w/app-hotfix', branch: 'y' },
], [], '/w/app-hotfix/src');
eq(nested.primary.path, '/w/app-hotfix', 'cwd 前缀命中取最长路径（避免 app 与 app-hotfix 互认）');

console.log('\n--- 4.10 客户端接口缓存：命中不重发、并发只发一次、force 绕过 ---');
const { fetchJsonCached, __resetApiCache } = await import('../lib/ui/session-pr-panel.js');
let calls = 0;
globalThis.fetch = async () => {
  calls += 1;
  return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, data: { v: calls } }) };
};
__resetApiCache();
const a1 = await fetchJsonCached('/x', 60_000);
const a2 = await fetchJsonCached('/x', 60_000);
eq(calls, 1, 'TTL 内第二次请求命中缓存');
eq(a1.data.v, a2.data.v, '返回的是同一份数据');
await fetchJsonCached('/x', 60_000, true);
eq(calls, 2, 'force 时绕过缓存');
__resetApiCache();
calls = 0;
const p1 = fetchJsonCached('/y', 60_000);
const p2 = fetchJsonCached('/y', 60_000);
await Promise.all([p1, p2]);
eq(calls, 1, '同一 URL 并发挂载只发一次（in-flight 去重）');
__resetApiCache();
calls = 0;
await fetchJsonCached('/z', 0);
await fetchJsonCached('/z', 0);
eq(calls, 2, 'TTL=0 视为不缓存');

console.log('\n--- 4.11 头像：URL 加尺寸 + 渲染点 ---');
const { avatarSrc } = await import('../lib/ui/session-pr-panel.js');
eq(avatarSrc('https://avatars.githubusercontent.com/u/1', 16), 'https://avatars.githubusercontent.com/u/1?s=16', '无查询参数时加 ?s=');
eq(avatarSrc('https://avatars.githubusercontent.com/u/1?v=4', 16), 'https://avatars.githubusercontent.com/u/1?v=4&s=16', '已有参数时用 &');
eq(avatarSrc('https://avatars.githubusercontent.com/u/1?s=40', 16), 'https://avatars.githubusercontent.com/u/1?s=40', '已有 s= 不重复加');
eq(avatarSrc('', 16), '', '空 URL 返回空（调用方退化成首字母）');
eq(avatarSrc(null, 16), '', 'null 不炸');
eq(avatarSrc('https://x/y', 8), 'https://x/y?s=12', '尺寸下限 12（太小会糊）');

console.log('\n--- 4.13 胶囊展开方向：贴边、按空间选向 ---');
const { cardPlacementFor } = await import('../lib/ui/session-pr-panel.js');
// 默认位置（右下角，right 20 / bottom 148）：空间在上方，应向上展开且右对齐
const dflt = cardPlacementFor(null, 1440, 900);
eq(dflt.openDown, false, '默认右下角的胶囊：向上展开（下方只有 148px）');
eq(dflt.openRight, false, '默认位置右侧空间不足 → 向左展开，卡右边缘贴胶囊右边缘');
eq(dflt.style.right, (1440 - (1440 - 20)) + 'px', '右边缘与胶囊对齐（right=20）');
eq(dflt.style.width, '372px', '宽度固定 372');
ok(dflt.maxHeight <= 470, '最大高度不超过 470');
// 拖到左上角：右侧空间充足 → 向右展开、向下展开
const topLeft = cardPlacementFor({ x: 40, y: 60 }, 1440, 900);
eq(topLeft.openRight, true, '胶囊在左侧时向右展开');
eq(topLeft.openDown, true, '胶囊在上方时向下展开');
eq(topLeft.style.left, (40 + 110) + 'px', '左边缘贴胶囊右边缘');
eq(topLeft.style.top, (60 + 30) + 'px', '上边缘贴胶囊下边缘');
// 拖到屏幕正中间：两侧都不够宽 → 向左（贴右），纵向按空间大的一侧
const mid = cardPlacementFor({ x: 700, y: 400 }, 1440, 900);
eq(mid.openRight, false, '中间位置右侧不够 372 → 向左');
ok(mid.maxHeight >= 180, '极小空间也有可用高度（下限 180）');
// 视口很矮时不能把卡片挤成 0 高
const tiny = cardPlacementFor({ x: 100, y: 100 }, 800, 300);
ok(tiny.maxHeight >= 180, '矮视口仍保底 180 高');

console.log('\n--- 4.14 运行展示窗口：未完成 + 最近 30 分钟 ---');
const { isRunWorthShowing } = await import('../lib/ci-summary.js');
const nowMs = Date.now();
const minsAgo = (m) => new Date(nowMs - m * 60000).toISOString();
ok(isRunWorthShowing({ status: 'in_progress' }, nowMs), '运行中一定显示');
ok(isRunWorthShowing({ status: 'queued' }, nowMs), '排队中也显示');
ok(isRunWorthShowing({ status: 'completed', conclusion: 'success', updatedAt: minsAgo(5) }, nowMs), '5 分钟前完成 → 显示');
ok(isRunWorthShowing({ status: 'completed', conclusion: 'failure', updatedAt: minsAgo(29) }, nowMs), '29 分钟前完成 → 显示');
ok(!isRunWorthShowing({ status: 'completed', conclusion: 'success', updatedAt: minsAgo(31) }, nowMs), '31 分钟前完成 → 不显示');
ok(!isRunWorthShowing({ status: 'completed', conclusion: 'success', updatedAt: minsAgo(8 * 60) }, nowMs), '8 小时前 → 不显示');
ok(!isRunWorthShowing({ status: 'completed' }, nowMs), '没有时间戳 → 不显示（宁可少显示）');

console.log('\n--- 4.15 功能列表只取最近 20 条 ---');
const { pickRecentPrs } = await import('../lib/ui/session-pr-panel.js');
const mkPr = (n, hoursAgo) => ({ number: n, updatedAt: new Date(Date.now() - hoursAgo * 3600000).toISOString() });
const prBatch = Array.from({ length: 57 }, (_, i) => mkPr(4000 + i, i + 1));
const recent = pickRecentPrs(prBatch, 20);
eq(recent.length, 20, '57 条只取 20 条');
eq(recent[0].number, 4000, '最新的一条排第一');
ok(recent.every((p, i) => i === 0 || Date.parse(recent[i - 1].updatedAt) >= Date.parse(p.updatedAt)), '按更新时间倒序');
eq(pickRecentPrs(prBatch.slice(0, 5), 20).length, 5, '不足 20 条时全给');
eq(pickRecentPrs([{ number: 1 }, { number: 2, updatedAt: 'bad' }], 20).length, 2, '时间戳缺失/非法不丢条目');
eq(pickRecentPrs([], 20).length, 0, '空列表不炸');

console.log('\n--- 4.16 下滑加载更多 ---');
const { shouldLoadMore } = await import('../lib/ui/pr-lanes.js');
ok(shouldLoadMore(900, 400, 1300), '滑到底部 → 触发加载');
ok(shouldLoadMore(860, 400, 1300), '距底 40px 提前触发');
ok(!shouldLoadMore(0, 400, 1300), '在顶部不触发');
ok(!shouldLoadMore(0, 400, 400), '没有可滚动空间时不触发');
ok(!shouldLoadMore(100, 400, 900), '离底部还远不触发');

console.log('\n--- 4.17 关注度：该看哪一条 ---');
const { prAttention } = await import('../lib/ui/pr-lanes.js');
eq(prAttention({ state: 'OPEN', checks: { state: 'pass', total: 6, failing: 0 } }), 0, '全绿且无冲突 → 0');
eq(prAttention({ state: 'OPEN', checks: { state: 'pending', total: 6, failing: 0 } }), 1, '检查进行中 → 1 留意');
eq(prAttention({ state: 'OPEN', reviewDecision: 'CHANGES_REQUESTED' }), 2, '要求修改 → 2 待处理');
eq(prAttention({ state: 'OPEN', reviewRequested: ['me'] }), 2, '待我评审 → 2 待处理');
eq(prAttention({ state: 'OPEN', checks: { state: 'fail', total: 6, failing: 2 } }), 3, 'CI 失败 → 3 阻塞');
eq(prAttention({ state: 'OPEN', mergeable: 'CONFLICTING' }), 3, '有冲突 → 3 阻塞');
eq(prAttention({ state: 'OPEN', mergeStateStatus: 'DIRTY' }), 3, 'DIRTY → 3 阻塞');
eq(prAttention({ state: 'MERGED' }), 0, '已合并不再需要动作');
eq(prAttention(null), 0, '空值不炸');

console.log('\n--- 5. 样式与模块真的进了 bundle ---');
const client = fs.readFileSync(path.join(dirname, '../lib/client.js'), 'utf8');
console.log('\n--- 4.12 CI/CD tab：本会话 PR 的 Actions（PR 校验 + 合并后） ---');
ok(client.includes('function ActionsBlock'), 'CI/CD tab 用 Actions 运行列表');
ok(client.includes('/api/github/pr-runs'), '按 PR 取运行，不是仓库级');
ok(client.includes('ghsp-run-phase'), '每条运行标出阶段');
ok(client.includes('合并后'), '区分「PR 校验」与「合并后」');
const routesCi = fs.readFileSync(path.join(dirname, '../lib/api/routes-actions.js'), 'utf8');
ok(routesCi.includes('/api/github/pr-runs'), '路由已注册 PR 运行接口');
ok(/actions\/runs\?branch=/.test(routesCi), '按分支过滤运行（head 与 base）');
ok(client.includes('宿主还没重启'), '宿主版本落后时给出可行动的提示，而不是抛 404');
ok(client.includes('React.useState("rebase")'), '合并方式默认 rebase');
ok(client.includes('近 30 分钟没有运行'), '无近期运行的分支折成一行说明');
ok(client.includes('ghsp-checks-num'), '行内显示检查通过数 n/m');
ok(client.includes('ghsp-attn'), '需要处理的 PR 有标记');
ok(client.includes('window.addEventListener("keydown"'), '浮窗支持键盘导航');
ok(client.includes('ghsp-row.sel'), '键盘选中行有高亮');
ok(client.includes('prune --dry-run'), 'worktree 清理只给预览命令，不代执行');
ok(client.includes('pickRecentPrs(items, visiblePrs)'), '浮窗按可见条数渲染（默认 20）');
ok(client.includes('setVisiblePrs'), '滑到底会递增可见条数');
eq(client.includes('已显示 '), true, '提示显示「已显示 N / M 条」');
ok(client.includes('继续下滑加载更多'), '有「继续下滑」提示');
ok(client.includes('var allowed = ["squash", "merge", "rebase"]'), '仓库不允许 rebase 时仍会回退到可用项');
ok(client.includes('ghsp-note-warn'), '提示条有独立样式（不占据内容区）');

console.log('\n━━━━━━━━━ phase45 汇总 ━━━━━━━━━');
console.log(`通过 ${pass}/${total}`);
if (fails.length > 0) { console.error('失败项：\n- ' + fails.join('\n- ')); process.exit(1); }
