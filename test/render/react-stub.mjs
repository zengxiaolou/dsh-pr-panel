// test/render/react-stub.mjs - 最小 React 替身 + 渲染/沉淀工具（零依赖，Node 直接跑）
//
// 为什么需要它：lib/ui/session-pr-panel.js 是纯 ESM 导出的函数组件，不依赖
// react-dom，只要给一个 `React.createElement` + hooks 的替身就能在 Node 里
// 「渲染」出元素树。元素树是普通对象，于是点击 = 调用 props.onClick，
// 断言 = 遍历树取文本 / className / props。这样 phase1-27 的「静态字符串
// 检查」升级成「点击 → 状态 → 输出」的真实行为测试。
//
// 替身的两个关键契约（写错就会得到假绿/假红）：
// 1. hooks 必须按调用顺序重放：每次渲染游标归零，值存进扁平 slot 数组；
//    useEffect 只把「依赖变了」的 effect 排进本轮队列，渲染结束后按序执行。
// 2. setState / dispatch 必须置 dirty：settle() 靠 dirty 决定要不要再渲染一轮
//    （上限 12 轮，每轮等 20ms 让 fetch 的 microtask 落地）。
//
// 注入的全局：React / renderOctocat / renderMarkdownLite / formatRelativeTime /
// splitDiffByFile —— 后者在真实 client bundle 里是由构建期注入的全局，
// 面板代码直接引用裸标识符，所以这里也必须挂到 globalThis 上。

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ *
 * 元素树
 * ------------------------------------------------------------------ */
function makeElement(type, props, ...children) {
  const flat = [];
  const push = (child) => {
    if (child === null || child === undefined || child === false || child === true) return;
    if (Array.isArray(child)) {
      child.forEach(push);
      return;
    }
    flat.push(child);
  };
  children.forEach(push);
  return { type, props: props || {}, children: flat };
}

/* ------------------------------------------------------------------ *
 * hooks：所有渲染共用一个当前 renderer（activeRt）
 * ------------------------------------------------------------------ */
let activeRt = null;

function nextSlot(rt) {
  if (!rt) throw new Error('React hook 在渲染之外被调用（activeRt 为空）');
  const index = rt.cursor;
  rt.cursor += 1;
  if (!rt.slots[index]) rt.slots[index] = {};
  return rt.slots[index];
}

function depsChanged(prev, next) {
  if (!Array.isArray(next)) return true;
  if (!Array.isArray(prev) || prev.length !== next.length) return true;
  for (let i = 0; i < next.length; i += 1) {
    if (!Object.is(prev[i], next[i])) return true;
  }
  return false;
}

function useState(init) {
  const rt = activeRt;
  const slot = nextSlot(rt);
  if (!Object.prototype.hasOwnProperty.call(slot, 'value')) {
    slot.value = typeof init === 'function' ? init() : init;
  }
  const setState = (next) => {
    const prev = slot.value;
    const value = typeof next === 'function' ? next(prev) : next;
    if (!Object.is(value, prev)) {
      slot.value = value;
      rt.dirty = true;
    }
  };
  return [slot.value, setState];
}

function useReducer(reducer, init) {
  const rt = activeRt;
  const slot = nextSlot(rt);
  if (!Object.prototype.hasOwnProperty.call(slot, 'value')) {
    slot.value = typeof init === 'function' ? init() : init;
  }
  const dispatch = (action) => {
    slot.value = reducer(slot.value, action);
    rt.dirty = true;
  };
  return [slot.value, dispatch];
}

function useRef(init) {
  const slot = nextSlot(activeRt);
  if (!Object.prototype.hasOwnProperty.call(slot, 'value')) slot.value = { current: init };
  return slot.value;
}

function useMemo(fn) {
  nextSlot(activeRt);
  // 不缓存结果：面板里的 useMemo 都是纯推导，每次重算最贴近「没有过期缓存」，
  // 也避免依赖数组写错导致的假绿。slot 仍然占位，保持 hook 顺序。
  return fn();
}

function useCallback(fn) {
  nextSlot(activeRt);
  return fn;
}

function useEffect(fn, deps) {
  const rt = activeRt;
  const slot = nextSlot(rt);
  const isFirst = !slot.hasRun;
  if (isFirst || depsChanged(slot.deps, deps)) {
    rt.pending.push({ fn, deps: Array.isArray(deps) ? deps.slice() : deps, slot });
  }
}

const ReactStub = {
  createElement: makeElement,
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
  useReducer,
};

/* ------------------------------------------------------------------ *
 * 构建期注入的全局替身
 * ------------------------------------------------------------------ */
