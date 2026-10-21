// test/phase37.test.mjs - Phase 37 · 详情拆分（core 先到、thread 后补）
//
// 背景（2026-10-21）：详情一次取 24 个字段要 2.4s，其中 reviews+comments+commits
// 占 55KB / ~2s。拆成两段并行取：
//   core   ≈1.5s（头部/描述/变更/检查/操作立刻能画）
//   thread ≈1.85s（讨论区后到，第二次命中缓存 1ms）
//
// 本阶段钉住：
// 1. pr-detail?withThread=0 的 --json 不含 reviews/comments/commits/files。
// 2. pr-detail 缺省仍带 thread（向后兼容，老调用方不会突然丢字段）。
// 3. /api/github/pr-thread 只取 reviews,comments,commits；30s 缓存；refresh=1 穿透。
// 4. pr-thread 参数校验：缺 number / 缺 repo → 400，POST → 405。
// 5. 客户端：面板用 withThread=0 调详情，并单独调 pr-thread。

import assert from 'node:assert';

let pass = 0; let total = 0; const fails = [];
function ok(cond, name) { total += 1; if (cond) pass += 1; else { fails.push(name); console.error('❌ ' + name); } }

const routes = new Map();
const webServer = { exact: new Map(), prefixes: new Map(), register(r) { (r.kind === 'exact' ? this.exact : this.prefixes).set(r.path, r); routes.set(r.path, r); return () => {}; } };
const calls = [];
let payload = { number: 2050, title: 't', state: 'OPEN', reviews: [{ id: 'r1' }], comments: [{ id: 'c1' }], commits: [{ oid: 'abc' }] };
const stubExec = { async run(args) { calls.push(args.slice()); return { ok: true, data: payload }; } };
const { registerApiRoutes } = await import('../lib/api/routes.js');
registerApiRoutes({ webServer }, stubExec, undefined, 15_000);

async function invoke(path, q, method = 'GET') {
  let out = '';
  const res = { statusCode: 0, setHeader() {}, end(c) { out += c; } };
  await routes.get(path).handler({ method, url: path + q }, res);
  return { status: res.statusCode, body: out ? JSON.parse(out) : null };
}

const viewArgs = () => calls.filter((a) => a[0] === 'pr' && a[1] === 'view');

/* 1. core only */
calls.length = 0;
const core = await invoke('/api/github/pr-detail', '?number=2050&repo=acme/demo&withDiff=0&withThread=0&refresh=1');
const coreArgs = viewArgs()[0];
const coreFields = coreArgs[coreArgs.indexOf('--json') + 1];
ok(core.status === 200, 'core 请求必须 200');
ok(!/reviews|comments|commits|files/.test(coreFields), `withThread=0 不得再取讨论字段（实际 ${coreFields.slice(0, 80)}…）`);
ok(/headRefOid/.test(coreFields) && /statusCheckRollup/.test(coreFields), 'core 仍须包含行内评论与检查所需字段');
ok(core.body.data.threadIncluded === false, '响应必须标注 threadIncluded=false');

/* 2. 缺省带 thread（兼容） */
calls.length = 0;
const full = await invoke('/api/github/pr-detail', '?number=2050&repo=acme/demo&withDiff=0&refresh=1');
const fullArgs = viewArgs()[0];
const fullFields = fullArgs[fullArgs.indexOf('--json') + 1];
ok(/reviews/.test(fullFields) && /comments/.test(fullFields) && /commits/.test(fullFields), '缺省必须仍带 reviews/comments/commits');
ok(full.body.data.threadIncluded === true, '响应必须标注 threadIncluded=true');

/* 3. pr-thread 契约 */
calls.length = 0;
const t1 = await invoke('/api/github/pr-thread', '?repo=acme/demo&number=2050');
ok(t1.status === 200 && t1.body.ok, 'pr-thread 必须 200');
ok(Array.isArray(t1.body.data.reviews) && t1.body.data.reviews.length === 1, '必须返回 reviews');
ok(Array.isArray(t1.body.data.comments) && Array.isArray(t1.body.data.commits), '必须返回 comments/commits');
const tArgs = viewArgs()[0];
ok(tArgs[tArgs.indexOf('--json') + 1] === 'reviews,comments,commits', '只取 reviews,comments,commits 三个字段');

const before = viewArgs().length;
const t2 = await invoke('/api/github/pr-thread', '?repo=acme/demo&number=2050');
ok(viewArgs().length === before, '30s 内重复请求必须走缓存（不再调 gh）');
ok(t2.body.data.cached === true, '缓存命中要标注 cached:true');

const t3 = await invoke('/api/github/pr-thread', '?repo=acme/demo&number=2050&refresh=1');
ok(viewArgs().length === before + 1, 'refresh=1 必须穿透缓存');

/* 4. 参数校验 */
calls.length = 0;
ok((await invoke('/api/github/pr-thread', '?repo=acme/demo')).status === 400, '缺 number → 400');
ok((await invoke('/api/github/pr-thread', '?number=2050')).status === 400, '缺 repo → 400');
ok((await invoke('/api/github/pr-thread', '?repo=acme/demo&number=2050', 'POST')).status === 405, 'POST → 405');
ok(calls.length === 0, '校验失败时不得调用 gh');

/* 5. 客户端接线 */
const fs = await import('node:fs');
const client = fs.readFileSync('lib/client.js', 'utf8');
const start = client.indexOf('// ---- [Bundled: session-pr-panel.js] ----');
const end = client.indexOf('// ---- [End: session-pr-panel.js] ----');
const panelSrc = client.slice(start, end);
ok(/withThread=0/.test(panelSrc), '面板必须以 withThread=0 调详情');
ok(/\/api\/github\/pr-thread/.test(panelSrc), '面板必须单独调用 /api/github/pr-thread');
ok(/usePrThread/.test(panelSrc), '必须有独立的 thread hook');
assert.ok(panelSrc.length > 0);

/* 6. core 8s 短缓存：重复请求不再调 gh，refresh=1 穿透 */
calls.length = 0;
await invoke('/api/github/pr-detail', '?number=777&repo=acme/demo&withDiff=0&withThread=0&refresh=1');
const afterFirst = viewArgs().length;
await invoke('/api/github/pr-detail', '?number=777&repo=acme/demo&withDiff=0&withThread=0');
ok(viewArgs().length === afterFirst, `8s 内的重复详情请求必须走缓存（实际又调了 ${viewArgs().length - afterFirst} 次）`);
await invoke('/api/github/pr-detail', '?number=777&repo=acme/demo&withDiff=0&withThread=0&refresh=1');
ok(viewArgs().length === afterFirst + 1, 'refresh=1 必须穿透 core 缓存');

console.log(`\n===== Phase 37: ${pass}/${total} PASS =====`);
process.exit(fails.length ? 1 : 0);
