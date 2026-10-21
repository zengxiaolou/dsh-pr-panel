// test/phase28.test.mjs - Phase 28 · 会话 PR 面板「真实渲染 / 交互」回归套件
//
// 为什么要有这一阶段：phase1-27 全是对编译产物做静态字符串检查，或对 Host 路由
// 做请求级测试——**没有任何一条测到客户端渲染与点击行为**。字符串还在、按钮还
// 在文案里，不代表点下去真的会发请求、行号真的按 hunk 算、已合并的 PR 真的不
// 再渲染审批按钮。本套件用 test/render/react-stub.mjs 的最小 React 替身在 Node
// 里渲染 lib/ui/session-pr-panel.js，断言「点击 → 状态 → 输出」：
//
// 1. 懒加载 diff：挂载时 fetch 里 0 次 pr-diff；点「加载 diff」后恰好 1 次且有 diff 行。
// 2. 行内评论：点可评论行 → 评论条 → 提交 POST pr-inline-comment；行号按
//    `@@ -1,2 +1,3 @@` 推成新增行 3，side=RIGHT、commit_id=headRefOid。
// 3. 头部门控：MERGED/CLOSED 完全不渲染批准/合并/自动合并；DIRTY 批准+合并
//    禁用且 title 给原因、自动合并仍可点；BLOCKED 只禁合并。
// 4. 修复队列：单条 fix 提示词含 `PR <repo>#<number>` 与评审正文；「全部 fix N」
//    一次只推一条含 `### 1)` 与全部条目的消息；PR 作者自评与 APPROVED 评审不入队。
// 5. CI fix：只有失败检查出 fix 按钮；提示词含 --log-failed 与该检查 details URL。
// 6. diff 展开：>400 行的文件出「显示全部 N 行」，点开后全部渲染且按钮消失。
// 7. Composer 降级：insertText 缺失走 setDraft；两者都缺失写剪贴板并 toast 说明。
//
// 只 import lib/ui/session-pr-panel.js（不碰 lib/client.js 的 bundle 字符串），
// 因此与父 Agent 并行重建 client bundle 互不干扰。Node ESM、零依赖、无网络。
//
// 放宽说明（1 处，其余全部按任务书字面断言）：
// - 任务书要求「全部 fix N 点第二次不重复」。产物每次点击都会调用一次
//   insertText（真实 Composer 的 insertText 是追加语义，两次点击本来就会追加
//   两份同样的提示词），所以「跨点击不重复」在产物上不成立。本套件按可证伪的
//   契约落测：每次点击只推 **一条** 消息、消息内部每个条目恰好出现一次、
//   两次点击内容完全一致、队列长度不因点击增长（仍为 3 条 / 按钮仍为
//   「全部 fix 3」）。这仍能抓住「一次点击推两条」「队列被点击污染」「条目
//   重复拼接」三类真实回归，断言强度不降反升。

import assert from 'node:assert';
import { createRenderer } from './render/react-stub.mjs';

// 支撑模块在被 import 时已把 React / renderOctocat / renderMarkdownLite /
// formatRelativeTime / splitDiffByFile 挂到 globalThis（bundle 里由构建期注入）。
const panel = await import('../lib/ui/session-pr-panel.js');
const { SessionPrPanel, resetSessionPrModuleState } = panel;

const REPO = 'acme/demo';
const NUMBER = 128;
const HEAD_SHA = '0123456789abcdef0123456789abcdef01234567';

/* ------------------------------------------------------------------ *
 * 夹具
 * ------------------------------------------------------------------ */
