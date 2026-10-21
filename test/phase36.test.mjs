// test/phase36.test.mjs - Phase 36 · 「读取 PR 永远转圈」回归（空成功 + 输出截断）
//
// 现场（2026-10-21）：右栏 #2050 一直停「正在读取 PR...」。根因是一条**假成功**：
// executor 默认只保留 24k 输出，而这个 PR 的 `--json` 有 40+KB（正文+20 条评审+
// 8 条评论+文件列表）→ 被截断 → 无法 JSON 解析 → data 为空 → 路由回了
// `{ok:true, data:{pr:null}}` → 前端把 null 当成「还没读完」→ 无限骨架屏。
//
// 本阶段钉住三层：
// 1. Host：pr-detail 调用必须显式提高输出上限（≥100k 字符）。
// 2. Host：ok 但没有结构化数据 → 必须 502（不能回空成功）。
// 3. Client：收到 `{ok:true,data:{}}` 必须显示错误 + 重试，不得停在骨架屏。

import assert from 'node:assert';
import { createRenderer } from './render/react-stub.mjs';

let pass = 0; let total = 0; const fails = [];
function ok(cond, name) { total += 1; if (cond) pass += 1; else { fails.push(name); console.error('❌ ' + name); } }

/* ---------------- Host 侧 ---------------- */
const routes = new Map();
const webServer = { exact: new Map(), prefixes: new Map(), register(r) { (r.kind === 'exact' ? this.exact : this.prefixes).set(r.path, r); routes.set(r.path, r); return () => {}; } };
const calls = [];
let viewPayload = { ok: true, data: { number: 2050, title: 't', state: 'OPEN' } };

const stubExec = {
  async run(args, options) {
    calls.push({ args: args.slice(), options: options || {} });
    if (args[0] === 'pr' && args[1] === 'view') return viewPayload;
    return { ok: true, rawOutput: '' };
  },
};
const { registerApiRoutes } = await import('../lib/api/routes.js');
registerApiRoutes({ webServer }, stubExec, undefined, 15_000);
const detailRoute = routes.get('/api/github/pr-detail');

async function invoke(url) {
  let payload = '';
  const res = { statusCode: 0, setHeader() {}, end(c) { payload = c; } };
  await detailRoute.handler({ method: 'GET', url }, res);
  return { status: res.statusCode, body: payload ? JSON.parse(payload) : null };
}

calls.length = 0;
const okRes = await invoke('/api/github/pr-detail?withDiff=0&repo=acme/demo&number=2050');
ok(okRes.status === 200, '正常返回必须 200');
ok(okRes.body.data.pr && okRes.body.data.pr.number === 2050, '必须回传 pr 对象');
const detailCall = calls.find((c) => c.args[0] === 'pr' && c.args[1] === 'view');
ok(Boolean(detailCall), '必须调用 gh pr view');
ok((detailCall.options.maxOutputChars || 0) >= 100_000, `pr-detail 必须显式提高输出上限（实际 ${detailCall.options.maxOutputChars}）`);

viewPayload = { ok: true, data: undefined };
calls.length = 0;
const nullRes = await invoke('/api/github/pr-detail?withDiff=0&repo=acme/demo&number=2050');
ok(nullRes.status === 502, '「ok 但无数据」必须 502，不能回空成功');
ok(/解析失败|过大|JSON/.test(String(nullRes.body.error || '')), '错误信息必须说明是解析/体积问题');

viewPayload = { ok: false, error: 'boom' };
const errRes = await invoke('/api/github/pr-detail?withDiff=0&repo=acme/demo&number=2050');
ok(errRes.status === 502 && errRes.body.ok === false, 'gh 失败仍必须是 502 且 ok:false');

/* ---------------- Client 侧 ---------------- */
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.document = { addEventListener() {}, removeEventListener() {}, hidden: false, body: { style: {} }, head: { appendChild() {} }, getElementById: () => null, querySelectorAll: () => [], createElement: () => ({ setAttribute() {}, appendChild() {}, remove() {}, style: {} }) };
globalThis.window = { document: globalThis.document, addEventListener() {}, removeEventListener() {}, setTimeout: (f, m) => setTimeout(f, m), clearTimeout: (t) => clearTimeout(t), open() {}, innerWidth: 1280, innerHeight: 800 };
globalThis.navigator = { clipboard: { writeText: () => Promise.resolve() } };

const panel = await import('../lib/ui/session-pr-panel.js');
const { SessionPrPanel, resetSessionPrModuleState } = panel;

resetSessionPrModuleState();
const r = createRenderer();
r.setFetch(async (record) => {
  const u = String((record && record.url) || record);
  if (u.includes('/api/github/pr-detail')) return { ok: true, data: {} }; // 假成功
  if (u.includes('/api/github/pr-merge-methods')) return { ok: true, data: {} };
  return { ok: true, data: { items: [] } };
});
await r.mount(SessionPrPanel, {
  sessionId: 's1',
  inputActions: { insertText() { return true; } },
  onOpenUrl() {},
  useTabInfo: () => ({ tab: { navigation: { params: { repo: 'acme/demo', number: 2050 } } } }),
});
const text = r.text();
ok(/PR 详情为空/.test(text), `空成功必须显示明确错误（实际文案：${text.slice(0, 120)}）`);
ok(!/正在读取 PR/.test(text), '不得停留在「正在读取 PR...」骨架屏');
ok(/重试/.test(text), '必须提供重试入口');
r.dispose();

console.log(`\n===== Phase 36: ${pass}/${total} PASS =====`);
process.exit(fails.length ? 1 : 0);
