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
export declare function groupItemsByStage(items: any[]): any[];
/** 分支名归一：去类型前缀、去尾部日期、下划线转连字符 */
export declare function normalizeBranchSlug(head: any): string;
/**
 * 从 PR 标签里取功能名：`feature:xxx` / `feature/xxx` / `feature=xxx`。
 * 这是**唯一由人显式指定**的归组信号，可靠性高于任何分支名推断，
 * 所以只要两边都带标签，就完全以标签为准。
 */
export declare function featureLabelOfItem(item: any): string;
export declare function groupItemsByFeature(items: any[]): {
    key: any;
    label: any;
    source: string;
    items: any;
    furthest: any;
    done: boolean;
}[];
/** 泳道标签：slug 过长时截断（组名本身已经是「最短且够长」的那条） */
export declare function featureLabelOf(key: string): string;
/**
 * PR 的「要不要我动」等级（0 忽略，1 留意，2 待我处理，3 阻塞）。
 *
 * 借鉴 gh-dash 的分区思路：列表的价值不在"全量"，而在"该看哪条"。
 * 只用已经拿到的字段，不额外发请求；Host 与客户端共用这一份口径。
 */
export declare function prAttention(item: any): number;
export declare function buildLanes(items: any[], mode: string): {
    key: string;
    id: any;
    chip: any;
    name: string;
    count: any;
    title: string;
    items: any;
}[];
export declare function loadGroupMode(): string;
export declare function saveGroupMode(mode: string): void;
export declare function modeBar(mode: string, onChange: (next: string) => void): any;
/**
 * 泳道渲染（两种模式共用一份，避免浮窗和面板长歪）。
 *
 * `options.collapsed` / `options.onToggle` 是可选的：传了就把泳道头渲染成可点按钮。
 * 折叠状态由外层组件持有（Lanes），这样浮窗和面板共享同一份持久化状态。
 */
export declare function laneList(items: any[], mode: string, rowFn: (item: any) => any, options?: any): any;
export declare function loadCollapsedLanes(): string[];
export declare function saveCollapsedLanes(list: string[]): void;
/**
 * 持折叠状态的泳道组件。浮窗与面板都用它，
 * 所以「在浮窗里收起 Test，面板里 Test 也是收起的」。
 */
/**
 * 是否已经滑到"该加载更多"的位置（纯函数，可单测）。
 * 阈值给 48px：留一点提前量，用户不会撞到底才看见新内容。
 */
export declare function shouldLoadMore(scrollTop: number, clientHeight: number, scrollHeight: number, threshold?: number): boolean;
export declare function Lanes(props: any): any;
