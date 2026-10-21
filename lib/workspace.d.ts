export interface WorkspaceRecord {
    id: string;
    title: string;
    path: string;
    sessionIds: string[];
    updatedAt: string;
}
/** 仅供测试与配置变更后失效使用 */
export declare function resetWorkspaceCache(): void;
export declare function workspaceJsonPath(): string;
/**
 * 读取全部工作区记录。
 * 返回空数组表示「文件不存在」，抛错表示「文件存在但无法解析」——调用方必须区分这两种情况，
 * 否则 workspace.json 损坏时会显示成「你没有工作区」，把故障伪装成正常空状态。
 */
export declare function readWorkspaces(options?: {
    bypassCache?: boolean;
}): WorkspaceRecord[];
/** 容错读取：读取失败时返回空数组并把原因交给调用方，绝不静默吞掉 */
export declare function tryReadWorkspaces(): {
    workspaces: WorkspaceRecord[];
    error?: string;
};
/**
 * 按会话 ID 反查物理工作区路径。
 * 命中要求路径真实存在——workspace.json 里可能残留已删除的目录。
 */
export declare function findWorkspacePathBySession(sessionId: string): string | undefined;
/**
 * 匹配最近活跃且包含 Git 仓库的工作区路径。
 *
 * 为什么必须优先检查 hasGitDir：workspace.json 中可能记录了父级纯文件夹工作区（例如工程聚合根目录，本身非 Git 仓库），
 * 当它被打开过导致 updatedAt 较新时，若不检查 .git 就会误把该父目录当成当前仓库执行路径，
 * 进而导致后续 gh 命令报出 "fatal: not a git repository"。
 * 策略：优先选取最近活跃且明确具备 .git 的工作区；若均无 .git 再优雅回退到任意普通工作区。
 */
export declare function findMostRecentWorkspacePath(): string | undefined;
export declare function hasGitDir(dir: string): boolean;
/** 仓库解析来源：自身 / 祖先目录 / 子目录 */
/** 仓库解析来源：自身 / 祖先目录 / 子目录 / 用户手动指定 */
export type RepoRootVia = 'self' | 'ancestor' | 'child' | 'manual';
export interface RepoDiscoveryOptions {
    /** 'strict'（默认，与上游一致）| 'aggregate'（开启聚合根适配） */
    mode?: 'strict' | 'aggregate';
    /** aggregate 下最多向上回溯的层数，默认 3 */
    upwardLevels?: number;
    /** aggregate 下向下扫描子仓库的深度，默认 1 */
    childDepth?: number;
}
export interface RepoRootResolution {
    /** 解析出的仓库根（绝对路径） */
    root: string;
    via: RepoRootVia;
    /** 解析前的原始工作区路径 */
    workspacePath: string;
    /** 参与选择的候选仓库（via='child' 时可能多于一个） */
    candidates: string[];
}
/**
 * 解析仓库的真实 .git 目录。
 *
 * 为什么不能只看 .git 是否存在：worktree / submodule 的 .git 是文本文件
 * （内容为 `gitdir: <path>`），只做 existsSync 会得到「有仓库」却读不到 reflog 的结果。
 */
export declare function resolveGitDir(repoPath: string): string | null;
/** 目录自身是否为 Git 仓库根（含 worktree/submodule 的 .git 文件形态） */
export declare function isGitRepoRoot(dir: string): boolean;
/**
 * 向上回溯祖先目录找仓库根。
 * 只往回看，不看自身——自身是否仓库由调用方先行判定，避免语义重叠。
 */
export declare function findAncestorGitRoot(dir: string, levels?: number): string | null;
/**
 * 向下扫描子仓库，返回按路径排序的绝对路径。
 * 命中仓库的子目录不再继续下降：子仓库内部不会再有「同级仓库」需要发现，
 * 继续递归只会让聚合根下一层套一层时误把嵌套仓库当成并列候选。
 */
export declare function findChildGitRoots(dir: string, depth?: number): string[];
/**
 * 仓库最近活动时间（毫秒时间戳），用于在多个子仓库间做确定性排序。
 *
 * 取值优先级：
 *   1. `.git/logs/HEAD` 末行时间戳——最近一次提交 / 切换 / merge 的真实时间；
 *   2. `.git/index` 的 mtime——至少反映了最后一次 stage；
 *   3. 0——全新仓库（没有任何活动记录）。
 */
export declare function gitActivityTs(repoPath: string): number;
/**
 * 在候选仓库里挑「最近在动的那个」。
 * 并列时按路径字典序取最小者——保证同一份磁盘状态永远得到同一个结果，
 * 不依赖 readdir 的返回顺序（这是可测试性的前提）。
 */
export declare function pickMostActiveRepo(candidates: readonly string[]): string | null;
/**
 * 列出某个工作区下的全部可选仓库（用于面板的手动切换器）。
 * 与 resolveRepoRoot 的区别：这里不做「选哪个」的判断，只回答「有哪些」。
 */
export declare function listRepoCandidates(dir: string, options?: RepoDiscoveryOptions): string[];
/** 从绝对路径取一个适合展示的短名（面板下拉用），不再截断 owner/repo 之外的层级 */
export declare function repoDisplayName(repoPath: string): string;
/**
 * 把工作区路径解析为「真正可以跑 gh/git 的仓库根」。
 *
 * strict（默认）：只认自身是仓库根，与上游语义完全一致；
 * aggregate：自身 → 向上回溯 → 向下扫描子仓库，仍解析不到时返回 null
 * （保持「未关联」空状态，不伪造仓库）。
 */
export declare function resolveRepoRoot(dir: string, options?: RepoDiscoveryOptions): RepoRootResolution | null;
/**
 * 有界并发 map。
 * 为什么必须有：每个工作区探测最多 spawn 2 个 gh 进程，而 Node 的 libuv 线程池默认只有 4 个
 * 线程可用。工作区一多，无上限的 Promise.all 会把进程全部排进队列，单次 spawn 超时 10s × 排队
 * 造成整体秒级到十几秒的延迟（实测 /api/github/global-overview 曾达 18.9s）。
 * 这里显式限制在途数量，让延迟可预期，而不是随工作区数量线性劣化。
 */
export declare function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]>;
