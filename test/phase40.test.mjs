// test/phase40.test.mjs - Phase 40 · 按文件补丁（绕开 20000 行 / 超时）+ diff 行键盘可达
//
// 背景：整份 diff 撞 GitHub 的「20000 行」上限或 30s 超时时，面板此前只剩「拉取失败」。
// 新增 /api/github/pr-files：按文件返回 patch，页面回到文件列表逐个展开。
//
// 钉住：
// 1. 路由参数校验（缺 repo / 缺 number → 400，POST → 405，且不调 gh）。
// 2. HTTP 通道在测试里被关掉时，回退 gh `--paginate`；返回体映射成 {path,additions,deletions,patch}。
// 3. 60s 缓存：第二次不再调 gh；refresh=1 穿透。
// 4. 客户端：存在 /api/github/pr-files、usePrFiles、expandedFiles 与 diff 行的 role/tabIndex。

import assert from 'node:assert';

let pass = 0; let total = 0; const fails = [];
function ok(cond, name) { total += 1; if (cond) pass += 1; else { fails.push(name); console.error('❌ ' + name); } }

const routes = new Map();
const webServer = { exact: new Map(), prefixes: new Map(), register(r) { (r.kind === 'exact' ? this.exact : this.prefixes).set(r.path, r); routes.set(r.path, r); return () => {}; } };
const calls = [];
const stubExec = {
  async run(args) {
    calls.push(args.slice());
    if (args[0] === 'api' && String(args[1] || '').includes('/files')) {
      return {
        ok: true,
        data: [
          { filename: 'a.ts', additions: 3, deletions: 1, patch: '@@ -1,2 +1,3 @@\n x\n+y' },
          { filename: 'b.ts', additions: 0, deletions: 2, patch: '' },
        ],
      };
    }
    return { ok: true, data: {} };
  },
};
const { registerApiRoutes } = await import('../lib/api/routes.js');
registerApiRoutes({ webServer }, stubExec, undefined, 15_000);
const route = routes.get('/api/github/pr-files');

async function invoke(q, method = 'GET') {
  let out = '';
  const res = { statusCode: 0, setHeader() {}, end(c) { out += c; } };
  await route.handler({ method, url: '/api/github/pr-files' + q }, res);
  return { status: res.statusCode, body: out ? JSON.parse(out) : null };
}

ok(Boolean(route), '必须注册 /api/github/pr-files');

/* 1. 参数校验 */
calls.length = 0;
ok((await invoke('?repo=acme/demo')).status === 400, '缺 number → 400');
ok((await invoke('?number=7')).status === 400, '缺 repo → 400');
ok((await invoke('?repo=acme/demo&number=7', 'POST')).status === 405, 'POST → 405');
ok(calls.length === 0, '校验失败不得调用 gh');

/* 2. gh 兜底 + 映射 */
const first = await invoke('?repo=acme/demo&number=7');
ok(first.status === 200 && first.body.ok, '必须 200');
ok(first.body.data.files.length === 2, '两条文件都要返回');
ok(first.body.data.files[0].path === 'a.ts' && first.body.data.files[0].patch.includes('+y'), 'patch 必须原样带上');
ok(first.body.data.files[1].path === 'b.ts', '第二个文件映射正确');
const argv = calls.find((a) => String(a[1] || '').includes('/files'));
ok(argv && argv.includes('--paginate'), 'gh 兜底必须带 --paginate');

/* 3. 缓存 */
const before = calls.length;
const second = await invoke('?repo=acme/demo&number=7');
ok(calls.length === before, '60s 内重复请求必须走缓存');
ok(second.body.data.cached === true, '缓存命中标注 cached');
const third = await invoke('?repo=acme/demo&number=7&refresh=1');
ok(calls.length === before + 1, 'refresh=1 必须穿透缓存');

/* 4. 客户端接线 */
const fs = await import('node:fs');
const client = fs.readFileSync('lib/client.js', 'utf8');
const start = client.indexOf('// ---- [Bundled: session-pr-panel.js] ----');
const end = client.indexOf('// ---- [End: session-pr-panel.js] ----');
const panelSrc = client.slice(start, end);
ok(/\/api\/github\/pr-files/.test(panelSrc), '面板必须调用 pr-files');
ok(/function usePrFiles/.test(panelSrc), '必须有 usePrFiles hook');
ok(/expandedFiles/.test(panelSrc), '文件行必须能展开单文件补丁');
ok(/role: pickable \? "button"/.test(panelSrc), 'diff 行必须带 role=button');
ok(/tabIndex: pickable \? 0/.test(panelSrc), 'diff 行必须可 Tab 到');
assert.ok(panelSrc.length > 0);

console.log(`\n===== Phase 40: ${pass}/${total} PASS =====`);
process.exit(fails.length ? 1 : 0);
