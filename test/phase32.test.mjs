// test/phase32.test.mjs - Phase 32 · 浮窗拖拽（移动 / 持久化 / 双击归位 / 拖拽不误触）
//
// 为什么单列：拖拽是「看着能动、实际不能用」的高发区——常见三种坏法：
// 1) 拖完那一下同时触发 click，把卡片又展开/收起了；
// 2) 位置不持久化，刷新就跳回角落；
// 3) 拖出视口后再也抓不到。
//
// 本阶段用 test/render/react-stub.mjs + 一个最小 document/window/localStorage，
// 真触发 mousedown → mousemove → mouseup，断言：
// 1. 初始没有内联定位（默认贴在右下角）。
// 2. 表头拖动 → 浮窗 left/top 跟随位移，并写入 localStorage。
// 3. 重新挂载 → 读到上次位置（持久化生效）。
// 4. 双击表头 → 回到默认角落（内联定位清除）且 localStorage 被清。
// 5. 拖动药丸后松手 → 不展开卡片（movedRef 抑制 click）。
// 6. 位移小于抖动阈值（2px）→ 不算拖拽，点击仍然展开。
// 7. 位置越界（拖到左上角外）→ 被夹紧，不会丢出视口。

import assert from 'node:assert';
import { createRenderer } from './render/react-stub.mjs';

const listeners = { doc: {}, win: {} };
function bind(store) {
  return {
    addEventListener(type, fn) { (store[type] = store[type] || []).push(fn); },
    removeEventListener(type, fn) { store[type] = (store[type] || []).filter((f) => f !== fn); },
  };
}
function fire(store, type, event) {
  (store[type] || []).slice().forEach((fn) => fn(event));
}

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};
globalThis.document = {
  ...bind(listeners.doc),
  hidden: false,
  body: { style: {} },
  head: { appendChild() {}, removeChild() {} },
  getElementById: () => null,
  querySelectorAll: () => [],
  createElement: () => ({ setAttribute() {}, appendChild() {}, remove() {}, style: {}, textContent: '' }),
};
globalThis.window = {
  ...bind(listeners.win),
  document: globalThis.document,
  innerWidth: 1280,
  innerHeight: 800,
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (t) => clearTimeout(t),
  open() {},
};
globalThis.navigator = { clipboard: { writeText: () => Promise.resolve() } };

const panel = await import('../lib/ui/session-pr-panel.js');
const { SessionPrOverlay, resetSessionPrModuleState } = panel;

const ITEMS = [
  { repo: 'acme/demo', number: 630, title: 'fix: 可拖动浮窗', state: 'OPEN', isDraft: false, url: 'https://github.com/acme/demo/pull/630', baseRefName: 'main', additions: 1, deletions: 1, changedFiles: 1, checks: { state: 'pass', total: 1, failing: 0 } },
];

let pass = 0; let total = 0; const fails = [];
function ok(cond, name) { total += 1; if (cond) pass += 1; else { fails.push(name); console.error('❌ ' + name); } }

const POS_KEY = 'dsh-pr-panel:overlay-pos';

async function mountOverlay() {
  resetSessionPrModuleState();
  const r = createRenderer();
  r.setFetch(async () => ({ ok: true, data: { items: ITEMS, total: 1 } }));
  const tree = await r.mount(SessionPrOverlay, {
    useSessions: (sel) => sel({ byId: { s1: { retainedBy: { mainView: 1 } } } }),
    onOpenPr() {},
    onOpenUrl() {},
  });
  return { r, tree };
}

function overlayNode(r) {
  return r.find((n) => n && n.props && n.props.className === 'ghsp-overlay');
}

/* ---- 1. 初始无内联定位 ---- */
store.clear();
let { r } = await mountOverlay();
ok(overlayNode(r).props.style === undefined, '默认贴右下角（没有内联 left/top）');

