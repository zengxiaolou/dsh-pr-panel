/**
 * 工作区解析的单一数据源。
 *
 * 为什么独立成模块：`~/.dsh/storages/workspace.json` 的读取与「会话 ID → 物理路径」的
 * 反查逻辑原先在 executor.ts 与 api/routes.ts 里各写了一份（routes.ts 内还写了两遍），
 * 三份实现的字段兜底行为已有细微差异。同一份事实在多个地方各自解析，迟早会出现
 * 「工具看到的工作区」与「面板显示的工作区」不一致，因此收敛到这里。
 *
 * 本模块刻意不依赖 GhExecutor，只做纯文件读取，便于单元测试与复用。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface WorkspaceRecord {
  id: string;
  title: string;
  path: string;
  sessionIds: string[];
  updatedAt: string;
}

/** 缓存时长：workspace.json 变更频率低，但面板会反复读取，缓存可显著降低磁盘 IO 与解析开销 */
const WORKSPACE_CACHE_TTL_MS = 5_000;

interface CacheEntry {
  at: number;
  records: WorkspaceRecord[];
}

let cache: CacheEntry | null = null;

/** 仅供测试与配置变更后失效使用 */
export function resetWorkspaceCache(): void {
  cache = null;
}

export function workspaceJsonPath(): string {
  return path.join(os.homedir(), '.dsh', 'storages', 'workspace.json');
}

/**
 * 读取全部工作区记录。
 * 返回空数组表示「文件不存在」，抛错表示「文件存在但无法解析」——调用方必须区分这两种情况，
 * 否则 workspace.json 损坏时会显示成「你没有工作区」，把故障伪装成正常空状态。
 */
export function readWorkspaces(options: { bypassCache?: boolean } = {}): WorkspaceRecord[] {
  const now = Date.now();
  if (!options.bypassCache && cache && now - cache.at < WORKSPACE_CACHE_TTL_MS) {
    return cache.records;
  }

  const file = workspaceJsonPath();
  if (!fs.existsSync(file)) {
    cache = { at: now, records: [] };
    return [];
  }

  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const raw = parsed?.tables?.workspaces ?? {};

  const records: WorkspaceRecord[] = Object.keys(raw).map((id) => {
    const item = raw[id] ?? {};
    return {
      id,
      title: typeof item.title === 'string' ? item.title : '',
      path: typeof item.path === 'string' ? item.path : '',
      sessionIds: Array.isArray(item.sessionIds) ? item.sessionIds : [],
      updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : '',
    };
  });

  cache = { at: now, records };
  return records;
}

/** 容错读取：读取失败时返回空数组并把原因交给调用方，绝不静默吞掉 */
export function tryReadWorkspaces(): { workspaces: WorkspaceRecord[]; error?: string } {
  try {
    return { workspaces: readWorkspaces() };
  } catch (err: any) {
    return { workspaces: [], error: err?.message || '工作区数据读取失败' };
  }
}

/**
 * 按会话 ID 反查物理工作区路径。
 * 命中要求路径真实存在——workspace.json 里可能残留已删除的目录。
 */
export function findWorkspacePathBySession(sessionId: string): string | undefined {
  try {
    const { workspaces } = tryReadWorkspaces();
    for (const ws of workspaces) {
      if (ws.sessionIds.includes(sessionId) && ws.path && fs.existsSync(ws.path)) {
        return ws.path;
      }
    }
  } catch {
    // 会话反查是可选的尽力而为路径，失败时由调用方回退到其他策略
  }
  return undefined;
}

/**
 * 匹配最近活跃且包含 Git 仓库的工作区路径。
 *
 * 为什么必须优先检查 hasGitDir：workspace.json 中可能记录了父级纯文件夹工作区（例如工程聚合根目录，本身非 Git 仓库），
 * 当它被打开过导致 updatedAt 较新时，若不检查 .git 就会误把该父目录当成当前仓库执行路径，
 * 进而导致后续 gh 命令报出 "fatal: not a git repository"。
 * 策略：优先选取最近活跃且明确具备 .git 的工作区；若均无 .git 再优雅回退到任意普通工作区。
 */
