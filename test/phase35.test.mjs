// test/phase35.test.mjs - Phase 35 · 会话 PR 元数据「批量加速」（GraphQL 一次拿一仓库）
//
// 现场背景（2026-10-21）：一次刷新 12 条 PR，逐条 `gh pr view` 在并发 4 下要 5.8s，
// 用户感知就是「刷新慢/没反应」。改成：同一仓库一次 GraphQL（别名批量），12 条 ≈ 1.6s。
//
// 本阶段钉住：
// 1. 同一仓库 12 条 → 恰好 1 次 `gh api graphql`，0 次 `gh pr view`。
// 2. 两个仓库 → 2 次 graphql（按仓库分组，不串仓库）。
// 3. GraphQL 结果的映射：state / isDraft / additions / CI 三态（SUCCESS→pass，FAILURE→fail，PENDING→pending）。
// 4. GraphQL 失败（企业版权限等）→ 退回逐条 `gh pr view`，结果依然完整（不空、不报错）。
// 5. 缓存命中：第二次调用（无 refresh）不再打 graphql。
// 6. lite=1：一个 gh 都不调，只回 pending 占位。

import assert from 'node:assert';
const { registerApiRoutes } = await import('../lib/api/routes.js');
import { recordCreatedPr, __resetCreatedPrTracker } from '../lib/session-pr-tracker.js';

let pass = 0; let total = 0; const fails = [];
function ok(cond, name) { total += 1; if (cond) pass += 1; else { fails.push(name); console.error('❌ ' + name); } }

/* ---------- 路由装配 ---------- */
const routes = new Map();
const webServer = {
  exact: new Map(), prefixes: new Map(), registered: [],
  register(r) {
    (r.kind === 'exact' ? this.exact : this.prefixes).set(r.path, r);
    this.registered.push(r.path);
    routes.set(r.path, r);
    return () => {};
  },
};

const execCalls = [];
let graphqlResponder = () => ({ ok: true, data: { data: { repository: {} } } });
let viewResponder = () => ({ ok: true, data: { number: 1, title: 'stub', state: 'OPEN' } });

const stubExec = {
  async run(args) {
    execCalls.push(args.slice());
    const joined = args.join(' ');
    if (joined.includes('graphql')) return graphqlResponder(args);
    if (args[0] === 'pr' && args[1] === 'view') return viewResponder(args);
    return { ok: true, data: {} };
  },
};

registerApiRoutes({ webServer }, stubExec, undefined, 15_000);
const route = routes.get('/api/github/session-created-prs');

async function invoke(url) {
  let payload = '';
  const res = { statusCode: 0, setHeader() {}, end(c) { payload = c; } };
  await route.handler({ method: 'GET', url }, res);
  return { status: res.statusCode, body: payload ? JSON.parse(payload) : null };
}

function reset(sessionId, prs) {
  __resetCreatedPrTracker();
  execCalls.length = 0;
  for (const pr of prs) recordCreatedPr(sessionId, `https://github.com/${pr.repo}/pull/${pr.number}`, 'tool');
}
const graphqlCalls = () => execCalls.filter((a) => a.includes('graphql'));
const viewCalls = () => execCalls.filter((a) => a[0] === 'pr' && a[1] === 'view');

/* ---------- 1. 同仓库 12 条 = 1 次 graphql ---------- */
{
  const prs = Array.from({ length: 12 }, (_, i) => ({ repo: 'acme/demo', number: 100 + i }));
  reset('sess-batch', prs);
  // 桩按查询里的别名与编号解析，不依赖调用方顺序（否则会测出假红）
  graphqlResponder = (args) => {
    const q = String(args[3] || '');
    const repoNode = {};
    for (const m of q.matchAll(/p(\d+): pullRequest\(number: (\d+)\)/g)) {
      const idx = Number(m[1]);
      const num = Number(m[2]);
      repoNode[`p${idx}`] = {
        number: num, title: 'PR ' + num, state: 'MERGED', isDraft: false, url: `https://github.com/acme/demo/pull/${num}`,
        author: { login: 'someone' }, baseRefName: 'main', headRefName: 'x', additions: 3, deletions: 1, changedFiles: 2,
        reviewDecision: 'APPROVED',
        // 编号 100 固定 FAILURE，其余 SUCCESS
        statusCheckRollup: { state: num === 100 ? 'FAILURE' : 'SUCCESS' },
        createdAt: '', updatedAt: '', mergedAt: '',
      };
    }
    return { ok: true, data: { data: { repository: repoNode } } };
  };
  const { status, body } = await invoke('/api/github/session-created-prs?sessionId=sess-batch&refresh=1');
  ok(status === 200 && body.ok, '批量路径必须 200');
  ok(graphqlCalls().length === 1, `同仓库 12 条只能打 1 次 graphql（实际 ${graphqlCalls().length}）`);
  ok(viewCalls().length === 0, `命中批量就不该再逐条 pr view（实际 ${viewCalls().length}）`);
  ok(body.data.items.length === 12, '12 条都要返回');
  const first = body.data.items.find((i) => i.number === 100);
  ok(first.state === 'MERGED', 'state 必须来自 GraphQL');
  ok(first.checks.state === 'fail', `FAILURE → checks.state=fail（实际 ${first.checks && first.checks.state}，items=${body.data.items.length}）`);
  ok(body.data.items.find((i) => i.number === 101).checks.state === 'pass', `SUCCESS → checks.state=pass（实际 ${(body.data.items.find((i) => i.number === 101) || {}).checks && (body.data.items.find((i) => i.number === 101) || {}).checks.state}）`);
  ok(first.additions === 3 && first.deletions === 1, '增删行数必须透传');
}

