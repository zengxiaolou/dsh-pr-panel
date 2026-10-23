/**
 * CI 结果归一与统计。
 *
 * 为什么单独一层：
 * 同一个 PR 的检查来自两种完全不同的对象——
 *   - CheckRun（GitHub Actions / 第三方 App）：`name` + `status` + `conclusion`
 *     + `startedAt` / `completedAt`；
 *   - StatusContext（老式 commit status）：`context` + `state` + `createdAt`，没有完成时间。
 * 面板原先只把它们压成一个三态圆点，于是「跑完了吗 / 什么时候跑完的 / 卡在哪一项」
 * 全都看不出来。这里统一成带时间戳的条目，再算出一轮 CI 的墙钟与最慢项。
 *
 * 另一个用途：列表里的「CI ✅ 12m 前完成」需要完成时间，而列表只拿得到汇总，
 * 所以这里同时产出 `lastCompletedAt`，让 UI 不必自己遍历。
 */
function parseTime(value) {
    if (value == null || value === '')
        return null;
    const t = Date.parse(String(value));
    return Number.isFinite(t) ? t : null;
}
function isoOrNull(ms) {
    return ms == null ? null : new Date(ms).toISOString();
}
/** CheckRun 的 conclusion / StatusContext 的 state → 三态 */
function entryState(item) {
    const status = String(item.status || '').toUpperCase();
    const conclusion = String(item.conclusion || '').toUpperCase();
    const ctxState = String(item.state || '').toUpperCase();
    if (status && status !== 'COMPLETED') {
        // QUEUED / IN_PROGRESS / WAITING / REQUESTED 都算「还没完」
        return { state: 'pending', running: status === 'IN_PROGRESS' };
    }
    if (ctxState) {
        if (ctxState === 'SUCCESS')
            return { state: 'pass', running: false };
        if (ctxState === 'PENDING')
            return { state: 'pending', running: true };
        return { state: 'fail', running: false };
    }
    if (conclusion === 'SUCCESS' || conclusion === 'NEUTRAL' || conclusion === 'SKIPPED')
        return { state: 'pass', running: false };
    if (conclusion === 'FAILURE' || conclusion === 'TIMED_OUT' || conclusion === 'CANCELLED' ||
        conclusion === 'ACTION_REQUIRED' || conclusion === 'STARTUP_FAILURE' || conclusion === 'STALE')
        return { state: 'fail', running: false };
    if (conclusion)
        return { state: 'pending', running: false };
    // 什么标记都没有：当作排队中，而不是「通过」——把未知说成通过是最坏的一种错。
    return { state: 'pending', running: false };
}
/**
 * 汇总一组检查。
 * `now` 可注入，便于单测固定时间；不注入时用当前时刻估算在跑耗时。
 */
