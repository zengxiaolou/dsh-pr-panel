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
export function normalizeBranchSlug(head) {
    var s = String(head == null ? '' : head).toLowerCase().replace(/_/g, '-');
    s = s.replace(/^(fix|feat|feature|chore|hotfix|bugfix|sync|rel|release|ci)\//, '');
    // 尾部噪声按任意顺序剥：日期、修订号（-r2/-r3）、再到「同步到某分支」的套话
    // 不剥会把两条无关的 sync 用 cleanup-to-main 这种词串误并到一起（实测踩到）；
    // 而 -to-dev-r3 这种「套话 + 修订号」不先剥修订号就匹配不上。
    for (var pass = 0; pass < 3; pass += 1) {
        s = s.replace(/-?\d{8}(-v\d+)?$/, '');
        s = s.replace(/-r\d+$/i, '');
        s = s.replace(/-?(to|into)-(main|master|dev|development|test|release[^-]*)$/, '');
    }
    return s.replace(/-{2,}/g, '-').replace(/^-|-$/g, '');
}
/** 目标分支归一（用于「来源链」判定：slug 里含另一个 PR 的目标版本分支） */
function normalizeBaseName(base) {
    return String(base == null ? '' : base).toLowerCase().replace(/_/g, '-');
}
function hasVersionToken(text) {
    return /\d+\.\d+\.\d+/.test(String(text == null ? '' : text));
}
/** 最长公共连续词串（用于兄弟分支：同一个前缀 + 不同后缀） */
function commonTokenRun(a, b) {
    var A = String(a || '').split(/[-/]/).filter(Boolean);
    var B = String(b || '').split(/[-/]/).filter(Boolean);
    var best = [];
    var prev = new Array(B.length + 1).fill(0);
    for (var i = 1; i <= A.length; i += 1) {
        var cur = new Array(B.length + 1).fill(0);
        for (var j = 1; j <= B.length; j += 1) {
            if (A[i - 1] === B[j - 1]) {
                cur[j] = prev[j - 1] + 1;
                if (cur[j] > best.length)
                    best = A.slice(i - cur[j], i);
            }
        }
        prev = cur;
    }
    return best;
}
function versionTokensOf(slug) {
    var out = [];
    var re = /v?(\d+\.\d+\.\d+)/g;
    var m;
    while ((m = re.exec(slug)) !== null)
        out.push(m[1]);
    return out;
}
function topicTokensOf(slug) {
    return slug.split(/[-/]/).filter(function (t) {
        return t.length >= 4 && !FEATURE_NOISE_TOKENS.has(t) && !/^v?\d/.test(t);
    });
}
/**
 * 从 PR 标签里取功能名：`feature:xxx` / `feature/xxx` / `feature=xxx`。
 * 这是**唯一由人显式指定**的归组信号，可靠性高于任何分支名推断，
 * 所以只要两边都带标签，就完全以标签为准。
 */
export function featureLabelOfItem(item) {
    var labels = item && item.labels;
    var list = Array.isArray(labels) ? labels : [];
    for (var i = 0; i < list.length; i += 1) {
        var raw = list[i];
        var name = typeof raw === "string" ? raw : String((raw && raw.name) || "");
        var m = name.trim().match(/^feature\s*[:/=]\s*(.+)$/i);
        if (m)
            return m[1].trim();
    }
    return "";
}
/** 两个分支名是否属于同一条链 */
function sameChain(a, b) {
    // ① 标签优先：任一方带 feature 标签时只看标签
    if (a.featureLabel || b.featureLabel) {
        return Boolean(a.featureLabel) && a.featureLabel === b.featureLabel;
    }
    // ② 完全同名
    if (a.slug && a.slug === b.slug)
        return true;
    // ③ 版本互斥：两边都带版本号却没有交集 → 一定是不同批次
    //   （实测踩到：0.1.61 与 v1.0.79 的「删除 CI 测试」同名，会被词串规则并成一条）
    if (a.versions.length > 0 && b.versions.length > 0
        && !a.versions.some(function (v) { return b.versions.indexOf(v) >= 0; }))
        return false;
    // ③ 包含关系（源分支名被派生名完整包含）
    var shortSlug = a.slug.length <= b.slug.length ? a.slug : b.slug;
    var longSlug = a.slug.length <= b.slug.length ? b.slug : a.slug;
    if (shortSlug.length >= 6 && longSlug.indexOf(shortSlug) >= 0)
        return true;
    // ④ 兄弟分支：公共词串够长（remove-orphan-vcc-contract-{development,test,main}）
    var run = commonTokenRun(a.slug, b.slug);
    if (run.length >= 2 && run.join('-').length >= 8)
        return true;
    // ⑤ 来源链：一方的 slug 里含着另一方「带版本号的目标分支」
    var pair = [[a, b], [b, a]];
    for (var i = 0; i < pair.length; i += 1) {
        var src = pair[i][0];
        var dst = pair[i][1];
        var base = normalizeBaseName(src.baseRefName);
        if (hasVersionToken(base) && base.length >= 8 && dst.slug.indexOf(base) >= 0)
            return true;
    }
    // ⑥ 同版本 + 共享主题词（名字被改写、互不包含时）
    var sharedVersion = a.versions.some(function (v) { return b.versions.indexOf(v) >= 0; });
    if (!sharedVersion)
        return false;
    return a.topics.some(function (t) { return b.topics.indexOf(t) >= 0; });
}
/** 「推进度」：other 的 order=99 是排序哨兵，不能当进度用 */
function advanceRank(stage) {
    if (!stage || stage.id === "other")
        return -1;
    var n = Number(stage.order);
    return isFinite(n) ? n : -1;
}
export function groupItemsByFeature(items) {
    var list = (items || []).map(function (it) {
        var slug = normalizeBranchSlug(it && it.headRefName);
        return {
            item: it,
            slug: slug,
            versions: versionTokensOf(slug),
            topics: topicTokensOf(slug),
            featureLabel: featureLabelOfItem(it),
            head: String((it && it.headRefName) || '').trim(),
            baseRefName: String((it && it.baseRefName) || ''),
            key: slug || String((it && it.repo) || '') + '#' + String((it && it.number) || ''),
        };
    });
    // 并查集：只有真正同链的才连
    var parent = list.map(function (_, i) { return i; });
    function find(x) { while (parent[x] !== x) {
        parent[x] = parent[parent[x]];
        x = parent[x];
    } return x; }
    function union(a, b) { var ra = find(a), rb = find(b); if (ra !== rb)
        parent[ra] = rb; }
    for (var i = 0; i < list.length; i += 1) {
        for (var j = i + 1; j < list.length; j += 1) {
            if (sameChain(list[i], list[j]))
                union(i, j);
        }
    }
    var buckets = {};
    var order = [];
    list.forEach(function (row, idx) {
        var root = find(idx);
        if (!buckets[root]) {
            buckets[root] = [];
            order.push(root);
        }
        buckets[root].push(row);
    });
    var out = order.map(function (root) {
        var rows = buckets[root];
        var slugs = rows.map(function (r) { return r.slug; }).filter(Boolean).sort(function (a, b) { return a.length - b.length; });
        // 组名取「最短且够长」的 slug：太短的（v1.0.79、ci）不适合当标签
        var byLabel = rows[0] && rows[0].featureLabel ? rows[0].featureLabel : "";
        var commonRun = "";
        if (!byLabel && rows.length > 1) {
            var runs = {};
            for (var x = 0; x < rows.length; x += 1) {
                for (var y = x + 1; y < rows.length; y += 1) {
                    var crun = commonTokenRun(rows[x].slug, rows[y].slug);
                    if (crun.length >= 2 && crun.join('-').length >= 8) {
                        var key2 = crun.join('-');
                        runs[key2] = (runs[key2] || 0) + 1;
                    }
                }
            }
            var bestKey = Object.keys(runs).sort(function (p, q) { return runs[q] - runs[p] || p.length - q.length; })[0];
            commonRun = bestKey || "";
        }
        var key = byLabel
            ? "label:" + byLabel
            : (commonRun || slugs.filter(function (k) { return k.length >= 8; })[0] || slugs[0] || rows[0].key);
        var source = byLabel ? "label" : "branch";
        // 派生分支（sync/…-to-main-20261022）不该当功能名：
        // 剥掉 -to-main 与日期后，它和源分支的 slug 往往完全相同，只能靠名字本身区分
        var isDerived = function (h) { return /^sync\//i.test(h) || /\d{8}(-v\d+)?$/.test(h); };
        var label = byLabel || commonRun;
        if (!byLabel && commonRun) {
            var exact = rows.filter(function (r) { return r.slug === commonRun && r.head; });
            var exactOrigin = exact.filter(function (r) { return !isDerived(r.head); });
            if (exactOrigin.length)
                label = exactOrigin[0].head;
            else if (exact.length)
                label = exact[0].head;
        }
        if (!label) {
            var origins = rows.map(function (r) { return r.head; }).filter(function (h) { return h && !isDerived(h); });
            if (origins.length) {
                label = origins.sort(function (a, b) { return a.length - b.length; })[0];
            }
            else {
                for (var r = 0; r < rows.length; r += 1) {
                    if (rows[r].slug === key) {
                        label = rows[r].head;
                        break;
                    }
                }
            }
        }
        var furthest = null;
        var done = true;
        var itemsInGroup = rows.map(function (r) { return r.item; });
        itemsInGroup.forEach(function (it) {
            if (advanceRank(it && it.stage) > advanceRank(furthest))
                furthest = it.stage || null;
            if (!(it && it.mergedAt) && String((it && it.state) || '').toUpperCase() !== 'CLOSED')
                done = false;
        });
        return { key: key, label: label || key, source: source, items: itemsInGroup, furthest: furthest, done: done };
    });
    // 未完成的排最前面（要处理的事），再 done，最后 closed；同状态内按最远阶段（Dev 在前）
    var STATUS_ORDER = { pending: 0, done: 1, closed: 2 };
    out.sort(function (a, b) {
        var sa = STATUS_ORDER[featureStatusOf(a.items).status];
        var sb = STATUS_ORDER[featureStatusOf(b.items).status];
        if (sa !== sb)
            return sa - sb;
        return advanceRank(a.furthest) - advanceRank(b.furthest);
    });
    return out;
}
/** 分支名太长会吃掉整行，保留前缀 + 省略 */
function shortFeatureName(key) {
    return key.length > 26 ? key.slice(0, 25) + "…" : key;
}
/** 泳道标签：slug 过长时截断（组名本身已经是「最短且够长」的那条） */
export function featureLabelOf(key) {
    return shortFeatureName(key);
}
/**
 * 统一成「泳道描述」：两种模式给同一形状，渲染层只写一份。
 * - 阶段模式：chip = Dev/Test/…，name 为空
 * - 功能模式：chip = 该功能走到的最远阶段，name = 分支名
 */
/**
 * 功能完成度（泳道头的 tag）：
 *   有任一 PR 还开着 → pending（这个功能还没走完）
 *   全部 merged      → done
 *   剩下的（全 closed，或 merged 与 closed 混合）→ closed
 *
 * 环境（Dev/Test/Release）不再占用 tag：每条 PR 的目标分支在行内已经写明，
 * 头部更该回答「这个功能完了没有」。
 */
function featureStatusOf(items) {
    var open = 0;
    var merged = 0;
    var closed = 0;
    (items || []).forEach(function (it) {
        var st = String((it && it.state) || '').toUpperCase();
        if ((it && it.mergedAt) || st === 'MERGED')
            merged += 1;
        else if (st === 'CLOSED')
            closed += 1;
        else
            open += 1;
    });
    var total = open + merged + closed;
    // 判定顺序（按用户口径修订）：
    //   有开着的        → pending
    //   没有开着但有合并 → done（merged + closed 混合也算走完：改动的部分已经进去了）
    //   全是 closed     → closed（整个功能放弃了）
    var status = open > 0 ? 'pending' : (merged > 0 ? 'done' : 'closed');
    var label = status === 'pending' ? 'PENDING' : (status === 'closed' ? 'CLOSED' : 'DONE');
    var zh = status === 'pending' ? '未完成' : (status === 'closed' ? '已关闭' : '已完成');
    var title = zh + '（已合并 ' + merged + '/' + total + '）'
        + (open > 0 ? '\n还有 ' + open + ' 个未合并' : '')
        + (closed > 0 ? '\n另有 ' + closed + ' 个已关闭（未合并）' : '');
    return { status: status, label: label, title: title, merged: merged, total: total };
}
/**
 * PR 的「要不要我动」等级（0 忽略，1 留意，2 待我处理，3 阻塞）。
 *
 * 借鉴 gh-dash 的分区思路：列表的价值不在"全量"，而在"该看哪条"。
 * 只用已经拿到的字段，不额外发请求；Host 与客户端共用这一份口径。
 */
export function prAttention(item) {
    if (!item)
        return 0;
    var st = String(item.state || '').toUpperCase();
    if (st === 'MERGED' || st === 'CLOSED')
        return 0;
    var checks = item.checks || {};
    if (Number(checks.failing) > 0)
        return 3;
    if (String(item.mergeable || '').toUpperCase() === 'CONFLICTING')
        return 3;
    if (String(item.mergeStateStatus || '').toUpperCase() === 'DIRTY')
        return 3;
    if (String(item.reviewDecision || '').toUpperCase() === 'CHANGES_REQUESTED')
        return 2;
    if (Array.isArray(item.reviewRequested) && item.reviewRequested.length > 0)
        return 2;
    if (String(checks.state || '') === 'pending')
        return 1;
    return 0;
}
/**
 * 目标环境的推进顺序：Prod > Release > Test > Dev > 其他。
 *
 * 为什么不是"开发在前"：读列表的人关心的是"这个功能走到哪了"，
 * 已经到 Release 的排最上面，一眼看出最远的那一版；Dev 垫底。
 */
export function stageRankOf(item) {
    var st = item && item.stage;
    if (st && typeof st.order === 'number' && st.id !== 'other')
        return st.order;
    var id = String((st && st.id) || '').toLowerCase();
    var byId = { prod: 40, release: 30, test: 20, dev: 10 };
    if (byId[id])
        return byId[id];
    var b = String((item && item.baseRefName) || '').toLowerCase();
    if (/^(main|master|prod|production)$/.test(b))
        return 40;
    if (b.indexOf('release') === 0 || b.indexOf('release/') === 0)
        return 30;
    if (b === 'test' || b.indexOf('test/') === 0)
        return 20;
    if (b === 'dev' || b === 'development' || b.indexOf('dev/') === 0)
        return 10;
    return 0;
}
const prAttentionOf = prAttention;
export function buildLanes(items, mode) {
    if (mode === "feature") {
        return groupItemsByFeature(items).map(function (g) {
            var st = g.furthest;
            var fs = featureStatusOf(g.items);
            return {
                key: "f:" + g.key,
                id: fs.status,
                chip: fs.label,
                status: fs.status,
                attention: g.items.filter(function (it) { return prAttentionOf(it) >= 2; }).length,
                statusTitle: fs.title,
                name: featureLabelOf(g.label || g.key),
                count: g.items.length,
                title: fs.title + "\n" + g.items.length + " 个 PR · 最远走到 " + (st ? st.label : "未归类")
                    + (g.source === "label"
                        ? "\n按标签 feature:" + g.key.replace(/^label:/, "") + " 归组"
                        : "\n按分支名推断归组；给 PR 打 feature:<名> 标签即可精确归组")
                    + (g.items.length > 1 ? "\n同一版本/变更集在各分支上的 PR 收在此组" : ""),
                items: g.items.slice().sort(function (a, b) {
                    // 1) 目标环境：Release → Test → Dev（越靠近发布越靠上）
                    var byStage = stageRankOf(b) - stageRankOf(a);
                    if (byStage !== 0)
                        return byStage;
                    // 2) 同环境里，需要我动的在前
                    var byAttn = prAttentionOf(b) - prAttentionOf(a);
                    if (byAttn !== 0)
                        return byAttn;
                    // 3) 最后按编号倒序（新的在上），保证顺序稳定可预期
                    return (Number(b && b.number) || 0) - (Number(a && a.number) || 0);
                }),
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
    var onLoadMore = typeof opts.onLoadMore === "function" ? opts.onLoadMore : null;
    return React.createElement("div", {
        className: "ghsp-lanes",
        onScroll: onLoadMore ? function (ev) {
            var el = ev && ev.currentTarget;
            if (!el)
                return;
            if (shouldLoadMore(el.scrollTop, el.clientHeight, el.scrollHeight))
                onLoadMore();
        } : undefined,
    }, buildLanes(items, mode).map(function (lane) {
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
/**
 * 是否已经滑到"该加载更多"的位置（纯函数，可单测）。
 * 阈值给 48px：留一点提前量，用户不会撞到底才看见新内容。
 */
export function shouldLoadMore(scrollTop, clientHeight, scrollHeight, threshold = 48) {
    var st = Number(scrollTop) || 0;
    var ch = Number(clientHeight) || 0;
    var sh = Number(scrollHeight) || 0;
    if (sh <= ch)
        return false; // 没得滚，别触发
    return st + ch >= sh - Math.max(0, Number(threshold) || 0);
}
export function Lanes(props) {
    var [collapsed, setCollapsed] = React.useState(loadCollapsedLanes);
    var toggle = function (key) {
        var next = collapsed.indexOf(key) >= 0
            ? collapsed.filter(function (k) { return k !== key; })
            : collapsed.concat([key]);
        saveCollapsedLanes(next);
        setCollapsed(next);
    };
    return laneList(props.items, props.mode, props.rowFn, {
        collapsed: collapsed,
        onToggle: toggle,
        onLoadMore: props.onLoadMore,
    });
}
