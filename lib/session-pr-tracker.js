/**
 * 会话级「本会话新建的 PR」登记簿（Host 进程内）。
 *
 * 为什么要它：
 * - 浮窗要「有 PR 就立刻出现」。会话转写是异步落盘的，且解压扫描是按文件整体做的，
 *   一次 gh pr create 之后等它进转写再扫出来，观感上是「点了没反应」。
 * - 因此写路径（github_pr create）成功后就地登记一条 {sessionId, repo, number}；
 *   路由把「登记簿」与「转写回填」两路合并——前者负责即时，后者负责重开后补历史。
 *
 * 边界：
 * - 这是**派生缓存**，不是真相源。进程重启就没了，转写扫描会把它们找回来。
 * - 只登记「本会话新建」的 PR；提及、评审、合并过的 PR 不属于这个口径。
 */
/** 单个会话最多记多少条（够用即可，防长会话无限增长） */
const MAX_PER_SESSION = 80;
/** 最多跟踪多少个会话 */
const MAX_SESSIONS = 120;
const registry = new Map();
/** 从 PR 链接里拆出 owner/repo 与编号；不是 PR 链接就返回 null */
export function parsePrUrl(url) {
    if (typeof url !== 'string')
        return null;
    // owner/repo 每段必须以字母数字或下划线开头：这个值后续会作为 `gh --repo` 的参数，
    // 允许 `-` 开头等于允许构造出一个看起来像选项的值（即便 execFile 不走 shell）。
    const m = url.match(/github\.com\/([A-Za-z0-9_][A-Za-z0-9_.-]*)\/([A-Za-z0-9_][A-Za-z0-9_.-]*)\/pull\/(\d+)/i);
    if (!m)
        return null;
    const number = Number(m[3]);
    if (!Number.isInteger(number) || number <= 0)
        return null;
    return { repo: `${m[1]}/${m[2]}`, number };
}
/**
 * 登记一条「本会话新建的 PR」。
 * 同一 repo#number 重复登记只更新时间戳，不产生重复行。
 */
export function recordCreatedPr(sessionId, url, via = 'tool') {
    const id = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!id)
        return null;
    const parsed = parsePrUrl(url);
    if (!parsed)
        return null;
    const at = Date.now();
    const key = `${parsed.repo}#${parsed.number}`.toLowerCase();
    let rows = registry.get(id);
    if (!rows) {
        rows = [];
        registry.set(id, rows);
    }
    const hit = rows.find((r) => `${r.repo}#${r.number}`.toLowerCase() === key);
    if (hit) {
        hit.at = at;
        hit.via = via;
        return hit;
    }
    const row = { repo: parsed.repo, number: parsed.number, at, via };
    rows.push(row);
    if (rows.length > MAX_PER_SESSION)
        rows.splice(0, rows.length - MAX_PER_SESSION);
    // 简单的 LRU：超限时丢掉最早建立的那个会话
    if (registry.size > MAX_SESSIONS) {
        const oldest = registry.keys().next().value;
        if (typeof oldest === 'string' && oldest !== id)
            registry.delete(oldest);
    }
    return row;
}
/** 读取某个会话登记过的 PR（按时间倒序，最新在前） */
export function listSessionCreatedPrs(sessionId) {
    const rows = registry.get(typeof sessionId === 'string' ? sessionId.trim() : '');
    if (!rows || rows.length === 0)
        return [];
    return rows.slice().sort((a, b) => b.at - a.at);
}
/** 清空（测试用） */
export function __resetCreatedPrTracker() {
    registry.clear();
}
