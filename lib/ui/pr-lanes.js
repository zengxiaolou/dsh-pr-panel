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
export function groupItemsByStage(items) {
    var lanes = [];
    var index = {};
    (items || []).forEach(function (it) {
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
/**
 * 版本号提取：`release_v1.0.79` / `sync/release-0.1.49-...` / `回填 v1.0.67 的 13 个提交`
 * 都归到 `v1.0.67` 这种键上。
 *
 * 为什么要它：同一个变更往往会以不同的 head 名在多个分支上来回搬
 * （`fix/backfill-v1.0.67-into-v1.0.68` → `sync/release-v1.0.67-backfill-to-main`），
 * 按 head 归组会把一个功能的 2–3 个 PR 拆成 2–3 条泳道，等于没分组。
 * 这批 PR 共有的稳定信号是版本号，因此优先按版本聚合；没有版本号时才退回 head。
 */
function versionKeyOf(item) {
    var fields = [item && item.headRefName, item && item.baseRefName, item && item.title];
    for (var i = 0; i < fields.length; i += 1) {
        var m = String(fields[i] || "").match(/(?:^|[^\d.])v?(\d+\.\d+\.\d+)/i);
        if (m)
            return "v" + m[1];
    }
    return "";
}
function featureKeyOf(item) {
    var ver = versionKeyOf(item);
    if (ver)
        return ver;
    var head = String((item && item.headRefName) || "").trim();
    if (head)
        return head;
    return String((item && item.repo) || "") + "#" + String((item && item.number) || "");
}
/** 泳道标签：版本键原样展示，head 键做长度截断 */
function featureLabelOf(key) {
    if (/^v\d+\.\d+\.\d+$/.test(key))
        return key;
    return shortFeatureName(key);
}
/** 「推进度」：other 的 order=99 是排序哨兵，不能当进度用 */
function advanceRank(stage) {
    if (!stage || stage.id === "other")
        return -1;
    var n = Number(stage.order);
    return isFinite(n) ? n : -1;
}
export function groupItemsByFeature(items) {
    var order = [];
    var map = {};
    (items || []).forEach(function (it) {
        var key = featureKeyOf(it);
        var group = map[key];
        if (!group) {
            group = { key: key, items: [], furthest: null, done: true };
            map[key] = group;
            order.push(key);
        }
        group.items.push(it);
        if (advanceRank(it && it.stage) > advanceRank(group.furthest))
            group.furthest = it.stage || null;
        if (!(it && it.mergedAt) && String((it && it.state) || "").toUpperCase() !== "CLOSED")
            group.done = false;
    });
    var out = order.map(function (k) { return map[k]; });
    // 未完成的在前；再按走得最远的阶段升序（Dev 在前），与阶段泳道同向
    out.sort(function (a, b) {
        if (a.done !== b.done)
            return a.done ? 1 : -1;
        return advanceRank(a.furthest) - advanceRank(b.furthest);
    });
    return out;
}
/** 分支名太长会吃掉整行，保留前缀 + 省略 */
function shortFeatureName(key) {
    return key.length > 26 ? key.slice(0, 25) + "…" : key;
}
/**
 * 统一成「泳道描述」：两种模式给同一形状，渲染层只写一份。
 * - 阶段模式：chip = Dev/Test/…，name 为空
 * - 功能模式：chip = 该功能走到的最远阶段，name = 分支名
 */
export function buildLanes(items, mode) {
    if (mode === "feature") {
        return groupItemsByFeature(items).map(function (g) {
            var st = g.furthest;
            return {
                key: "f:" + g.key,
                id: (st && st.id) || "other",
                chip: st ? st.label : "",
                name: featureLabelOf(g.key),
                count: g.items.length,
                title: g.items.length + " 个 PR · 最远走到 " + (st ? st.label : "未归类") + (g.done ? " · 已全部合并" : "")
                    + (g.items.length > 1 ? "\n同一版本/变更集在各分支上的 PR 收在此组" : ""),
                items: g.items,
            };
        });
    }
    return groupItemsByStage(items).map(function (lane) {
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
export function loadGroupMode() {
    try {
        return localStorage.getItem(PR_GROUP_KEY) === "feature" ? "feature" : "stage";
    }
    catch (e) {
        return "stage";
    }
}
export function saveGroupMode(mode) {
    try {
        localStorage.setItem(PR_GROUP_KEY, mode === "feature" ? "feature" : "stage");
    }
    catch (e) { /* 隐私模式忽略 */ }
}
export function modeBar(mode, onChange) {
    var btn = function (key, text) {
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
export function laneList(items, mode, rowFn, options) {
    var opts = options || {};
    var collapsedList = Array.isArray(opts.collapsed) ? opts.collapsed : [];
    var onToggle = typeof opts.onToggle === "function" ? opts.onToggle : null;
    return React.createElement("div", { className: "ghsp-lanes" }, buildLanes(items, mode).map(function (lane) {
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
        return React.createElement("div", { className: "ghsp-lane" + (isCollapsed ? " collapsed" : ""), key: lane.key }, head, isCollapsed ? null : React.createElement("ul", { className: "ghsp-list" }, lane.items.map(rowFn)));
    }));
}
/** 折叠状态：与视图模式一样持久化，重开面板不回到「全展开」 */
const LANE_COLLAPSE_KEY = "dsh-github-flow:collapsed-lanes";
export function loadCollapsedLanes() {
    try {
        var raw = localStorage.getItem(LANE_COLLAPSE_KEY);
        if (!raw)
            return [];
        var arr = JSON.parse(raw);
        if (!Array.isArray(arr))
            return [];
        return arr.filter(function (x) { return typeof x === "string" && x.length <= 120; }).slice(0, 40);
    }
    catch (e) {
        return [];
    }
}
export function saveCollapsedLanes(list) {
    try {
        localStorage.setItem(LANE_COLLAPSE_KEY, JSON.stringify((list || []).slice(0, 40)));
    }
    catch (e) { /* 隐私模式忽略 */ }
}
/**
 * 持折叠状态的泳道组件。浮窗与面板都用它，
 * 所以「在浮窗里收起 Test，面板里 Test 也是收起的」。
 */
export function Lanes(props) {
    var [collapsed, setCollapsed] = React.useState(loadCollapsedLanes);
    var toggle = function (key) {
        var next = collapsed.indexOf(key) >= 0
            ? collapsed.filter(function (k) { return k !== key; })
            : collapsed.concat([key]);
        saveCollapsedLanes(next);
        setCollapsed(next);
    };
    return laneList(props.items, props.mode, props.rowFn, { collapsed: collapsed, onToggle: toggle });
}
