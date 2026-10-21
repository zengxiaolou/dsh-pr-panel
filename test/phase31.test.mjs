// test/phase31.test.mjs - Phase 31 · 浮窗右键菜单（复制链接 / 跳转 GitHub / 在面板打开）
//
// 为什么单列一阶段：phase28 覆盖的是右列面板，浮窗（shell.overlay 那一层）
// 的交互此前没有任何行为测试。右键菜单尤其容易「看起来有、点下去没用」：
// 菜单项容易被外层点击立刻关掉、复制链接可能复制到空、跳转可能调到 system
// 浏览器而不是 DSH 内置浏览器。
//
// 本阶段用 test/render/react-stub.mjs 渲染 SessionPrOverlay，并补一个最小的
// document / window / navigator（harness 默认没有 DOM），因此可以真的触发
// keydown(Escape) 与 navigator.clipboard。
//
// 钉住的契约：
// 1. 没右键时不渲染菜单。
// 2. 右键某一行 → 菜单出现在鼠标坐标处，含「在面板里打开 / 复制链接 / 跳转 GitHub」。
// 3. 复制链接 → 剪贴板拿到 PR URL、出「已复制」提示、菜单关闭。
// 4. 跳转 GitHub → 走 onOpenUrl（插件注入的是 DSH 内置浏览器优先的实现）。
// 5. 在面板里打开 → onOpenPr({repo, number})，菜单关闭。
// 6. Escape 关闭菜单；左键点击仍然正常打开面板（右键没破坏普通点击）。

import assert from 'node:assert';
import { createRenderer } from './render/react-stub.mjs';

/* ---- 最小 DOM：菜单的关闭逻辑依赖 document/window 监听 ---- */
const listeners = { doc: {}, win: {} };
function bind(store) {
  return {
    addEventListener(type, fn) { (store[type] = store[type] || []).push(fn); },
    removeEventListener(type, fn) { store[type] = (store[type] || []).filter((f) => f !== fn); },
  };
}
const copied = [];
const opened = [];
globalThis.document = {
  ...bind(listeners.doc),
  hidden: false,
  head: { appendChild() {}, removeChild() {} },
  getElementById: () => null,
  querySelectorAll: () => [],
  createElement: () => ({ setAttribute() {}, appendChild() {}, remove() {}, style: {}, textContent: '' }),
};
globalThis.window = {
  ...bind(listeners.win),
  document: globalThis.document,
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (t) => clearTimeout(t),
  open: (url) => { opened.push(url); },
};
globalThis.navigator = { clipboard: { writeText: (t) => { copied.push(t); return Promise.resolve(); } } };

const panel = await import('../lib/ui/session-pr-panel.js');
const { SessionPrOverlay, resetSessionPrModuleState } = panel;

const REPO = 'acme/demo';
const ITEMS = [
  { repo: REPO, number: 630, title: 'release(hermes): 告警状态失败原因可观测', state: 'OPEN', isDraft: false, url: 'https://github.com/acme/demo/pull/630', baseRefName: 'main', headRefName: 'hermes/alert', additions: 12, deletions: 3, changedFiles: 2, checks: { state: 'fail', total: 2, failing: 1 } },
  { repo: REPO, number: 631, title: 'test(hermes): 修正新增测试未被执行', state: 'MERGED', isDraft: false, url: 'https://github.com/acme/demo/pull/631', baseRefName: 'release/hermes', headRefName: 'hermes/test', additions: 5, deletions: 1, changedFiles: 1, checks: { state: 'pass', total: 1, failing: 0 } },
];

let pass = 0;
let total = 0;
const fails = [];
function ok(cond, name) {
  total += 1;
  if (cond) { pass += 1; } else { fails.push(name); console.error('❌ ' + name); }
}

const renderer = createRenderer();
renderer.setFetch(async (record) => {
  // harness 传的是 { url, method, opts } 记录，不是裸字符串
  const u = String((record && record.url) || record);
  if (u.includes('/api/github/session-created-prs')) return { ok: true, data: { items: ITEMS, total: ITEMS.length } };
  return { ok: true, data: {} };
});