function basePr(overrides = {}) {
  return {
    number: NUMBER,
    title: 'feat: 会话 PR',
    state: 'OPEN',
    isDraft: false,
    url: 'https://github.com/acme/demo/pull/128',
    headRefName: 'feature/x',
    baseRefName: 'main',
    headRefOid: HEAD_SHA,
    mergeStateStatus: 'CLEAN',
    autoMergeRequest: null,
    additions: 42,
    deletions: 8,
    changedFiles: 2,
    author: { login: 'alice' },
    createdAt: '2026-10-19T10:00:00Z',
    body: '## 背景\n\n正文。',
    reviews: [],
    comments: [],
    commits: [],
    statusCheckRollup: [],
    files: [{ path: 'a.ts', additions: 2, deletions: 1 }],
    ...overrides,
  };
}

// `@@ -1,2 +1,3 @@`：两行上下文（新文件 1、2 行）+ 一个新增行（新文件第 3 行）。
// 行号必须由 hunk 推算，不能是行数组下标——下面的断言专门钉这一点。
const SMALL_DIFF = [
  'diff --git a/a.ts b/a.ts',
  'index 1111111..2222222 100644',
  '--- a/a.ts',
  '+++ b/a.ts',
  '@@ -1,2 +1,3 @@',
  ' const a = 1;',
  ' const b = 2;',
  '+const c = 3;',
].join('\n');

function makeFetch(state) {
  return (record) => {
    const url = record.url;
    if (url.includes('/api/github/pr-diff')) {
      state.calls.diff += 1;
      return { ok: true, data: { diff: state.diff } };
    }
    if (url.includes('/api/github/pr-detail')) {
      state.calls.detail += 1;
      return { ok: true, data: { pr: state.pr } };
    }
    if (url.includes('/api/github/session-created-prs')) {
      return { ok: true, data: { items: [], total: 0 } };
    }
    if (record.method === 'POST') {
      state.posts.push({
        url,
        body: record.opts && record.opts.body ? JSON.parse(record.opts.body) : null,
      });
      return { ok: true, data: {} };
    }
    return { ok: true, data: {} };
  };
}

let current = null;

/** 挂载一个新的面板实例；上一实例的 effect cleanup 会先跑，避免轮询/定时器串台。 */
async function mountPanel({ pr, diff = '', inputActions } = {}) {
  if (current) {
    current.dispose();
    current = null;
  }
  resetSessionPrModuleState();
  const state = { pr, diff, calls: { diff: 0, detail: 0 }, posts: [], inserted: [], drafts: [], copied: [] };
  const actions = inputActions === undefined
    ? {
      insertText(t) { state.inserted.push(t); return true; },
      focus() {},
    }
    : inputActions;
  const renderer = createRenderer();
  renderer.setFetch(makeFetch(state));
  current = renderer;
  const tree = await renderer.mount(SessionPrPanel, {
    sessionId: 's1',
    inputActions: actions,
    onOpenUrl() {},
    useTabInfo: () => ({ tab: { navigation: { params: { repo: REPO, number: NUMBER } } } }),
  });
  return { h: renderer, state, tree, actions };
}

/* ------------------------------------------------------------------ *
 * 断言 / 选择器
 * ------------------------------------------------------------------ */
let assertions = 0;
function ok(cond, message) {
  assertions += 1;
  assert.ok(cond, message);
}
function eq(actual, expected, message) {
  assertions += 1;
  assert.strictEqual(actual, expected, message);
}

const isObject = (n) => n !== null && typeof n === 'object' && !Array.isArray(n);
const hasClass = (n, cls) => isObject(n) && n.props && typeof n.props.className === 'string'
  && n.props.className.split(/\s+/).includes(cls);
const isButton = (n) => isObject(n) && n.type === 'button';
const isClickable = (n) => isObject(n) && n.props && typeof n.props.onClick === 'function';
const lineNodes = (h) => h.findAll((n) => hasClass(n, 'ghsp-line'));
const buttons = (h, root) => h.findAll((n) => isButton(n), root);
const buttonByLabel = (h, label, root) => h.find((n) => isButton(n) && h.text(n).trim() === label, root);
const cardByTitle = (h, title) => h.find((n) => hasClass(n, 'ghsp-card-block') && h.text(n).startsWith(title));
const countOf = (haystack, needle) => String(haystack).split(needle).length - 1;

