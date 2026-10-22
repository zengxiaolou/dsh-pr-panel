declare const React: any;

/**
 * 会话 PR 的两种分组视图：按阶段（Dev→Test→Release→Prod）与按功能（同一 head 分支）。
 *
 * 为什么单独一个模块：面板文件已经很长，而这块是**纯分组/渲染逻辑**，与 PR 详情、
 * diff、评审流程无关。放这里之后它可以被单独 import 做无头断言（phase45），
 * 面板只负责把 state 和回调接进来。
 *
 * 排序由 Host 做（/api/github/session-created-prs 已按阶段排好并下发 stages 表），
 * 前端只负责切段——两边各排一套的结局一定是浮窗和面板顺序不一样。
 */

/** 按阶段的首次出现顺序切段（依赖 Host 已排序；不在这里重新排） */
export function groupItemsByStage(items: any[]) {
  var lanes: any[] = [];
  var index: any = {};
  (items || []).forEach(function (it: any) {
    var st = (it && it.stage) || null;
    var id = String((st && st.id) || (it && it.stageId) || "other");
    var lane = index[id];
    if (!lane) {
      lane = {
        id: id,
        label: (st && st.label) || id.toUpperCase(),
        labelZh: (st && st.labelZh) || "",
        items: [],
      };
      index[id] = lane;
      lanes.push(lane);
    }
    lane.items.push(it);
  });
  return lanes;
}

/* ------------------------------------------------------------------ *
 * 第二种分组：按功能（同一 head 分支跨 Dev/Test/Release 时收成一条泳道）
 *
 * 阶段泳道回答「现在有谁卡在 Test」，功能泳道回答「这个功能走到哪一步了」。
 * 两种视角都有人要，所以做成切换而不是二选一。分组本身在客户端做：
 * Host 已经把 item 排好序并给了 stage，前端只需要归堆。
 * ------------------------------------------------------------------ */

/** 功能键：head 分支名；拿不到时退化成 repo#number，保证每组唯一 */

/* ------------------------------------------------------------------ *
 * 功能归组：同一条链 = 同一个功能分支被合入不同目标分支
 *
 * 现实约束（实测 12 条真实 PR 得出）：同一条链的 head 名一定不同。
 *   fix/ci-new-branch-base
 *   sync/release-v1.0.80-ci-new-branch-base-20261022
 *   fix/backfill-v1.0.67-into-v1.0.68
 *   sync/release-v1.0.67-backfill-to-main-20261022
 * 提交信息也不共享（同步时的 commit 是重写的），标题同样被改写。
 * 所以只能靠**分支名结构**判断，两条规则：
 *   a) 包含关系：派生分支名里嵌了源分支名（sync/…-ci-new-branch-base-20261022 ⊃ ci-new-branch-base）
 *   b) 同版本 + 共享主题词：名字被改写、互不包含时（backfill-v1.0.67-into-… vs release-v1.0.67-backfill-…）
 * 用并查集把满足任一关系的连起来；组名取组内最短且够长的 slug（通常就是源功能分支）。
 * ------------------------------------------------------------------ */

const FEATURE_NOISE_TOKENS = new Set([
  'release', 'rel', 'sync', 'to', 'into', 'from', 'main', 'master',
  'dev', 'develop', 'test', 'qa', 'staging', 'merge', 'branch',
]);