/** 与 bundle 里 splitDiffByFile 同口径：按 `diff --git ` 切块，取 b/ 侧路径，统计 ±。 */
export function splitDiffByFile(patch) {
  const text = String(patch || '');
  const blocks = text.split(/^diff --git /m).filter((block) => block.trim());
  return blocks.map((block) => {
    const full = 'diff --git ' + block;
    const match = /a\/(\S+) b\/(\S+)/.exec(block.split('\n')[0] || '');
    const path = match ? match[2] : 'unknown';
    let additions = 0;
    let deletions = 0;
    for (const line of full.split('\n')) {
      if (line.slice(0, 3) === '+++' || line.slice(0, 3) === '---') continue;
      if (line.charAt(0) === '+') additions += 1;
      else if (line.charAt(0) === '-') deletions += 1;
    }
    return { path, text: full, additions, deletions };
  });
}

/** 极简 markdown：按空行分段 → <p>原文</p>，正文/意见的文本都能被 text() 读到。 */
function renderMarkdownLite(createElement, src) {
  const blocks = String(src === null || src === undefined ? '' : src)
    .split(/\n{2,}/)
    .filter((block) => block.trim());
  const h = typeof createElement === 'function' ? createElement : makeElement;
  return blocks.map((block, i) => h('p', { key: i }, block));
}

let installed = false;

/** 把 React / 构建期全局挂到 globalThis（幂等）。 */
export function installReactStub() {
  if (installed) return globalThis.React;
  globalThis.React = ReactStub;
  globalThis.renderOctocat = (size) => makeElement('svg', { className: 'octocat', width: size || 14 });
  globalThis.renderMarkdownLite = renderMarkdownLite;
  globalThis.formatRelativeTime = () => '刚刚';
  globalThis.splitDiffByFile = splitDiffByFile;
  installed = true;
  return globalThis.React;
}

installReactStub();

/* ------------------------------------------------------------------ *
 * 树遍历辅助
 * ------------------------------------------------------------------ */
export function walk(node, fn) {
  if (node === null || node === undefined || node === false) return;
  fn(node);
  if (typeof node === 'string' || typeof node === 'number') return;
  if (!node.children) return;
  node.children.forEach((child) => walk(child, fn));
}