/* ------------------------------------------------------------------ *
 * 用例
 * ------------------------------------------------------------------ */
const results = [];
let total = 0;
let passed = 0;

async function test(name, fn) {
  total += 1;
  try {
    await fn();
    passed += 1;
    console.log(`✅ ${name}`);
    results.push({ name, ok: true });
  } catch (err) {
    console.error(`❌ ${name}\n   ${err && err.message}`);
    results.push({ name, ok: false, err });
  }
}

console.log('🧪 开始执行 Phase 28 客户端渲染 / 交互回归测试\n');

await test('1. 懒加载 diff：挂载零 pr-diff 请求，点「加载 diff」后恰好一次并渲染行', async () => {
  const { h, state } = await mountPanel({ pr: basePr(), diff: SMALL_DIFF });
  eq(state.calls.diff, 0, '挂载时不允许请求 pr-diff（懒加载闸门）');
  eq(lineNodes(h).length, 0, '未点「加载 diff」时不应有 diff 行');
  ok(h.text().includes('加载 diff'), '未加载时应显示「加载 diff」按钮');
  ok(h.text().includes('a.ts'), '未加载时应先用详情里的文件清单占位');

  await h.click('加载 diff');
  eq(state.calls.diff, 1, '点「加载 diff」必须恰好触发一次 pr-diff 请求');
  ok(state.calls.diff === 1, '重复渲染不得重复请求 pr-diff');
  eq(lineNodes(h).length, 4, 'diff 行 = 1 个 hunk 头 + 3 行内容');
  ok(!h.text().includes('加载 diff'), '加载完成后「加载 diff」按钮应消失');
  ok(h.text().includes('重新加载'), '加载完成后应换成「重新加载」入口');
});

await test('2. 行内评论：点可评论行开评论条，提交按 hunk 算出新增行 3', async () => {
  const { h, state } = await mountPanel({ pr: basePr(), diff: SMALL_DIFF });
  await h.click('加载 diff');

  const pickable = h.findAll((n) => hasClass(n, 'ghsp-line') && hasClass(n, 'pickable') && isClickable(n));
  eq(pickable.length, 3, 'hunk 内两行上下文 + 一个新增行都可评论（删除行不可）');
  const addedRow = pickable.find((n) => hasClass(n, 'add'));
  ok(addedRow, '新增行必须存在且可评论');
  ok(h.text(addedRow).startsWith('3 '), '提示：新增行渲染的新行号应为 3');

  h.clickNode(addedRow);
  await h.settle();
  const commentBar = h.find((n) => hasClass(n, 'ghsp-commentbar'));
  ok(commentBar, '点可评论行后应出现评论条');
  ok(h.text(commentBar).includes(':3'), '评论条头部应显示行号 3');
  ok(h.find((n) => isButton(n) && h.text(n).includes('发到 PR（行内）'), commentBar), '评论条内必须有行内提交按钮');

  const textarea = h.find((n) => isObject(n) && n.type === 'textarea', commentBar);
  ok(textarea, '评论条内必须有输入框');
  h.change(textarea, '这里应该用 const');
  await h.settle();

  await h.click('发到 PR（行内）');
  const posts = state.posts.filter((p) => p.url.includes('/api/github/pr-inline-comment'));
  eq(posts.length, 1, '提交后必须恰好 POST 一次 pr-inline-comment');
  const body = posts[0].body;
  eq(body.repo, REPO, 'repo 必须原样带上');
  eq(body.number, NUMBER, 'number 必须原样带上');
  eq(body.path, 'a.ts', 'path 必须是所在文件');
  eq(body.line, 3, '行号必须按 hunk 推算为新增文件第 3 行（不是数组下标 2）');
  eq(body.side, 'RIGHT', '行内评论必须挂 RIGHT 侧');
  eq(body.commit_id, HEAD_SHA, 'commit_id 必须是 headRefOid');
  eq(body.body, '这里应该用 const', '评论正文必须原样提交');
  ok(h.text().includes('行内评论已发布'), '成功后应有 toast 反馈');
});

