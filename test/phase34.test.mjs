// test/phase34.test.mjs - Phase 34 · 刷新及时性（写操作后立刻刷新 / 回前台强制刷新 / TTL 收敛）
//
// 现场问题（2026-10-21）：「刷新同步功能不及时」——合并/评论之后，浮窗那份列表还挂着旧状态；
// 切到 GitHub 网页操作完再切回来，也要等下一拍才更新。
//
// 本阶段用 test/render/react-stub.mjs 真渲染面板与浮窗，断言：
// 1. 面板里点「合并」（二次确认后）成功 → 浮窗列表那次请求带 refresh=1（绕缓存）。
// 2. 评论/评审成功 → 同样立刻刷新列表。
// 3. 文档 visibilitychange 回到前台 → 触发一次带 refresh=1 的列表请求。
// 4. 窗口 focus → 同上。
// 5. host 两个 TTL 已收敛：元数据缓存 30s、转写重扫 30s（静态，避免退回 60s）。

import assert from 'node:assert';
import { createRenderer } from './render/react-stub.mjs';

let pass = 0; let total = 0; const fails = [];
function ok(cond, name) { total += 1; if (cond) pass += 1; else { fails.push(name); console.error('❌ ' + name); } }

/* ---- 最小 DOM（要能触发 visibilitychange / focus） ---- */
const listeners = { doc: {}, win: {} };
const bind = (store) => ({
  addEventListener(type, fn) { (store[type] = store[type] || []).push(fn); },
  removeEventListener(type, fn) { store[type] = (store[type] || []).filter((f) => f !== fn); },
});
const fire = (store, type, ev) => (store[type] || []).slice().forEach((fn) => fn(ev || {}));

const storeMap = new Map();
globalThis.localStorage = {
  getItem: (k) => (storeMap.has(k) ? storeMap.get(k) : null),
  setItem: (k, v) => { storeMap.set(k, String(v)); },
  removeItem: (k) => { storeMap.delete(k); },
};
const doc = {
  ...bind(listeners.doc), hidden: false,
  body: { style: {} },
  head: { appendChild() {}, removeChild() {} },
  getElementById: () => null, querySelectorAll: () => [],
  createElement: () => ({ setAttribute() {}, appendChild() {}, remove() {}, style: {}, textContent: '' }),
};
globalThis.document = doc;
globalThis.window = {
  ...bind(listeners.win), document: doc, innerWidth: 1280, innerHeight: 800,
  setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (t) => clearTimeout(t),
  open() {}, navigator: { clipboard: { writeText: () => Promise.resolve() } },
};
globalThis.navigator = globalThis.window.navigator;

const panel = await import('../lib/ui/session-pr-panel.js');
const { SessionPrPanel, SessionPrOverlay, resetSessionPrModuleState } = panel;

const REPO = 'acme/demo';
const NUMBER = 630;
const PR = {
  number: NUMBER, title: 'fix: 及时刷新', state: 'OPEN', isDraft: false, url: 'https://github.com/acme/demo/pull/630',
  headRefName: 'fix/x', baseRefName: 'main', headRefOid: '0123456789abcdef0123456789abcdef01234567',
  mergeStateStatus: 'CLEAN', autoMergeRequest: null, additions: 1, deletions: 1, changedFiles: 1,
  author: { login: 'someone' }, body: '', reviews: [], comments: [], commits: [], statusCheckRollup: [], files: [],
};
const LIST_ITEMS = [{ repo: REPO, number: NUMBER, title: 'fix: 及时刷新', state: 'OPEN', url: PR.url, baseRefName: 'main', additions: 1, deletions: 1, checks: { state: 'pass', total: 1, failing: 0 } }];

