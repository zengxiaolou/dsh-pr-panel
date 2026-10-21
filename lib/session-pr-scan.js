/**
 * 从会话转写里回填「本会话新建的 PR」。
 *
 * 为什么要扫转写而不是只依赖登记簿（session-pr-tracker.ts）：
 * 登记簿活在进程内存里，App 重启就没了；而用户对「这个会话提过哪些 PR」的期待是
 * 跨重启成立的。转写是 DSH 自己的持久化格式（~/.dsh/sessions/<ws>/<id>/session.v4.jsonl.zstd），
 * 只要扫一遍历史工具调用就能把它们原样找回来。
 *
 * 判定口径（只认「新建」）：
 *   1. github_pr 工具且 arguments.action === 'create'，结果里出现 PR 链接；
 *   2. github_api 且 POST 到 /pulls（非 /pulls/<n>），结果里出现 PR 链接；
 *   3. bash 命令含 `gh pr create`，输出里出现 PR 链接。
 * 提及、查看、评审、合并都不算——这是本次改造与旧「会话里出现过的 PR」的关键区别。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const execFileAsync = promisify(execFile);
const scanCache = new Map();
/** 同一份转写的并发解压只做一次（浮窗与面板各自轮询，不该各自 inflate） */
const inflightScans = new Map();
/**
 * 文件在变（agent 正在跑）时的最短重扫间隔。
 * 解压整份转写不便宜（5.4MB 实测 0.54s），而轮询是 8s 一次——间隔取一样就等于每轮都解压。
 * 30s 让「用 gh pr create 提交的 PR」半分钟内也能被回填；一天下来解压次数仍然可控。
 */
const MIN_RESCAN_MS = 30_000;
function sessionsRoot() {
    return path.join(os.homedir(), '.dsh', 'sessions');
}
/** 按 sessionId 在全部工作区目录里定位转写文件（目录名被转义过，不可预测） */
export function findTranscript(sessionId) {
    // 会话 id 是 DSH 生成的 `session-<hex>`，只允许这几种字符：
    // 它是从 HTTP query 直接进来的，带 `..` 的串会让 path.join 规范化后逃出 sessions 根目录。
    if (!sessionId || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId))
        return null;
    const root = sessionsRoot();
    let workspaces = [];
    try {
        workspaces = fs.readdirSync(root);
    }
    catch {
        return null;
    }
    for (const ws of workspaces) {
        const candidate = path.join(root, ws, sessionId, 'session.v4.jsonl.zstd');
        try {
            if (fs.existsSync(candidate))
                return candidate;
        }
        catch {
            /* 单个目录不可读就跳过 */
        }
    }
    return null;
}
/**
 * 解压会话转写。
 *
 * 必须异步：一份 5MB 转写的 zstd -dc 实测要 0.5s，同步版会把 Host 事件循环整个按住，
 * 期间所有会话的模型流、工具调用、HTTP 请求全部排队。GET 路由更不能在请求线程里 inflate。
 * 失败返回空串并置 failed 标记，由调用方向前端说明「是解压不了，不是没有 PR」。
 */