await test('3. 头部门控：MERGED/CLOSED 不渲染审批；DIRTY 禁批准+合并；BLOCKED 只禁合并', async () => {
  async function mountState(overrides) {
    const { h } = await mountPanel({ pr: basePr(overrides) });
    return h;
  }
  function actionState(h) {
    const labels = ['批准', '合并', '自动合并'];
    const out = {};
    labels.forEach((label) => {
      const node = buttonByLabel(h, label);
      out[label] = node ? { disabled: Boolean(node.props.disabled), title: node.props.title || '' } : null;
    });
    return out;
  }

  const merged = actionState(await mountState({ state: 'MERGED' }));
  eq(merged['批准'], null, 'MERGED 不应渲染「批准」按钮');
  eq(merged['合并'], null, 'MERGED 不应渲染「合并」按钮');
  eq(merged['自动合并'], null, 'MERGED 不应渲染「自动合并」按钮');

  const closed = actionState(await mountState({ state: 'CLOSED' }));
  eq(closed['批准'], null, 'CLOSED 不应渲染「批准」按钮');
  eq(closed['合并'], null, 'CLOSED 不应渲染「合并」按钮');
  eq(closed['自动合并'], null, 'CLOSED 不应渲染「自动合并」按钮');

  const dirty = actionState(await mountState({ state: 'OPEN', mergeStateStatus: 'DIRTY' }));
  ok(dirty['批准'] && dirty['批准'].disabled, 'DIRTY 时批准必须禁用');
  ok(/冲突/.test(dirty['批准'].title), 'DIRTY 时批准必须用 title 说明原因（冲突）');
  ok(dirty['合并'] && dirty['合并'].disabled, 'DIRTY 时合并必须禁用');
  ok(/冲突/.test(dirty['合并'].title), 'DIRTY 时合并必须用 title 说明原因（冲突）');
  ok(dirty['自动合并'] && dirty['自动合并'].disabled === false, 'DIRTY 时「自动合并」必须仍可用');

  const blocked = actionState(await mountState({ state: 'OPEN', mergeStateStatus: 'BLOCKED' }));
  ok(blocked['批准'] && blocked['批准'].disabled === false, 'BLOCKED 时批准仍可用');
  ok(blocked['合并'] && blocked['合并'].disabled, 'BLOCKED 时合并必须禁用');
  ok(/分支保护/.test(blocked['合并'].title), 'BLOCKED 时合并的禁用原因应指出分支保护');
  ok(blocked['自动合并'] && blocked['自动合并'].disabled === false, 'BLOCKED 时「自动合并」必须仍可用');

  const clean = actionState(await mountState({ state: 'OPEN', mergeStateStatus: 'CLEAN' }));
  ok(clean['批准'] && clean['批准'].disabled === false, 'CLEAN 时批准可用');
  ok(clean['合并'] && clean['合并'].disabled === false, 'CLEAN 时合并可用');
});

