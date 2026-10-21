// test/phase43.test.mjs - Phase 43 · PR 面板与仓库面板共用「已激活」的 tab 类型
//
// 现场（2026-10-21）：右栏 PR 标签还在，内容区全空。槽位检查显示
//   sidebar.right.pane.tab 的 occupant「github-pr」= active:false（其它都是 true）。
// 单独注册的第二个 tab 类型在部分页面状态下会变成 inactive，标签照旧显示、内容空白。
//
// 修法：不再依赖第二个类型。把 PR 面板挂在工作区正在用的 `github` 类型上，
// 用 params.number 分派：有 number → PR 面板；没有 → 仓库面板。
//
// 断言（加载真实 lib/client.js，桩 ctx）：
// 1. 打开 PR 面板用的是 kind=github + params{repo,number}。
// 2. 注册在 key `dsh-github-flow` 的 body 是分派器：给 number 渲染 SessionPrPanel，否则渲染仓库面板。
// 3. 标题同样分派。
// 4. 旧的 github-pr 类型仍注册着（历史标签不至于彻底失效）。

import assert from 'node:assert';

let pass = 0; let total = 0; const fails = [];
function ok(cond, name) { total += 1; if (cond) pass += 1; else { fails.push(name); console.error('❌ ' + name); } }

const docHandlers = {};
const doc = {
  addEventListener(t, fn) { (docHandlers[t] = docHandlers[t] || []).push(fn); },
  removeEventListener() {}, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
  createElement: () => ({ setAttribute() {}, appendChild() {}, remove() {}, style: {}, textContent: '' }),
  head: { appendChild() {}, removeChild() {} }, body: { appendChild() {}, removeChild() {}, style: {}, contains: () => false }, hidden: false,
};
globalThis.document = doc;
globalThis.window = { document: doc, navigator: { clipboard: { writeText: () => Promise.resolve() } }, setTimeout: (f) => { f(); return 0; }, clearTimeout() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, open() {}, innerWidth: 1280, innerHeight: 800, __ModuleLoader__: { load(o) { globalThis.__factory = o.factory; } } };
globalThis.navigator = globalThis.window.navigator;
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.fetch = async () => ({ json: async () => ({ ok: true, data: {} }) });

const React = {
  createElement: (type, props, ...kids) => ({ type, props: props || {}, children: kids }),
  Fragment: 'F', useState: (v) => [v, () => {}], useEffect: () => {}, useRef: (v) => ({ current: v }),
  useCallback: (f) => f, useMemo: (f) => f(), useReducer: (r, i) => [i, () => {}], createContext: () => ({ Provider: 'P', Consumer: 'C' }),
};
await import('../lib/client.js');
const exports_ = globalThis.__factory((name) => { if (name === 'react') return React; throw new Error('unexpected require ' + name); });

const tabCalls = [];
const slotRegs = [];       // { name, key, body }
const tabTypes = [];       // ids registered as tab types
const ctx = {
  get: (k) => (k === 'sidebarRight' ? { openTab(kind, opts) { tabCalls.push({ kind, opts }); } } : k === 'layout' ? { openRightbar() {} } : null),
  effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {}; },
  on() {},
  slots: {
    inject(slot, cb) { const d = cb(); return typeof d === 'function' ? d : () => {}; },
    register(reg, body) { slotRegs.push({ name: reg.name, key: reg.key || reg.id, body }); return { dispose() {} }; },
    subscribe() { return () => {}; },
  },
  sidebarRightTabs: { register(def) { tabTypes.push(def && def.id); return () => {}; } },
  sessions: {}, theme: {},
};
exports_.apply(ctx);

/* 1. 打开 PR 面板：kind 必须是激活的 github */
tabCalls.length = 0;
docHandlers.click && (() => {
  const anchor = { getAttribute: () => 'https://github.com/acme/demo/pull/630' };
  const target = { closest: (sel) => (sel.indexOf('a[href^="http"]') >= 0 ? anchor : null) };
  docHandlers.click.forEach((fn) => fn({ target, button: 0, defaultPrevented: false, preventDefault() {}, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false }));
})();
ok(tabCalls.length === 1 && tabCalls[0].kind === 'github', `必须用 github 类型承载 PR 面板（实际 ${tabCalls[0] && tabCalls[0].kind}）`);
assert.deepStrictEqual(tabCalls[0].opts.params, { repo: 'acme/demo', number: 630 });

/* 2. key 为 dsh-github-flow 的 body 是分派器 */
const bodyReg = slotRegs.find((r) => r.name === 'sidebar.right.pane.tab' && r.key === 'dsh-pr-panel');
ok(Boolean(bodyReg), '必须注册 sidebar.right.pane.tab/dsh-pr-panel');
const withPr = bodyReg.body({ useTabInfo: () => ({ tab: { navigation: { params: { repo: 'acme/demo', number: 630 } } } }) });
const noPr = bodyReg.body({ useTabInfo: () => ({ tab: { navigation: { params: {} } } }) });
ok(withPr && withPr.type && /SessionPrPanel/.test(withPr.type.name || ''), `有 number 时必须渲染 PR 面板（实际 ${withPr && withPr.type && withPr.type.name}）`);
ok(noPr && noPr.type && !/SessionPrPanel/.test(noPr.type.name || ''), `没有 number 时必须渲染仓库面板（实际 ${noPr && noPr.type && noPr.type.name}）`);

/* 3. 标题分派 */
const titleReg = slotRegs.find((r) => r.name === 'sidebar.right.pane.tab.title' && r.key === 'dsh-pr-panel');
ok(Boolean(titleReg), '必须注册标题分派器');
const titlePr = titleReg.body({ useTabInfo: () => ({ tab: { navigation: { params: { number: 630 } } } }) });
const titleWs = titleReg.body({ useTabInfo: () => ({ tab: { navigation: { params: {} } } }) });
ok(titlePr && titlePr.type && /SessionPrTitle|SessionPrTabTitle/.test(titlePr.type.name || ''), 'PR 标签标题必须用 PR 标题组件');
ok(titleWs && titleWs.type && !/SessionPr/.test(titleWs.type.name || ''), '仓库标签标题必须用仓库标题组件');

/* 4. 旧类型仍在（历史标签可见但不作为主路径） */
ok(tabTypes.includes('dsh-pr-panel'), '必须注册 dsh-pr-panel 这个 tab 类型');

console.log(`\n===== Phase 43: ${pass}/${total} PASS =====`);
process.exit(fails.length ? 1 : 0);