export function findMostRecentWorkspacePath(): string | undefined {
  try {
    const { workspaces } = tryReadWorkspaces();
    let bestGitWs: WorkspaceRecord | null = null;
    let bestGitAt = -1;
    let fallbackWs: WorkspaceRecord | null = null;
    let fallbackAt = -1;

    for (const ws of workspaces) {
      if (!ws.path || !fs.existsSync(ws.path)) continue;
      const at = Date.parse(ws.updatedAt || '');
      const score = Number.isFinite(at) ? at : 0;

      if (hasGitDir(ws.path)) {
        if (score > bestGitAt) {
          bestGitWs = ws;
          bestGitAt = score;
        }
      } else {
        if (score > fallbackAt) {
          fallbackWs = ws;
          fallbackAt = score;
        }
      }
    }

    return bestGitWs?.path || fallbackWs?.path;
  } catch {
    return undefined;
  }
}

export function hasGitDir(dir: string): boolean {
  try {
    return fs.existsSync(path.join(dir, '.git'));
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * 仓库发现（repoDiscovery='aggregate' 的纯文件原语）
 *
 * 背景：上游明确规定「工作区必须自身是仓库根」，聚合根目录（本身非仓库、
 * 子目录里挂着若干仓库）判定为未关联，理由是不想在聚合目录里「张冠李戴」。
 * 但「一个大目录下多个仓库」是很常见的开发方式，整块面板会因此失效。
 *
 * 这里给出 opt-in 所需的三级探测原语：自身 → 向上回溯祖先 → 向下扫描子仓库。
 * 全程只用 fs 读，不 spawn 子进程（沿用本模块的既有纪律），毫秒级。
 * ------------------------------------------------------------------ */

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
export function resolveGitDir(repoPath: string): string | null {
  const dotGit = path.join(repoPath, '.git');
  try {
    const st = fs.statSync(dotGit);
    if (st.isDirectory()) return dotGit;
    if (st.isFile()) {
      const text = fs.readFileSync(dotGit, 'utf8');
      const matched = text.match(/^gitdir:\s*(.+)$/m);
      if (!matched) return null;
      const target = matched[1].trim();
      const abs = path.isAbsolute(target) ? target : path.resolve(repoPath, target);
      return fs.existsSync(abs) ? abs : null;
    }
  } catch {
    // 不存在或不可读：按「不是仓库根」处理，由调用方继续下一级探测
  }
  return null;
}

/** 目录自身是否为 Git 仓库根（含 worktree/submodule 的 .git 文件形态） */
export function isGitRepoRoot(dir: string): boolean {
  return resolveGitDir(dir) !== null;
}

/**
 * 向上回溯祖先目录找仓库根。
 * 只往回看，不看自身——自身是否仓库由调用方先行判定，避免语义重叠。
 */
export function findAncestorGitRoot(dir: string, levels = 3): string | null {
  let current = path.resolve(dir);
  const stop = path.parse(current).root;
  for (let i = 0; i < levels; i += 1) {
    const parent = path.dirname(current);
    if (parent === current || parent === stop) return null;
    if (isGitRepoRoot(parent)) return parent;
    current = parent;
  }
  return null;
}

/** 扫描一个目录时跳过的重型/无关子目录，避免在 node_modules 里做无谓的 stat */ 
const CHILD_SCAN_SKIP = new Set([
  'node_modules', 'vendor', 'dist', 'build', 'out', 'target', 'Pods',
  'DerivedData', '.cache', '__pycache__', '.venv', 'venv',
]);

/**
 * 向下扫描子仓库，返回按路径排序的绝对路径。
 * 命中仓库的子目录不再继续下降：子仓库内部不会再有「同级仓库」需要发现，
 * 继续递归只会让聚合根下一层套一层时误把嵌套仓库当成并列候选。
 */
export function findChildGitRoots(dir: string, depth = 1): string[] {
  const found: string[] = [];

  const walk = (current: string, level: number): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || CHILD_SCAN_SKIP.has(entry.name)) continue;
      const child = path.join(current, entry.name);
      // 允许符号链接目录参与判定（statSync 会跟随链接），但不再对链接做递归
      let isDir = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        try {
          isDir = fs.statSync(child).isDirectory();
        } catch {
          isDir = false;
        }
      }
      if (!isDir) continue;
      if (isGitRepoRoot(child)) {
        found.push(child);
        continue;
      }
      if (level < depth) walk(child, level + 1);
    }
  };

  walk(dir, 1);
  return found.sort();
}

/**
 * 仓库最近活动时间（毫秒时间戳），用于在多个子仓库间做确定性排序。
 *
 * 取值优先级：
 *   1. `.git/logs/HEAD` 末行时间戳——最近一次提交 / 切换 / merge 的真实时间；
 *   2. `.git/index` 的 mtime——至少反映了最后一次 stage；
 *   3. 0——全新仓库（没有任何活动记录）。
 */
