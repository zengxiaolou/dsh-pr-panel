// test/phase42.test.mjs - Phase 42 · 头部按钮只反映「现在真的能做什么」
//
// 现场（2026-10-21）：PR 有 1 项检查失败 + 评审要求修改，头部「合并」看起来仍然可点。
// 用户要的是二选一：要么把不能操作的按钮明确置灰并说明原因，要么干脆只留能操作的。
//
// 现在的契约：
// 1. 有失败检查 → 合并禁用，原因写「N 项检查未通过」；行内给一条「不能合并：…」提示。
// 2. 评审要求修改 → 合并禁用（若没有更靠前的阻塞原因），提示里出现「评审要求修改」。
// 3. 已批准过 → 批准按钮禁用，标题说明「你已经批准过」。
// 4. 冲突（DIRTY）→ 批准与合并都禁用，提示含「有合并冲突」。
// 5. 已合并的 PR → 整排审批按钮不渲染（沿用既有行为）。

import assert from 'node:assert';
import { createRenderer } from './render/react-stub.mjs';

let pass = 0; let total = 0; const fails = [];
function ok(cond, name) { total += 1; if (cond) pass += 1; else { fails.push(name); console.error('❌ ' + name); } }

globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.document = { addEventListener() {}, removeEventListener() {}, hidden: false, body: { style: {} }, head: { appendChild() {} }, getElementById: () => null, querySelectorAll: () => [], createElement: () => ({ setAttribute() {}, appendChild() {}, remove() {}, style: {} }) };
globalThis.window = { document: globalThis.document, addEventListener() {}, removeEventListener() {}, setTimeout: (f, m) => setTimeout(f, m), clearTimeout: (t) => clearTimeout(t), open() {}, innerWidth: 1280, innerHeight: 800 };
globalThis.navigator = { clipboard: { writeText: () => Promise.resolve() } };

const panel = await import('../lib/ui/session-pr-panel.js');
const { SessionPrPanel, resetSessionPrModuleState } = panel;

const REPO = 'acme/demo';
const NUMBER = 700;

function prFixture(over = {}) {
  return {
    number: NUMBER, title: 'fix: gating', state: 'OPEN', isDraft: false,
    url: 'https://github.com/acme/demo/pull/700', headRefName: 'fix/x', baseRefName: 'development',
    headRefOid: '0123456789abcdef0123456789abcdef01234567',
    mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED', autoMergeRequest: null,
    additions: 1, deletions: 1, changedFiles: 1, author: { login: 'someone' }, body: '',
    reviews: [], comments: [], commits: [], files: [],
    statusCheckRollup: [], ...over,
  };
}

async function mount(pr) {
  resetSessionPrModuleState();
  const r = createRenderer();
  r.setFetch(async (record) => {
    const u = String((record && record.url) || record);
    if (u.includes('/api/github/pr-detail')) return { ok: true, data: { pr } };
    if (u.includes('/api/github/pr-thread')) return { ok: true, data: { reviews: pr.reviews || [], comments: [], commits: [] } };
    if (u.includes('/api/github/pr-files')) return { ok: true, data: { files: [] } };
    if (u.includes('merge-methods')) return { ok: true, data: { squash: true, merge: true, rebase: true } };
    return { ok: true, data: { items: [] } };
  });
  await r.mount(SessionPrPanel, {
    sessionId: 's1',
    inputActions: { insertText() { return true; } },
    onOpenUrl() {},
    useTabInfo: () => ({ tab: { navigation: { params: { repo: REPO, number: NUMBER } } } }),
  });
  return r;
}

function button(r, label) {
  return r.find((n) => n && n.props && n.props.className && String(n.props.className).includes('ghsp-btn') && r.text(n).trim() === label);
}

const FAIL_CHECK = { __typename: 'CheckRun', name: 'hermes/review-gate', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'u' };

/* 1. 失败检查 → 合并禁用 + 原因 + 行内提示 */
{
  const r = await mount(prFixture({ statusCheckRollup: [FAIL_CHECK], reviewDecision: 'CHANGES_REQUESTED' }));
  const merge = button(r, '合并');
  ok(merge && merge.props.disabled === true, '有失败检查时合并必须禁用');
  ok(merge && String(merge.props.title).includes('检查未通过'), `禁用原因要说明是检查未过（实际 ${merge && merge.props.title}）`);
  ok(/不能合并：/.test(r.text()) && /检查未通过/.test(r.text()), '行内必须有「不能合并：…」提示');
  ok(/评审要求修改/.test(r.text()), '提示里要包含评审要求修改');
  const approve = button(r, '批准');
  ok(approve && approve.props.disabled !== true, '别人发的 PR、评审要求修改时仍可批准');
  r.dispose();
}

/* 2. 已批准 → 批准禁用 */
{
  const r = await mount(prFixture({ reviewDecision: 'APPROVED', statusCheckRollup: [] }));
  const approve = button(r, '批准');
  ok(approve && approve.props.disabled === true, '已批准过就不能再点批准');
  ok(approve && String(approve.props.title).includes('已经批准过'), '标题要说明已批准过');
  r.dispose();
}

/* 3. 冲突 → 批准与合并都禁用 */
{
  const r = await mount(prFixture({ mergeStateStatus: 'DIRTY', statusCheckRollup: [] }));
  ok(button(r, '合并').props.disabled === true, 'DIRTY 时合并禁用');
  ok(button(r, '批准').props.disabled === true, 'DIRTY 时批准也禁用');
  ok(/有合并冲突/.test(r.text()), '提示里要有「有合并冲突」');
  r.dispose();
}

/* 4. 一切正常 → 都能点 */
{
  const r = await mount(prFixture({ mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED', statusCheckRollup: [] }));
  ok(button(r, '合并').props.disabled !== true, 'CLEAN 时合并可点');
  ok(!/不能合并：/.test(r.text()), '全部满足时不该出现阻塞提示');
  r.dispose();
}

/* 5. 已合并 → 不渲染审批按钮 */
{
  const r = await mount(prFixture({ state: 'MERGED', mergedAt: '2026-10-20T00:00:00Z' }));
  ok(!button(r, '合并') && !button(r, '批准'), '已合并的 PR 不应渲染审批按钮');
  ok(!/不能合并：/.test(r.text()), '已合并时不再显示阻塞提示');
  r.dispose();
}

assert.ok(true);
console.log(`\n===== Phase 42: ${pass}/${total} PASS =====`);
process.exit(fails.length ? 1 : 0);