export function summarizeCi(checks, now = Date.now()) {
    const list = Array.isArray(checks) ? checks : [];
    const entries = [];
    let passed = 0;
    let failed = 0;
    let pending = 0;
    let running = 0;
    let firstStart = null;
    let lastDone = null;
    let slowest = null;
    for (const item of list) {
        if (!item)
            continue;
        const name = String(item.name || item.context || '').trim() || '未命名检查';
        const { state, running: isRunning } = entryState(item);
        if (state === 'pass')
            passed += 1;
        else if (state === 'fail')
            failed += 1;
        else
            pending += 1;
        if (isRunning)
            running += 1;
        // StatusContext 没有 completedAt：state=SUCCESS 时用 createdAt 作为「完成时间」，
        // 这样「什么时候完成」在只有老式 status 的仓库里也有答案。
        // 但那是唯一时间戳，不能拿来算耗时——否则等于对外宣称「0s 跑完」。
        const started = parseTime(item.startedAt) ?? parseTime(item.createdAt);
        const realEnd = parseTime(item.completedAt);
        const inferredEnd = realEnd == null && state === 'pass' && !String(item.status || '')
            ? parseTime(item.createdAt) : null;
        const completed = realEnd ?? inferredEnd;
        if (started != null && (firstStart == null || started < firstStart))
            firstStart = started;
        if (completed != null && (lastDone == null || completed > lastDone))
            lastDone = completed;
        const durationMs = realEnd != null && started != null && realEnd >= started ? realEnd - started : null;
        if (durationMs != null && (!slowest || durationMs > slowest.durationMs))
            slowest = { name, durationMs };
        entries.push({
            name,
            state,
            durationMs,
            startedAt: isoOrNull(started),
            completedAt: isoOrNull(completed),
            url: String(item.detailsUrl || item.targetUrl || ''),
        });
    }
    const total = entries.length;
    const state = total === 0 ? 'none' : failed > 0 ? 'fail' : pending > 0 ? 'pending' : 'pass';
    // 墙钟：全部跑完用「最后一刻完成」；还有在跑的就算到现在——
    // 否则一个已经跑了 40 分钟、只剩最后一项的 CI 会显示成「用时 2m」（最后完成的那项），
    // 用户看到的是假进度。
    const stillRunning = pending > 0;
    const endRef = stillRunning && firstStart != null
        ? now
        : (lastDone != null ? lastDone : (firstStart != null ? now : null));
    const durationMs = firstStart != null && endRef != null && endRef >= firstStart ? endRef - firstStart : null;
    // 失败项排前面：出问题时第一眼要看的就是它
    const rank = { fail: 0, pending: 1, pass: 2, none: 3 };
    entries.sort((a, b) => {
        if (rank[a.state] !== rank[b.state])
            return rank[a.state] - rank[b.state];
        return a.name.localeCompare(b.name);
    });
    return {
        state,
        total,
        passed,
        failed,
        pending,
        firstStartedAt: isoOrNull(firstStart),
        lastCompletedAt: isoOrNull(lastDone),
        durationMs,
        running,
        slowest,
        checks: entries,
    };
}
/** 把耗时说成人话：42s / 8m12s / 1h04m */
export function formatDuration(ms) {
    if (ms == null || !Number.isFinite(ms) || ms < 0)
        return '';
    const totalSec = Math.round(ms / 1000);
    if (totalSec < 60)
        return `${totalSec}s`;
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    if (min < 60)
        return sec === 0 ? `${min}m` : `${min}m${String(sec).padStart(2, '0')}s`;
    const hour = Math.floor(min / 60);
    const restMin = min % 60;
    return `${hour}h${String(restMin).padStart(2, '0')}m`;
}
/** 「12m 前」——完成时间比绝对时间戳更好读 */
export function formatAge(at, now = Date.now()) {
    if (at == null || at === '')
        return '';
    const t = typeof at === 'number' ? at : Date.parse(String(at));
    if (!Number.isFinite(t))
        return '';
    const diff = Math.max(0, now - t);
    const sec = Math.round(diff / 1000);
    if (sec < 60)
        return `${sec}s 前`;
    const min = Math.round(sec / 60);
    if (min < 60)
        return `${min}m 前`;
    const hour = Math.round(min / 60);
    if (hour < 24)
        return `${hour}h 前`;
    return `${Math.round(hour / 24)}d 前`;
}
/**
 * GraphQL `statusCheckRollup.state` → 三态。
 * 认不出的值返回 null（不要猜成 pass）。
 */
export function rollupStateToCiState(raw) {
    const s = String(raw == null ? '' : raw).toUpperCase();
    if (!s)
        return null;
    if (s === 'SUCCESS')
        return 'pass';
    if (s === 'FAILURE' || s === 'ERROR' || s === 'TIMED_OUT' || s === 'CANCELLED' || s === 'ACTION_REQUIRED' || s === 'STARTUP_FAILURE')
        return 'fail';
    if (s === 'PENDING' || s === 'EXPECTED' || s === 'QUEUED' || s === 'IN_PROGRESS')
        return 'pending';
    return null;
}
/**
 * 用「权威汇总」校正「明细汇总」。
 *
 * 为什么必须有这一步：列表接口只取前 N 项检查明细（控流量），而一个 PR 可能有
 * 20+ 项。如果第 13 项失败、前 12 项全绿，拿明细算出来的结论就是「全绿」——
 * 面板显示通过、实际挂着红叉，这是这类 UI 里最坏的一种错。
 *
 * 规则：**状态永远听 GitHub 的汇总**；数量/耗时仍用明细（所以带 partial 标记），
 * 失败但明细里看不见失败项时，failed 至少记 1，不显示「✕0」。
 */