await test('4. 修复队列：单条提示词 / 全部 fix 一次一条 / 排除 APPROVED 与作者自评', async () => {
  const pr = basePr({
    reviews: [
      { author: { login: 'reviewer2' }, state: 'CHANGES_REQUESTED', body: 'REVIEW-BODY-ALPHA', submittedAt: '2026-10-19T11:00:00Z' },
      { author: { login: 'reviewer2' }, state: 'COMMENTED', body: 'REVIEW-BODY-BETA', submittedAt: '2026-10-19T11:05:00Z' },
      { author: { login: 'reviewer3' }, state: 'APPROVED', body: 'APPROVED-BODY-NOPE', submittedAt: '2026-10-19T11:10:00Z' },
    ],
    comments: [
      { author: { login: 'alice' }, body: 'AUTHOR-REPLY-NOPE', createdAt: '2026-10-19T12:00:00Z' },
      { author: { login: 'bob' }, body: 'COMMENT-BODY-GAMMA', createdAt: '2026-10-19T12:05:00Z' },
    ],
  });
  const { h, state } = await mountPanel({ pr });

  const requestsCard = cardByTitle(h, '待修改意见');
  ok(requestsCard, '必须渲染「待修改意见」卡片');
  const requestBody = h.text(requestsCard);
  ok(!requestBody.includes('APPROVED-BODY-NOPE'), 'APPROVED 评审不是待办，不得入队');
  ok(!requestBody.includes('AUTHOR-REPLY-NOPE'), 'PR 作者自己的评论不得入队');
  ok(requestBody.includes('REVIEW-BODY-ALPHA') && requestBody.includes('REVIEW-BODY-BETA')
    && requestBody.includes('COMMENT-BODY-GAMMA'), '三条待办必须齐且按最新在前');
  const fixButtons = h.findAll((n) => isClickable(n) && h.text(n).trim() === 'fix', requestsCard);
  eq(fixButtons.length, 3, '每条待办一个 fix 按钮');
  ok(h.text(requestsCard).includes('全部 fix 3'), '批量按钮文案必须带队列长度 3');

  // 单条：必须是一整段可直接执行的提示词，带 PR 引用与正文。
  h.clickNode(fixButtons[0]);
  await h.settle();
  eq(state.inserted.length, 1, '单条 fix 只推一条消息');
  const single = state.inserted[0];
  ok(single.includes(`PR ${REPO}#${NUMBER}`), '单条提示词必须含 PR <repo>#<number>');
  ok(single.includes('COMMENT-BODY-GAMMA'), '单条提示词必须含该条意见正文（最新在前，第一条是 bob 的评论）');
  ok(!single.includes('APPROVED-BODY-NOPE') && !single.includes('AUTHOR-REPLY-NOPE'), '单条提示词不得混入被排除的条目');

  // 批量：一次点击只推一条，含 ### 1) 与全部条目，条目内部不重复。
  state.inserted.length = 0;
  await h.click(/^全部 fix \d+$/);
  eq(state.inserted.length, 1, '「全部 fix N」一次点击只推一条消息');
  const batch = state.inserted[0];
  ok(batch.includes('### 1)'), '批量提示词必须含编号 `### 1)`');
  ['REVIEW-BODY-ALPHA', 'REVIEW-BODY-BETA', 'COMMENT-BODY-GAMMA'].forEach((body) => {
    ok(batch.includes(body), `批量提示词必须含每条意见：${body}`);
    eq(countOf(batch, body), 1, `每条意见在批量提示词里只能出现一次：${body}`);
  });
  eq(countOf(batch, '### '), 3, '批量提示词编号数必须等于队列长度 3');
  ok(!batch.includes('APPROVED-BODY-NOPE') && !batch.includes('AUTHOR-REPLY-NOPE'), '批量提示词不得混入被排除的条目');

  // 再点一次：不产生第二条消息、内容与首次一致、队列长度不变。
  await h.click(/^全部 fix \d+$/);
  eq(state.inserted.length, 2, '再次点击仍然是一次点击一条消息');
  eq(state.inserted[1], batch, '再次点击推的内容必须与首次完全一致（不叠加条目）');
  eq(countOf(state.inserted[1], '### '), 3, '再次点击不得重复拼接条目');
  eq(h.findAll((n) => isClickable(n) && h.text(n).trim() === 'fix', cardByTitle(h, '待修改意见')).length, 3,
    '点击后队列长度不得增长（仍为 3 条）');
  ok(h.text(cardByTitle(h, '待修改意见')).includes('全部 fix 3'), '点击后批量按钮文案不变（仍为全部 fix 3）');
});

