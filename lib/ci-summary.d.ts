/**
 * CI 结果归一与统计。
 *
 * 为什么单独一层：
 * 同一个 PR 的检查来自两种完全不同的对象——
 *   - CheckRun（GitHub Actions / 第三方 App）：`name` + `status` + `conclusion`
 *     + `startedAt` / `completedAt`；
 *   - StatusContext（老式 commit status）：`context` + `state` + `createdAt`，没有完成时间。
 * 面板原先只把它们压成一个三态圆点，于是「跑完了吗 / 什么时候跑完的 / 卡在哪一项」
 * 全都看不出来。这里统一成带时间戳的条目，再算出一轮 CI 的墙钟与最慢项。
 *
 * 另一个用途：列表里的「CI ✅ 12m 前完成」需要完成时间，而列表只拿得到汇总，
 * 所以这里同时产出 `lastCompletedAt`，让 UI 不必自己遍历。
 */
export type CiState = 'pass' | 'fail' | 'pending' | 'none';
export interface CiCheckInput {
    /** CheckRun 用 name，StatusContext 用 context */
    name?: unknown;
    context?: unknown;
    status?: unknown;
    conclusion?: unknown;
    state?: unknown;
    startedAt?: unknown;
    completedAt?: unknown;
    createdAt?: unknown;
    detailsUrl?: unknown;
    targetUrl?: unknown;
}
export interface CiCheckEntry {
    name: string;
    state: CiState;
    /** 单项耗时（毫秒）；没有确定结束时间时为 null */
    durationMs: number | null;
    startedAt: string | null;
    completedAt: string | null;
    url: string;
}
export interface CiSummary {
    state: CiState;
    total: number;
    passed: number;
    failed: number;
    pending: number;
    /** 整轮 CI 的起止（最早开始 → 最晚完成），全部完成时两者都有值 */
    firstStartedAt: string | null;
    lastCompletedAt: string | null;
    /** 墙钟耗时：firstStartedAt → lastCompletedAt；还有在跑的就是 firstStartedAt → now */
    durationMs: number | null;
    /** 还在跑的数量（pending 里细分出来，给「2/5 运行中」用） */
    running: number;
    /** 最慢的一项：大 PR 里通常是 e2e，用户最想知道卡谁 */
    slowest: {
        name: string;
        durationMs: number;
    } | null;
    /**
     * 明细不完整：列表只取前 N 项检查，或汇总与明细不一致。
     * 数量与耗时仍按已有明细算，但**状态**必须由调用方用权威汇总覆盖。
     */
    partial?: boolean;
    checks: CiCheckEntry[];
}
/**
 * 汇总一组检查。
 * `now` 可注入，便于单测固定时间；不注入时用当前时刻估算在跑耗时。
 */
export declare function summarizeCi(checks: CiCheckInput[] | null | undefined, now?: number): CiSummary;
/** 把耗时说成人话：42s / 8m12s / 1h04m */
export declare function formatDuration(ms: number | null | undefined): string;
/** 「12m 前」——完成时间比绝对时间戳更好读 */
export declare function formatAge(at: number | string | null | undefined, now?: number): string;
/**
 * GraphQL `statusCheckRollup.state` → 三态。
 * 认不出的值返回 null（不要猜成 pass）。
 */
export declare function rollupStateToCiState(raw: unknown): CiState | null;
/**
 * 用「权威汇总」校正「明细汇总」。
 *
 * 为什么必须有这一步：列表接口只取前 N 项检查明细（控流量），而一个 PR 可能有
 * 20+ 项。如果第 13 项失败、前 12 项全绿，拿明细算出来的结论就是「全绿」——
 * 面板显示通过、实际挂着红叉，这是这类 UI 里最坏的一种错。
 *
 * 规则：**状态永远听 GitHub 的汇总**；数量/耗时仍用明细（所以带 partial 标记），
 * 失败但明细里看不见失败项时，failed 至少记 1，不显示「✕0」。
 */
export declare function reconcileCiState(ci: CiSummary, rollupState: unknown, truncated?: boolean): CiSummary;
/**
 * workflow 运行统计：成功率 + 平均耗时。
 * 只统计有 conclusion 的运行（还在跑的不该拉低成功率）。
 */
export interface WorkflowRunInput {
    conclusion?: unknown;
    status?: unknown;
    createdAt?: unknown;
    startedAt?: unknown;
    updatedAt?: unknown;
}
export interface RunStats {
    runs: number;
    passed: number;
    failed: number;
    cancelled: number;
    /** 0–1；没有已结束运行时为 null（不要报 0%，那是「全失败」的意思） */
    successRate: number | null;
    avgDurationMs: number | null;
    lastSuccessAt: string | null;
    lastCompletedAt: string | null;
}
export declare function summarizeRunStats(runs: WorkflowRunInput[] | null | undefined): RunStats;
/**
 * 正在跑的那次运行「走到哪一步」。
 * GitHub 的 job/step 是两级：先找当前 job，再在它里面找第一个未完成的 step。
 * 没有任何 job 数据时返回 null，UI 就只显示状态徽标，不编造进度。
 */
export interface JobStepInput {
    number?: unknown;
    name?: unknown;
    status?: unknown;
    conclusion?: unknown;
}
export interface JobInput {
    name?: unknown;
    status?: unknown;
    conclusion?: unknown;
    startedAt?: unknown;
    completedAt?: unknown;
    steps?: JobStepInput[];
}
export interface ActiveRunProgress {
    job: string;
    jobStatus: string;
    stepNumber: number | null;
    stepName: string;
    stepsDone: number;
    stepsTotal: number;
    /** 整体 job 维度进度（0–1），steps 缺失时按 job 状态估 0.5 */
    ratio: number;
}
export declare function pickActiveProgress(jobs: JobInput[] | null | undefined): ActiveRunProgress | null;