const calls = [];
function makeFetch() {
  return async (record) => {
    const u = String((record && record.url) || record);
    calls.push(u);
    if (u.includes('/api/github/session-created-prs')) return { ok: true, data: { items: LIST_ITEMS, total: 1 } };
    if (u.includes('/api/github/pr-detail')) return { ok: true, data: { pr: PR } };
    if (u.includes('/api/github/pr-diff')) return { ok: true, data: { diff: '' } };
    if (u.includes('/api/github/repo-merge-methods')) return { ok: true, data: { squash: true, merge: true, rebase: true } };
    return { ok: true, data: { message: '已合并' } };
  };
}

/* ---- 1/2. 面板写操作后刷新浮窗列表 ---- */
async function mountPanel() {
  resetSessionPrModuleState();
  const r = createRenderer();
  r.setFetch(makeFetch());
  await r.mount(SessionPrPanel, {
    sessionId: 's1',
    inputActions: { insertText() { return true; } },
    onOpenUrl() {},
    useTabInfo: () => ({ tab: { navigation: { params: { repo: REPO, number: NUMBER } } } }),
  });
  return r;
}

function listCalls(since) {
  return calls.slice(since).filter((u) => u.includes('/api/github/session-created-prs'));
}
function forcedListCalls(since) {
  return listCalls(since).filter((u) => u.includes('refresh=1'));
}

let r = await mountPanel();
let mark = calls.length;
await r.click('合并');
await r.click('确认合并？');
await new Promise((res) => setTimeout(res, 30));
const toastText = (r.findAll((n) => n && n.props && String(n.props.className || '').includes('ghsp-toast')).map((n) => r.text(n)) || []).join(' | ');
ok(forcedListCalls(mark).length >= 1, `合并成功后必须立刻强制刷新浮窗列表（refresh=1）；toast=${toastText}；calls=${calls.slice(mark).join(' , ')}`);

r.dispose();
r = await mountPanel();
{
  const box = r.find((n) => n && n.type === 'textarea' && n.props && typeof n.props.onChange === 'function');
  r.change(box, '发一条评论');
}
await r.settle();
mark = calls.length;
await r.click('发到 PR 评论');
await new Promise((res) => setTimeout(res, 30));
ok(forcedListCalls(mark).length >= 1, '评论成功后同样立刻刷新列表');

/* ---- 3/4. 回前台 / 窗口 focus 强制刷新 ---- */
resetSessionPrModuleState();
// 这两个监听在真实场景里由 client.ts 的 apply() 安装；这里直接调用模块导出
const stopWatch = panel.watchSessionPrVisibility();
const ov = createRenderer();
ov.setFetch(makeFetch());
await ov.mount(SessionPrOverlay, {
  useSessions: (sel) => sel({ byId: { s1: { retainedBy: { mainView: 1 } } } }),
  onOpenPr() {}, onOpenUrl() {},
});
ok((listeners.doc.visibilitychange || []).length >= 1, '必须监听 visibilitychange');
ok((listeners.win.focus || []).length >= 1, '必须监听 window focus');

mark = calls.length;
doc.hidden = false;
fire(listeners.doc, 'visibilitychange');
await new Promise((res) => setTimeout(res, 30));
ok(forcedListCalls(mark).length >= 1, '回到前台必须强制刷新（不是等下一拍缓存）');

mark = calls.length;
fire(listeners.win, 'focus');
await new Promise((res) => setTimeout(res, 30));
ok(forcedListCalls(mark).length >= 1, '窗口获得焦点必须强制刷新');

ov.dispose();
stopWatch();

/* ---- 5. host TTL 收敛（静态） ---- */
const fs = await import('node:fs');
const routes = fs.readFileSync('src/api/routes-actions.ts', 'utf8');
const scan = fs.readFileSync('src/session-pr-scan.ts', 'utf8');
ok(/hit\.at < 30_000\) return hit\.data/.test(routes), '元数据缓存 TTL 必须收敛到 30s');
ok(/MIN_RESCAN_MS = 30_000/.test(scan), '转写重扫间隔必须收敛到 30s');
assert.ok(true);

console.log(`\n===== Phase 34: ${pass}/${total} PASS =====`);
process.exit(fails.length ? 1 : 0);