/** 分支名归一：去类型前缀、去尾部日期、下划线转连字符 */
export function normalizeBranchSlug(head: any): string {
  var s = String(head == null ? '' : head).toLowerCase().replace(/_/g, '-');
  s = s.replace(/^(fix|feat|feature|chore|hotfix|bugfix|sync|rel|release)\//, '');
  s = s.replace(/-?\d{8}$/, '');
  return s.replace(/-{2,}/g, '-').replace(/^-|-$/g, '');
}

function versionTokensOf(slug: string): string[] {
  var out: string[] = [];
  var re = /v?(\d+\.\d+\.\d+)/g;
  var m: RegExpExecArray | null;
  while ((m = re.exec(slug)) !== null) out.push(m[1]);
  return out;
}

function topicTokensOf(slug: string): string[] {
  return slug.split(/[-/]/).filter(function (t) {
    return t.length >= 4 && !FEATURE_NOISE_TOKENS.has(t) && !/^v?\d/.test(t);
  });
}

/** 两个分支名是否属于同一条链 */
function sameChain(a: any, b: any): boolean {
  // 完全同名（含短名，如 feat/login → login）一定是同一条链
  if (a.slug && a.slug === b.slug) return true;
  var shortSlug = a.slug.length <= b.slug.length ? a.slug : b.slug;
  var longSlug = a.slug.length <= b.slug.length ? b.slug : a.slug;
  // a) 包含关系（slug 太短容易误连，比如 ci）
  if (shortSlug.length >= 6 && longSlug.indexOf(shortSlug) >= 0) return true;
  // b) 同版本 + 共享主题词
  var sharedVersion = a.versions.some(function (v: string) { return b.versions.indexOf(v) >= 0; });
  if (!sharedVersion) return false;
  return a.topics.some(function (t: string) { return b.topics.indexOf(t) >= 0; });
}

/** 「推进度」：other 的 order=99 是排序哨兵，不能当进度用 */
function advanceRank(stage: any) {
  if (!stage || stage.id === "other") return -1;
  var n = Number(stage.order);
  return isFinite(n) ? n : -1;
}

export function groupItemsByFeature(items: any[]) {
  var list = (items || []).map(function (it: any) {
    var slug = normalizeBranchSlug(it && it.headRefName);
    return {
      item: it,
      slug: slug,
      versions: versionTokensOf(slug),
      topics: topicTokensOf(slug),
      key: slug || String((it && it.repo) || '') + '#' + String((it && it.number) || ''),
    };
  });

  // 并查集：只有真正同链的才连
  var parent: number[] = list.map(function (_, i) { return i; });
  function find(x: number): number { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
  function union(a: number, b: number) { var ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; }
  for (var i = 0; i < list.length; i += 1) {
    for (var j = i + 1; j < list.length; j += 1) {
      if (sameChain(list[i], list[j])) union(i, j);
    }
  }

  var buckets: any = {};
  var order: number[] = [];
  list.forEach(function (row, idx) {
    var root = find(idx);
    if (!buckets[root]) { buckets[root] = []; order.push(root); }
    buckets[root].push(row);
  });

  var out = order.map(function (root) {
    var rows = buckets[root];
    var slugs = rows.map(function (r: any) { return r.slug; }).filter(Boolean).sort(function (a: string, b: string) { return a.length - b.length; });
    // 组名取「最短且够长」的 slug：太短的（v1.0.79、ci）不适合当标签
    var key = slugs.filter(function (k: string) { return k.length >= 8; })[0] || slugs[0] || rows[0].key;
    var label = "";
    for (var r = 0; r < rows.length; r += 1) {
      if (rows[r].slug === key) { label = String(rows[r].item && rows[r].item.headRefName || "").trim(); break; }
    }
    var furthest: any = null;
    var done = true;
    var itemsInGroup = rows.map(function (r: any) { return r.item; });
    itemsInGroup.forEach(function (it: any) {
      if (advanceRank(it && it.stage) > advanceRank(furthest)) furthest = it.stage || null;
      if (!(it && it.mergedAt) && String((it && it.state) || '').toUpperCase() !== 'CLOSED') done = false;
    });
    return { key: key, label: label || key, items: itemsInGroup, furthest: furthest, done: done };
  });

  // 未完成的在前；再按走得最远的阶段升序（Dev 在前），与阶段泳道同向
  out.sort(function (a: any, b: any) {
    if (a.done !== b.done) return a.done ? 1 : -1;
    return advanceRank(a.furthest) - advanceRank(b.furthest);
  });
  return out;
}


/** 分支名太长会吃掉整行，保留前缀 + 省略 */
function shortFeatureName(key: string) {
  return key.length > 26 ? key.slice(0, 25) + "…" : key;
}
/** 泳道标签：slug 过长时截断（组名本身已经是「最短且够长」的那条） */
export function featureLabelOf(key: string) {
  return shortFeatureName(key);
}


/**
 * 统一成「泳道描述」：两种模式给同一形状，渲染层只写一份。
 * - 阶段模式：chip = Dev/Test/…，name 为空
 * - 功能模式：chip = 该功能走到的最远阶段，name = 分支名
 */
export function buildLanes(items: any[], mode: string) {
  if (mode === "feature") {
    return groupItemsByFeature(items).map(function (g: any) {
      var st = g.furthest;
      return {
        key: "f:" + g.key,
        id: (st && st.id) || "other",
        chip: st ? st.label : "",
        name: featureLabelOf(g.label || g.key),
        count: g.items.length,
        title: g.items.length + " 个 PR · 最远走到 " + (st ? st.label : "未归类") + (g.done ? " · 已全部合并" : "")
          + (g.items.length > 1 ? "\n同一版本/变更集在各分支上的 PR 收在此组" : ""),
        items: g.items,
      };
    });
  }
  return groupItemsByStage(items).map(function (lane: any) {
    return {
      key: "s:" + lane.id,
      id: lane.id,
      chip: lane.label,
      name: "",
      count: lane.items.length,
      title: (lane.labelZh ? lane.labelZh + " · " : "") + lane.items.length + " 个 PR",
      items: lane.items,
    };
  });
}

/** 视图切换（阶段 / 功能），两处入口共用同一个持久化键 */
const PR_GROUP_KEY = "dsh-github-flow:pr-group";

export function loadGroupMode(): string {
  try {
    return localStorage.getItem(PR_GROUP_KEY) === "feature" ? "feature" : "stage";
  } catch (e) {
    return "stage";
  }
}

export function saveGroupMode(mode: string) {
  try { localStorage.setItem(PR_GROUP_KEY, mode === "feature" ? "feature" : "stage"); } catch (e) { /* 隐私模式忽略 */ }
}

export function modeBar(mode: string, onChange: (next: string) => void) {
  var btn = function (key: string, text: string) {
    return React.createElement("button", {
      type: "button",
      className: "ghsp-mode-btn" + (mode === key ? " active" : ""),
      "aria-pressed": mode === key ? "true" : "false",
      title: key === "stage" ? "按阶段分组：看每个阶段堆了哪些 PR" : "按功能分组：同一分支的 PR 收成一条，看功能走到哪一步",
      onClick: function () { onChange(key); },
    }, text);
  };
  return React.createElement("div", { className: "ghsp-mode-bar" }, btn("stage", "阶段"), btn("feature", "功能"));
}

/**
 * 泳道渲染（两种模式共用一份，避免浮窗和面板长歪）。
 *
 * `options.collapsed` / `options.onToggle` 是可选的：传了就把泳道头渲染成可点按钮。
 * 折叠状态由外层组件持有（Lanes），这样浮窗和面板共享同一份持久化状态。
 */
export function laneList(items: any[], mode: string, rowFn: (item: any) => any, options?: any) {
  var opts = options || {};
  var collapsedList: string[] = Array.isArray(opts.collapsed) ? opts.collapsed : [];
  var onToggle = typeof opts.onToggle === "function" ? opts.onToggle : null;

  return React.createElement(
    "div",
    { className: "ghsp-lanes" },
    buildLanes(items, mode).map(function (lane: any) {
      var isCollapsed = collapsedList.indexOf(lane.key) >= 0;
      var headInner = [
        onToggle
          ? React.createElement("span", { className: "ghsp-lane-chevron", "aria-hidden": "true" }, isCollapsed ? "▸" : "▾")
          : null,
        lane.chip ? React.createElement("span", { className: "ghsp-lane-chip " + lane.id }, lane.chip) : null,
        lane.name ? React.createElement("span", { className: "ghsp-lane-name" }, lane.name) : null,
        React.createElement("span", { className: "ghsp-lane-count" }, String(lane.count)),
      ].filter(Boolean);

      var head = onToggle
        ? React.createElement("button", {
            type: "button",
            className: "ghsp-lane-head ghsp-lane-toggle",
            title: lane.title + "\n点击" + (isCollapsed ? "展开" : "收起"),
            "aria-expanded": isCollapsed ? "false" : "true",
            onClick: function () { onToggle(lane.key); },
          }, headInner)
        : React.createElement("div", { className: "ghsp-lane-head", title: lane.title }, headInner);

      return React.createElement(
        "div",
        { className: "ghsp-lane" + (isCollapsed ? " collapsed" : ""), key: lane.key },
        head,
        isCollapsed ? null : React.createElement("ul", { className: "ghsp-list" }, lane.items.map(rowFn))
      );
    })
  );
}

/** 折叠状态：与视图模式一样持久化，重开面板不回到「全展开」 */
const LANE_COLLAPSE_KEY = "dsh-github-flow:collapsed-lanes";

export function loadCollapsedLanes(): string[] {
  try {
    var raw = localStorage.getItem(LANE_COLLAPSE_KEY);
    if (!raw) return [];
    var arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter(function (x: any) { return typeof x === "string" && x.length <= 120; }).slice(0, 40);
  } catch (e) {
    return [];
  }
}

export function saveCollapsedLanes(list: string[]) {
  try { localStorage.setItem(LANE_COLLAPSE_KEY, JSON.stringify((list || []).slice(0, 40))); } catch (e) { /* 隐私模式忽略 */ }
}

/**
 * 持折叠状态的泳道组件。浮窗与面板都用它，
 * 所以「在浮窗里收起 Test，面板里 Test 也是收起的」。
 */
export function Lanes(props: any) {
  var [collapsed, setCollapsed] = React.useState(loadCollapsedLanes);

  var toggle = function (key: string) {
    var next = collapsed.indexOf(key) >= 0
      ? collapsed.filter(function (k: string) { return k !== key; })
      : collapsed.concat([key]);
    saveCollapsedLanes(next);
    setCollapsed(next);
  };

  return laneList(props.items, props.mode, props.rowFn, { collapsed: collapsed, onToggle: toggle });
}