export function text(node) {
  const parts = [];
  walk(node, (n) => {
    if (typeof n === 'string' || typeof n === 'number') parts.push(String(n));
  });
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

export function classes(node) {
  const out = [];
  walk(node, (n) => {
    if (n && typeof n === 'object' && n.props && typeof n.props.className === 'string') out.push(n.props.className);
  });
  return out;
}

const norm = (value) => String(value === null || value === undefined ? '' : value).replace(/\s+/g, '');

/** 按可见文本找第一个可点击节点并触发 onClick（不 settle；settle 由 renderer 负责）。 */
export function clickByText(tree, label) {
  const target = norm(label);
  let hit = null;
  walk(tree, (n) => {
    if (hit || !n || typeof n !== 'object' || !n.props) return;
    if (typeof n.props.onClick !== 'function') return;
    if (norm(text(n)) === target) hit = n;
  });
  if (!hit) return null;
  hit.props.onClick({});
  return hit;
}

/* ------------------------------------------------------------------ *
 * 渲染器
 * ------------------------------------------------------------------ */
function renderNode(node) {
  if (node === null || node === undefined || node === false || node === true) return null;
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (typeof node.type === 'function') {
    const children = node.children.length === 0
      ? undefined
      : (node.children.length === 1 ? node.children[0] : node.children);
    const props = Object.assign({}, node.props);
    if (children !== undefined) props.children = children;
    return renderNode(node.type(props));
  }
  return {
    type: node.type,
    props: node.props || {},
    children: node.children.map(renderNode).filter((child) => child !== null),
  };
}

let fetchInstalled = false;

function installFetch() {
  if (fetchInstalled) return;
  globalThis.fetch = (url, opts) => {
    const record = {
      url: String(url),
      method: String((opts && opts.method) || 'GET').toUpperCase(),
      opts: opts || null,
    };
    const rt = activeRt;
    if (rt) rt.fetchCalls.push(record);
    let payload;
    try {
      payload = rt && rt.fetchImpl ? rt.fetchImpl(record) : { ok: true, data: {} };
    } catch (err) {
      return Promise.reject(err);
    }
    return Promise.resolve(payload).then((value) => (
      value && typeof value.json === 'function' ? value : { json: async () => value }
    ));
  };
  fetchInstalled = true;
}

/**
 * 创建一个渲染器。每次 mount 都从干净的 slot 数组开始；不同用例之间请复用
 * 同一个 renderer 并先 dispose()，避免旧 effect 的轮询/定时器干扰。
 */
export function createRenderer(options = {}) {
  installFetch();
  const rt = {
    slots: [],
    cursor: 0,
    dirty: false,
    pending: [],
    component: null,
    props: null,
    tree: null,
    fetchCalls: [],
    fetchImpl: () => ({ ok: true, data: {} }),
    waitMs: Number.isFinite(options.waitMs) ? options.waitMs : 20,
    maxPasses: Number.isFinite(options.maxPasses) ? options.maxPasses : 12,
    disposed: true,
  };

  function renderPass() {
    rt.cursor = 0;
    rt.pending = [];
    rt.dirty = false;
    activeRt = rt;
    rt.tree = renderNode(makeElement(rt.component, rt.props || {}, []));
    return rt.tree;
  }

  function runEffect(entry) {
    const slot = entry.slot;
    if (typeof slot.cleanup === 'function') {
      try {
        slot.cleanup();
      } catch (err) {
        /* 清理阶段的异常不应掩盖真正的断言失败 */
      }
      slot.cleanup = null;
    }
    slot.hasRun = true;
    slot.deps = entry.deps;
    const cleanup = entry.fn();
    if (typeof cleanup === 'function') slot.cleanup = cleanup;
  }

  /** 渲染 → 执行本轮 effect → 等 20ms → 若 setState 置脏则再来一轮（上限 12 轮）。 */
  async function settle() {
    let tree = null;
    for (let pass = 0; pass < rt.maxPasses; pass += 1) {
      tree = renderPass();
      const effects = rt.pending;
      rt.pending = [];
      effects.forEach(runEffect);
      if (effects.length === 0 && !rt.dirty) return tree;
      await sleep(rt.waitMs);
      if (!rt.dirty) return tree;
    }
    return tree;
  }

  async function mount(component, props) {
    rt.component = component;
    rt.props = props || {};
    rt.slots = [];
    rt.cursor = 0;
    rt.dirty = false;
    rt.pending = [];
    rt.fetchCalls = [];
    rt.disposed = false;
    return settle();
  }

  function dispose() {
    for (let i = rt.slots.length - 1; i >= 0; i -= 1) {
      const slot = rt.slots[i];
      if (slot && typeof slot.cleanup === 'function') {
        try {
          slot.cleanup();
        } catch (err) {
          /* 忽略 */
        }
        slot.cleanup = null;
      }
    }
    rt.slots = [];
    rt.tree = null;
    rt.component = null;
    rt.props = null;
    rt.disposed = true;
    if (activeRt === rt) activeRt = null;
  }

  function findAll(predicate, root) {
    const out = [];
    walk(root === undefined ? rt.tree : root, (node) => {
      if (predicate(node)) out.push(node);
    });
    return out;
  }

  function find(predicate, root) {
    let hit = null;
    walk(root === undefined ? rt.tree : root, (node) => {
      if (!hit && predicate(node)) hit = node;
    });
    return hit;
  }

  function clickableLabels(root) {
    return findAll((n) => n && typeof n === 'object' && n.props && typeof n.props.onClick === 'function', root)
      .map((n) => text(n))
      .filter(Boolean);
  }

  function findClickable(label, opts = {}) {
    const matcher = label instanceof RegExp ? label : norm(label);
    const matches = findAll((node) => {
      if (!node || typeof node !== 'object' || !node.props) return false;
      if (typeof node.props.onClick !== 'function') return false;
      const labelText = text(node);
      if (matcher instanceof RegExp) return matcher.test(labelText);
      const normalized = norm(labelText);
      return opts.exact === false ? normalized.includes(matcher) : normalized === matcher;
    }, opts.root);
    return matches;
  }

  async function click(label, opts = {}) {
    const matches = findClickable(label, opts);
    const node = matches[opts.nth || 0];
    if (!node) {
      throw new Error(`click 找不到可点击目标：${String(label)}；当前可点击文本：${clickableLabels(opts.root).slice(0, 24).join(' / ')}`);
    }
    node.props.onClick(opts.event || {});
    // 事件处理器常见形态是 async：先让 microtask（fetch → setState）落地，
    // 否则 settle 可能在状态还没写回时就判定「已静止」，toast / loading 全看不到。
    await sleep(rt.waitMs);
    await settle();
    return node;
  }

  function clickNode(node, event) {
    if (!node || !node.props || typeof node.props.onClick !== 'function') {
      throw new Error('clickNode：节点没有 onClick');
    }
    node.props.onClick(event || {});
  }

  function change(node, value) {
    if (!node || !node.props || typeof node.props.onChange !== 'function') {
      throw new Error('change：节点没有 onChange');
    }
    node.props.onChange({ target: { value } });
  }

  function setFetch(impl) {
    rt.fetchImpl = impl;
  }

  return {
    mount,
    settle,
    dispose,
    get tree() { return rt.tree; },
    get fetchCalls() { return rt.fetchCalls; },
    setFetch,
    find,
    findAll,
    click,
    clickNode,
    change,
    clickableLabels,
    text: (node) => text(node === undefined ? rt.tree : node),
    classes: (node) => classes(node === undefined ? rt.tree : node),
    count: (predicate, root) => findAll(predicate, root).length,
  };
}