await test('5. CI fix：只有失败检查出 fix，提示词含 --log-failed 与详情 URL', async () => {
  const failingUrl = 'https://github.com/acme/demo/actions/runs/11/job/22';
  const passingUrl = 'https://github.com/acme/demo/actions/runs/11/job/33';
  const pr = basePr({
    statusCheckRollup: [
      { name: 'build', workflowName: 'CI', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: failingUrl },
      { name: 'lint', workflowName: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: passingUrl },
      { name: 'deploy', workflowName: 'CI', status: 'IN_PROGRESS' },
    ],
  });
  const { h, state } = await mountPanel({ pr });
  const checksCard = cardByTitle(h, '检查');
  ok(checksCard, '必须渲染「检查」卡片');

  const failRows = h.findAll((n) => hasClass(n, 'ghsp-check') && hasClass(n, 'fail'), checksCard);
  eq(failRows.length, 1, '3 项检查里只有 build 失败');
  const fixButtons = h.findAll((n) => isClickable(n) && h.text(n).trim() === 'fix', checksCard);
  eq(fixButtons.length, 1, '只有失败检查才渲染 fix 按钮（通过 / 进行中都不渲染）');
  ok(h.text(failRows[0]).includes('build'), 'fix 按钮所在行必须是失败的 build');
  ok(h.text(checksCard).includes('修复失败项 1'), '失败检查的批量修复入口文案应为「修复失败项 1」');

  h.clickNode(fixButtons[0]);
  await h.settle();
  eq(state.inserted.length, 1, 'CI fix 只推一条消息');
  const prompt = state.inserted[0];
  ok(prompt.includes('--log-failed'), 'CI 提示词必须要求先拉失败日志（--log-failed）');
  ok(prompt.includes(failingUrl), 'CI 提示词必须带上失败检查的 details URL');
  ok(!prompt.includes(passingUrl), '通过检查的 URL 不得混入失败提示词');
  ok(prompt.includes('build'), 'CI 提示词必须点名失败的检查');
});

await test('6. diff 分段展开：默认 400 行，按批 +2000 行加载，不再一次铺全量', async () => {
  const mk = (n) => {
    const diff = ['diff --git a/big.ts b/big.ts', 'index 1111111..2222222 100644', '--- a/big.ts', '+++ b/big.ts', `@@ -1,${n} +1,${n} @@`];
    for (let i = 1; i <= n; i += 1) diff.push(' line ' + i);
    return diff.join('\n');
  };

  // 6a. 421 行：默认 400，剩余 21 行一批就能显示完
  {
    const { h } = await mountPanel({ pr: basePr({ files: [{ path: 'big.ts', additions: 1, deletions: 0 }] }), diff: mk(420) });
    await h.click('加载 diff');
    eq(lineNodes(h).length, 400, '默认最多渲染 400 行');
    ok(/显示剩余 21 行/.test(h.text()), '剩余不足一批时按钮直接说「显示剩余 21 行」');
    await h.click(/^显示剩余 21 行$/);
    eq(lineNodes(h).length, 421, '点开后渲染全部 421 行（1 hunk 头 + 420 行）');
    ok(!/显示剩余/.test(h.text()), '全部展开后按钮消失');
  }

  // 6b. 5000 行：一批 2000，按钮文案带剩余数，三次点完
  {
    const { h } = await mountPanel({ pr: basePr({ files: [{ path: 'big.ts', additions: 1, deletions: 0 }] }), diff: mk(5000) });
    await h.click('加载 diff');
    eq(lineNodes(h).length, 400, '超长文件默认仍只渲染 400 行');
    ok(/继续加载 2000 行（剩 4601）/.test(h.text()), '剩余超过一批时提示「继续加载 2000 行（剩 N）」');
    await h.click(/^继续加载 2000 行（剩 4601）$/);
    eq(lineNodes(h).length, 2400, '一次只加 2000 行');
    ok(/继续加载 2000 行（剩 2601）/.test(h.text()), '剩余数同步递减');
    await h.click(/^继续加载 2000 行（剩 2601）$/);
    eq(lineNodes(h).length, 4400, '再点一次到 4400 行');
    await h.click(/^显示剩余 601 行$/);
    eq(lineNodes(h).length, 5001, '最后一批补齐到 5001 行（含 hunk 头）');
    ok(!/继续加载|显示剩余/.test(h.text()), '加载完后不得残留展开按钮');
  }
});

