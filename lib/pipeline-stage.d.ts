/**
 * 流水线阶段判定：Dev → Test → Release → Prod（→ Other）。
 *
 * 为什么需要它：
 * 一个会话里常常有 4–5 个功能并行，各自的 PR 停在不同的目标分支上。
 * 面板按「更新时间」平铺时，Dev 起步的、卡在 Test 的、等发版的混在一起，
 * 眼睛只能一行行读分支名去猜「这个功能走到哪一步了」。
 * 这里把「目标分支」翻译成有序阶段，列表就能按阶段排、按阶段分组——
 * 顺序本身就是进度。
 *
 * 判定优先级（后者只在前者判不出来时生效）：
 *   1. label（`stage:test` / `env:release` 这类团队约定）；
 *   2. baseRefName（PR 的目标分支 = 这个 PR 要去哪，最准）；
 *   3. headRefName（兜底：分支名本身带 dev/test/release 语义）。
 *
 * 注意：这里只做**语义映射**，不发明流程。仓库用 `feature/*` 直接进 main、
 * 没有 test/release 分支时，这些 PR 会落进 prod 或 other —— 不会假装有阶段。
 */
export type PipelineStageId = 'dev' | 'test' | 'release' | 'prod' | 'other';
export interface PipelineStage {
    id: PipelineStageId;
    /** 界面展示名（英文，遵循插件既有 UI 语言） */
    label: string;
    /** 中文名，给 tooltip / 文档用 */
    labelZh: string;
    /** 排序序号：越小越靠前（越接近开发侧） */
    order: number;
}
/** 有序阶段表：sort 与分组都从这里取序号，不在各处硬编码数字 */
export declare const PIPELINE_STAGES: PipelineStage[];
export declare function stageById(id: string): PipelineStage;
export type StageMatchedBy = 'label' | 'base' | 'head' | 'none';
export interface ResolvedStage {
    id: PipelineStageId;
    label: string;
    labelZh: string;
    order: number;
    matchedBy: StageMatchedBy;
    /** 命中的原始值（分支名或 label），便于排错「为什么这个 PR 算 Test」 */
    matchedValue: string;
}
/**
 * 用户自定义的阶段分支名（cordis.yml 的 `pipelineStages`）。
 * 语义：**追加并优先于内置规则**——把 `uat` 写进 prod，`uat` 就归生产；
 * 内置规则仍兜底，不会被整体替换掉（避免用户漏写一个名字导致某段空掉）。
 */
export interface StageOverrides {
    dev?: string[];
    test?: string[];
    release?: string[];
    prod?: string[];
}
export interface StageRule {
    id: PipelineStageId;
    test: RegExp;
}
/**
 * 把配置里的分支名编成规则。
 * 每个名字按「前缀 + 可选分隔符后缀」匹配（`uat` 命中 `uat` 与 `uat/1.2`），
 * 这样用户不必为每个变体写一条。
 */
export declare function buildStageOverrideRules(overrides?: StageOverrides | null): StageRule[];
export interface StageInput {
    baseRefName?: unknown;
    headRefName?: unknown;
    labels?: unknown;
}
/**
 * 解析单个 PR/分支的流水线阶段。
 * `overrides` 来自插件配置 `pipelineStages`，不传则用内置规则。
 */
export declare function resolvePipelineStage(input: StageInput | null | undefined, overrides?: StageOverrides | null): ResolvedStage;
/**
 * 同一阶段内部的次序：
 *   1. 待审/open 在前，草稿随后，已合并/已关闭沉底（它们已经走完这一段）；
 *   2. 同状态按更新时间倒序（刚动过的排前面）；
 *   3. 最后按编号倒序兜底，保证刷新之间顺序稳定。
 */
export declare function prStateRank(item: any): number;
export declare function comparePrsByStage(a: any, b: any): number;
/**
 * 给条目补上阶段并排序（不修改入参）。
 * 已经带 `stage.order` 的条目直接复用，避免重复解析。
 */
export declare function sortPrsByStage<T extends Record<string, any>>(items: T[]): T[];
export interface StageGroup<T> {
    stage: PipelineStage;
    items: T[];
}
/** 按阶段分组，空阶段不返回（浮窗不想要 5 个空泳道） */
export declare function groupPrsByStage<T extends Record<string, any>>(items: T[]): Array<StageGroup<T>>;
/**
 * 功能维度聚合：同一个功能在 Dev→Test→Release 之间流转时，head 分支通常不变，
 * 只是 base 一路往上换。按 headRefName 归组，就能把「同一功能的几个 PR」
 * 收成一条泳道，看出它当前停在最靠后的那个阶段。
 */
export interface FeatureGroup<T> {
    /** headRefName；拿不到时退化成 repo#number，保证每组唯一 */
    key: string;
    items: T[];
    /** 走得最远的那个阶段（阶段序号最大） */
    furthest: PipelineStage;
    /** 是否已经全部合并 */
    done: boolean;
    /** 展示名（原始分支名，或标签值）；缺省时用 key */
    label?: string;
    /** 分组依据：label（人工显式指定）优先于 branch（分支名推断） */
    source?: 'label' | 'branch';
}
/** 分支名归一：去类型前缀、去尾部日期、下划线转连字符 */
export declare function normalizeBranchSlug(head: any): string;
/**
 * 从 PR 标签里取功能名（`feature:xxx` / `feature/xxx` / `feature=xxx`）。
 * 唯一由人显式指定的归组信号：两边都有标签时完全以标签为准。
 */
export declare function featureLabelOfItem(item: any): string;
/** 单条 PR 的归一化信息（导出供测试） */
export declare function featureRowOf(item: any): {
    slug: string;
    versions: string[];
    topics: string[];
    featureLabel: string;
};
export declare function groupPrsByFeature<T extends Record<string, any>>(items: T[]): Array<FeatureGroup<T>>;
