export interface SessionHeader {
    id: string;
    /** 父会话 id（子代理会话才有） */
    parentSession?: string;
    /** `subagent` 表示这个会话是派出来的子代理 */
    origin?: string;
    delegationDepth: number;
    cwd?: string;
}
export interface SessionDescendant {
    id: string;
    parentId: string;
    /** 1 = 主会话的直接子代理，2 = 孙代理…… */
    depth: number;
}
export interface LineageOptions {
    /** 覆盖 sessions 根目录（测试用）；默认 ~/.dsh/sessions */
    sessionsRoot?: string;
    /** 血缘深度上限，默认 4 */
    maxDepth?: number;
    /** 单次枚举的会话上限，默认 400 */
    maxSessions?: number;
}
/** 测试用：清空头缓存与计数 */
export declare function __resetSessionLineageCache(): void;
/** 测试用：观察「读了几次盘」，防止血缘枚举退化成每次请求都 spawn zstd */
export declare function __sessionLineageStats(): {
    spawns: number;
    cacheHits: number;
    failures: number;
    cached: number;
};
/** 会话 id 只允许 DSH 生成的那几种字符：它可能来自 HTTP query，不能拼出 `..` */
export declare function isSafeSessionId(id: string): boolean;
/** 在指定 sessions 根目录下按 sessionId 找转写（工作区目录名被转义过，只能逐个试） */
export declare function findTranscriptUnder(root: string, sessionId: string): string | null;
/** 解析转写第一行（`type:"session"`）成头结构；不是会话头就返回 null */
export declare function parseSessionHeaderLine(line: string): SessionHeader | null;
/** 读某个转写文件的会话头（路径级永久缓存：头写进文件后不会再变） */
export declare function readSessionHeader(transcript: string, opts?: {
    useCache?: boolean;
}): Promise<SessionHeader | null>;
/**
 * 列出 rootSessionId 名下的全部子孙会话（BFS，深度优先不影响结果排序）。
 *
 * 返回空数组的三种正常情况：根会话没有转写 / 没有子代理 / 系统缺 zstd。
 * 不抛异常——浮窗的数据源不该因为血缘读不到就整块 500。
 */
export declare function listSessionDescendants(rootSessionId: string, options?: LineageOptions): Promise<SessionDescendant[]>;