/* ---------- 2. 两个仓库 = 2 次 graphql ---------- */
{
  reset('sess-two', [{ repo: 'acme/a', number: 1 }, { repo: 'acme/b', number: 2 }]);
  graphqlResponder = (args) => {
    const q = args[3] || '';
    const repo = q.includes('"a"') ? 'a' : 'b';
    return { ok: true, data: { data: { repository: { p0: {
      number: repo === 'a' ? 1 : 2, title: repo, state: 'OPEN', isDraft: false, url: '', author: { login: 'u' },
      baseRefName: 'main', headRefName: 'h', additions: 0, deletions: 0, changedFiles: 0, reviewDecision: '',
      statusCheckRollup: { state: 'PENDING' }, createdAt: '', updatedAt: '', mergedAt: '',
    } } } } };
  };
  const { body } = await invoke('/api/github/session-created-prs?sessionId=sess-two&refresh=1');
  ok(graphqlCalls().length === 2, `两个仓库必须各打一次（实际 ${graphqlCalls().length}）`);
  ok(body.data.items.length === 2, '两条都要返回');
  ok(body.data.items.every((i) => i.checks.state === 'pending'), 'PENDING → checks.state=pending');
}

/* ---------- 3. graphql 失败 → 逐条 pr view 兜底 ---------- */
{
  reset('sess-fallback', [{ repo: 'acme/demo', number: 7 }]);
  graphqlResponder = () => ({ ok: false, error: 'gh: Resource not accessible (HTTP 403)' });
  viewResponder = (args) => ({ ok: true, data: { number: Number(args[2]), title: 'fallback', state: 'OPEN', isDraft: false, url: 'u', author: { login: 'u' }, baseRefName: 'main', headRefName: 'h', additions: 1, deletions: 1, changedFiles: 1, reviewDecision: '', statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }], createdAt: '', updatedAt: '', mergedAt: '' } });
  const { status, body } = await invoke('/api/github/session-created-prs?sessionId=sess-fallback&refresh=1');
  ok(status === 200, 'graphql 失败不能让接口 500');
  ok(viewCalls().length >= 1, '必须退回逐条 pr view');
  ok(body.data.items[0].title === 'fallback', '兜底路径同样要有数据');
  ok(body.data.items[0].checks.state === 'pass', 'REST contexts 的 SUCCESS 仍然映射成 pass');
}

/* ---------- 4. 缓存命中不再打 graphql ---------- */
{
  reset('sess-cache', [{ repo: 'acme/demo', number: 9 }]);
  graphqlResponder = () => ({ ok: true, data: { data: { repository: { p0: {
    number: 9, title: 'cached', state: 'OPEN', isDraft: false, url: '', author: { login: 'u' }, baseRefName: 'main',
    headRefName: 'h', additions: 0, deletions: 0, changedFiles: 0, reviewDecision: '', statusCheckRollup: { state: 'SUCCESS' },
    createdAt: '', updatedAt: '', mergedAt: '',
  } } } } });
  await invoke('/api/github/session-created-prs?sessionId=sess-cache&refresh=1');
  const before = graphqlCalls().length;
  const { body } = await invoke('/api/github/session-created-prs?sessionId=sess-cache');
  ok(graphqlCalls().length === before, '30s 内无 refresh 必须走缓存，不再打 graphql');
  ok(body.data.items[0].title === 'cached', '缓存内容必须一致');
}

/* ---------- 5. lite=1 一个 gh 都不调 ---------- */
{
  reset('sess-lite', [{ repo: 'acme/demo', number: 11 }]);
  const { body } = await invoke('/api/github/session-created-prs?sessionId=sess-lite&lite=1&refresh=1');
  ok(execCalls.length === 0, `lite 模式不得调用任何 gh（实际 ${execCalls.length}）`);
  ok(body.data.items[0].pending === true, 'lite 必须回 pending 占位');
}

console.log(`\n===== Phase 35: ${pass}/${total} PASS =====`);
process.exit(fails.length ? 1 : 0);
