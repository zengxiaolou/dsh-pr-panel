// test/phase41.test.mjs - Phase 41 · 写操作后的乐观更新 + 详情快路径接线
//
// 为什么：合并/批准成功后，之前要等一次后台往返（~0.8s）界面才变，用户会以为「点了没反应」。
// 现在先用用户意图改本地状态（按钮立刻消失/徽标立刻变），再让后台刷新对账。
//
// 同时钉住详情快路径的接线（Host 侧 HTTP GraphQL 只在 withThread=0 时启用，
// 失败自动退回 gh —— 测试环境 HTTP 被关掉，所以这里只做静态契约）。

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
const NUMBER = 630;
const BASE_PR = {
  number: NUMBER, title: 'fix: 乐观更新', state: 'OPEN', isDraft: false, url: 'https://github.com/acme/demo/pull/630',
  headRefName: 'fix/x', baseRefName: 'main', headRefOid: '0123456789abcdef0123456789abcdef01234567',
  mergeStateStatus: 'CLEAN', reviewDecision: 'REVIEW_REQUIRED', autoMergeRequest: null,
  additions: 1, deletions: 1, changedFiles: 1, author: { login: 'someone' }, body: '', reviews: [], comments: [], commits: [], statusCheckRollup: [], files: [],
};

/* 关键：详情接口始终返回 OPEN —— 如果界面变了，只可能来自乐观更新 */
function makeFetch(state) {
  return async (record) => {
    const u = String((record && record.url) || record);
    if (u.includes('/api/github/session-created-prs')) return { ok: true, data: { items: [], total: 0 } };
    if (u.includes('/api/github/pr-detail')) {
      // 写操作之后让详情请求**永远挂起**：此时界面若变了，只可能来自乐观更新
      if (state.wroteAt) return new Promise(() => {});
      return { ok: true, data: { pr: { ...BASE_PR } } };
    }
    if (u.includes('/api/github/pr-thread')) return { ok: true, data: { reviews: [], comments: [], commits: [] } };
    if (u.includes('/api/github/pr-files')) return { ok: true, data: { files: [] } };
    if (u.includes('/api/github/repo-merge-methods')) return { ok: true, data: { squash: true, merge: true, rebase: true } };
    if (record.method === 'POST') {
      state.posts.push({ url: u, body: JSON.parse(record.opts.body || '{}') });
      state.wroteAt = Date.now();
      return { ok: true, data: { message: '已提交' } };
    }
    return { ok: true, data: {} };
  };
}

async function mount() {
  resetSessionPrModuleState();
  const state = { posts: [], wroteAt: 0 };
  const r = createRenderer();
  r.setFetch(makeFetch(state));
  await r.mount(SessionPrPanel, {
    sessionId: 's1',
    inputActions: { insertText() { return true; } },
    onOpenUrl() {},
    useTabInfo: () => ({ tab: { navigation: { params: { repo: REPO, number: NUMBER } } } }),
  });
  return { r, state };
}

const hasText = (r, re) => re.test(r.text());

/* 1. 合并成功后：不依赖后台刷新，审批按钮立刻消失 */
{
  const { r, state } = await mount();
  ok(hasText(r, /合并/), '初始应能看到合并按钮');
  await r.click('合并');
  await r.click(/确认合并/);
  await new Promise((res) => setTimeout(res, 50));
  const mergePost = state.posts.find((p) => p.url.includes('/api/github/pr-merge'));
  ok(Boolean(mergePost), '必须真的发出合并请求');
  ok(!hasText(r, /^合并$/m) && !hasText(r, /确认合并/), '合并成功后合并按钮必须立刻消失（乐观更新，等不到后台刷新）');
  r.dispose();
}

/* 2. 批准成功后：不再显示「批准」，评审结论立刻变成 APPROVED */
{
  const { r, state } = await mount();
  ok(hasText(r, /批准/), '初始应有批准按钮');
  await r.click('批准');
  await new Promise((res) => setTimeout(res, 50));
  const reviewPost = state.posts.find((p) => p.url.includes('/api/github/pr-review-submit'));
  ok(Boolean(reviewPost) && reviewPost.body.event === 'APPROVE', '必须发出 APPROVE 评审');
  ok(hasText(r, /APPROVED|已批准/), '评审结论必须立刻变成 APPROVED');
  r.dispose();
}

/* 3. Host 详情快路径的静态契约 */
const fs = await import('node:fs');
const routes = fs.readFileSync('src/api/routes-actions.ts', 'utf8');
ok(/if \(!withThread && explicitRepo\)/.test(routes), '快路径必须只在 withThread=0 时启用（旧调用方仍走 gh）');
ok(/githubGraphql<any>\(q, \{ owner, name, number \}\)/.test(routes), '必须用 GraphQL 走 HTTP 快路径');
ok(/statusCheckRollup: \(\(node\.statusCheckRollup/.test(routes), '必须把 GraphQL 的 contexts 归一成 gh 的形状');
ok(/autoMergeRequest: node\.autoMergeRequest \|\| null/.test(routes), 'autoMergeRequest 必须透传（按钮门控依赖它）');
assert.ok(true);

console.log(`\n===== Phase 41: ${pass}/${total} PASS =====`);
process.exit(fails.length ? 1 : 0);
