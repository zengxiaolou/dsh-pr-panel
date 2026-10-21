/**
 * 动作类路由：缓存强制刷新 + 右侧栏快捷操作（create_pr/create_issue/open_browser/open_terminal）。
 * 共同特征：POST 触发、读少写多、无缓存语义，与概览类路由的演进方向不同。
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hasGitDir } from '../workspace.js';
import { watchGitMetadata } from '../git-watcher.js';
import { isSafeExternalUrl, sendJson } from './route-helpers.js';
import { listSessionCreatedPrs } from '../session-pr-tracker.js';
import { readSessionCreatedPrs } from '../session-pr-scan.js';
import { listSessionDescendants } from '../session-lineage.js';
import { githubGraphql, githubGet } from '../github-http.js';
import { resolvePipelineStage, sortPrsByStage, PIPELINE_STAGES } from '../pipeline-stage.js';
/**
 * 把 gh 的原始报错翻成「用户能照着做」的一句话。
 *
 * 为什么不做无脑透传：`gh: Unprocessable Entity (HTTP 422)` 这种串对用户零信息量，
 * 而 422/403/404 在这里几乎总是固定几种原因（PR 状态变了、没权限、编号或仓库不对）。
 * 保留原始串在括号里，方便排查时对照。
 */
/**
 * GraphQL 的 `statusCheckRollup.state` 是单个枚举（SUCCESS/FAILURE/PENDING/…），
 * 与 REST 的 contexts 数组不同。这里压成和 summarizeCheckRollup 同构的三态，
 * 让上层（浮窗圆点 / 列表徽标）无需区分数据来源。
 */
function checksFromGraphqlState(state) {
    const raw = String(state || '').toUpperCase();
    if (raw === 'SUCCESS')
        return { state: 'pass', total: 0, failing: 0 };
    if (raw === 'FAILURE' || raw === 'ERROR' || raw === 'TIMED_OUT' || raw === 'CANCELLED')
        return { state: 'fail', total: 0, failing: 1 };
    if (raw === 'PENDING' || raw === 'EXPECTED' || raw === 'QUEUED' || raw === 'IN_PROGRESS')
        return { state: 'pending', total: 0, failing: 0 };
    return { state: 'none', total: 0, failing: 0 };
}
function humanizeGhError(raw, fallback) {
    const text = String(raw || '').trim();
    if (!text)
        return fallback;
    const lower = text.toLowerCase();
    const withRaw = (hint) => `${hint}（原始报错：${text.slice(0, 180)}）`;
    if (lower.includes('http 401') || lower.includes('authentication') || lower.includes('not logged')) {
        return withRaw('GitHub 登录已失效：在终端跑一次 `gh auth login` 再试');
    }
    if (lower.includes('http 403') || lower.includes('forbidden') || lower.includes('resource not accessible')) {
        return withRaw('没有权限做这次操作：确认账号对该仓库有写权限（组织仓库可能还需要 SSO 授权）');
    }
    if (lower.includes('http 404') || lower.includes('not found')) {
        return withRaw('找不到这个仓库或 PR：核对编号与仓库名，或当前账号看不到它');
    }
    if (lower.includes('http 422') || lower.includes('unprocessable')) {
        return withRaw('GitHub 拒绝了这次请求（422）：PR 状态已变、或分支保护/评审规则不满足');
    }
    if (lower.includes('merge conflict') || lower.includes('not mergeable') || lower.includes('conflict')) {
        return withRaw('存在合并冲突：先把目标分支合进当前分支、解决冲突后再试');
    }
    if (lower.includes('protected branch') || lower.includes('branch protection') || lower.includes('required status') || lower.includes('review required')) {
        return withRaw('分支保护未满足：要求的检查或批准还没通过');
    }
    if (lower.includes('rate limit') || lower.includes('api rate')) {
        return withRaw('触发了 GitHub 限流：等几分钟再试，或检查 gh 的配额');
    }
    if (lower.includes('timed out') || lower.includes('timeout') || lower.includes('etimedout')) {
        return withRaw('gh 超时：网络或 GitHub 响应慢，重试一次');
    }
    return text;
}
/**
 * 把 gh 的 statusCheckRollup 压成一个可画的三态：
 * pass / fail / pending / none。浮窗只有一个圆点，装不下 20 个 check。
 */
function summarizeCheckRollup(rollup) {
    if (!Array.isArray(rollup) || rollup.length === 0)
        return { state: 'none', total: 0, failing: 0 };
    let failing = 0;
    let pending = 0;
    let passing = 0;
    for (const item of rollup) {
        const conclusion = String(item?.conclusion || '').toUpperCase();
        const status = String(item?.status || '').toUpperCase();
        const ctxState = String(item?.state || '').toUpperCase();
        if (status && status !== 'COMPLETED') {
            pending += 1;
            continue;
        }
        if (ctxState) {
            if (ctxState === 'SUCCESS')
                passing += 1;
            else if (ctxState === 'PENDING')
                pending += 1;
            else
                failing += 1;
            continue;
        }
        if (conclusion === 'SUCCESS' || conclusion === 'NEUTRAL' || conclusion === 'SKIPPED')
            passing += 1;
        else if (conclusion === 'FAILURE' || conclusion === 'TIMED_OUT' || conclusion === 'CANCELLED' || conclusion === 'ACTION_REQUIRED' || conclusion === 'STARTUP_FAILURE')
            failing += 1;
        else
            pending += 1;
    }
    const total = rollup.length;
    const state = failing > 0 ? 'fail' : pending > 0 ? 'pending' : 'pass';
    return { state, total, failing };
}
/**
 * 构造「在新终端窗口运行命令」的平台命令（execFile 数组形态，不经 shell）。
 *
 * Issue #2 修复要点：
 * - Windows：cmd.exe（显式 .exe，规避 GUI 父进程 PATH 解析差异）+ start 的窗口标题
 *   占位 "DSH GitHub"——start 的首个带引号参数会被解析为标题而非程序，占位后
 *   powershell.exe 才能被稳定识别为目标程序；
 * - macOS：osascript 驱动 Terminal.app，命令经引号转义拼入 AppleScript；
 * - Linux：发行版终端二进制与参数形态各异（gnome-terminal 用 `--`、konsole 用
 *   `-e`、xfce4-terminal 用 `-x`），单一硬编码在主流桌面大概率不存在——由
 *   detectLinuxTerminal 按探测结果返回对应形态。
 */
/**
 * 有界并发 map：这个模块里的补充请求（逐条补 PR 元数据）不能无上限并发，
 * 否则十几次 gh 子进程会一起挤进 libuv 的 4 个线程里排队。
 */
async function mapLimitFn(items, limit, fn) {
    const out = new Array(items.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
        for (;;) {
            const i = cursor++;
            if (i >= items.length)
                return;
            out[i] = await fn(items[i], i);
        }
    });
    await Promise.all(workers);
    return out;
}
/**
 * 从会话转写里扫出 PR 编号。
 *
 * 三种写法都要认：
 *   1. 完整 URL      github.com/<owner>/<repo>/pull/<n>
 *   2. 简写          <owner>/<repo>#<n>
 *   3. 裸编号        #<n>（只在「当前仓库」上下文里成立，见下）
 *
 * 裸编号为什么敢收：面板是仓库级视图，裸 #123 几乎只可能指当前仓库；而每一条都会
 * 被 gh pr view 验证一次，取不到的直接丢掉（missing），所以误收的代价只是多一次请求，
 * 不收的代价是「用户在对话里说了 #3934 却看不到」——后者明显更糟。
 */