let openedPr = [];
let openedUrl = [];
resetSessionPrModuleState();
let tree = await renderer.mount(SessionPrOverlay, {
  useSessions: (sel) => sel({ byId: { s1: { retainedBy: { mainView: 1 } } } }),
  onOpenPr: (p) => { openedPr.push(p); },
  onOpenUrl: (u) => { openedUrl.push(u); },
});

const rows = () => renderer.findAll((n) => n && n.props && n.props.className === 'ghsp-row');

/* ---- 1. 先展开卡片 ---- */
ok(/PR #630/.test(renderer.text()), '收起态药丸显示最新编号');
await renderer.click(/PR/);
ok(rows().length === 2, '展开后每行一个 ghsp-row');
ok(!/复制链接/.test(renderer.text()), '没右键时不渲染菜单');

/* ---- 2. 右键第一行 ---- */
rows()[0].props.onContextMenu({ preventDefault() {}, clientX: 120, clientY: 80 });
await renderer.settle();
const menu = renderer.find((n) => n && n.props && n.props.className === 'ghsp-menu');
ok(Boolean(menu), '右键后出现菜单');
ok(menu.props.style.left === '120px' && menu.props.style.top === '80px', '菜单定位在鼠标坐标');
ok(/在面板里打开/.test(renderer.text(menu)) && /复制链接/.test(renderer.text(menu)) && /跳转 GitHub/.test(renderer.text(menu)), '菜单含三项动作');
ok(/#630/.test(renderer.text(menu)) && new RegExp(REPO).test(renderer.text(menu)), '菜单头部标明是哪条 PR');

/* ---- 3. 复制链接 ---- */
await renderer.click('复制链接');
ok(copied.length === 1 && copied[0] === ITEMS[0].url, '复制到剪贴板的必须是 PR URL');
ok(!renderer.find((n) => n && n.props && n.props.className === 'ghsp-menu'), '复制后菜单关闭');
ok(/已复制链接/.test(renderer.text()), '复制后给出提示');

/* ---- 4. 跳转 GitHub ---- */
rows()[0].props.onContextMenu({ preventDefault() {}, clientX: 200, clientY: 160 });
await renderer.settle();
await renderer.click('跳转 GitHub');
ok(openedUrl.length === 1 && openedUrl[0] === ITEMS[0].url, '跳转走 onOpenUrl（内置浏览器优先）');
ok(!renderer.find((n) => n && n.props && n.props.className === 'ghsp-menu'), '跳转后菜单关闭');

/* ---- 5. 在面板里打开 ---- */
rows()[1].props.onContextMenu({ preventDefault() {}, clientX: 210, clientY: 170 });
await renderer.settle();
await renderer.click('在面板里打开');
ok(openedPr.length === 1 && openedPr[0].repo === REPO && openedPr[0].number === 631, '菜单里的「打开」必须打开右键的那一条');

/* ---- 6. Escape 关闭 ---- */
rows()[0].props.onContextMenu({ preventDefault() {}, clientX: 220, clientY: 180 });
await renderer.settle();
ok(Boolean(renderer.find((n) => n && n.props && n.props.className === 'ghsp-menu')), '菜单再次打开');
(listeners.doc.keydown || []).forEach((fn) => fn({ key: 'Escape' }));
await renderer.settle();
ok(!renderer.find((n) => n && n.props && n.props.className === 'ghsp-menu'), 'Escape 关闭菜单');

/* ---- 7. 左键点击仍然正常 ---- */
rows()[0].props.onClick();
await renderer.settle();
ok(openedPr.length === 2 && openedPr[1].number === 630, '左键点击仍然直接进入面板');

// 浮窗会起轮询定时器：把渲染器卸掉（跑 effect cleanup）再退出，否则 Node 被 interval 挂住
renderer.dispose();
console.log(`\n===== Phase 31: ${pass}/${total} PASS =====`);
process.exit(fails.length ? 1 : 0);
