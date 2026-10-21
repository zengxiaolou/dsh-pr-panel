/**
 * 聚合根下的「手动选中仓库」持久化。
 *
 * 为什么放在 data 目录而不是 cordis 配置：这是一份**按工作区**变化的数据，
 * 不是插件级配置。写进 profile 的补丁层会让每次切换都触发插件重载，而且
 * 「A 目录选 repo1、B 目录选 repo2」在单一 config 里根本表达不了。
 *
 * 文件形状：{ "<workspace 绝对路径>": "<仓库根绝对路径>" }
 * 读取失败一律按「没有选择」处理（自动选择兜底），写入失败则抛给调用方，
 * 因为「用户点了切换但没生效」必须让上层看得见，不能静默假装成功。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 选择表所在目录（与 proxy.json 同级，随 DSH 卸载/清理一起走） */
export function repoSelectionDir(): string {
  return path.join(os.homedir(), '.dsh', 'data', 'dsh-pr-panel');
}

export function repoSelectionPath(): string {
  return path.join(repoSelectionDir(), 'repo-selection.json');
}

/** 读整张表；文件不存在或损坏都返回空表（损坏时不阻塞面板，交由下次写入自愈） */
function readAll(): Record<string, string> {
  try {
    const raw = fs.readFileSync(repoSelectionPath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const table: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof key === 'string' && typeof value === 'string' && key && value) {
        table[key] = value;
      }
    }
    return table;
  } catch {
    return {};
  }
}

/** 取某个工作区手动选中的仓库根；未选择或记录已失效（目录不存在）时返回 undefined */
export function readRepoSelection(workspacePath: string): string | undefined {
  if (!workspacePath) return undefined;
  const picked = readAll()[workspacePath];
  if (!picked) return undefined;
  // 目录被删/仓库被移走后，旧选择必须失效，否则每次请求都指向一个不存在的路径
  try {
    if (!fs.existsSync(picked)) return undefined;
  } catch {
    return undefined;
  }
  return picked;
}

/**
 * 写入/清除某个工作区的选择。
 * @param repoRoot 仓库根绝对路径；传 null 表示清除（恢复自动选择）
 */
export function writeRepoSelection(workspacePath: string, repoRoot: string | null): void {
  if (!workspacePath) throw new Error('缺少工作区路径');
  const table = readAll();
  if (repoRoot === null) {
    delete table[workspacePath];
  } else {
    if (!repoRoot) throw new Error('缺少仓库路径');
    table[workspacePath] = repoRoot;
  }

  const dir = repoSelectionDir();
  fs.mkdirSync(dir, { recursive: true });

  // 先写临时文件再 rename：避免面板在写入过程中读到半截 JSON 而整表回退成「无选择」
  const target = repoSelectionPath();
  const temp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(table, null, 2), 'utf8');
  fs.renameSync(temp, target);
}
