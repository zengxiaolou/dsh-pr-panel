/**
 * 会话级「本会话新建的 PR」登记簿（Host 进程内）。
 *
 * 为什么要它：
 * - 浮窗要「有 PR 就立刻出现」。会话转写是异步落盘的，且解压扫描是按文件整体做的，
 *   一次 gh pr create 之后等它进转写再扫出来，观感上是「点了没反应」。
 * - 因此写路径（github_pr create）成功后就地登记一条 {sessionId, repo, number}；
 *   路由把「登记簿」与「转写回填」两路合并——前者负责即时，后者负责重开后补历史。
 *
 * 边界：
 * - 这是**派生缓存**，不是真相源。进程重启就没了，转写扫描会把它们找回来。
 * - 只登记「本会话新建」的 PR；提及、评审、合并过的 PR 不属于这个口径。
 */
export type CreatedPrVia = 'tool' | 'bash' | 'api';
export interface CreatedPrRef {
    /** owner/repo */
    repo: string;
    number: number;
    /** 创建时间（毫秒） */
    at: number;
    via: CreatedPrVia;
}
/** 从 PR 链接里拆出 owner/repo 与编号；不是 PR 链接就返回 null */
export declare function parsePrUrl(url: string): {
    repo: string;
    number: number;
} | null;
/**
 * 登记一条「本会话新建的 PR」。
 * 同一 repo#number 重复登记只更新时间戳，不产生重复行。
 */
export declare function recordCreatedPr(sessionId: string, url: string, via?: CreatedPrVia): CreatedPrRef | null;
/** 读取某个会话登记过的 PR（按时间倒序，最新在前） */
export declare function listSessionCreatedPrs(sessionId: string): CreatedPrRef[];
/** 清空（测试用） */
export declare function __resetCreatedPrTracker(): void;