async function scanSessionPrRefs(transcript, repoNameWithOwner) {
    let text = '';
    try {
        // Node 20 的 zlib 没有 zstd API，统一走 zstd CLI
        text = execFileSync('zstd', ['-dc', transcript], { maxBuffer: 256 * 1024 * 1024, encoding: 'utf8' });
    }
    catch {
        return { explicit: [], bare: [] };
    }
    const target = repoNameWithOwner.toLowerCase();
    const [owner, repo] = target ? target.split('/') : ['', ''];
    const explicit = [];
    const bare = [];
    const seen = new Set();
    const pushExplicit = (num) => {
        const n = Number(num);
        if (!Number.isInteger(n) || n <= 0 || seen.has(n))
            return;
        seen.add(n);
        explicit.push(n);
    };
    const pushBare = (num) => {
        const n = Number(num);
        if (!Number.isInteger(n) || n <= 0 || seen.has(n))
            return;
        seen.add(n);
        bare.push(n);
    };
    if (!target)
        return { explicit, bare };
    // 1) 完整 URL
    const escapedOwner = owner.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const escapedRepo = repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const urlRe = new RegExp(`github\\.com\\/${escapedOwner}\\/${escapedRepo}\\/pull\\/(\\d+)`, 'gi');
    let m;
    while ((m = urlRe.exec(text)) !== null)
        pushExplicit(m[1]);
    // 2) owner/repo#N
    const shortRe = /([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)/g;
    while ((m = shortRe.exec(text)) !== null) {
        if (`${m[1]}/${m[2]}`.toLowerCase() === target)
            pushExplicit(m[3]);
    }
    // 3) 裸 #N —— 只在「显式引用之后」作为补充，且必须过 gh 验证
    //    为什么单独一组：对话里的 #235 很可能是 Issue 号，混在一起会把列表塞满垃圾。
    const bareRe = /(?:^|[^A-Za-z0-9_\/#])#(\d{2,6})\b/g;
    while ((m = bareRe.exec(text)) !== null)
        pushBare(m[1]);
    return { explicit, bare };
}
export function buildTerminalCommand(command) {
    if (process.platform === 'win32') {
        return {
            bin: 'cmd.exe',
            // -NoProfile 是 Windows 兼容基线：powershell.exe 是全量自带的 5.1，其默认执行
            // 策略常为 Restricted——加载用户 profile（如 conda init 写入的）会就地报
            // UnauthorizedAccess 红错（实测：winget 安装仍正常，但启动噪音吓人）。
            // 白名单命令（gh/winget/brew/apt）均不依赖用户 profile 环境；pwsh 7 是个人
            // 安装不作依赖，-NoProfile 在 5.1/7 语义一致，一并消除该类报错并加速启动。
            args: ['/c', 'start', 'DSH GitHub', 'powershell.exe', '-NoExit', '-NoProfile', '-Command', command],
        };
    }
    if (process.platform === 'darwin') {
        // AppleScript 字符串内的双引号以 \" 转义；白名单命令虽无引号，仍统一转义防未来扩展踩坑
        const escaped = command.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        return {
            bin: 'osascript',
            args: [
                '-e', `tell application "Terminal" to do script "${escaped}"`,
                '-e', 'tell application "Terminal" to activate',
            ],
        };
    }
    if (process.platform === 'linux') {
        const terminal = detectLinuxTerminal();
        if (!terminal)
            return null;
        // 各终端「执行命令并保持窗口」的参数形态不同：
        // - gnome-terminal -- <sh> -c：新版 -e 已弃用，-- 后直接跟命令行
        // - konsole/xfce4-terminal/xterm：-e/-x 执行，sh -c + exec 保交互语义
        //   （命令结束后 exec sh 落回交互 shell，窗口不闪退）
        const shArgs = ['sh', '-c', `${command}; exec sh`];
        switch (terminal) {
            case 'gnome-terminal': return { bin: 'gnome-terminal', args: ['--', ...shArgs] };
            case 'konsole': return { bin: 'konsole', args: ['-e', ...shArgs] };
            case 'xfce4-terminal': return { bin: 'xfce4-terminal', args: ['-x', ...shArgs] };
            case 'x-terminal-emulator': return { bin: 'x-terminal-emulator', args: ['-e', ...shArgs] };
            case 'xterm': return { bin: 'xterm', args: ['-e', ...shArgs] };
            default: return null;
        }
    }
    return null;
}
/** Linux 终端探测结果缓存（进程级）：which 探测有子进程成本，会话内只做一次 */
let cachedLinuxTerminal;
/**
 * 探测当前 Linux 桌面可用的终端模拟器（按桌面占有率排序）。
 * 返回 null 表示全部不可用——调用方据此走失败分支而非硬编码赌一个。
 */
function detectLinuxTerminal() {
    if (cachedLinuxTerminal !== undefined)
        return cachedLinuxTerminal;
    const candidates = ['gnome-terminal', 'konsole', 'xfce4-terminal', 'x-terminal-emulator', 'xterm'];
    try {
        const { execFileSync } = require('node:child_process');
        for (const name of candidates) {
            try {
                execFileSync('which', [name], { stdio: 'ignore', timeout: 2_000 });
                cachedLinuxTerminal = name;
                return name;
            }
            catch { /* 该候选不存在，试下一个 */ }
        }
    }
    catch { /* which 本身不可用（极端环境），视为无可用终端 */ }
    cachedLinuxTerminal = null;
    return null;
}
/** 测试辅助：重置 Linux 终端探测缓存（便于单测注入不同探测环境） */
export function resetLinuxTerminalCache() {
    cachedLinuxTerminal = undefined;
}
/**
 * 执行终端唤起并等待真实结果（Issue #2 核心修复：不再先斩后奏报假成功）。
 * start/osascript 场景下命令随宿主立即退出，close 即代表唤起动作用的成败；
 * err 与 stderr 原样上抛给调用方决定 HTTP 语义。
 */
function launchTerminalAndWait(command) {
    return new Promise((resolve) => {
        const built = buildTerminalCommand(command);
        if (!built) {
            resolve({ ok: false, error: '未找到可用的系统终端（Linux 下请先安装 gnome-terminal / konsole 等任一终端模拟器）' });
            return;
        }
        // stdio 必须忽略：start 唤起的交互式窗口会继承 execFile 的 stdout/stderr 管道句柄，
        // -NoExit 窗口存活期间管道永不关闭——回调要等满 10s 超时甚至不触发（实测复现：
        // 唤起成功的窗口让 HTTP 响应挂起 10s+）。交互终端本就不该捕获输出；stdio ignore
        // 后等待语义回归 cmd.exe 自身退出（start 创建窗口后立即返回，亚秒级）。
        // 改用原生 spawn：execFile 的类型与实现都强制 stdout 管道捕获，而交互终端唤起
        // 场景需要的恰恰是「不捕获」——spawn 的 stdio:'ignore' 是官方支持的干净形态。
        const child = spawn(built.bin, built.args, {
            stdio: 'ignore',
            detached: false,
        });
        // 10s 兜底超时：正常路径 cmd.exe start 毫秒级返回；超时视为唤起故障并如实回传
        let timedOut = false;
        const killTimer = setTimeout(() => { timedOut = true; child.kill(); }, 10_000);
        child.on('error', (err) => {
            clearTimeout(killTimer);
            resolve({ ok: false, error: err.message });
        });
        child.on('close', (code) => {
            clearTimeout(killTimer);
            if (code === 0) {
                resolve({ ok: true });
            }
            else if (timedOut) {
                // kill 触发的 close 是 code=null——如实归因为超时而非"退出码 null"
                resolve({ ok: false, error: '终端启动命令 10 秒未返回（可能被安全软件拦截）' });
            }
            else {
                resolve({ ok: false, error: `终端启动命令退出码 ${code}` });
            }
        });
    });
}
/* ──────────────────────────────────────────────────────────────────────────
 * 终端唤起去重（防「窗口风暴」）
 *
 * 现场故障（2026-10-20）：auth-guide-card 的「唤起终端登录」按钮，以及任何程序化
 * POST /api/github/action{action:open_terminal}，会在 gh 其实已经登录的情况下反复
 * 用 AppleScript 开 Terminal 窗口跑 `gh auth login`；而 gh 一旦进入交互式
 * `Where do you use GitHub?` 就永远在等输入，于是一路堆到七八个卡死窗口 + 同数量
 * 的 gh 进程，只能手动一个个关。
 *
 * 三道闸，按「最省事」到「最严格」依次拦：
 *   1. 认证态闸：gh 已登录且无网络异常时直接拒绝开窗。这是根因——调用方拿不到
 *      「未登录」信号，本来就不该需要窗口。
 *   2. 在途闸：已经有 `gh auth login` 在等输入（10 分钟内）就复用它，不再开新窗；
 *      更老的视为僵尸窗口允许重开，避免遗留进程把真实登录永久挡住。
 *   3. 冷却闸：同一条命令 N 秒内只唤起一次，兜住按钮连点与重试循环。
 * 另外并发请求通过 in-flight 合并共享同一次 spawn，不会一人开一个窗。
 * ────────────────────────────────────────────────────────────────────────── */
/** 同一命令的唤起冷却（毫秒），可用 DSH_GITHUB_TERMINAL_COOLDOWN_MS 覆盖 */
const TERMINAL_LAUNCH_COOLDOWN_MS = (() => {
    const raw = Number(process.env.DSH_GITHUB_TERMINAL_COOLDOWN_MS);
    return Number.isFinite(raw) && raw >= 0 ? raw : 60_000;
})();
/** 已存在的 `gh auth login` 超过这个年龄就当僵尸窗口，允许重新唤起 */
const PENDING_LOGIN_MAX_AGE_S = 600;
let lastTerminalLaunch = null;
let inflightTerminalLaunch = null;
/** 测试辅助：清空去重状态，让每个用例从干净状态开始 */
export function resetTerminalLaunchState() {
    lastTerminalLaunch = null;
    inflightTerminalLaunch = null;
}
/** 把 ps 的 etime 文本（MM:SS / HH:MM:SS / D-HH:MM:SS）折算成秒 */
export function parseElapsedSeconds(text) {
    const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(String(text || '').trim());
    if (!m)
        return null;
    return Number(m[1] || 0) * 86400 + Number(m[2] || 0) * 3600 + Number(m[3] || 0) * 60 + Number(m[4] || 0);
}
/**
 * 是否已有 `gh auth login` 在等输入？返回最年轻那个的年龄（秒），没有则 null。
 * 只在 darwin/linux 探测（pgrep+ps）；Windows 返回 null，交给冷却闸兜底。
 */
export function pendingGhLoginAgeSeconds() {
    if (process.platform === 'win32')
        return null;
    try {
        const pids = execFileSync('pgrep', ['-f', '^gh auth login'], { encoding: 'utf8', timeout: 2_000 })
            .trim().split(/\s+/).filter(Boolean).slice(0, 4);
        if (!pids.length)
            return null;
        let youngest = null;
        for (const pid of pids) {
            const seconds = parseElapsedSeconds(execFileSync('ps', ['-o', 'etime=', '-p', pid], { encoding: 'utf8', timeout: 2_000 }));
            if (seconds === null)
                continue;
            if (youngest === null || seconds < youngest)
                youngest = seconds;
        }
        return youngest;
    }
    catch {
        // pgrep 无匹配退出码 1、ps 目标已消失也会抛——两种都等价于「没有在途窗口」
        return null;
    }
}
/**
 * 受控地唤起系统终端。返回值带 status，调用方据此如实告诉用户
 * 「开窗了 / 复用了已有窗口 / 已登录不用开」——既不再「说成功但没弹」，也不再「弹一堆」。
 */
export async function requestTerminalLaunch(command, options = {}) {
    const now = options.now ? options.now() : Date.now();
    if (!options.force) {
        // 闸 1：认证态已满足就不要开窗（真正的根因）
        if (command === 'gh auth login' && options.authCheck) {
            const auth = await options.authCheck().catch(() => null);
            if (auth && auth.loggedIn && !auth.networkError) {
                const who = auth.user ? `（${auth.user}）` : '';
                return {
                    ok: true,
                    status: 'skipped',
                    skipped: true,
                    message: `gh 已登录${who}，无需再执行 gh auth login；如需补权限或换账号，请显式传 force`,
                };
            }
        }
        // 闸 2：已有等待中的登录窗口就复用
        if (command === 'gh auth login') {
            const pendingCheck = options.pendingCheck || pendingGhLoginAgeSeconds;
            const age = pendingCheck();
            if (age !== null && age <= PENDING_LOGIN_MAX_AGE_S) {
                return {
                    ok: true,
                    status: 'reused',
                    reused: true,
                    message: `已有一个 gh auth login 窗口在等你输入（已开 ${age} 秒），请切到那个 Terminal 窗口完成授权，本次不再重复开窗`,
                };
            }
        }
        // 闸 3：冷却窗口内的重复请求复用上一次结果
        if (lastTerminalLaunch && lastTerminalLaunch.command === command && now - lastTerminalLaunch.at < TERMINAL_LAUNCH_COOLDOWN_MS) {
            const waited = Math.max(0, Math.round((now - lastTerminalLaunch.at) / 1000));
            return {
                ok: lastTerminalLaunch.ok,
                status: 'reused',
                reused: true,
                message: `${waited} 秒前刚唤起过终端（${command}），为避免重复开窗本次跳过；确需重开请显式传 force`,
            };
        }
        // 并发合并：同一命令的并发请求共享一次 spawn
        if (inflightTerminalLaunch && inflightTerminalLaunch.command === command) {
            const shared = await inflightTerminalLaunch.promise;
            return {
                ...shared,
                status: shared.ok ? 'reused' : 'launched',
                reused: shared.ok,
                message: shared.message || '正在唤起终端，本次请求已合并到同一次唤起',
            };
        }
    }
    const launcher = options.launcher || ((cmd) => launchTerminalAndWait(cmd));
    const promise = launcher(command)
        .then((result) => ({ ok: result.ok, status: 'launched', error: result.error }))
        .catch((err) => ({ ok: false, status: 'launched', error: err?.message || String(err) }));
    inflightTerminalLaunch = { command, promise };
    let outcome;
    try {
        outcome = await promise;
    }
    finally {
        inflightTerminalLaunch = null;
    }
    lastTerminalLaunch = { command, at: now, ok: outcome.ok };
    return outcome;
}
export function registerActionRoutes(deps, executor, cacheMap, globalCache) {
    const { bindRoute } = deps;
    // 1. 强制刷新缓存
    bindRoute({
        kind: 'exact',
        path: '/api/github/refresh',
        handler: async (req, res) => {
            cacheMap.clear();
            globalCache.clear();
            sendJson(res, 200, { ok: true, message: '缓存已清空，下次读取将拉取最新数据' });
        },
    });
    // 2. 右侧栏快捷操作代理接口
    bindRoute({
        kind: 'exact',
        path: '/api/github/action',
        handler: async (req, res) => {
            if (req.method !== 'POST') {
                sendJson(res, 405, { ok: false, message: '仅支持 POST 请求' });
                return;
            }
            let body = '';
            req.on('data', (chunk) => { body += chunk; });
            req.on('end', async () => {
                try {
                    const payload = body ? JSON.parse(body) : {};
                    const cwd = payload.cwd || process.cwd();
                    switch (payload.action) {
                        case 'create_pr': {
                            const cmd = ['pr', 'create', '--title', payload.title || 'Update', '--body', payload.body || 'Created from DSH Rightbar'];
                            if (payload.draft)
                                cmd.push('--draft');
                            const r = await executor.run(cmd, { cwd });
                            if (!r.ok)
                                throw new Error(r.error);
                            sendJson(res, 200, { ok: true, message: 'PR 创建成功', url: r.rawOutput });
                            break;
                        }
                        case 'create_issue': {
                            const cmd = ['issue', 'create', '--title', payload.title || 'New Issue', '--body', payload.body || 'Created from DSH Rightbar'];
                            const r = await executor.run(cmd, { cwd });
                            if (!r.ok)
                                throw new Error(r.error);
                            sendJson(res, 200, { ok: true, message: 'Issue 创建成功', url: r.rawOutput });
                            break;
                        }
                        case 'open_browser': {
                            // 原实现把 payload.url 直接拼进 shell 字符串再交给 exec()，
                            // 形如 https://x" & calc & " 的 URL 可闭合引号并追加任意命令——本机任意页面
                            // 都能通过 POST 这个端点触发命令执行。
                            // 现在改为：先用 URL 解析白名单协议，再用 execFile 参数数组传递，全程不经过 shell。
                            if (!isSafeExternalUrl(payload.url)) {
                                throw new Error('url 参数无效：只允许 http/https 开头的完整地址');
                            }
                            const { execFile } = await import('node:child_process');
                            const [bin, args] = process.platform === 'win32'
                                ? ['cmd', ['/c', 'start', '', payload.url]]
                                : process.platform === 'darwin'
                                    ? ['open', [payload.url]]
                                    : ['xdg-open', [payload.url]];
                            // 不 await，也不让打开失败反向影响接口语义；仅记录以便排查
                            execFile(bin, args, (err) => {
                                if (err)
                                    console.warn('[dsh-pr-panel] 打开浏览器失败:', err?.message || err);
                            });
                            sendJson(res, 200, { ok: true, message: '已在浏览器打开' });
                            break;
                        }
                        case 'open_terminal': {
                            const command = typeof payload.command === 'string' ? payload.command.trim() : 'gh auth login';
                            // 严格白名单过滤，严防任意命令注入
                            const allowedCommands = [
                                'gh auth login',
                                'winget install --id GitHub.cli',
                                'brew install gh',
                                'sudo apt install gh',
                                'sudo dnf install gh',
                            ];
                            if (!allowedCommands.includes(command)) {
                                throw new Error(`不支持唤起该指令: ${command}`);
                            }
                            // Issue #2 修复：等待真实唤起结果再回传——旧实现 execFile 异步回调吞错、
                            // 路由先行返回 ok:true，导致终端弹不弹都提示成功。
                            // 2026-10-20 修复：不再每次调用都无条件开窗。认证态已满足 / 已有等待中的
                            // 登录窗口 / 冷却期内的重复请求，都走 requestTerminalLaunch 的去重闸，
                            // 否则按钮连点或重试循环会堆出一串卡在同一个提示上的窗口。
                            const launch = await requestTerminalLaunch(command, {
                                force: payload.force === true,
                                authCheck: () => executor.checkAuth(cwd),
                            });
                            if (!launch.ok) {
                                sendJson(res, 500, {
                                    ok: false,
                                    message: `唤起终端失败：${launch.error}。请手动打开系统终端执行：${command}`,
                                });
                                return;
                            }
                            if (launch.status !== 'launched') {
                                // 复用/跳过都算「不需要再开窗」，但要如实说明原因，避免用户以为点了没反应
                                console.warn(`[dsh-pr-panel] 终端唤起已去重（${launch.status}）：${launch.message}`);
                            }
                            sendJson(res, 200, {
                                ok: true,
                                status: launch.status || 'launched',
                                reused: Boolean(launch.reused),
                                skipped: Boolean(launch.skipped),
                                message: launch.message || `已唤起系统终端，请在弹出窗口执行：${command}`,
                            });
                            break;
                        }
                        case 'switch_branch': {
                            const branch = typeof payload.branch === 'string' ? payload.branch.trim() : '';
                            if (!branch) {
                                sendJson(res, 400, { ok: false, error: '缺少目标分支名称' });
                                return;
                            }
                            const r = await executor.switchGitBranch(cwd, branch);
                            if (!r.ok) {
                                sendJson(res, 400, { ok: false, error: r.error });
                                return;
                            }
                            cacheMap.clear();
                            sendJson(res, 200, { ok: true, currentBranch: r.currentBranch, message: `已成功切换到分支 ${r.currentBranch}` });
                            break;
                        }
                        case 'file_diff':
                        case 'get_file_diff': {
                            const fileTarget = typeof payload.file === 'string' ? payload.file.trim() : (typeof payload.filePath === 'string' ? payload.filePath.trim() : '');
                            if (!fileTarget) {
                                sendJson(res, 400, { ok: false, error: '缺少目标文件路径' });
                                return;
                            }
                            const resolvedCwd = executor.resolveWorkspaceCwd(cwd);
                            const r = await executor.getFileDiff(resolvedCwd, fileTarget);
                            sendJson(res, 200, { ok: r.ok, data: r, error: r.error });
                            break;
                        }
                        case 'uncommitted_files':
                        case 'get_uncommitted_files': {
                            const limit = Math.min(Math.max(1, Number(payload.limit) || 15), 100);
                            const skip = Math.max(0, Number(payload.skip) || 0);
                            const resolvedCwd = executor.resolveWorkspaceCwd(cwd);
                            const r = await executor.getUncommittedFiles(resolvedCwd, limit, skip);
                            sendJson(res, 200, { ok: true, data: r });
                            break;
                        }
                        default:
                            sendJson(res, 400, { ok: false, message: `未知的操作类型: ${payload.action}` });
                    }
                }
                catch (err) {
                    sendJson(res, 500, { ok: false, error: err.message || '操作执行失败' });
                }
            });
        },
    });
    // 3. 读取当前工作区的所有 Git 分支列表（纯本地只读，毫秒级响应）
    bindRoute({
        kind: 'exact',
        path: '/api/github/branches',
        handler: async (req, res) => {
            if (req.method !== 'GET') {
                sendJson(res, 405, { ok: false, message: '仅支持 GET 请求' });
                return;
            }
            try {
                const url = new URL(req.url || '', 'http://127.0.0.1');
                const cwd = url.searchParams.get('cwd') || undefined;
                const result = await executor.getGitBranches(cwd);
                if (!result) {
                    sendJson(res, 404, { ok: false, error: '当前工作区不是 Git 仓库或无法读取分支' });
                    return;
                }
                sendJson(res, 200, { ok: true, data: result });
            }
            catch (err) {
                sendJson(res, 500, { ok: false, error: err?.message || '读取分支列表失败' });
            }
        },
    });
    // 4. 切换当前工作区的 Git 分支（带未提交变更防护与合法性校验）
    bindRoute({
        kind: 'exact',
        path: '/api/github/branch-switch',
        handler: async (req, res) => {
            if (req.method !== 'POST') {
                sendJson(res, 405, { ok: false, message: '仅支持 POST 请求' });
                return;
            }
            let body = '';
            req.on('data', (chunk) => { body += chunk; });
            req.on('end', async () => {
                try {
                    const payload = body ? JSON.parse(body) : {};
                    const cwd = payload.cwd || undefined;
                    const branch = typeof payload.branch === 'string' ? payload.branch.trim() : '';
                    if (!branch) {
                        sendJson(res, 400, { ok: false, error: '缺少目标分支名称' });
                        return;
                    }
                    const r = await executor.switchGitBranch(cwd, branch);
                    if (!r.ok) {
                        sendJson(res, 400, { ok: false, error: r.error });
                        return;
                    }
                    // 核心联动：切换分支成功后，当前工作区缓存立即失效，确保后续拉取新分支数据
                    cacheMap.clear();
                    sendJson(res, 200, {
                        ok: true,
                        currentBranch: r.currentBranch,
                        message: `已成功切换到分支 ${r.currentBranch}`,
                    });
                }
                catch (err) {
                    sendJson(res, 500, { ok: false, error: err?.message || '切换分支失败' });
                }
            });
        },
    });
    // 5. 本地 Git 元数据定向监听（专供右侧栏开启「本地 Git 改动实时感知」时长轮询）
    // 严格安全纪律：只针对 .git/index 与 .git/HEAD 实施定向非递归监听，严禁监听源码目录防句柄耗尽；
    // 800ms 防抖合并；连接断开时自动关闭 watcher 释放系统资源（委托给底层 git-watcher 服务）。
    bindRoute({
        kind: 'exact',
        path: '/api/github/git-watch',
        handler: async (req, res) => {
            if (req.method !== 'GET') {
                sendJson(res, 405, { ok: false, message: '仅支持 GET 请求' });
                return;
            }
            const url = new URL(req.url || '', 'http://127.0.0.1');
            // 聚合根模式：先解析出可用的仓库根，监听/读取都落在真仓库上。
            // strict 模式下等价于原来的 hasGitDir(cwd) 判定。
            const requestedCwd = url.searchParams.get('cwd');
            const repoRootInfo = requestedCwd ? executor.resolveWorkspaceRepoRoot(requestedCwd) : null;
            if (!repoRootInfo) {
                sendJson(res, 400, { ok: false, error: '非 Git 仓库，无需监听' });
                return;
            }
            const cwd = repoRootInfo.root;
            let responded = false;
            try {
                const stop = watchGitMetadata(cwd, (event) => {
                    if (responded)
                        return;
                    responded = true;
                    sendJson(res, 200, { ok: true, ...event });
                });
                req.on('close', () => {
                    if (!responded) {
                        responded = true;
                        stop();
                    }
                });
            }
            catch (err) {
                sendJson(res, 500, { ok: false, error: err?.message || '建立监听失败' });
            }
        },
    });
    // 6. 纯本地 Git 状态毫秒级轻量查询（专供工作区改动时的局部定向刷新）
    // 严格安全与性能纪律：
    // 1. 动静解耦：仅执行本地 getLocalGitStatus、getGitCommitLog 与 getGitBranches；
    // 2. 100% 零网络调用、零远端 GitHub API 请求、零 Token 额度消耗，耗时仅 5~10ms；
    // 3. 彻底与 PR/Issue/Run 远端数据解耦，切断因修改本地文件误触发远端全量网络风暴与超时报错的恶性循环。
    bindRoute({
        kind: 'exact',
        path: '/api/github/local-git-status',
        handler: async (req, res) => {
            if (req.method !== 'GET') {
                sendJson(res, 405, { ok: false, message: '仅支持 GET 请求' });
                return;
            }
            const url = new URL(req.url || '', 'http://127.0.0.1');
            // 同上：聚合根解析到仓库根后再读本地 Git 状态
            const requestedCwd = url.searchParams.get('cwd');
            const repoRootInfo = requestedCwd ? executor.resolveWorkspaceRepoRoot(requestedCwd) : null;
            if (!repoRootInfo) {
                sendJson(res, 400, { ok: false, error: '非 Git 仓库，无法获取本地 Git 状态' });
                return;
            }
            const cwd = repoRootInfo.root;
            try {
                const gitStatus = await executor.getLocalGitStatus(cwd).catch(() => null);
                const commitLog = await executor
                    .getGitCommitLog(cwd, gitStatus ? gitStatus.hasUpstream : false)
                    .catch(() => null);
                const branches = await executor.getGitBranches(cwd).catch(() => null);
                // 同步就地更新内存缓存中的本地元数据，保证后续全量请求也能自然拿到最新的本地状态
                const cached = cacheMap.getFallback(cwd) || cacheMap.get(cwd, Date.now());
                if (cached) {
                    if (gitStatus)
                        cached.gitStatus = gitStatus;
                    if (commitLog)
                        cached.commitLog = commitLog;
                    if (branches)
                        cached.branches = branches;
                }
                sendJson(res, 200, {
                    ok: true,
                    data: {
                        gitStatus,
                        commitLog,
                        branches,
                    },
                    cwd,
                });
            }
            catch (err) {
                sendJson(res, 500, { ok: false, error: err?.message || '获取本地 Git 状态失败' });
            }
        },
    });
    // 7. 单个未提交文件的 Git Diff 差异查询（供右侧栏 FileDiffModal 调用）
    bindRoute({
        kind: 'exact',
        path: '/api/github/file-diff',
        handler: async (req, res) => {
            if (req.method !== 'GET') {
                sendJson(res, 405, { ok: false, message: '仅支持 GET 请求' });
                return;
            }
            try {
                const url = new URL(req.url || '', 'http://127.0.0.1');
                const cwd = url.searchParams.get('cwd') || undefined;
                const file = url.searchParams.get('file');
                if (!file || !file.trim()) {
                    sendJson(res, 400, { ok: false, error: '缺少必需的 file 参数' });
                    return;
                }
                const resolvedCwd = executor.resolveWorkspaceCwd(cwd);
                if (!hasGitDir(resolvedCwd)) {
                    sendJson(res, 400, { ok: false, error: '当前工作区不是 Git 仓库' });
                    return;
                }
                const diffResult = await executor.getFileDiff(resolvedCwd, file.trim());
                if (!diffResult.ok) {
                    sendJson(res, 400, { ok: false, error: diffResult.error || '获取文件差异失败' });
                    return;
                }
                sendJson(res, 200, { ok: true, data: diffResult });
            }
            catch (err) {
                sendJson(res, 500, { ok: false, error: err?.message || '获取文件差异失败' });
            }
        },
    });
    // 8. 本地未提交文件列表轻量流式分页查询（供右侧栏滑动加载调用）
    bindRoute({
        kind: 'exact',
        path: '/api/github/uncommitted-files',
        handler: async (req, res) => {
            if (req.method !== 'GET') {
                sendJson(res, 405, { ok: false, message: '仅支持 GET 请求' });
                return;
            }
            try {
                const url = new URL(req.url || '', 'http://127.0.0.1');
                const cwd = url.searchParams.get('cwd') || undefined;
                const limit = Math.min(Math.max(1, Number(url.searchParams.get('limit')) || 15), 100);
                const skip = Math.max(0, Number(url.searchParams.get('skip')) || 0);
                const resolvedCwd = executor.resolveWorkspaceCwd(cwd);
                if (!hasGitDir(resolvedCwd)) {
                    sendJson(res, 400, { ok: false, error: '当前工作区不是 Git 仓库' });
                    return;
                }
                const result = await executor.getUncommittedFiles(resolvedCwd, limit, skip);
                sendJson(res, 200, { ok: true, data: result });
            }
            catch (err) {
                sendJson(res, 500, { ok: false, error: err?.message || '获取未提交文件列表失败' });
            }
        },
    });
    // 10. 聚合根下手动切换绑定的仓库
    // 为什么单独一个路由：这是「用户意图」而不是「探测结果」，必须落盘并且立刻对
    // 所有后续请求生效（缓存按最终仓库根分键，切换后自然走新键）。
    bindRoute({
        kind: 'exact',
        path: '/api/github/select-repo',
        handler: async (req, res) => {
            if (req.method !== 'POST') {
                sendJson(res, 405, { ok: false, message: '仅支持 POST 请求' });
                return;
            }
            let body = '';
            req.on('data', (chunk) => { body += chunk; });
            req.on('end', async () => {
                try {
                    const payload = body ? JSON.parse(body) : {};
                    const workspace = typeof payload.cwd === 'string' ? payload.cwd.trim() : '';
                    if (!workspace) {
                        sendJson(res, 400, { ok: false, error: '缺少工作区路径 (cwd)' });
                        return;
                    }
                    // repo 为 null / 空串 = 清除手动选择，回到自动选择
                    const rawRepo = payload.repo;
                    const repo = typeof rawRepo === 'string' && rawRepo.trim() ? rawRepo.trim() : null;
                    const result = executor.selectWorkspaceRepo(workspace, repo);
                    if (!result.ok) {
                        sendJson(res, 400, { ok: false, error: result.error });
                        return;
                    }
                    sendJson(res, 200, {
                        ok: true,
                        data: {
                            workspacePath: workspace,
                            repoRoot: result.resolution?.root,
                            repoVia: result.resolution?.via,
                            repoCandidates: result.resolution?.candidates || [],
                        },
                    });
                }
                catch (err) {
                    sendJson(res, 500, { ok: false, error: err?.message || '切换仓库失败' });
                }
            });
        },
    });
    // 会话 PR 缓存：key = sessionId + 仓库根，60 秒内复用。
    // 面板每次刷新（lastSyncedAt 变化）都会打这个接口，逐条 gh 调用不应重复付账。
    const sessionPrCache = new Map();
    // 单条 PR 元数据缓存：翻页时同一批编号会被重复请求，缓存 120 秒
    const prMetaCache = new Map();
    // 13. 「本次对话里出现过的 PR」
    //
    // 数据源不是 GitHub，而是会话记录本身：DSH 把每个会话写成
    // ~/.dsh/sessions/<workspace>/<sessionId>/session.v4.jsonl.zstd。
    // 这里解压后扫出 github.com/<owner>/<repo>/pull/<n> 与 owner/repo#n 两种写法，
    // 再用一次 gh pr list 把元数据补齐（不逐条请求，避免 N 次往返）。
    bindRoute({
        kind: 'exact',
        path: '/api/github/session-prs',
        handler: async (req, res) => {
            if (req.method !== 'GET') {
                sendJson(res, 405, { ok: false, message: '仅支持 GET 请求' });
                return;
            }
            try {
                const url = new URL(req.url || '', 'http://127.0.0.1');
                const sessionId = (url.searchParams.get('sessionId') || '').trim();
                const cwdParam = url.searchParams.get('cwd') || undefined;
                if (!sessionId) {
                    sendJson(res, 400, { ok: false, error: '缺少 sessionId' });
                    return;
                }
                const repoRoot = executor.resolveWorkspaceRepoRoot(cwdParam);
                if (!repoRoot) {
                    sendJson(res, 400, { ok: false, error: '当前工作区未关联 Git 仓库' });
                    return;
                }
                const identity = executor.getRepoIdentityFromLocal(repoRoot.root);
                const repoNameWithOwner = identity?.nameWithOwner || '';
                // 会话文件定位：workspace 目录名不可预测（中文被转义过），直接按 sessionId 扫
                const sessionsRoot = path.join(os.homedir(), '.dsh', 'sessions');
                let transcript = null;
                try {
                    for (const ws of fs.readdirSync(sessionsRoot)) {
                        const candidate = path.join(sessionsRoot, ws, sessionId, 'session.v4.jsonl.zstd');
                        if (fs.existsSync(candidate)) {
                            transcript = candidate;
                            break;
                        }
                    }
                }
                catch {
                    transcript = null;
                }
                if (!transcript) {
                    sendJson(res, 200, { ok: true, data: { repo: repoNameWithOwner, items: [], reason: '找不到该会话的转写文件' } });
                    return;
                }
                const url2 = new URL(req.url || '', 'http://127.0.0.1');
                const limit = Math.min(Math.max(1, Number(url2.searchParams.get('limit')) || 12), 30);
                const offset = Math.max(0, Number(url2.searchParams.get('offset')) || 0);
                // refs（编号列表）单独缓存：解压+扫描比逐条 gh 贵的多，而翻页只改窗口
                const refsKey = `${sessionId}::${repoRoot.root}`;
                let refs = sessionPrCache.get(refsKey);
                if (!refs || Date.now() - refs.at > 60_000) {
                    const scanned = await scanSessionPrRefs(transcript, repoNameWithOwner);
                    refs = { at: Date.now(), payload: scanned };
                    sessionPrCache.set(refsKey, refs);
                }
                const scanned = refs.payload;
                // 显式引用优先，裸编号补位；上限 30 条（再多也没人翻）
                const candidates = scanned.explicit.concat(scanned.bare).slice(0, 30);
                // 先把候选全部解析一遍（并发 6，单条缓存 120s），过滤掉不是 PR 的编号——
                // 裸 #235 这种 Issue 号会在这里被剔掉，列表里不会出现「元数据缺失」的行。
                const resolved = await mapLimitFn(candidates, 6, async (n) => {
                    const hit = prMetaCache.get(n);
                    if (hit && Date.now() - hit.at < 120_000)
                        return hit.data;
                    const r = await executor.run(['pr', 'view', String(n), '--json', 'number,title,state,isDraft,url,author,updatedAt,mergedAt,createdAt'], { cwd: repoRoot.root, timeoutMs: 15_000 });
                    const value = r.ok && r.data ? r.data : { number: n, missing: true };
                    // 未命中的也缓存（negative cache），避免每次刷新都重试同级 Issue 号
                    prMetaCache.set(n, { at: Date.now(), data: value });
                    return value;
                });
                const valid = resolved.filter((it) => it && !it.missing);
                const items = valid.slice(offset, offset + limit);
                sendJson(res, 200, {
                    ok: true,
                    data: {
                        repo: repoNameWithOwner,
                        repoRoot: repoRoot.root,
                        transcript: path.basename(path.dirname(transcript)),
                        total: valid.length,
                        candidates: candidates.length,
                        offset,
                        limit,
                        items,
                    },
                });
            }
            catch (err) {
                sendJson(res, 500, { ok: false, error: err?.message || '读取会话 PR 失败' });
            }
        },
    });
    // 13b. 「本会话新建的 PR」——右侧浮窗与 PR 面板的唯一数据源。
    //
    // 与上面 13 的区别（关键，别再合并回去）：13 是「对话里出现过的 PR」（提及即收），
    // 这一条只认**本会话亲手新建**的：插件登记簿（即时）+ 会话转写回填（跨重启）。
    // 浮窗的语义就是「我刚提的 PR 在哪」，混入提过的旧 PR 就失去意义。
    const createdPrMetaCache = new Map();
    bindRoute({
        kind: 'exact',
        path: '/api/github/session-created-prs',
        handler: async (req, res) => {
            if (req.method !== 'GET') {
                sendJson(res, 405, { ok: false, message: '仅支持 GET 请求' });
                return;
            }
            try {
                const url = new URL(req.url || '', 'http://127.0.0.1');
                const sessionId = (url.searchParams.get('sessionId') || '').trim();
                if (!sessionId) {
                    sendJson(res, 400, { ok: false, error: '缺少 sessionId' });
                    return;
                }
                const force = url.searchParams.get('refresh') === '1';
                // 会话血缘：主会话 + 它的子代理会话。
                // 「本会话提交的 PR」现在是**整棵树**的口径：主会话把活派给 subagent 后，
                // 子会话里 github_pr create / gh pr create 建出来的 PR 同样是「这个会话刚提的」。
                // 不做这一步，发版/并行工作面派下去的 PR 永远不会出现在浮窗里。
                const descendants = await listSessionDescendants(sessionId);
                const lineage = [
                    { id: sessionId, depth: 0 },
                    ...descendants.map((entry) => ({ id: entry.id, depth: entry.depth })),
                ];
                /** 血缘签名：子代理会话增减时它才会变，用来判断磁盘快照是否还配得上当前树 */
                const lineageSignature = lineage.map((entry) => entry.id).sort().join(',');
                const depthById = new Map(lineage.map((entry) => [entry.id, entry.depth]));
                // 两路合并：登记簿（进程内、即时）优先，转写回填兜底；同一 repo#number 只留一条。
                // 顺序很关键：主会话先入表，重复时 origin 保持 main；子代理只补空缺。
                const merged = new Map();
                const addRef = (row, ownerId) => {
                    const key = `${row.repo}#${row.number}`.toLowerCase();
                    const hit = merged.get(key);
                    if (hit) {
                        if (row.at > hit.at)
                            hit.at = row.at;
                        return;
                    }
                    merged.set(key, {
                        repo: row.repo,
                        number: row.number,
                        at: row.at,
                        via: row.via,
                        origin: ownerId === sessionId ? 'main' : 'subagent',
                        originSessionId: ownerId,
                        depth: depthById.get(ownerId) || 0,
                    });
                };
                for (const entry of lineage) {
                    for (const row of listSessionCreatedPrs(entry.id))
                        addRef(row, entry.id);
                }
                // 子会话的转写也要扫：重启后登记簿是空的，历史 PR 全靠回填。
                // 并发 3：每份转写都要 zstd 解压，棵树可能是十几个子代理，一口气全解会顶住事件循环。
                const scans = await mapLimitFn(lineage, 3, async (entry) => ({
                    entry,
                    scan: await readSessionCreatedPrs(entry.id, { force }),
                }));
                const scanned = scans[0]?.scan ?? { refs: [], transcript: null, reason: '找不到该会话的转写文件' };
                for (const { entry, scan } of scans) {
                    for (const row of scan.refs)
                        addRef(row, entry.id);
                }
                const refs = Array.from(merged.values()).sort((a, b) => b.at - a.at).slice(0, 12);
                // 冷启动快路径：本进程还没为这个会话提供过数据，且磁盘上有一份 24h 内的成功结果。
                // 血缘签名必须一致才用：新派出一个子代理（可能刚建了 PR）时，旧快照已经不完整了。
                if (!force && refs.length > 0 && !snapshotServed.has(sessionId)) {
                    const snap = loadSessionSnapshot()[sessionId];
                    snapshotServed.add(sessionId);
                    if (snap && snap.sig === lineageSignature && Array.isArray(snap.items) && snap.items.length > 0
                        && Date.now() - snap.at < SNAPSHOT_MAX_AGE_MS) {
                        sendJson(res, 200, {
                            ok: true,
                            data: {
                                sessionId,
                                items: snap.items,
                                total: snap.items.length,
                                descendants: descendants.length,
                                fromSnapshot: true,
                                snapshotAt: snap.at,
                            },
                        });
                        return;
                    }
                }
                // lite=1：浮窗首屏只要「有几个 PR、编号是多少」，不该为它跑最多 12 次 gh pr view。
                // 已缓存过的照常返回（越用越快），没缓存的先给 pending 占位，展开卡片时再补。
                const lite = url.searchParams.get('lite') === '1';
                const buildItem = (ref, meta) => ({
                    repo: ref.repo,
                    number: ref.number,
                    at: ref.at,
                    via: ref.via,
                    // 来源：main = 主视图会话亲手建的；subagent = 派下去的子代理会话建的。
                    // 界面据此加「子代理」小标，用户不会疑惑「我没提过这个 PR 怎么在这」。
                    origin: ref.origin,
                    originSessionId: ref.originSessionId,
                    depth: ref.depth,
                    title: meta?.title || `${ref.repo}#${ref.number}`,
                    state: meta?.state || 'UNKNOWN',
                    isDraft: Boolean(meta?.isDraft),
                    url: meta?.url || `https://github.com/${ref.repo}/pull/${ref.number}`,
                    author: meta?.author?.login || (typeof meta?.author === 'string' ? meta.author : ''),
                    baseRefName: meta?.baseRefName || '',
                    headRefName: meta?.headRefName || '',
                    additions: Number(meta?.additions) || 0,
                    deletions: Number(meta?.deletions) || 0,
                    changedFiles: Number(meta?.changedFiles) || 0,
                    reviewDecision: meta?.reviewDecision || '',
                    createdAt: meta?.createdAt || '',
                    updatedAt: meta?.updatedAt || '',
                    mergedAt: meta?.mergedAt || '',
                    // 流水线阶段：Dev → Test → Release → Prod（按目标分支/label 判定）
                    ...(function () {
                        const stage = resolvePipelineStage({
                            baseRefName: meta?.baseRefName || '',
                            headRefName: meta?.headRefName || '',
                            labels: meta?.labels,
                        });
                        return { stage, stageId: stage.id };
                    })(),
                    checks: summarizeCheckRollup(meta?.statusCheckRollup) && meta?.statusCheckRollup
                        ? summarizeCheckRollup(meta.statusCheckRollup)
                        : checksFromGraphqlState(meta?.statusCheckRollupState),
                    missing: !meta,
                });
                const rememberItem = (ref, data) => {
                    const key = `${ref.repo}#${ref.number}`.toLowerCase();
                    createdPrMetaCache.set(key, { at: Date.now(), data });
                    if (createdPrMetaCache.size > 240) {
                        const oldest = createdPrMetaCache.keys().next().value;
                        if (typeof oldest === 'string' && oldest !== key)
                            createdPrMetaCache.delete(oldest);
                    }
                    return data;
                };
                /** 每仓库一次 GraphQL，把 N 条 PR 合成 1 个请求（12 条 ≈ 1.5s，而不是 5.8s） */
                const fetchRepoBatch = async (repo, list) => {
                    const parts = repo.split('/');
                    if (parts.length !== 2)
                        return null;
                    const aliases = list.map((ref, idx) => `  p${idx}: pullRequest(number: ${Number(ref.number)}) { number title state isDraft url author { login } baseRefName headRefName additions deletions changedFiles reviewDecision statusCheckRollup { state } createdAt updatedAt mergedAt }`).join('\n');
                    const query = `query {\n  repository(owner: ${JSON.stringify(parts[0])}, name: ${JSON.stringify(parts[1])}) {\n${aliases}\n  }\n}`;
                    // 快路径：进程内复用的 HTTP 通道（同一端点反复取，省掉每次 gh 的握手）
                    const viaHttp = await githubGraphql(query);
                    let body = null;
                    if (viaHttp.ok && viaHttp.data) {
                        body = viaHttp.data;
                    }
                    else {
                        const r = await executor.run(['api', 'graphql', '-f', `query=${query}`], { timeoutMs: 20_000 });
                        if (r.ok && r.data) {
                            body = r.data;
                        }
                        else {
                            // GraphQL 部分成功也会 exit 1（例如某条 PR 已被删除，errors 里带 NOT_FOUND），
                            // 但 stdout 里其实有完整的 data。直接放弃会把这个仓库整体降级成逐条 REST。
                            const raw = typeof r.rawOutput === 'string' ? r.rawOutput : '';
                            if (raw) {
                                try {
                                    const parsed = JSON.parse(raw);
                                    if (parsed && (parsed.data || parsed.repository))
                                        body = parsed;
                                }
                                catch { /* 非 JSON 就真的退回逐条 */ }
                            }
                            if (!body)
                                return null;
                        }
                    }
                    const node = body?.data?.repository ?? body?.repository;
                    if (!node)
                        return null;
                    const out = new Map();
                    list.forEach((ref, idx) => {
                        const raw = node[`p${idx}`];
                        if (!raw) {
                            out.set(`${repo}#${ref.number}`.toLowerCase(), null);
                            return;
                        }
                        // 按返回体里的 number 建索引（而不是按别名位置）：别名顺序与 list 顺序
                        // 一旦不一致（调用方重排/缓存混入），按位置映射就会张冠李戴。
                        out.set(`${repo}#${Number(raw.number) || ref.number}`.toLowerCase(), {
                            ...raw,
                            statusCheckRollupState: raw?.statusCheckRollup?.state || null,
                            statusCheckRollup: undefined,
                        });
                    });
                    return out;
                };
                // 先把「需要刷新」的条目按仓库分组，每个仓库打一次 GraphQL
                const needsByRepo = new Map();
                if (!lite) {
                    for (const ref of refs) {
                        const key = `${ref.repo}#${ref.number}`.toLowerCase();
                        const hit = createdPrMetaCache.get(key);
                        if (!force && hit && Date.now() - hit.at < 30_000)
                            continue;
                        const list = needsByRepo.get(ref.repo) || [];
                        list.push(ref);
                        needsByRepo.set(ref.repo, list);
                    }
                }
                const batchResults = new Map();
                await mapLimitFn(Array.from(needsByRepo.entries()), 3, async (entry) => {
                    const repo = entry[0];
                    const list = entry[1];
                    const got = await fetchRepoBatch(repo, list);
                    if (got)
                        got.forEach((value, k) => batchResults.set(k, value === null ? { __missing: true } : value));
                    return null;
                });
                const items = await mapLimitFn(refs, 6, async (ref) => {
                    const key = `${ref.repo}#${ref.number}`.toLowerCase();
                    const hit = createdPrMetaCache.get(key);
                    // 30s：浮窗最坏滞后 = 一个 TTL + 一个轮询周期；再长就会明显「不及时」
                    if (!force && hit && Date.now() - hit.at < 30_000)
                        return hit.data;
                    if (lite) {
                        return {
                            repo: ref.repo,
                            number: ref.number,
                            at: ref.at,
                            via: ref.via,
                            origin: ref.origin,
                            originSessionId: ref.originSessionId,
                            depth: ref.depth,
                            title: '',
                            state: 'UNKNOWN',
                            isDraft: false,
                            url: `https://github.com/${ref.repo}/pull/${ref.number}`,
                            author: '',
                            baseRefName: '',
                            headRefName: '',
                            additions: 0,
                            deletions: 0,
                            changedFiles: 0,
                            reviewDecision: '',
                            createdAt: '',
                            updatedAt: '',
                            mergedAt: '',
                            checks: { state: 'none', total: 0, failing: 0 },
                            missing: false,
                            pending: true,
                        };
                    }
                    // 命中批量结果：直接构造；__missing 表示 GraphQL 说这条不存在
                    if (batchResults.has(key)) {
                        const got = batchResults.get(key);
                        const data = buildItem(ref, got && got.__missing ? null : got);
                        return rememberItem(ref, data);
                    }
                    // 兜底：GraphQL 不可用（token 权限/企业版策略）时退回逐条 gh pr view
                    const r = await executor.run(['pr', 'view', String(ref.number), '--repo', ref.repo, '--json',
                        'number,title,state,isDraft,url,author,baseRefName,headRefName,additions,deletions,changedFiles,reviewDecision,statusCheckRollup,createdAt,updatedAt,mergedAt'], { timeoutMs: 15_000 });
                    const meta = r.ok && r.data ? r.data : null;
                    return rememberItem(ref, buildItem(ref, meta));
                });
                // 排序在 Host 做：浮窗、面板、快照三处消费同一份数据，排一次就都对了
                const ordered = sortPrsByStage(items);
                sendJson(res, 200, {
                    ok: true,
                    data: {
                        sessionId,
                        transcript: scanned.transcript ? path.basename(path.dirname(scanned.transcript)) : null,
                        reason: scanned.reason,
                        total: ordered.length,
                        stages: PIPELINE_STAGES.map((x) => ({ id: x.id, label: x.label, labelZh: x.labelZh, order: x.order })),
                        // 子代理会话数：0 表示这棵树只有主会话（旧口径行为），>0 时列表里可能混有 origin=subagent 的行
                        descendants: descendants.length,
                        items: ordered,
                    },
                });
                if (!lite && items.length > 0 && items.every((i) => !i.pending)) {
                    saveSessionSnapshot(sessionId, ordered, lineageSignature);
                }
            }
            catch (err) {
                sendJson(res, 500, { ok: false, error: err?.message || '读取本会话 PR 失败' });
            }
        },
    });
    // 10.9 PR 详情 core 的短缓存：面板每 10s 自动刷一次，用户点开同一条 PR 时
    // 常常在几秒内又发一次同样请求。8s 缓存只吃掉「重复」，不会让画面过期。
    const prCoreCache = new Map();
    // 11. 单个 PR 详情（元数据 + 改动文件 + 全量 diff）
    // 为什么不用工具层：面板里的「评审」是一次 UI 交互，走 gh 工具要经过模型轮次，
    // 既慢又浪费 token；这里直接把 gh 的原生输出交给渲染层。
    bindRoute({
        kind: 'exact',
        path: '/api/github/pr-detail',
        handler: async (req, res) => {
            if (req.method !== 'GET') {
                sendJson(res, 405, { ok: false, message: '仅支持 GET 请求' });
                return;
            }
            try {
                const url = new URL(req.url || '', 'http://127.0.0.1');
                const cwd = url.searchParams.get('cwd') || undefined;
                const number = Number(url.searchParams.get('number'));
                if (!Number.isInteger(number) || number <= 0) {
                    sendJson(res, 400, { ok: false, error: '缺少或非法的 PR 编号 (number)' });
                    return;
                }
                // repo 显式给出时（会话 PR 面板跨仓使用），PR 编号属于那个仓库而不是工作区仓库：
                // 这时不能拿工作区仓库去解析 —— 同名编号会张冠李戴。
                const repoParam = (url.searchParams.get('repo') || '').trim();
                // owner/repo 每段都以字母数字或下划线开头：gh 的参数不允许被拼成 `-something` 形态
                const explicitRepo = /^[A-Za-z0-9_][A-Za-z0-9_.-]*\/[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(repoParam) ? repoParam : '';
                const repoRoot = explicitRepo ? null : executor.resolveWorkspaceRepoRoot(cwd);
                if (!explicitRepo && !repoRoot) {
                    sendJson(res, 400, { ok: false, error: '当前工作区未关联 Git 仓库' });
                    return;
                }
                const repoArgs = explicitRepo ? ['--repo', explicitRepo] : [];
                const runCwd = explicitRepo ? (cwd || process.cwd()) : repoRoot.root;
                // 分两段取：core（标题/状态/检查，≈1.5s、4KB）+ thread（reviews/comments/commits，≈2s、55KB）。
                // 面板先渲染头部与操作，讨论区后到——用户感知从 2.4s 变 1.6s。
                const withThread = url.searchParams.get('withThread') !== '0';
                const coreFields = 'number,title,body,author,state,isDraft,reviewDecision,mergeable,mergeStateStatus,autoMergeRequest,additions,deletions,changedFiles,baseRefName,headRefName,headRefOid,url,createdAt,updatedAt,mergedAt,statusCheckRollup';
                const forceCore = url.searchParams.get('refresh') === '1';
                const coreKey = `${explicitRepo || 'ws'}#${number}`.toLowerCase();
                const coreHit = prCoreCache.get(coreKey);
                const coreCached = !forceCore && coreHit && Date.now() - coreHit.at < 8_000 ? coreHit.data : null;
                let prData = null;
                // 快路径：面板只要 core（withThread=0）时，走进程内 HTTP GraphQL——
                // 复用连接后一次往返约 0.5s，而 gh 每次新进程要 1.5s。带 thread 的旧调用方
                // 仍走 gh（那条路径的 reviews/comments/commits 形状不需要重新映射，降低风险）。
                if (coreCached) {
                    prData = coreCached;
                }
                else if (!withThread && explicitRepo) {
                    const [owner, name] = explicitRepo.split('/');
                    const q = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number title body state isDraft reviewDecision mergeable mergeStateStatus
      additions deletions changedFiles baseRefName headRefName headRefOid url
      createdAt updatedAt mergedAt
      author { login }
      autoMergeRequest { enabledAt mergeMethod }
      statusCheckRollup { contexts(first: 100) { nodes {
        __typename
        ... on CheckRun { name status conclusion detailsUrl startedAt completedAt }
        ... on StatusContext { context state targetUrl description }
      } } }
    }
  }
}`;
                    const viaHttp = await githubGraphql(q, { owner, name, number });
                    const node = viaHttp.ok ? viaHttp.data?.data?.repository?.pullRequest : null;
                    if (node) {
                        prData = {
                            number: node.number,
                            title: node.title,
                            body: node.body || '',
                            state: node.state,
                            isDraft: Boolean(node.isDraft),
                            reviewDecision: node.reviewDecision || '',
                            mergeable: node.mergeable,
                            mergeStateStatus: node.mergeStateStatus,
                            autoMergeRequest: node.autoMergeRequest || null,
                            additions: Number(node.additions) || 0,
                            deletions: Number(node.deletions) || 0,
                            changedFiles: Number(node.changedFiles) || 0,
                            baseRefName: node.baseRefName || '',
                            headRefName: node.headRefName || '',
                            headRefOid: node.headRefOid || '',
                            url: node.url || '',
                            createdAt: node.createdAt || '',
                            updatedAt: node.updatedAt || '',
                            mergedAt: node.mergedAt || '',
                            author: node.author || null,
                            // 归一成 gh pr view 的形状：CheckRun 用 name/conclusion，StatusContext 用 context/state
                            statusCheckRollup: ((node.statusCheckRollup && node.statusCheckRollup.contexts && node.statusCheckRollup.contexts.nodes) || []).map((c) => (c && c.__typename === 'StatusContext'
                                ? { __typename: 'StatusContext', context: c.context || '', state: c.state || '', targetUrl: c.targetUrl || '', description: c.description || '' }
                                : { __typename: 'CheckRun', name: c?.name || '', status: c?.status || '', conclusion: c?.conclusion || '', detailsUrl: c?.detailsUrl || '', startedAt: c?.startedAt || '', completedAt: c?.completedAt || '' })),
                        };
                    }
                }
                if (!prData) {
                    const detail = await executor.run(['pr', 'view', String(number), ...repoArgs, '--json',
                        withThread ? `${coreFields},commits,files,reviews,comments` : coreFields], 
                    // PR 详情 JSON 可能几十 KB（正文+评审+评论+文件列表）：24k 默认截断会让它
                    // 变成不可解析的文本，调用方拿到 data:undefined 却仍 ok —— 面板就会永远转圈。
                    { cwd: runCwd, timeoutMs: 20_000, maxOutputChars: 400_000 });
                    if (!detail.ok) {
                        sendJson(res, 502, { ok: false, error: detail.error || '读取 PR 详情失败' });
                        return;
                    }
                    if (!detail.data) {
                        // ok 但没有结构化数据 = 解析失败（通常是超大 JSON 被截断或 gh 输出异常）。
                        // 绝不能回 200 + pr:null：前端会把它当成「还没读完」而无限骨架屏。
                        sendJson(res, 502, { ok: false, error: 'PR 详情解析失败（返回内容过大或不是合法 JSON）' });
                        return;
                    }
                    prData = detail.data;
                }
                if (!withThread && prData) {
                    prCoreCache.set(coreKey, { at: Date.now(), data: prData });
                    if (prCoreCache.size > 120) {
                        const oldest = prCoreCache.keys().next().value;
                        if (typeof oldest === 'string' && oldest !== coreKey)
                            prCoreCache.delete(oldest);
                    }
                }
                const detail = { ok: true, data: prData };
                // withDiff=0：只要元数据。面板先渲染头部/描述/检查，diff 走 /api/github/pr-diff，
                // 否则一个 75 文件的大 PR 会把整个详情卡在 gh pr diff 的 30 秒超时上。
                const wantDiff = url.searchParams.get('withDiff') !== '0';
                const patch = wantDiff
                    ? await executor.run(['pr', 'diff', String(number), ...repoArgs], { cwd: runCwd, timeoutMs: 30_000, rawText: true })
                    : { ok: true, rawOutput: '', truncated: false };
                sendJson(res, 200, {
                    ok: true,
                    data: {
                        pr: detail.data || null,
                        // 跨仓查询时 runCwd 只是 gh 的工作目录（可能是 Host 的 process.cwd），
                        // 不能当 repoRoot 暴露出去误导消费方
                        repoRoot: repoRoot ? repoRoot.root : null,
                        repo: explicitRepo || undefined,
                        repoVia: repoRoot ? repoRoot.via : undefined,
                        diff: wantDiff && patch.ok ? String(patch.rawOutput || '') : '',
                        diffError: wantDiff && !patch.ok ? (patch.error || '拉取 diff 失败') : undefined,
                        diffTruncated: wantDiff ? Boolean(patch.truncated) : false,
                        threadIncluded: withThread,
                    },
                });
            }
            catch (err) {
                sendJson(res, 500, { ok: false, error: err?.message || '读取 PR 详情失败' });
            }
        },
    });
    // 11d2. PR 文件补丁列表（按文件给 patch，绕开「全量 diff 20000 行」的硬上限）
    const prFilesCache = new Map();
    bindRoute({
        kind: 'exact',
        path: '/api/github/pr-files',
        handler: async (req, res) => {
            if (req.method !== 'GET') {
                sendJson(res, 405, { ok: false, message: '仅支持 GET 请求' });
                return;
            }
            try {
                const url = new URL(req.url || '', 'http://127.0.0.1');
                const number = Number(url.searchParams.get('number'));
                const repoParam = (url.searchParams.get('repo') || '').trim();
                const repo = /^[A-Za-z0-9_][A-Za-z0-9_.-]*\/[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(repoParam) ? repoParam : '';
                if (!Number.isInteger(number) || number <= 0) {
                    sendJson(res, 400, { ok: false, error: '缺少或非法的 PR 编号 (number)' });
                    return;
                }
                if (!repo) {
                    sendJson(res, 400, { ok: false, error: '缺少或非法的仓库 (repo)' });
                    return;
                }
                const key = `${repo}#${number}`.toLowerCase();
                const force = url.searchParams.get('refresh') === '1';
                const hit = prFilesCache.get(key);
                if (!force && hit && Date.now() - hit.at < 60_000) {
                    sendJson(res, 200, { ok: true, data: { ...hit.data, cached: true } });
                    return;
                }
                const [owner, name] = repo.split('/');
                // 分页取，最多 300 个文件：大 PR 的文件 tab 也就是这么翻的
                const files = [];
                let page = 1;
                let truncated = false;
                for (; page <= 3; page += 1) {
                    const r = await githubGet(`/repos/${owner}/${name}/pulls/${number}/files?per_page=100&page=${page}`);
                    if (!r.ok || !Array.isArray(r.data)) {
                        if (page === 1) {
                            // HTTP 不可用就退回 gh（--paginate 由 gh 处理）
                            const g = await executor.run(['api', `repos/${owner}/${name}/pulls/${number}/files?per_page=100`, '--paginate'], { timeoutMs: 25_000, maxOutputChars: 900_000 });
                            if (!g.ok || !g.data) {
                                sendJson(res, 502, { ok: false, error: humanizeGhError(g.error, '读取 PR 文件列表失败') });
                                return;
                            }
                            const list = Array.isArray(g.data) ? g.data : [];
                            const data = {
                                repo, number,
                                files: list.slice(0, 300).map((f) => ({
                                    path: f.filename || f.path || '', additions: Number(f.additions) || 0,
                                    deletions: Number(f.deletions) || 0, patch: typeof f.patch === 'string' ? f.patch : '',
                                })),
                                truncated: list.length > 300,
                            };
                            prFilesCache.set(key, { at: Date.now(), data });
                            sendJson(res, 200, { ok: true, data });
                            return;
                        }
                        break;
                    }
                    files.push(...r.data);
                    if (r.data.length < 100)
                        break;
                    if (files.length >= 300) {
                        truncated = true;
                        break;
                    }
                }
                const data = {
                    repo, number,
                    files: files.slice(0, 300).map((f) => ({
                        path: f.filename || f.path || '', additions: Number(f.additions) || 0,
                        deletions: Number(f.deletions) || 0, patch: typeof f.patch === 'string' ? f.patch : '',
                    })),
                    truncated,
                };
                prFilesCache.set(key, { at: Date.now(), data });
                if (prFilesCache.size > 120) {
                    const oldest = prFilesCache.keys().next().value;
                    if (typeof oldest === 'string' && oldest !== key)
                        prFilesCache.delete(oldest);
                }
                sendJson(res, 200, { ok: true, data });
            }
            catch (err) {
                sendJson(res, 500, { ok: false, error: err?.message || '读取 PR 文件列表失败' });
            }
        },
    });
    // 11e. PR 讨论串（reviews / comments / commits）—— 从详情里拆出来单独取：
    // 这一段是最重的（实测 55KB / 2s），拆开后详情能先画出来。
    const prThreadCache = new Map();
    bindRoute({
        kind: 'exact',
        path: '/api/github/pr-thread',
        handler: async (req, res) => {
            if (req.method !== 'GET') {
                sendJson(res, 405, { ok: false, message: '仅支持 GET 请求' });
                return;
            }
            try {
                const url = new URL(req.url || '', 'http://127.0.0.1');
                const number = Number(url.searchParams.get('number'));
                if (!Number.isInteger(number) || number <= 0) {
                    sendJson(res, 400, { ok: false, error: '缺少或非法的 PR 编号 (number)' });
                    return;
                }
                const repoParam = (url.searchParams.get('repo') || '').trim();
                const explicitRepo = /^[A-Za-z0-9_][A-Za-z0-9_.-]*\/[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(repoParam) ? repoParam : '';
                if (!explicitRepo) {
                    sendJson(res, 400, { ok: false, error: '缺少或非法的仓库 (repo)' });
                    return;
                }
                const key = `${explicitRepo}#${number}`.toLowerCase();
                const force = url.searchParams.get('refresh') === '1';
                const hit = prThreadCache.get(key);
                if (!force && hit && Date.now() - hit.at < 30_000) {
                    sendJson(res, 200, { ok: true, data: { ...hit.data, cached: true } });
                    return;
                }
                const [owner, name] = explicitRepo.split('/');
                const threadQuery = `query {
  repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {
    pullRequest(number: ${number}) {
      reviews(first: 80) { nodes { author { login } state body submittedAt commit { oid } } }
      comments(first: 80) { nodes { author { login } body createdAt url } }
      commits(last: 30) { nodes { commit { oid messageHeadline committedDate authors(first: 3) { nodes { name email user { login } } } } } }
    }
  }
}`;
                const viaHttp = await githubGraphql(threadQuery);
                let reviews = [];
                let comments = [];
                let commits = [];
                if (viaHttp.ok && viaHttp.data && viaHttp.data?.data?.repository?.pullRequest) {
                    const node = viaHttp.data.data.repository.pullRequest;
                    reviews = (node.reviews?.nodes || []).map((r) => ({
                        author: { login: r?.author?.login || '' }, state: r?.state || '', body: r?.body || '', submittedAt: r?.submittedAt || '', commit: { oid: r?.commit?.oid || '' },
                    }));
                    comments = (node.comments?.nodes || []).map((c) => ({
                        author: { login: c?.author?.login || '' }, body: c?.body || '', createdAt: c?.createdAt || '', url: c?.url || '',
                    }));
                    commits = (node.commits?.nodes || []).map((c) => ({
                        oid: c?.commit?.oid || '', messageHeadline: c?.commit?.messageHeadline || '', committedDate: c?.commit?.committedDate || '',
                        authors: (c?.commit?.authors?.nodes || []).map((a) => ({
                            login: a?.user?.login || '', name: a?.name || '', email: a?.email || '',
                        })),
                    }));
                }
                else {
                    const r = await executor.run(['pr', 'view', String(number), '--repo', explicitRepo, '--json', 'reviews,comments,commits'], { timeoutMs: 25_000, maxOutputChars: 400_000 });
                    if (!r.ok) {
                        sendJson(res, 502, { ok: false, error: humanizeGhError(r.error, '读取 PR 讨论失败') });
                        return;
                    }
                    if (!r.data) {
                        sendJson(res, 502, { ok: false, error: 'PR 讨论解析失败（返回内容过大或不是合法 JSON）' });
                        return;
                    }
                    reviews = r.data.reviews || [];
                    comments = r.data.comments || [];
                    commits = r.data.commits || [];
                }
                const data = { repo: explicitRepo, number, reviews, comments, commits };
                prThreadCache.set(key, { at: Date.now(), data });
                if (prThreadCache.size > 120) {
                    const oldest = prThreadCache.keys().next().value;
                    if (typeof oldest === 'string' && oldest !== key)
                        prThreadCache.delete(oldest);
                }
                sendJson(res, 200, { ok: true, data });
            }
            catch (err) {
                sendJson(res, 500, { ok: false, error: err?.message || '读取 PR 讨论失败' });
            }
        },
    });
    // 12. 提交 PR 评审（approve / request-changes / comment）
    // 写操作：面板侧必须自己二次确认（UI 里的按钮不属于 tool 调用，走不到插件
    // 的写操作审批门禁），因此这里只做参数合法性校验，确认交互在渲染层。
    bindRoute({
        kind: 'exact',
        path: '/api/github/pr-review',
        handler: async (req, res) => {
            if (req.method !== 'POST') {
                sendJson(res, 405, { ok: false, message: '仅支持 POST 请求' });
                return;
            }
            let body = '';
            req.on('data', (chunk) => { body += chunk; });
            req.on('end', async () => {
                try {
                    const payload = body ? JSON.parse(body) : {};
                    const number = Number(payload.number);
                    const event = String(payload.event || '').toUpperCase();
                    const comment = typeof payload.body === 'string' ? payload.body.trim() : '';
                    if (!Number.isInteger(number) || number <= 0) {
                        sendJson(res, 400, { ok: false, error: '缺少或非法的 PR 编号 (number)' });
                        return;
                    }
                    if (event !== 'APPROVE' && event !== 'REQUEST_CHANGES' && event !== 'COMMENT') {
                        sendJson(res, 400, { ok: false, error: '非法评审类型，仅支持 APPROVE / REQUEST_CHANGES / COMMENT' });
                        return;
                    }
                    // 「请求修改」必须说明原因：GitHub 侧语义要求对作者可执行的意见，空正文等于没提
                    if (event === 'REQUEST_CHANGES' && !comment) {
                        sendJson(res, 400, { ok: false, error: '请求修改必须填写说明' });
                        return;
                    }
                    // 身份判定必须 fail-closed：
                    // 「查不到作者就放行」会让一次探测失败变成一次真实的误写（实测踩过：
                    // 手动切到另一个仓库后 PR 编号对不上，探测失败 → 仍然发出了 review 请求）。
                    // 因此两条判定任一失败都直接拒绝写操作。
                    const requestCwd = typeof payload.cwd === 'string' && payload.cwd.trim() ? payload.cwd.trim() : undefined;
                    const whoami = await executor.run(['api', 'user'], { timeoutMs: 10_000 });
                    const me = whoami.ok && whoami.data ? whoami.data.login : undefined;
                    if (!me) {
                        sendJson(res, 400, { ok: false, error: '无法确认当前 GitHub 账号，已拒绝评审（避免误写）' });
                        return;
                    }
                    // 信任边界：面板传来的 author 只能用来「提前拒绝」，绝不能用来放行。
                    // 它来自客户端，可被构造；真正决定能不能写的必须是服务端自己的查询
                    // （gh pr view --json author），且查询失败时一律拒绝（fail-closed）。
                    const hintedAuthor = typeof payload.author === 'string' ? payload.author.trim() : '';
                    if (hintedAuthor && hintedAuthor === me) {
                        sendJson(res, 400, { ok: false, error: '不能评审自己发起的 PR（GitHub 限制）' });
                        return;
                    }
                    const detail = await executor.run(['pr', 'view', String(number), '--json', 'author'], { timeoutMs: 15_000, cwd: requestCwd });
                    if (!detail.ok || !detail.data) {
                        sendJson(res, 400, {
                            ok: false,
                            error: `无法确认 PR #${number} 的作者（${detail.error || '查询失败'}），已拒绝评审（避免误写）`,
                        });
                        return;
                    }
                    const author = detail.data.author?.login || '';
                    if (!author) {
                        sendJson(res, 400, { ok: false, error: '无法确认 PR 作者，已拒绝评审（避免误写）' });
                        return;
                    }
                    if (author === me) {
                        sendJson(res, 400, { ok: false, error: '不能评审自己发起的 PR（GitHub 限制）' });
                        return;
                    }
                    const repoRoot = executor.resolveWorkspaceRepoRoot(requestCwd);
                    if (!repoRoot) {
                        sendJson(res, 400, { ok: false, error: '当前会话未关联 Git 仓库' });
                        return;
                    }
                    const flag = event === 'APPROVE' ? '--approve' : event === 'REQUEST_CHANGES' ? '--request-changes' : '--comment';
                    const args = ['pr', 'review', String(number), flag];
                    if (comment)
                        args.push('--body', comment);
                    const result = await executor.run(args, { cwd: repoRoot.root, timeoutMs: 25_000 });
                    if (!result.ok) {
                        sendJson(res, 502, { ok: false, error: humanizeGhError(result.error, '提交评审失败') });
                        return;
                    }
                    sendJson(res, 200, {
                        ok: true,
                        data: { number, event, message: event === 'APPROVE' ? '已批准' : event === 'REQUEST_CHANGES' ? '已请求修改' : '已发布评论' },
                    });
                }
                catch (err) {
                    sendJson(res, 500, { ok: false, error: err?.message || '提交评审失败' });
                }
            });
        },
    });
    // 11b. 单独拉 diff：详情面板先出内容，diff 慢也不拖住整页。
    bindRoute({
        kind: 'exact',
        path: '/api/github/pr-diff',
        handler: async (req, res) => {
            if (req.method !== 'GET') {
                sendJson(res, 405, { ok: false, message: '仅支持 GET 请求' });
                return;
            }
            try {
                const url = new URL(req.url || '', 'http://127.0.0.1');
                const number = Number(url.searchParams.get('number'));
                const cwd = url.searchParams.get('cwd') || undefined;
                const repoParam = (url.searchParams.get('repo') || '').trim();
                const explicitRepo = /^[A-Za-z0-9_][A-Za-z0-9_.-]*\/[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(repoParam) ? repoParam : '';
                if (!Number.isInteger(number) || number <= 0) {
                    sendJson(res, 400, { ok: false, error: '缺少或非法的 PR 编号 (number)' });
                    return;
                }
                const repoRoot = explicitRepo ? null : executor.resolveWorkspaceRepoRoot(cwd);
                if (!explicitRepo && !repoRoot) {
                    sendJson(res, 400, { ok: false, error: '当前工作区未关联 Git 仓库' });
                    return;
                }
                const repoArgs = explicitRepo ? ['--repo', explicitRepo] : [];
                const runCwd = explicitRepo ? (cwd || process.cwd()) : repoRoot.root;
                const patch = await executor.run(['pr', 'diff', String(number), ...repoArgs], { cwd: runCwd, timeoutMs: 20_000, rawText: true });
                sendJson(res, 200, {
                    ok: true,
                    data: {
                        number,
                        repo: explicitRepo || undefined,
                        diff: patch.ok ? String(patch.rawOutput || '') : '',
                        diffError: patch.ok ? undefined : (patch.error || '拉取 diff 失败'),
                        diffTruncated: Boolean(patch.truncated),
                    },
                });
            }
            catch (err) {
                sendJson(res, 500, { ok: false, error: err?.message || '拉取 diff 失败' });
            }
        },
    });
    // 11c. 提交评审（批准 / 请求修改 / 评论）——跨仓版本。
    //
    // 走 REST 而不是 gh pr review：面板里的 PR 可能不属于当前工作区仓库，
    // 而 gh pr review 依赖本地仓库上下文；`gh api .../reviews` 只要 -R 语义即可。
    // 自己的 PR 会被 GitHub 拒绝（422），这里原样把错误回给界面，不假装成功。
    bindRoute({
        kind: 'exact',
        path: '/api/github/pr-review-submit',
        handler: async (req, res) => {
            if (req.method !== 'POST') {
                sendJson(res, 405, { ok: false, message: '仅支持 POST 请求' });
                return;
            }
            try {
                const payload = await readJsonBodySafe(req);
                const repo = typeof payload.repo === 'string' ? payload.repo.trim() : '';
                const number = Number(payload.number);
                const body = typeof payload.body === 'string' ? payload.body.trim() : '';
                const event = String(payload.event || '').toUpperCase();
                if (!REPO_ARG_RE.test(repo)) {
                    sendJson(res, 400, { ok: false, error: '缺少或非法的仓库 (repo)' });
                    return;
                }
                if (!Number.isInteger(number) || number <= 0) {
                    sendJson(res, 400, { ok: false, error: '缺少或非法的 PR 编号 (number)' });
                    return;
                }
                if (event !== 'APPROVE' && event !== 'REQUEST_CHANGES' && event !== 'COMMENT') {
                    sendJson(res, 400, { ok: false, error: '非法评审类型，仅支持 APPROVE / REQUEST_CHANGES / COMMENT' });
                    return;
                }
                if (event === 'REQUEST_CHANGES' && !body) {
                    sendJson(res, 400, { ok: false, error: '请求修改必须填写说明' });
                    return;
                }
                if (body.length > MAX_COMMENT_CHARS) {
                    sendJson(res, 400, { ok: false, error: `内容过长（上限 ${MAX_COMMENT_CHARS} 字符）` });
                    return;
                }
                // 先验：gh api 只会回一个 422，用户看不懂；这两类情况提前说清楚。
                const guard = await executor.run(['pr', 'view', String(number), '--repo', repo, '--json', 'state,author'], { timeoutMs: 15_000 });
                if (guard.ok && guard.data) {
                    const gState = String(guard.data.state || '').toUpperCase();
                    const gAuthor = (guard.data.author || {}).login || '';
                    if (gState === 'MERGED' || gState === 'CLOSED') {
                        sendJson(res, 400, { ok: false, error: `PR #${number} 已${gState === 'MERGED' ? '合并' : '关闭'}，不能再提交评审` });
                        return;
                    }
                    const me = await executor.run(['api', 'user'], { timeoutMs: 10_000 });
                    const meLogin = me.ok && me.data ? String(me.data.login || '') : '';
                    if (meLogin && gAuthor === meLogin && event !== 'COMMENT') {
                        sendJson(res, 400, { ok: false, error: '不能批准或请求修改自己发起的 PR（GitHub 限制）；想留话请用「发到 PR 评论」' });
                        return;
                    }
                }
                const args = ['api', `repos/${repo}/pulls/${number}/reviews`, '--method', 'POST', '-f', `event=${event}`];
                if (body)
                    args.push('-f', `body=${body}`);
                const result = await executor.run(args, { timeoutMs: 25_000 });
                if (!result.ok) {
                    sendJson(res, 502, { ok: false, error: humanizeGhError(result.error, '提交评审失败') });
                    return;
                }
                sendJson(res, 200, {
                    ok: true,
                    data: { repo, number, event, message: event === 'APPROVE' ? '已批准' : event === 'REQUEST_CHANGES' ? '已请求修改' : '已评论' },
                });
            }
            catch (err) {
                sendJson(res, 500, { ok: false, error: err?.message || '提交评审失败' });
            }
        },
    });
    // 11c2. 仓库允许哪几种合并方式：GitHub 只在仓库对象上给 allow_*_merge，
    // PR 对象上没有。面板据此过滤下拉，避免用户选一个必然被拒的方式。
    const repoMergeMethodsCache = new Map();
    /**
     * 会话 PR 列表的「冷启动快照」。
     *
     * 为什么：重启 DSH 后第一次打开浮窗要等一次完整聚合（最坏 ~1.5s，网络差时更久）。
     * 把上一次成功的结果落盘，重启后直接吐出来先渲染，8 秒内的下一拍再换成真数据——
     * 用户感知从「等一次网络往返」变成「立刻出现」，代价是可能看到最多一个轮询周期的旧值。
     */
    const SESSION_SNAPSHOT_PATH = path.join(os.homedir(), '.dsh', 'data', 'dsh-pr-panel', 'session-pr-snapshot.json');
    const SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
    let sessionSnapshot = null;
    const snapshotServed = new Set();
    function loadSessionSnapshot() {
        if (sessionSnapshot)
            return sessionSnapshot;
        try {
            const raw = fs.readFileSync(SESSION_SNAPSHOT_PATH, 'utf8');
            const parsed = JSON.parse(raw);
            sessionSnapshot = parsed && typeof parsed === 'object' ? parsed : {};
        }
        catch {
            sessionSnapshot = {};
        }
        return sessionSnapshot;
    }
    function saveSessionSnapshot(sessionId, items, sig) {
        try {
            const all = loadSessionSnapshot();
            all[sessionId] = { at: Date.now(), items: items.slice(0, 12), sig };
            // 最多留 20 个会话，避免无限增长
            const keys = Object.keys(all);
            if (keys.length > 20) {
                keys.sort((a, b) => (all[a].at || 0) - (all[b].at || 0));
                for (const k of keys.slice(0, keys.length - 20))
                    delete all[k];
            }
            fs.mkdirSync(path.dirname(SESSION_SNAPSHOT_PATH), { recursive: true });
            const tmp = `${SESSION_SNAPSHOT_PATH}.${process.pid}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(all), 'utf8');
            fs.renameSync(tmp, SESSION_SNAPSHOT_PATH);
        }
        catch { /* 快照只是加速层，写失败不影响主流程 */ }
    }
    bindRoute({
        kind: 'exact',
        path: '/api/github/repo-merge-methods',
        handler: async (req, res) => {
            if (req.method !== 'GET') {
                sendJson(res, 405, { ok: false, message: '仅支持 GET 请求' });
                return;
            }
            try {
                const url = new URL(req.url || '', 'http://127.0.0.1');
                const repo = (url.searchParams.get('repo') || '').trim();
                if (!REPO_ARG_RE.test(repo)) {
                    sendJson(res, 400, { ok: false, error: '缺少或非法的仓库 (repo)' });
                    return;
                }
                const cached = repoMergeMethodsCache.get(repo);
                if (cached && Date.now() - cached.at < 300_000) {
                    sendJson(res, 200, { ok: true, data: cached.data });
                    return;
                }
                const r = await executor.run(['api', `repos/${repo}`], { timeoutMs: 15_000 });
                if (!r.ok || !r.data) {
                    sendJson(res, 502, { ok: false, error: humanizeGhError(r.error, '读取仓库设置失败') });
                    return;
                }
                const d = r.data;
                const data = {
                    repo,
                    squash: d.allow_squash_merge !== false,
                    merge: d.allow_merge_commit !== false,
                    rebase: d.allow_rebase_merge !== false,
                    // 只允许 squash 合并且必须压缩标题时，面板可以据此提示
                    squashOnly: d.allow_squash_merge !== false && d.allow_merge_commit === false && d.allow_rebase_merge === false,
                };
                repoMergeMethodsCache.set(repo, { at: Date.now(), data });
                sendJson(res, 200, { ok: true, data });
            }
            catch (err) {
                sendJson(res, 500, { ok: false, error: err?.message || '读取仓库设置失败' });
            }
        },
    });
    // 11d. 合并 / 自动合并 —— 面板头部那几个按钮的落点。
    //
    // 走 gh pr merge：--auto 就是 GitHub 的「Auto-merge」（底层是 enablePullRequestAutoMerge 的
    // 同一套语义），--disable-auto 关闭；仓库没开分支保护时 GitHub 会拒绝，错误原样回给界面。
    bindRoute({
        kind: 'exact',
        path: '/api/github/pr-merge',
        handler: async (req, res) => {
            if (req.method !== 'POST') {
                sendJson(res, 405, { ok: false, message: '仅支持 POST 请求' });
                return;
            }
            try {
                const payload = await readJsonBodySafe(req);
                const repo = typeof payload.repo === 'string' ? payload.repo.trim() : '';
                const number = Number(payload.number);
                // 只在「字段缺失」时取默认值；显式传空串一律 400。
                // 合并会改写远端历史，调用方把 action 写空不能等于「那就合并吧」。
                const action = payload.action === undefined || payload.action === null ? 'merge' : String(payload.action);
                const method = payload.method === undefined || payload.method === null ? 'squash' : String(payload.method);
                if (!REPO_ARG_RE.test(repo)) {
                    sendJson(res, 400, { ok: false, error: '缺少或非法的仓库 (repo)' });
                    return;
                }
                if (!Number.isInteger(number) || number <= 0) {
                    sendJson(res, 400, { ok: false, error: '缺少或非法的 PR 编号 (number)' });
                    return;
                }
                if (action !== 'merge' && action !== 'auto' && action !== 'disable-auto') {
                    sendJson(res, 400, { ok: false, error: '非法动作，仅支持 merge / auto / disable-auto' });
                    return;
                }
                if (method !== 'squash' && method !== 'merge' && method !== 'rebase') {
                    sendJson(res, 400, { ok: false, error: '非法合并方式，仅支持 squash / merge / rebase' });
                    return;
                }
                // 前置状态校验：已合并 / 已关闭的 PR 上「合并」与「开启自动合并」都不可能生效，
                // 而 `gh pr merge` 对这两种情况会打印一行提示、**退出码仍是 0**——不做前置判断就会谎报成功。
                const before = await executor.run(['pr', 'view', String(number), '--repo', repo, '--json', 'state,mergeStateStatus,autoMergeRequest'], { timeoutMs: 15_000 });
                if (!before.ok || !before.data) {
                    sendJson(res, 502, { ok: false, error: before.error || `读不到 PR #${number} 的当前状态` });
                    return;
                }
                const beforeState = String(before.data.state || '').toUpperCase();
                const hadAuto = Boolean(before.data.autoMergeRequest);
                if (beforeState === 'MERGED' || beforeState === 'CLOSED') {
                    sendJson(res, 400, {
                        ok: false,
                        error: `PR #${number} 已经是 ${beforeState === 'MERGED' ? '已合并' : '已关闭'}状态，${action === 'disable-auto' ? '无需取消自动合并' : '不能再合并或开启自动合并'}`,
                    });
                    return;
                }
                if (action === 'disable-auto' && !hadAuto) {
                    sendJson(res, 400, { ok: false, error: `PR #${number} 本来就没有开启自动合并` });
                    return;
                }
                const args = ['pr', 'merge', String(number), '--repo', repo];
                if (action === 'disable-auto') {
                    args.push('--disable-auto');
                }
                else if (action === 'auto') {
                    args.push('--auto', '--' + method);
                }
                else {
                    args.push('--' + method);
                    if (payload.delete_branch === true)
                        args.push('--delete-branch');
                }
                const result = await executor.run(args, { timeoutMs: 30_000 });
                if (!result.ok) {
                    sendJson(res, 502, { ok: false, error: humanizeGhError(result.error, '合并失败') });
                    return;
                }
                // 后验效果：gh 的退出码不足以证明事情真的发生了，必须回读状态确认。
                const after = await executor.run(['pr', 'view', String(number), '--repo', repo, '--json', 'state,autoMergeRequest,mergedAt'], { timeoutMs: 15_000 });
                const afterState = after.ok && after.data ? String(after.data.state || '').toUpperCase() : '';
                const afterAuto = Boolean(after.ok && after.data && after.data.autoMergeRequest);
                const affected = action === 'merge'
                    ? afterState === 'MERGED'
                    : action === 'auto'
                        ? afterAuto
                        : !afterAuto;
                if (!affected) {
                    sendJson(res, 502, {
                        ok: false,
                        error: `操作没有生效：当前状态 ${afterState || '未知'}${action === 'auto' ? '，自动合并仍未开启（仓库可能未启用分支保护）' : ''}${action === 'disable-auto' ? '，自动合并仍未关闭' : ''}。gh 输出：${String(result.rawOutput || '').trim().slice(0, 200) || '（空）'}`,
                    });
                    return;
                }
                sendJson(res, 200, {
                    ok: true,
                    data: {
                        repo,
                        number,
                        action,
                        method,
                        state: afterState,
                        message: action === 'disable-auto' ? '已取消自动合并' : action === 'auto' ? '已开启自动合并' : '已合并',
                    },
                });
            }
            catch (err) {
                sendJson(res, 500, { ok: false, error: err?.message || '合并失败' });
            }
        },
    });
    // 12b. PR 会话评论（不是 review）——面板里「把意见发到 PR」的落点。
    //
    // 为什么单独一条：`gh pr review --comment` 在**自己的 PR** 上会被 GitHub 拒绝
    // （can not review your own pull request），而用户看的多半就是自己刚提的 PR。
    // `gh pr comment` 是 issue comment，没有这个限制，语义也更贴近「说一句」。
    const REPO_ARG_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*\/[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
    const MAX_COMMENT_CHARS = 64_000;
    async function readJsonBodySafe(req) {
        return new Promise((resolve) => {
            let body = '';
            let tooBig = false;
            req.on('data', (chunk) => {
                body += chunk;
                if (body.length > MAX_COMMENT_CHARS * 2)
                    tooBig = true;
            });
            req.on('end', () => {
                if (tooBig)
                    return resolve({});
                try {
                    resolve(body ? JSON.parse(body) : {});
                }
                catch {
                    resolve({});
                }
            });
        });
    }
    bindRoute({
        kind: 'exact',
        path: '/api/github/pr-comment',
        handler: async (req, res) => {
            if (req.method !== 'POST') {
                sendJson(res, 405, { ok: false, message: '仅支持 POST 请求' });
                return;
            }
            try {
                const payload = await readJsonBodySafe(req);
                const repo = typeof payload.repo === 'string' ? payload.repo.trim() : '';
                const number = Number(payload.number);
                const body = typeof payload.body === 'string' ? payload.body.trim() : '';
                if (!REPO_ARG_RE.test(repo)) {
                    sendJson(res, 400, { ok: false, error: '缺少或非法的仓库 (repo)，应形如 owner/repo' });
                    return;
                }
                if (!Number.isInteger(number) || number <= 0) {
                    sendJson(res, 400, { ok: false, error: '缺少或非法的 PR 编号 (number)' });
                    return;
                }
                if (!body) {
                    sendJson(res, 400, { ok: false, error: '评论内容不能为空' });
                    return;
                }
                if (body.length > MAX_COMMENT_CHARS) {
                    sendJson(res, 400, { ok: false, error: `评论过长（上限 ${MAX_COMMENT_CHARS} 字符）` });
                    return;
                }
                const result = await executor.run(['pr', 'comment', String(number), '--repo', repo, '--body', body], { timeoutMs: 25_000 });
                if (!result.ok) {
                    sendJson(res, 502, { ok: false, error: humanizeGhError(result.error, '发布评论失败') });
                    return;
                }
                sendJson(res, 200, { ok: true, data: { repo, number, message: '评论已发布' } });
            }
            catch (err) {
                sendJson(res, 500, { ok: false, error: err?.message || '发布评论失败' });
            }
        },
    });
    // 12c. PR 行内评论：把「这一行要改」精确落到 GitHub 的 review comment 上。
    //
    // 走 REST（gh api）而不是 gh pr review：行内评论必须带 path/line/side/commit_id，
    // CLI 没有等价子命令。commit_id 用 PR 的 head sha（pr-detail 会回传 headRefOid）。
    bindRoute({
        kind: 'exact',
        path: '/api/github/pr-inline-comment',
        handler: async (req, res) => {
            if (req.method !== 'POST') {
                sendJson(res, 405, { ok: false, message: '仅支持 POST 请求' });
                return;
            }
            try {
                const payload = await readJsonBodySafe(req);
                const repo = typeof payload.repo === 'string' ? payload.repo.trim() : '';
                const number = Number(payload.number);
                const body = typeof payload.body === 'string' ? payload.body.trim() : '';
                const filePath = typeof payload.path === 'string' ? payload.path.trim() : '';
                const line = Number(payload.line);
                const side = payload.side === 'LEFT' ? 'LEFT' : 'RIGHT';
                const commitId = typeof payload.commit_id === 'string' ? payload.commit_id.trim() : '';
                // 多行评论：GitHub 用 start_line + line 表示区间，且 start_line 必须小于 line
                const rawStart = payload.start_line;
                const startLine = rawStart === undefined || rawStart === null ? null : Number(rawStart);
                if (!REPO_ARG_RE.test(repo)) {
                    sendJson(res, 400, { ok: false, error: '缺少或非法的仓库 (repo)' });
                    return;
                }
                if (!Number.isInteger(number) || number <= 0) {
                    sendJson(res, 400, { ok: false, error: '缺少或非法的 PR 编号 (number)' });
                    return;
                }
                if (!body) {
                    sendJson(res, 400, { ok: false, error: '评论内容不能为空' });
                    return;
                }
                if (body.length > MAX_COMMENT_CHARS) {
                    sendJson(res, 400, { ok: false, error: `评论过长（上限 ${MAX_COMMENT_CHARS} 字符）` });
                    return;
                }
                // 路径只允许相对仓库根的文件路径：拒绝绝对路径与 `..`，避免把请求拼到别的端点语义上
                if (!filePath || filePath.length > 1024 || filePath.startsWith('/') || filePath.includes('..')) {
                    sendJson(res, 400, { ok: false, error: '缺少或非法的文件路径 (path)' });
                    return;
                }
                if (!Number.isInteger(line) || line <= 0 || line > 1_000_000) {
                    sendJson(res, 400, { ok: false, error: '缺少或非法的行号 (line)' });
                    return;
                }
                if (!/^[0-9a-f]{7,64}$/i.test(commitId)) {
                    sendJson(res, 400, { ok: false, error: '缺少或非法的 commit_id（应取 PR 的 headRefOid）' });
                    return;
                }
                if (startLine !== null) {
                    if (!Number.isInteger(startLine) || startLine <= 0 || startLine >= line) {
                        sendJson(res, 400, { ok: false, error: '多行评论的 start_line 必须是小于 line 的正整数' });
                        return;
                    }
                }
                const commentArgs = ['api', `repos/${repo}/pulls/${number}/comments`, '--method', 'POST',
                    '-f', `body=${body}`,
                    '-f', `path=${filePath}`,
                    '-f', `side=${side}`,
                    '-F', `line=${line}`,
                    '-f', `commit_id=${commitId}`];
                if (startLine !== null)
                    commentArgs.push('-F', `start_line=${startLine}`, '-f', `start_side=${side}`);
                const result = await executor.run(commentArgs, { timeoutMs: 25_000 });
                if (!result.ok) {
                    sendJson(res, 502, { ok: false, error: humanizeGhError(result.error, '发布行内评论失败') });
                    return;
                }
                sendJson(res, 200, { ok: true, data: { repo, number, path: filePath, line, message: '行内评论已发布' } });
            }
            catch (err) {
                sendJson(res, 500, { ok: false, error: err?.message || '发布行内评论失败' });
            }
        },
    });
}