async function decompress(transcript) {
    try {
        // Node 20 的 zlib 没有 zstd API，统一走 zstd CLI（与既有会话扫描保持同一条链路）
        const { stdout } = await execFileAsync('zstd', ['-dc', transcript], {
            maxBuffer: 256 * 1024 * 1024,
            encoding: 'utf8',
        });
        return { text: String(stdout || ''), failed: false };
    }
    catch (err) {
        warnDecompressFailure(err);
        return { text: '', failed: true };
    }
}
let warnedDecompress = false;
function warnDecompressFailure(err) {
    if (warnedDecompress)
        return; // 每进程只吼一次，别让轮询把日志刷爆
    warnedDecompress = true;
    const code = err && (err.code || err.message);
    console.warn(`[dsh-pr-panel] 无法解压会话转写（${code}）。会话 PR 的跨重启回填将不可用，请确认系统里有 zstd 命令。`);
}
function readArguments(raw) {
    if (typeof raw !== 'string')
        return raw && typeof raw === 'object' ? raw : null;
    try {
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
}
function isPrCreatingCall(name, args) {
    if (name === 'github_pr')
        return Boolean(args && args.action === 'create' && args.dry_run !== true);
    if (name === 'github_api') {
        if (!args)
            return false;
        const endpoint = String(args.endpoint || '');
        const method = String(args.method || 'GET').toUpperCase();
        // POST /repos/{owner}/{repo}/pulls —— 少数 /pulls/ 后还有段的是别的东西
        return method === 'POST' && /\/pulls\/?$/i.test(endpoint);
    }
    if (name === 'bash' || name === 'shell') {
        const cmd = String((args && (args.command || args.script)) || '');
        return /\bgh\s+pr\s+create\b/.test(cmd);
    }
    return false;
}
function resultText(data) {
    const content = data && data.message && data.message.content;
    if (!Array.isArray(content)) {
        return typeof data?.message?.content === 'string' ? data.message.content : '';
    }
    const parts = [];
    for (const part of content) {
        if (!part)
            continue;
        if (typeof part === 'string')
            parts.push(part);
        else if (typeof part.text === 'string')
            parts.push(part.text);
        else if (typeof part.content === 'string')
            parts.push(part.content);
    }
    return parts.join('\n');
}
const PR_URL_RE = /https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)/gi;
/** 纯函数：从一份转写文本里扫出本会话新建的 PR（按出现顺序，去重保序） */
export function scanCreatedPrsFromTranscript(text) {
    if (!text)
        return [];
    const calls = new Map();
    const out = [];
    const seen = new Set();
    const push = (repo, number, at, via) => {
        if (!Number.isInteger(number) || number <= 0)
            return;
        const key = `${repo}#${number}`.toLowerCase();
        if (seen.has(key))
            return;
        seen.add(key);
        out.push({ repo, number, at, via });
    };
    const lines = text.split('\n');
    for (const line of lines) {
        if (!line)
            continue;
        // 廉价前置过滤：一份长转写里绝大多数行与工具调用无关
        if (line.indexOf('"tool/call"') === -1 && line.indexOf('"tool/result"') === -1)
            continue;
        let rec;
        try {
            rec = JSON.parse(line);
        }
        catch {
            continue;
        }
        const type = rec && rec.type;
        const data = rec && rec.data;
        if (!data)
            continue;
        if (type === 'tool/call') {
            const callId = String(data.callId || '');
            if (!callId)
                continue;
            calls.set(callId, {
                name: String(data.name || ''),
                args: readArguments(data.arguments),
                at: Number(rec.time) || 0,
            });
            continue;
        }
        if (type !== 'tool/result')
            continue;
        const callId = String(data.toolCallId || (data.message && data.message.toolCallId) || '');
        const call = callId ? calls.get(callId) : undefined;
        if (!call || !isPrCreatingCall(call.name, call.args))
            continue;
        const body = resultText(data);
        if (!body)
            continue;
        const via = call.name === 'github_api' ? 'api' : call.name === 'github_pr' ? 'tool' : 'bash';
        PR_URL_RE.lastIndex = 0;
        let m;
        while ((m = PR_URL_RE.exec(body)) !== null) {
            push(`${m[1]}/${m[2]}`, Number(m[3]), call.at || Number(rec.time) || 0, via);
        }
    }
    return out;
}
/**
 * 读某个会话新建的 PR（带 mtime 缓存 + 并发去重）。
 *
 * 缓存键是转写文件的 mtime + size：文件没动就完全不打解压；文件在动（agent 正在写）
 * 时也不低于 MIN_RESCAN_MS 一次。同一份转写在多个轮询同时到达时只解压一次。
 *
 * 异步是硬要求：见 decompress() 的说明，同步 inflate 会按住 Host 事件循环。
 */
export async function readSessionCreatedPrs(sessionId, opts = {}) {
    const transcript = findTranscript(sessionId);
    if (!transcript)
        return { refs: [], transcript: null, reason: '找不到该会话的转写文件' };
    let stat;
    try {
        stat = fs.statSync(transcript);
    }
    catch {
        return { refs: [], transcript, reason: '读不到转写文件状态' };
    }
    const cached = scanCache.get(transcript);
    const fresh = cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size;
    if (cached && !opts.force && fresh)
        return { refs: cached.refs, transcript };
    if (cached && !opts.force && Date.now() - cached.at < MIN_RESCAN_MS) {
        return { refs: cached.refs, transcript };
    }
    let pending = inflightScans.get(transcript);
    if (!pending) {
        pending = (async () => {
            const { text, failed } = await decompress(transcript);
            // 失败也把标记带出来：共享这次 inflate 的第二个调用方不能把它当「扫完了，没有 PR」
            return { refs: failed ? [] : scanCreatedPrsFromTranscript(text), failed };
        })();
        inflightScans.set(transcript, pending);
    }
    let refs = [];
    let failed = false;
    try {
        const settled = await pending;
        refs = settled.refs;
        failed = settled.failed;
    }
    catch (err) {
        failed = true;
        warnDecompressFailure(err);
    }
    finally {
        inflightScans.delete(transcript);
    }
    // 解压失败时不写缓存：下一次轮询值得再试（比如 zstd 被临时移出 PATH）
    if (failed) {
        return { refs: [], transcript, reason: '无法解压会话转写（缺少 zstd 命令或文件损坏），跨重启回填暂不可用' };
    }
    scanCache.set(transcript, { mtimeMs: stat.mtimeMs, size: stat.size, at: Date.now(), refs });
    return { refs, transcript };
}
