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
export declare function groupItemsByFeature(items: any[]): any[];
/**
 * 统一成「泳道描述」：两种模式给同一形状，渲染层只写一份。
 * - 阶段模式：chip = Dev/Test/…，name 为空
 * - 功能模式：chip = 该功能走到的最远阶段，name = 分支名
 */
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
export declare function Lanes(props: any): any;
