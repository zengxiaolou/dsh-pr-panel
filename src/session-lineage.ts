/**
 * 会话血缘：一个主会话底下挂了哪些「子代理会话」。
 *
 * 为什么要它：
 * - 「本会话提交的 PR」原来的口径只看主视图会话（retainedBy.mainView）。但 PR 往往是
 *   子代理建出来的（release / 发版 / 多工作面并行时，主会话把活派给 subagent），
 *   那些 PR 写在子会话的转写里，主会话的浮窗因此永远看不见。
 * - DSH 的会话转写第一行是 `{"type":"session",...}` 头，子代理会话在头里带
 *   `parentSession` / `origin:"subagent"` / `delegationDepth`。这是跨重启仍然成立的
 *   持久事实（比任何进程内登记簿都可靠），所以血缘直接从转写头里读。
 *
 * 边界与代价：
 * - **只读头**，不解压整份转写：zstd 解到第一行就 kill（本机实测 4–5ms/份），
 *   并且按文件路径永久缓存——头一旦写下就不会再变。
 * - 只在**主会话所在的工作区目录**里找。子代理继承父会话的 cwd，DSH 也把它们落在
 *   同一个 `~/.dsh/sessions/<escaped-cwd>/` 下；跨工作区扫一遍既慢又没有收益。
 * - 深度上限 4 层、单次最多 400 个会话，防止异常数据把 BFS 拖成环。
 * - 没有 `zstd` 命令时不报错，退化成「没有子代理会话」——与 session-pr-scan 的
 *   回填链路同一个失败模式，界面照常显示主会话的 PR。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

const DEFAULT_MAX_DEPTH = 4;
const DEFAULT_MAX_SESSIONS = 400;
const HEADER_TIMEOUT_MS = 5000;
/** 一次读多少个转写头：本机 4–5ms/份，6 路并发已经足够 */
const HEADER_CONCURRENCY = 6;

const headerCache = new Map<string, SessionHeader | null>();
const debug = { spawns: 0, cacheHits: 0, failures: 0 };
let warnedMissingZstd = false;

/** 测试用：清空头缓存与计数 */
export function __resetSessionLineageCache(): void {
  headerCache.clear();
  debug.spawns = 0;
  debug.cacheHits = 0;
  debug.failures = 0;
  warnedMissingZstd = false;
}

/** 测试用：观察「读了几次盘」，防止血缘枚举退化成每次请求都 spawn zstd */
export function __sessionLineageStats(): { spawns: number; cacheHits: number; failures: number; cached: number } {
  return { ...debug, cached: headerCache.size };
}

function sessionsRootDefault(): string {
  return path.join(os.homedir(), '.dsh', 'sessions');
}

/** 会话 id 只允许 DSH 生成的那几种字符：它可能来自 HTTP query，不能拼出 `..` */
export function isSafeSessionId(id: string): boolean {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id);
}

/** 在指定 sessions 根目录下按 sessionId 找转写（工作区目录名被转义过，只能逐个试） */
export function findTranscriptUnder(root: string, sessionId: string): string | null {
  if (!isSafeSessionId(sessionId)) return null;
  let workspaces: string[] = [];
  try {
    workspaces = fs.readdirSync(root);
  } catch {
    return null;
  }
  for (const ws of workspaces) {
    const candidate = path.join(root, ws, sessionId, 'session.v4.jsonl.zstd');
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* 单个目录不可读就跳过 */
    }
  }
  return null;
}

/** 解析转写第一行（`type:"session"`）成头结构；不是会话头就返回 null */
export function parseSessionHeaderLine(line: string): SessionHeader | null {
  const text = String(line || '').trim();
  if (!text) return null;
  try {
    const rec = JSON.parse(text);
    if (!rec || rec.type !== 'session' || typeof rec.id !== 'string' || !rec.id) return null;
    const depth = Number(rec.delegationDepth);
    return {
      id: rec.id,
      parentSession: typeof rec.parentSession === 'string' && rec.parentSession ? rec.parentSession : undefined,
      origin: typeof rec.origin === 'string' && rec.origin ? rec.origin : undefined,
      delegationDepth: Number.isFinite(depth) ? depth : 0,
      cwd: typeof rec.cwd === 'string' ? rec.cwd : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * 只解压到第一行就杀掉 zstd。
 *
 * 不能用 `execFile('zstd', ...)`：那会把整份转写（可达数十 MB）解完才返回，
 * 一次枚举几十个会话就等于把 Host 事件循环按住几秒。spawn + 读到换行即 kill 才是
 * 「读一个头」的真实成本。
 */
function readTranscriptHeaderRaw(transcript: string): Promise<SessionHeader | null> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      debug.spawns += 1;
      child = spawn('zstd', ['-dc', transcript], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      debug.failures += 1;
      resolve(null);
      return;
    }
    let buffer = '';
    let settled = false;
    const finish = (value: SessionHeader | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill('SIGKILL'); } catch { /* 已经退出 */ }
      resolve(value);
    };
    const timer = setTimeout(() => {
      debug.failures += 1;
      finish(null);
    }, HEADER_TIMEOUT_MS);
    if (typeof (timer as any).unref === 'function') (timer as any).unref();

    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const nl = buffer.indexOf('\n');
      if (nl >= 0) finish(parseSessionHeaderLine(buffer.slice(0, nl)));
    });
    child.on('error', (err: any) => {
      debug.failures += 1;
      if (!warnedMissingZstd && (err?.code === 'ENOENT' || String(err?.message || '').includes('ENOENT'))) {
        warnedMissingZstd = true;
        console.warn('[dsh-pr-panel] 找不到 zstd 命令：子代理会话的 PR 不会被收进浮窗（主会话不受影响）。');
      }
      finish(null);
    });
    child.on('close', () => {
      const line = buffer.split('\n')[0];
      finish(parseSessionHeaderLine(line));
    });
  });
}

