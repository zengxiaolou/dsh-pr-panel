// test/phase30.test.mjs - 终端唤起去重（防「窗口风暴」）
//
// 复现的现场故障（2026-10-20）：gh 其实已登录，但 open_terminal 被按钮连点 /
// 程序化 POST 反复触发，每次都开一个新 Terminal 窗口跑 `gh auth login`；而这些
// gh 进程会永远停在 `Where do you use GitHub?` 等输入，窗口与进程一路堆到七八个，
// 只能手动一个个关。
//
// 本阶段锁死四道服务端防线（认证态闸 / 在途闸 / 冷却闸 / 并发合并）与两道前端
// 防线（唤起中禁用、成功后短冷却），全部通过注入 launcher/now/pendingCheck/authCheck
// 验证，不真开窗口、不依赖本机是否有残留的 gh 进程。
import { readFileSync } from 'node:fs';

let pass = 0, total = 0;
const fails = [];
function assert(c, n) { total++; if (c) pass++; else { fails.push(n); console.error('❌ ' + n); } }

const actions = await import('../lib/api/routes-actions.js');

// ---- 1. 导出面 ----
console.log('\n--- 1. exported surface ---');
assert(typeof actions.requestTerminalLaunch === 'function', '导出受控唤起入口 requestTerminalLaunch');
assert(typeof actions.resetTerminalLaunchState === 'function', '导出 resetTerminalLaunchState（用例间隔离）');
assert(typeof actions.parseElapsedSeconds === 'function', '导出 parseElapsedSeconds（etime 解析可单测）');
assert(typeof actions.pendingGhLoginAgeSeconds === 'function', '导出 pendingGhLoginAgeSeconds（在途探测）');

// ---- 2. ps etime 解析 ----
console.log('\n--- 2. ps etime parsing ---');
assert(actions.parseElapsedSeconds('00:45') === 45, 'MM:SS → 45');
assert(actions.parseElapsedSeconds('02:31:20') === 2 * 3600 + 31 * 60 + 20, 'HH:MM:SS');
assert(actions.parseElapsedSeconds('1-02:03:04') === 86400 + 2 * 3600 + 3 * 60 + 4, 'D-HH:MM:SS');
assert(actions.parseElapsedSeconds('  03:07  ') === 187, '容忍 ps 输出的首尾空白');
assert(actions.parseElapsedSeconds('') === null, '空串 → null');
assert(actions.parseElapsedSeconds('garbage') === null, '垃圾输入 → null（不抛）');

// ---- 3. 闸 1：认证态已满足就不开窗 ----
console.log('\n--- 3. gate: already authenticated ---');
{
  actions.resetTerminalLaunchState();
  let launched = 0;
  const r = await actions.requestTerminalLaunch('gh auth login', {
    authCheck: async () => ({ loggedIn: true, user: 'zengxiaolou' }),
    pendingCheck: () => null,
    launcher: async () => { launched++; return { ok: true }; },
  });
  assert(r.ok === true, '已登录时语义仍是成功（不是报错）');
  assert(r.status === 'skipped' && r.skipped === true, '状态为 skipped');
  assert(launched === 0, '★已登录时一次终端都不唤起（根因修复）');
  assert(String(r.message).includes('zengxiaolou'), '提示里说明已登录的账号');
}

// ---- 4. 未登录 / 网络异常时才真唤起，且只唤起一次 ----
console.log('\n--- 4. gate: launch when genuinely logged out ---');
{
  actions.resetTerminalLaunchState();
  let launched = 0;
  const r = await actions.requestTerminalLaunch('gh auth login', {
    authCheck: async () => ({ loggedIn: false }),
    pendingCheck: () => null,
    launcher: async () => { launched++; return { ok: true }; },
  });
  assert(r.ok === true && r.status === 'launched', '未登录时正常开窗');
  assert(launched === 1, '唤起且仅唤起一次');
}
{
  // networkError 不能被当成「已登录」而拒绝开窗：代理阻断时用户恰恰需要在终端里
  // 手动跑 gh auth status 排查，这是 auth-guide-card 的「终端排查状态」分支。
  actions.resetTerminalLaunchState();
  let launched = 0;
  const r = await actions.requestTerminalLaunch('gh auth login', {
    authCheck: async () => ({ loggedIn: true, networkError: true }),
    pendingCheck: () => null,
    launcher: async () => { launched++; return { ok: true }; },
  });
  assert(launched === 1 && r.status === 'launched', 'networkError 时仍允许开窗');
}
{
  // authCheck 自己抛错也不能把用户的路堵死（fail-open：宁可真开一个窗）
  actions.resetTerminalLaunchState();
  let launched = 0;
  await actions.requestTerminalLaunch('gh auth login', {
    authCheck: async () => { throw new Error('boom'); },
    pendingCheck: () => null,
    launcher: async () => { launched++; return { ok: true }; },
  });
  assert(launched === 1, '认证探测异常时 fail-open 开窗');
}

