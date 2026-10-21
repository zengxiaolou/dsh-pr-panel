export interface GithubHttpResult<T = any> {
    ok: boolean;
    status: number;
    data?: T;
    error?: string;
}
/** 测试注入：跳过 `gh auth token` 子进程 */
export declare function __setGithubTokenForTests(token: string): void;
export declare function __resetGithubHttpForTests(): void;
/** REST GET（只读） */
export declare function githubGet<T = any>(path: string): Promise<GithubHttpResult<T>>;
/** GraphQL 查询（只读） */
export declare function githubGraphql<T = any>(query: string, variables?: Record<string, unknown>): Promise<GithubHttpResult<T>>;
