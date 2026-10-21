/** 选择表所在目录（与 proxy.json 同级，随 DSH 卸载/清理一起走） */
export declare function repoSelectionDir(): string;
export declare function repoSelectionPath(): string;
/** 取某个工作区手动选中的仓库根；未选择或记录已失效（目录不存在）时返回 undefined */
export declare function readRepoSelection(workspacePath: string): string | undefined;
/**
 * 写入/清除某个工作区的选择。
 * @param repoRoot 仓库根绝对路径；传 null 表示清除（恢复自动选择）
 */
export declare function writeRepoSelection(workspacePath: string, repoRoot: string | null): void;