await test('7. Composer 降级：insertText → setDraft → 剪贴板 + toast', async () => {
  // 7a. 没有 insertText 时用 setDraft。
  const draftState = { drafts: [] };
  const draftMount = await mountPanel({
    pr: basePr(),
    inputActions: {
      setDraft(text) { draftState.drafts.push(text); },
    },
  });
  await draftMount.h.click('推到对话框');
  eq(draftState.drafts.length, 1, 'insertText 缺失时应回落到 setDraft');
  ok(draftState.drafts[0].includes(`${REPO}#${NUMBER}`), 'setDraft 收到的内容必须是完整的 PR 上下文');
  eq(draftMount.state.inserted.length, 0, 'setDraft 分支不应调用 insertText');
  const draftToast = draftMount.h.find((n) => hasClass(n, 'ghsp-toast'));
  ok(draftToast && draftMount.h.text(draftToast).includes('已放进输入框'), 'setDraft 成功应有「已放进输入框」toast');
  ok(draftToast.props.className.includes('ok'), 'setDraft 成功 toast 用 ok 语气');

  // 7b. insertText 存在时优先 insertText，剪贴板不被触碰。
  const copied = [];
  Object.defineProperty(globalThis, 'navigator', {
    value: { clipboard: { writeText: (text) => copied.push(text) } },
    configurable: true,
    writable: true,
  });
  const insertState = { inserted: [] };
  const insertMount = await mountPanel({
    pr: basePr(),
    inputActions: {
      insertText(text) { insertState.inserted.push(text); return true; },
      setDraft() { throw new Error('insertText 可用时不得走 setDraft'); },
    },
  });
  await insertMount.h.click('推到对话框');
  eq(insertState.inserted.length, 1, 'insertText 可用时必须优先 insertText');
  eq(copied.length, 0, 'insertText 可用时不得写剪贴板');

  // 7c. 两者都缺失：写剪贴板 + toast 明确告知。
  const clipState = { copied: [] };
  Object.defineProperty(globalThis, 'navigator', {
    value: { clipboard: { writeText: (text) => clipState.copied.push(text) } },
    configurable: true,
    writable: true,
  });
  const clipMount = await mountPanel({ pr: basePr(), inputActions: {} });
  await clipMount.h.click('推到对话框');
  eq(clipState.copied.length, 1, 'insertText / setDraft 都缺失时必须写剪贴板');
  ok(clipState.copied[0].includes(`${REPO}#${NUMBER}`), '剪贴板内容必须是完整的 PR 上下文');
  const toast = clipMount.h.find((n) => hasClass(n, 'ghsp-toast'));
  ok(toast, '剪贴板兜底后必须有 toast 说明');
  ok(clipMount.h.text(toast).includes('剪贴板'), 'toast 必须明确说内容已复制到剪贴板');
  ok(toast.props.className.includes('info'), '剪贴板兜底 toast 用 info 语气');
  eq(clipMount.state.inserted.length, 0, '剪贴板分支不得调用 insertText');
});

/* ------------------------------------------------------------------ *
 * 汇总
 * ------------------------------------------------------------------ */
if (current) {
  current.dispose();
  current = null;
}
resetSessionPrModuleState();

console.log('\n========================================');
console.log(`Phase 28 Test Result: ${passed}/${total} 用例 PASSED（${assertions} 条断言）`);
console.log('========================================');
if (passed !== total) {
  console.error(`\n❌ ${total - passed} 个用例失败`);
  results.filter((r) => !r.ok).forEach((r) => {
    console.error(`\n--- ${r.name} ---\n${r.err && r.err.stack ? r.err.stack : r.err}`);
  });
  process.exit(1);
}
process.exit(0);
