import type { GhExecutor } from '../executor.js';
import { TtlCache } from '../cache.js';
import type { GitHubOverviewData, GlobalOverviewData } from '../types.js';
import { type RouteDeps } from './route-helpers.js';
export declare function buildTerminalCommand(command: string): {
    bin: string;
    args: string[];
} | null;
/** 测试辅助：重置 Linux 终端探测缓存（便于单测注入不同探测环境） */
export declare function resetLinuxTerminalCache(): void;
export interface TerminalLaunchOutcome {
    ok: boolean;
    /** launched=真的开了窗 / reused=复用了已有窗口 / skipped=认证态已满足无需开窗 */
    status?: 'launched' | 'reused' | 'skipped';
    reused?: boolean;
    skipped?: boolean;
    message?: string;
    error?: string;
}
/** 测试辅助：清空去重状态，让每个用例从干净状态开始 */
export declare function resetTerminalLaunchState(): void;
/** 把 ps 的 etime 文本（MM:SS / HH:MM:SS / D-HH:MM:SS）折算成秒 */
export declare function parseElapsedSeconds(text: string): number | null;
/**
 * 是否已有 `gh auth login` 在等输入？返回最年轻那个的年龄（秒），没有则 null。
 * 只在 darwin/linux 探测（pgrep+ps）；Windows 返回 null，交给冷却闸兜底。
 */
export declare function pendingGhLoginAgeSeconds(): number | null;
export interface TerminalLaunchOptions {
    /** 显式强制：跳过认证态 / 在途 / 冷却三道闸（补权限、换账号等真实诉求） */
    force?: boolean;
    /** 认证态探测；由调用方注入 executor.checkAuth，未注入则跳过认证闸 */
    authCheck?: () => Promise<{
        loggedIn?: boolean;
        user?: string;
        networkError?: boolean;
    } | null>;
    /** 实际唤起实现，测试可注入假实现 */
    launcher?: (command: string) => Promise<{
        ok: boolean;
        error?: string;
    }>;
    /** 在途窗口探测，测试可注入（默认扫本机 gh auth login 进程） */
    pendingCheck?: () => number | null;
    /** 时间源，测试可注入 */
    now?: () => number;
}
/**
 * 受控地唤起系统终端。返回值带 status，调用方据此如实告诉用户
 * 「开窗了 / 复用了已有窗口 / 已登录不用开」——既不再「说成功但没弹」，也不再「弹一堆」。
 */
export declare function requestTerminalLaunch(command: string, options?: TerminalLaunchOptions): Promise<TerminalLaunchOutcome>;
export declare function registerActionRoutes(deps: RouteDeps, executor: GhExecutor, cacheMap: TtlCache<GitHubOverviewData>, globalCache: TtlCache<GlobalOverviewData>): void;