export function gitActivityTs(repoPath: string): number {
  const gitDir = resolveGitDir(repoPath);
  if (!gitDir) return 0;

  try {
    const logPath = path.join(gitDir, 'logs', 'HEAD');
    if (fs.existsSync(logPath)) {
      const lines = fs.readFileSync(logPath, 'utf8').trimEnd().split('\n');
      const last = lines[lines.length - 1] || '';
      // reflog 行格式：<old> <new> <name> <email> <unix-ts> <tz> <msg>
      const matched = last.match(/>\s+(\d{9,})\s+[+-]\d{4}/);
      if (matched) return Number(matched[1]) * 1000;
    }
  } catch {
    // 新仓库还没有 reflog，继续退化到 index mtime
  }

  try {
    return fs.statSync(path.join(gitDir, 'index')).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * 在候选仓库里挑「最近在动的那个」。
 * 并列时按路径字典序取最小者——保证同一份磁盘状态永远得到同一个结果，
 * 不依赖 readdir 的返回顺序（这是可测试性的前提）。
 */
export function pickMostActiveRepo(candidates: readonly string[]): string | null {
  let best: string | null = null;
  let bestTs = -1;
  for (const candidate of [...candidates].sort()) {
    const ts = gitActivityTs(candidate);
    if (ts > bestTs) {
      best = candidate;
      bestTs = ts;
    }
  }
  return best;
}

/**
 * 列出某个工作区下的全部可选仓库（用于面板的手动切换器）。
 * 与 resolveRepoRoot 的区别：这里不做「选哪个」的判断，只回答「有哪些」。
 */
export function listRepoCandidates(dir: string, options: RepoDiscoveryOptions = {}): string[] {
  const resolved = resolveRepoRoot(dir, options);
  return resolved ? resolved.candidates : [];
}

/** 从绝对路径取一个适合展示的短名（面板下拉用），不再截断 owner/repo 之外的层级 */
export function repoDisplayName(repoPath: string): string {
  try {
    return path.basename(repoPath) || repoPath;
  } catch {
    return repoPath;
  }
}

/**
 * 把工作区路径解析为「真正可以跑 gh/git 的仓库根」。
 *
 * strict（默认）：只认自身是仓库根，与上游语义完全一致；
 * aggregate：自身 → 向上回溯 → 向下扫描子仓库，仍解析不到时返回 null
 * （保持「未关联」空状态，不伪造仓库）。
 */
export function resolveRepoRoot(
  dir: string,
  options: RepoDiscoveryOptions = {},
): RepoRootResolution | null {
  if (!dir) return null;
  if (!fs.existsSync(dir)) return null;

  const workspacePath = dir;

  // 1. 自身即仓库根：两条策略下都直接命中
  if (isGitRepoRoot(dir)) {
    return { root: dir, via: 'self', workspacePath, candidates: [dir] };
  }

  if ((options.mode || 'strict') !== 'aggregate') return null;

  // 2. 当前目录是某个仓库的子目录（如 repo/src、repo/packages/app）
  const ancestor = findAncestorGitRoot(dir, options.upwardLevels ?? 3);
  if (ancestor) {
    return { root: ancestor, via: 'ancestor', workspacePath, candidates: [ancestor] };
  }

  // 3. 聚合根目录：向下找子仓库，取最近活跃的一个
  const children = findChildGitRoots(dir, options.childDepth ?? 1);
  if (children.length === 0) return null;
  const picked = pickMostActiveRepo(children) || children[0];
  return { root: picked, via: 'child', workspacePath, candidates: children };
}

/**
 * 有界并发 map。
 * 为什么必须有：每个工作区探测最多 spawn 2 个 gh 进程，而 Node 的 libuv 线程池默认只有 4 个
 * 线程可用。工作区一多，无上限的 Promise.all 会把进程全部排进队列，单次 spawn 超时 10s × 排队
 * 造成整体秒级到十几秒的延迟（实测 /api/github/global-overview 曾达 18.9s）。
 * 这里显式限制在途数量，让延迟可预期，而不是随工作区数量线性劣化。
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];
  const effectiveLimit = Math.max(1, Math.min(limit, items.length));
  const results = new Array<R>(items.length);
  let cursor = 0;

  const workers = Array.from({ length: effectiveLimit }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  });

  await Promise.all(workers);
  return results;
}