export function reconcileCiState(ci, rollupState, truncated = false) {
    const authoritative = rollupStateToCiState(rollupState);
    if (!authoritative)
        return truncated ? { ...ci, partial: true } : ci;
    if (authoritative === ci.state)
        return truncated ? { ...ci, partial: true } : ci;
    return {
        ...ci,
        state: authoritative,
        failed: authoritative === 'fail' ? Math.max(1, ci.failed) : ci.failed,
        partial: true,
    };
}
export function summarizeRunStats(runs) {
    const list = Array.isArray(runs) ? runs : [];
    let passed = 0;
    let failed = 0;
    let cancelled = 0;
    let durSum = 0;
    let durCount = 0;
    let lastSuccess = null;
    let lastCompleted = null;
    for (const run of list) {
        if (!run)
            continue;
        const conclusion = String(run.conclusion || '').toUpperCase();
        const started = parseTime(run.startedAt) ?? parseTime(run.createdAt);
        const ended = parseTime(run.updatedAt);
        if (conclusion === 'SUCCESS') {
            passed += 1;
            if (ended != null && (lastSuccess == null || ended > lastSuccess))
                lastSuccess = ended;
        }
        else if (conclusion === 'FAILURE' || conclusion === 'TIMED_OUT' || conclusion === 'STARTUP_FAILURE') {
            failed += 1;
        }
        else if (conclusion === 'CANCELLED' || conclusion === 'SKIPPED' || conclusion === 'NEUTRAL') {
            cancelled += 1;
        }
        else {
            continue; // 还在跑 / 排队中：不进统计
        }
        if (ended != null && (lastCompleted == null || ended > lastCompleted))
            lastCompleted = ended;
        if (started != null && ended != null && ended >= started) {
            durSum += ended - started;
            durCount += 1;
        }
    }
    const settled = passed + failed + cancelled;
    return {
        runs: list.length,
        passed,
        failed,
        cancelled,
        successRate: settled > 0 ? passed / settled : null,
        avgDurationMs: durCount > 0 ? Math.round(durSum / durCount) : null,
        lastSuccessAt: isoOrNull(lastSuccess),
        lastCompletedAt: isoOrNull(lastCompleted),
    };
}
const DONE_STEP = new Set(['COMPLETED', 'SUCCESS', 'FAILURE', 'CANCELLED', 'SKIPPED', 'TIMED_OUT', 'ACTION_REQUIRED']);
export function pickActiveProgress(jobs) {
    const list = Array.isArray(jobs) ? jobs : [];
    if (list.length === 0)
        return null;
    // 优先「正在跑」的 job；没有就退到第一个还没结束的 job（queued / waiting）
    const activeJob = list.find((j) => String(j && j.status || '').toUpperCase() === 'IN_PROGRESS')
        || list.find((j) => {
            const s = String(j && j.status || '').toUpperCase();
            return s && s !== 'COMPLETED';
        });
    if (!activeJob)
        return null;
    const steps = Array.isArray(activeJob.steps) ? activeJob.steps.filter(Boolean) : [];
    const total = steps.length;
    let done = 0;
    let current = null;
    for (const step of steps) {
        const status = String(step && step.status || '').toUpperCase();
        if (status === 'COMPLETED' || DONE_STEP.has(String(step && step.conclusion || '').toUpperCase())) {
            done += 1;
            continue;
        }
        if (!current) {
            const num = Number(step && step.number);
            current = { number: Number.isFinite(num) ? num : null, name: String(step && step.name || '').trim() };
        }
    }
    const jobStatus = String(activeJob.status || '').toUpperCase();
    const ratio = total > 0 ? Math.min(1, Math.max(0, done / total)) : (jobStatus === 'IN_PROGRESS' ? 0.5 : 0);
    return {
        job: String(activeJob.name || '').trim() || '未命名 job',
        jobStatus,
        stepNumber: current ? current.number : null,
        stepName: current ? current.name : '',
        stepsDone: done,
        stepsTotal: total,
        ratio,
    };
}
/**
 * 这条运行值不值得展示。
 *
 * 口径（用户 2026-10-23 明确）：未完成的要看；已完成的只看最近 30 分钟内；
 * 更早的不拉也不显示——历史成功/失败对"现在要不要处理"没有价值。
 */
export function isRunWorthShowing(run, now = Date.now(), windowMs = 30 * 60_000) {
    const status = String(run?.status || '').toLowerCase();
    if (status === 'in_progress' || status === 'queued' || status === 'waiting' || status === 'requested' || status === 'pending') {
        return true;
    }
    const t = Date.parse(String(run?.updatedAt || run?.createdAt || ''));
    if (!isFinite(t))
        return false;
    return now - t <= windowMs;
}