/* ---- 2. 表头拖动 ---- */
await r.click(/PR/);
const head = r.find((n) => n && n.props && String(n.props.className || '').includes('ghsp-card-head'));
ok(Boolean(head) && typeof head.props.onMouseDown === 'function', '表头是拖拽把手');
// 让 getBoundingClientRect 有值（默认角：right 20 / bottom 148 → 粗略给个起点）
head.props.onMouseDown({ button: 0, clientX: 400, clientY: 300, currentTarget: { closest: () => ({ getBoundingClientRect: () => ({ left: 900, top: 300, width: 372, height: 320 }) }) }, preventDefault() {} });
fire(listeners.doc, 'mousemove', { clientX: 460, clientY: 360 });
await r.settle();
ok(overlayNode(r).props.style && overlayNode(r).props.style.left === '960px', `拖动后 left 跟随（实际 ${overlayNode(r).props.style && overlayNode(r).props.style.left}）`);
ok(overlayNode(r).props.style.top === '360px', '拖动后 top 跟随');
fire(listeners.doc, 'mouseup', {});
ok(Boolean(store.get(POS_KEY)), '松手后位置写入 localStorage');
ok(JSON.parse(store.get(POS_KEY)).x === 960, '持久化的是最终 x');

/* ---- 3. 重新挂载读取位置 ---- */
({ r } = await mountOverlay());
ok(overlayNode(r).props.style && overlayNode(r).props.style.left === '960px', '重新挂载沿用上次位置');

/* ---- 4. 双击归位 ---- */
await r.click(/PR/); // 重新挂载后是收起态，先展开才有表头
const head2 = r.find((n) => n && n.props && String(n.props.className || '').includes('ghsp-card-head'));
head2.props.onDoubleClick();
await r.settle();
ok(overlayNode(r).props.style === undefined, '双击归位：内联定位清除');
ok(!store.has(POS_KEY), '双击归位：localStorage 清除');

/* ---- 5. 拖动药丸不展开 ---- */
({ r } = await mountOverlay()); // 收起态才有药丸
const pill = r.find((n) => n && n.props && n.props.className === 'ghsp-pill');
pill.props.onMouseDown({ button: 0, clientX: 100, clientY: 100, currentTarget: { closest: () => ({ getBoundingClientRect: () => ({ left: 800, top: 400, width: 120, height: 30 }) }) }, preventDefault() {} });
fire(listeners.doc, 'mousemove', { clientX: 160, clientY: 150 });
fire(listeners.doc, 'mouseup', {});
await r.settle();
pill.props.onClick();
await r.settle();
ok(!/本会话提交的 PR/.test(r.text()), '拖动药丸后的 click 不展开卡片');

/* ---- 6. 抖动阈值：2px 不算拖 ---- */
({ r } = await mountOverlay());
const pill2 = r.find((n) => n && n.props && n.props.className === 'ghsp-pill');
pill2.props.onMouseDown({ button: 0, clientX: 100, clientY: 100, currentTarget: { closest: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0, width: 120, height: 30 }) }) }, preventDefault() {} });
fire(listeners.doc, 'mousemove', { clientX: 102, clientY: 101 });
fire(listeners.doc, 'mouseup', {});
await r.settle();
pill2.props.onClick();
await r.settle();
ok(/本会话提交的 PR/.test(r.text()), '1–2px 抖动仍按点击处理');

/* ---- 7. 越界夹紧 ---- */
({ r } = await mountOverlay());
await r.click(/PR/);
const head3 = r.find((n) => n && n.props && String(n.props.className || '').includes('ghsp-card-head'));
head3.props.onMouseDown({ button: 0, clientX: 400, clientY: 300, currentTarget: { closest: () => ({ getBoundingClientRect: () => ({ left: 900, top: 300, width: 372, height: 320 }) }) }, preventDefault() {} });
fire(listeners.doc, 'mousemove', { clientX: -5000, clientY: -5000 });
await r.settle();
const left = parseInt(overlayNode(r).props.style.left, 10);
const top = parseInt(overlayNode(r).props.style.top, 10);
ok(left > -372 && left <= 8, `左侧夹紧（实际 ${left}）`);
ok(top === 8, `顶部夹紧（实际 ${top}）`);
fire(listeners.doc, 'mouseup', {});

r.dispose();
console.log(`\n===== Phase 32: ${pass}/${total} PASS =====`);
process.exit(fails.length ? 1 : 0);