/** 读某个转写文件的会话头（路径级永久缓存：头写进文件后不会再变） */
export async function readSessionHeader(transcript: string, opts: { useCache?: boolean } = {}): Promise<SessionHeader | null> {
  if (!transcript) return null;
  if (opts.useCache !== false && headerCache.has(transcript)) {
    debug.cacheHits += 1;
    return headerCache.get(transcript) ?? null;
  }
  const header = await readTranscriptHeaderRaw(transcript);
  // 失败不写缓存：下次请求值得再试（比如 zstd 被临时移出 PATH）
  if (header) headerCache.set(transcript, header);
  return header;
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length || 1)) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * 列出 rootSessionId 名下的全部子孙会话（BFS，深度优先不影响结果排序）。
 *
 * 返回空数组的三种正常情况：根会话没有转写 / 没有子代理 / 系统缺 zstd。
 * 不抛异常——浮窗的数据源不该因为血缘读不到就整块 500。
 */
export async function listSessionDescendants(
  rootSessionId: string,
  options: LineageOptions = {},
): Promise<SessionDescendant[]> {
  const rootId = typeof rootSessionId === 'string' ? rootSessionId.trim() : '';
  if (!isSafeSessionId(rootId)) return [];

  const sessionsRoot = options.sessionsRoot || sessionsRootDefault();
  const rootTranscript = findTranscriptUnder(sessionsRoot, rootId);
  if (!rootTranscript) return [];
  const workspaceDir = path.dirname(path.dirname(rootTranscript));

  let entries: string[] = [];
  try {
    entries = fs.readdirSync(workspaceDir);
  } catch {
    return [];
  }

  const transcripts = entries
    .filter((name) => isSafeSessionId(name))
    .map((name) => path.join(workspaceDir, name, 'session.v4.jsonl.zstd'))
    .filter((file) => {
      try { return fs.statSync(file).isFile(); } catch { return false; }
    });

  const headers = await mapLimit(transcripts, HEADER_CONCURRENCY, (file) => readSessionHeader(file));
  const childrenOf = new Map<string, SessionHeader[]>();
  for (const header of headers) {
    if (!header || !header.parentSession) continue;
    const list = childrenOf.get(header.parentSession) || [];
    list.push(header);
    childrenOf.set(header.parentSession, list);
  }

  const maxDepth = Number.isFinite(options.maxDepth) ? Math.max(1, Number(options.maxDepth)) : DEFAULT_MAX_DEPTH;
  const maxSessions = Number.isFinite(options.maxSessions) ? Math.max(1, Number(options.maxSessions)) : DEFAULT_MAX_SESSIONS;
  const seen = new Set<string>([rootId]);
  const out: SessionDescendant[] = [];
  let frontier: Array<{ id: string; depth: number }> = [{ id: rootId, depth: 0 }];

  while (frontier.length > 0 && out.length < maxSessions) {
    const next: Array<{ id: string; depth: number }> = [];
    for (const current of frontier) {
      if (current.depth >= maxDepth) continue;
      for (const child of childrenOf.get(current.id) || []) {
        if (seen.has(child.id)) continue;
        seen.add(child.id);
        out.push({ id: child.id, parentId: current.id, depth: current.depth + 1 });
        next.push({ id: child.id, depth: current.depth + 1 });
        if (out.length >= maxSessions) break;
      }
      if (out.length >= maxSessions) break;
    }
    frontier = next;
  }

  // 稳定输出：浅层在前、同层按 id —— 让「主会话的直系子代理」优先参与合并
  out.sort((a, b) => a.depth - b.depth || a.id.localeCompare(b.id));
  return out;
}