// ---- 5. 闸 3：冷却窗口内不重复开窗 ----
console.log('\n--- 5. gate: cooldown ---');
{
  actions.resetTerminalLaunchState();
  let launched = 0;
  let clock = 1_000_000;
  const opts = () => ({
    authCheck: async () => ({ loggedIn: false }),
    pendingCheck: () => null,
    launcher: async () => { launched++; return { ok: true }; },
    now: () => clock,
  });

  const first = await actions.requestTerminalLaunch('gh auth login', opts());
  assert(first.status === 'launched' && launched === 1, '第一次真开窗');

  clock += 30_000;
  const second = await actions.requestTerminalLaunch('gh auth login', opts());
  assert(second.ok === true && second.status === 'reused' && second.reused === true, '30 秒内复用，不重复开窗');
  assert(launched === 1, '★冷却期内仍只有一次唤起');
  assert(/30 秒前/.test(String(second.message)), '提示给出距上次唤起多久');

  clock += 120_000;
  const third = await actions.requestTerminalLaunch('gh auth login', opts());
  assert(third.status === 'launched' && launched === 2, '冷却结束后允许重开');
}

// ---- 6. 闸 2：已有等待中的登录窗口就复用 ----
console.log('\n--- 6. gate: pending login window ---');
{
  actions.resetTerminalLaunchState();
  let launched = 0;
  const r = await actions.requestTerminalLaunch('gh auth login', {
    authCheck: async () => ({ loggedIn: false }),
    pendingCheck: () => 45,
    launcher: async () => { launched++; return { ok: true }; },
  });
  assert(r.ok === true && r.status === 'reused', '已有窗口时返回复用');
  assert(launched === 0, '★已有等待窗口时不再开新窗');
  assert(String(r.message).includes('45'), '提示里带上已等待的秒数');
}
{
  // 2 小时前的窗口是僵尸（本机实测就有一个卡了 2h26m 的），不能永久挡住真实登录
  actions.resetTerminalLaunchState();
  let launched = 0;
  const r = await actions.requestTerminalLaunch('gh auth login', {
    authCheck: async () => ({ loggedIn: false }),
    pendingCheck: () => 7_200,
    launcher: async () => { launched++; return { ok: true }; },
  });
  assert(launched === 1 && r.status === 'launched', '僵尸窗口（>10 分钟）允许重开');
}

// ---- 7. 并发合并：同时点两下只开一个窗 ----
console.log('\n--- 7. concurrent requests collapse ---');
{
  actions.resetTerminalLaunchState();
  let launched = 0;
  const opts = () => ({
    authCheck: async () => ({ loggedIn: false }),
    pendingCheck: () => null,
    launcher: async () => {
      launched++;
      await new Promise((r) => setTimeout(r, 30));
      return { ok: true };
    },
  });
  const [a, b] = await Promise.all([
    actions.requestTerminalLaunch('gh auth login', opts()),
    actions.requestTerminalLaunch('gh auth login', opts()),
  ]);
  assert(a.ok === true && b.ok === true, '两个并发请求都应拿到成功');
  assert(launched === 1, '★并发两次只 spawn 一次');
  assert(b.status === 'reused', '被合并的那个标记为 reused');
}

// ---- 8. force 逃生门 ----
console.log('\n--- 8. force escape hatch ---');
{
  actions.resetTerminalLaunchState();
  let launched = 0;
  const r = await actions.requestTerminalLaunch('gh auth login', {
    force: true,
    authCheck: async () => ({ loggedIn: true, user: 'x' }),
    pendingCheck: () => 10,
    launcher: async () => { launched++; return { ok: true }; },
  });
  assert(launched === 1 && r.status === 'launched', 'force 跳过三道闸（补权限/换账号）');
}

// ---- 9. 唤起失败如实回传，不吞错 ----
console.log('\n--- 9. failure is reported, not swallowed ---');
{
  actions.resetTerminalLaunchState();
  const r = await actions.requestTerminalLaunch('gh auth login', {
    authCheck: async () => ({ loggedIn: false }),
    pendingCheck: () => null,
    launcher: async () => ({ ok: false, error: '终端启动命令退出码 1' }),
  });
  assert(r.ok === false && /退出码 1/.test(String(r.error)), '唤起失败时 ok=false 且带原始成因');
}
{
  actions.resetTerminalLaunchState();
  const r = await actions.requestTerminalLaunch('gh auth login', {
    authCheck: async () => ({ loggedIn: false }),
    pendingCheck: () => null,
    launcher: async () => { throw new Error('spawn 直接炸'); },
  });
  assert(r.ok === false && /spawn 直接炸/.test(String(r.error)), 'launcher 抛错也被兜成失败结果');
}

// ---- 10. 源码护栏：路由必须走受控唤起，客户端必须有连点保护 ----
console.log('\n--- 10. source guardrails ---');
{
  const routeSrc = readFileSync(new URL('../src/api/routes-actions.ts', import.meta.url), 'utf8');
  assert(routeSrc.includes('requestTerminalLaunch(command'), 'open_terminal 走 requestTerminalLaunch');
  assert(!/const launch = await launchTerminalAndWait\(command\)/.test(routeSrc), '旧的无条件唤起调用已移除');
  assert(routeSrc.includes('authCheck: () => executor.checkAuth(cwd)'), '认证态闸接的是 executor.checkAuth');
  assert(routeSrc.includes("force: payload.force === true"), 'force 逃生门透传到受控唤起');

  // 前端「认证引导卡」已随工作台移除；终端唤起的四道服务端防线（认证态闸 / 在途闸 /
  // 冷却闸 / 并发合并）仍由上面的注入式用例覆盖，这里不再断言已删除的 UI。
}

console.log(`\n${pass}/${total} 断言通过`);
if (fails.length) {
  console.error(`\n${fails.length} 个断言失败`);
  process.exit(1);
}
