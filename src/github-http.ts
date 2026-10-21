/**
 * GitHub API 直连通道（HTTP keep-alive），用于**只读**的高频取数。
 *
 * 为什么需要它：`gh` 每次调用都是一个新进程，TLS 握手与连接都重来一遍。实测同一台机器、
 * 同一个代理下，`gh pr view` 每次 ~1.4s，而进程内复用连接的第二次 fetch 只要 ~0.4s。
 * 轮询类接口（会话 PR 列表、PR 讨论串）是「同一端点反复取」，正好吃这个 3–4 倍差价。
 *
 * 边界（刻意为之）：
 * - **只做 GET / GraphQL 查询**。写操作（合并、评审、评论）继续走 gh：gh 的鉴权与作用域
 *   错误提示更成熟，不该为了几百毫秒把不可逆操作换到自研通道上。
 * - 任何失败（无 token、401、网络错误）都返回 ok:false，由调用方退回 gh——这是纯加速层，
 *   不允许成为新的单点故障。
 * - token 从 `gh auth token` 取（复用用户已有登录态），10 分钟刷新一次；401 时立即失效重取。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface GithubHttpResult<T = any> {
  ok: boolean;
  status: number;
  data?: T;
  error?: string;
}

let cachedToken = '';
let tokenAt = 0;
const TOKEN_TTL_MS = 10 * 60_000;
const TOKEN_MISS_TTL_MS = 60_000;

/**
 * 关掉直连通路的两个理由：
 * 1. 诊断：怀疑加速层本身有问题时，`DSH_GITHUB_HTTP=off` 立刻退回纯 gh 链路；
 * 2. 测试：phase 测试用桩执行器断言「调了几次 gh」，若这里真的走网络，
 *    断言会变成依赖外网与登录态。测试进程路径里带 test/，自动关掉。
 */
function httpDisabled(): boolean {
  if (String(process.env.DSH_GITHUB_HTTP || '').toLowerCase() === 'off') return true;
  const entry = String(process.argv[1] || '');
  return /(^|[\\/])test[\\/]/.test(entry);
}

/** 测试注入：跳过 `gh auth token` 子进程 */
export function __setGithubTokenForTests(token: string): void {
  cachedToken = token;
  tokenAt = Date.now();
}

export function __resetGithubHttpForTests(): void {
  cachedToken = '';
  tokenAt = 0;
}

async function getToken(): Promise<string> {
  if (cachedToken && Date.now() - tokenAt < TOKEN_TTL_MS) return cachedToken;
  // 失败过的 60 秒内不再反复 spawn `gh auth token`
  if (!cachedToken && tokenAt && Date.now() - tokenAt < TOKEN_MISS_TTL_MS) return '';
  try {
    const { stdout } = await execFileAsync('gh', ['auth', 'token'], { timeout: 5_000 });
    cachedToken = String(stdout || '').trim();
    tokenAt = Date.now();
    return cachedToken;
  } catch {
    cachedToken = '';
    tokenAt = Date.now();
    return '';
  }
}

async function request<T>(path: string, init: { method?: string; body?: string } = {}): Promise<GithubHttpResult<T>> {
  if (httpDisabled()) return { ok: false, status: 0, error: 'disabled' };
  const token = await getToken();
  if (!token) return { ok: false, status: 0, error: 'no-token' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(`https://api.github.com${path}`, {
      method: init.method || 'GET',
      body: init.body,
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'dsh-pr-panel',
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
    });
    const text = await res.text();
    let data: any = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (res.status === 401) { cachedToken = ''; } // 立即失效，下次重取
    if (!res.ok) {
      return { ok: false, status: res.status, error: (data && (data.message || data.error)) || `HTTP ${res.status}` };
    }
    return { ok: true, status: res.status, data: data as T };
  } catch (err: any) {
    return { ok: false, status: 0, error: String(err?.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

/** REST GET（只读） */
export function githubGet<T = any>(path: string): Promise<GithubHttpResult<T>> {
  return request<T>(path);
}

/** GraphQL 查询（只读） */
export function githubGraphql<T = any>(query: string, variables?: Record<string, unknown>): Promise<GithubHttpResult<T>> {
  return request<T>('/graphql', { method: 'POST', body: JSON.stringify({ query, variables: variables || {} }) });
}
