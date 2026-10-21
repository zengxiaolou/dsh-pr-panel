// test/phase33.test.mjs - Phase 33 · 从聊天里点 PR 链接，必须落到「我们的面板」
//
// 现场问题（2026-10-20）：在对话里点 #630 这种 PR 链接，落到内嵌浏览器里的 GitHub 网页，
// 因为内嵌浏览器没有登录态，页面一直转圈/空白，用户以为「面板没数据」。
//
// 现在 client 半的全局 click 接管会先判断：github.com/<o>/<r>/pull/<n> → 直接开
// 右栏 PR 面板（读本地 gh，秒开）——现在挂在已知激活的 `github` 类型上，
// 靠 params.number 与仓库面板区分（单独注册的 github-pr 类型在某些页面状态下会 inactive）；带修饰键（Shift/⌘）或非 PR 链接维持原行为。
//
// 本阶段不走「静态字符串」，而是真的把 lib/client.js 在桩环境里加载并 apply()，
// 再派发一个合成 click，断言 openTab 的 kind 与 params、以及 preventDefault 是否被调用。

import assert from 'node:assert';

let pass = 0; let total = 0; const fails = [];
function ok(cond, name) { total += 1; if (cond) pass += 1; else { fails.push(name); console.error('❌ ' + name); } }

/* ---------- 最小 DOM ---------- */
const docHandlers = {};
const doc = {
  addEventListener(type, fn) { (docHandlers[type] = docHandlers[type] || []).push(fn); },
  removeEventListener() {},
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: () => ({ setAttribute() {}, appendChild() {}, remove() {}, style: {}, textContent: '' }),
  head: { appendChild() {}, removeChild() {} },
  body: { appendChild() {}, removeChild() {}, style: {}, contains: () => false },
  hidden: false,
};
globalThis.document = doc;
globalThis.window = {
  document: doc,
  navigator: { clipboard: { writeText: () => Promise.resolve() } },
  setTimeout: (fn) => { try { fn(); } catch (e) { /* 忽略 */ } return 0; },
  clearTimeout() {},
  addEventListener() {}, removeEventListener() {},
  dispatchEvent() {},
  open() {},
  innerWidth: 1280, innerHeight: 800,
  __ModuleLoader__: { load(opts) { globalThis.__factory = opts.factory; } },
};
globalThis.navigator = globalThis.window.navigator;
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.fetch = async () => ({ json: async () => ({ ok: true, data: {} }) });

const React = {
  createElement: (type, props, ...kids) => ({ type, props: props || {}, kids }),
  Fragment: 'F',
  useState: (v) => [v, () => {}],
  useEffect: () => {},
  useRef: (v) => ({ current: v }),
  useCallback: (f) => f,
  useMemo: (f) => f(),
  useReducer: (r, i) => [i, () => {}],
  createContext: () => ({ Provider: 'P', Consumer: 'C' }),
};
const tabCalls = [];
const openTabCalls = [];
await import('../lib/client.js');
ok(typeof globalThis.__factory === 'function', 'client bundle 的 factory 被 loader 捕获');
const exports_ = globalThis.__factory((name) => {
  if (name === 'react') return React;
  throw new Error('unexpected require: ' + name);
});
const ctx = {
  get: (k) => (k === 'sidebarRight' ? { openTab(kind, opts) { tabCalls.push({ kind, opts }); } } : k === 'layout' ? { openRightbar() {} } : null),
  effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {}; },
  on() {},
  slots: {
    inject(slot, cb) { const d = cb(); return typeof d === 'function' ? d : () => {}; },
    register() { return { dispose() {} }; },
    subscribe() { return () => {}; },
  },
  sidebarRightTabs: { register() { return () => {}; } },
};
exports_.apply(ctx);
ok(docHandlers.click && docHandlers.click.length >= 1, '全局 click 接管已安装');

function fakeClick(href, opts = {}) {
  const calls = [];
  const anchor = { getAttribute: () => href };
  const target = {
    closest(sel) {
      if (sel.indexOf('a[href^="http"]') >= 0) return anchor;
      if (sel === '[class*="dsh-github"]') return opts.inPluginUi ? target : null;
      return null;
    },
  };
  const ev = {
    target, button: 0,
    metaKey: Boolean(opts.metaKey), ctrlKey: false, shiftKey: Boolean(opts.shiftKey), altKey: false,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; calls.push('preventDefault'); },
  };
  docHandlers.click.forEach((fn) => fn(ev));
  return ev;
}

/* 1. 聊天里的 PR 链接（不在插件 UI 内）→ 打开我们的面板，并吃掉默认行为 */
tabCalls.length = 0;
let ev = fakeClick('https://github.com/acme/demo/pull/630');
ok(tabCalls.length === 1, '点 PR 链接必须调用 openTab 一次');
ok(tabCalls[0].kind === 'github', `必须用激活的 github 类型承载 PR 面板（实际 ${tabCalls[0].kind}）`);
assert.deepStrictEqual(tabCalls[0].opts.params, { repo: 'acme/demo', number: 630 });
ok(ev.defaultPrevented, '必须 preventDefault，否则还会同时跳网页');

/* 2. PR 链接 + 修饰键 → 交给浏览器（不拦截） */
tabCalls.length = 0;
ev = fakeClick('https://github.com/acme/demo/pull/630', { metaKey: true });
ok(tabCalls.length === 0 && !ev.defaultPrevented, '⌘+点击维持「打开网页」的默认行为');

/* 3. 非 PR 的 GitHub 链接（issue / tree）→ 不抢 */
tabCalls.length = 0;
ev = fakeClick('https://github.com/acme/demo/issues/12');
ok(tabCalls.length === 0, 'issue 链接不抢（它不属于 PR 面板）');

/* 4. 插件 UI 内的普通链接 → 走内置浏览器（kind=browser），不抢 PR 面板 */
tabCalls.length = 0;
ev = fakeClick('https://github.com/acme/demo/tree/main', { inPluginUi: true });
ok(tabCalls.length === 1 && tabCalls[0].kind === 'browser', '插件面板里的非 PR 链接仍走内置浏览器通道');

/* 5. 插件 UI 内的 PR 链接 → 仍然开我们的面板（优先于浏览器） */
tabCalls.length = 0;
ev = fakeClick('https://github.com/acme/demo/pull/9', { inPluginUi: true });
ok(tabCalls.length === 1 && tabCalls[0].kind === 'github', '插件 UI 里的 PR 链接同样开面板');

console.log(`\n===== Phase 33: ${pass}/${total} PASS =====`);
process.exit(fails.length ? 1 : 0);
