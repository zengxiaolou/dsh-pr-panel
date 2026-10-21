// test/phase44.test.mjs - Phase 44 · 子代理会话的 PR 也收进「本会话提交的 PR」
//
// 现场（2026-10-21）：浮窗只显示主视图会话亲手建的 PR。发版这类活常被派给
// subagent，PR 写在子会话的转写里，主会话的浮窗因此永远看不见——用户以为插件漏统计。
//
// 修法：从会话转写头（`parentSession` / `origin:"subagent"` / `delegationDepth`）
// 还原会话血缘，把「主会话 + 全部子代理会话」的登记簿与转写一起合并，逐行标 origin。
//
// 钉住：
// 1. parseSessionHeaderLine：只认 type=session 且带 id 的头，其它一律 null。
// 2. listSessionDescendants：BFS 出子 / 孙，忽略无关会话，深度上限生效，头缓存只读一次盘。
// 3. /api/github/session-created-prs：主会话 PR 标 main，子代理 PR 标 subagent 并带 depth，
//    同一 repo#number 只留一行（主会话口径优先）。
// 4. lib/client.js：浮窗/面板行带「子代理」来源小标。
//
// 依赖：系统 zstd（与真实回填链路同一个依赖）。缺 zstd 时相关用例跳过而不是误报。

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'prp-phase44-'));
// 必须在动态 import 之前：session-pr-scan / session-lineage 的 sessions 根在运行时读 homedir
process.env.HOME = home;
process.env.USERPROFILE = home;

const hasZstd = (() => {
  try { execFileSync('zstd', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

let pass = 0;
let total = 0;
const fails = [];
function ok(cond, name) {
  total += 1;
  if (cond) pass += 1;
  else { fails.push(name); console.error('❌ ' + name); }
}

const SESSIONS = path.join(home, '.dsh', 'sessions');
const WS = '--Users-test-workspace--';

function header(id, extra = {}) {
  return { type: 'session', version: 4, id, createdAt: 1792590000000, cwd: '/Users/test/workspace', isSeeded: false, delegationDepth: 0, ...extra };
}

const callLine = (seq, time, callId, name, args) => JSON.stringify({
  type: 'tool/call', seq, time, data: { callId, name, arguments: typeof args === 'string' ? args : JSON.stringify(args) },
});
const resultLine = (seq, time, callId, text) => JSON.stringify({
  type: 'tool/result', seq, time, data: { toolCallId: callId, message: { role: 'tool', content: [{ type: 'text', text }] } },
});

/** 写一份真实形状的会话转写（zstd 压缩），返回文件路径 */
function writeTranscript(sessionId, headerRecord, lines = []) {
  const dir = path.join(SESSIONS, WS, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  if (!hasZstd) return path.join(dir, 'session.v4.jsonl.zstd');
  const raw = [JSON.stringify(headerRecord), ...lines].join('\n') + '\n';
  const src = path.join(dir, 'session.v4.jsonl');
  fs.writeFileSync(src, raw);
  const packed = execFileSync('zstd', ['-q', '-c', src], { maxBuffer: 64 * 1024 * 1024 });
  const dst = path.join(dir, 'session.v4.jsonl.zstd');
  fs.writeFileSync(dst, packed);
  fs.rmSync(src, { force: true });
  return dst;
}

const createdByGithubPr = (n, repo = 'acme/demo') => [
  callLine(1, 1000, 'c-' + n, 'github_pr', { action: 'create' }),
  resultLine(2, 1000 + n, 'c-' + n, `已创建 https://github.com/${repo}/pull/${n}`),
];
const createdByBash = (n, repo = 'acme/demo') => [
  callLine(3, 2000 + n, 'b-' + n, 'bash', { command: 'gh pr create --fill' }),
  resultLine(4, 2000 + n + 1, 'b-' + n, `https://github.com/${repo}/pull/${n}`),
];

/* ------------------------------------------------------------------ *
 * 一、头解析
 * ------------------------------------------------------------------ */
const { parseSessionHeaderLine, listSessionDescendants, __resetSessionLineageCache, __sessionLineageStats } =
  await import('../lib/session-lineage.js');

ok(parseSessionHeaderLine(JSON.stringify(header('session-root')))?.id === 'session-root', '正常会话头必须解析出 id');
ok(parseSessionHeaderLine('') === null && parseSessionHeaderLine('not json') === null, '空串/非 JSON 必须返回 null');
ok(parseSessionHeaderLine(JSON.stringify({ type: 'tool/call', id: 'x' })) === null, '非 session 类型的行不得当成头');
ok(parseSessionHeaderLine(JSON.stringify({ type: 'session' })) === null, '缺 id 的头必须被拒绝');
{
  const child = parseSessionHeaderLine(JSON.stringify(header('session-child', { parentSession: 'session-root', origin: 'subagent', delegationDepth: 2 })));
  ok(child?.parentSession === 'session-root' && child?.origin === 'subagent' && child?.delegationDepth === 2, '子代理头的三个血缘字段必须保留');
}

/* ------------------------------------------------------------------ *
 * 二、血缘 BFS（真实 zstd 转写）
 * ------------------------------------------------------------------ */
if (!hasZstd) {
  console.log('⚠️  系统没有 zstd：跳过血缘与路由的真实转写用例（与真实回填链路同一依赖）');
} else {
  const root = 'session-44-root';
  const childA = 'session-44-child-a';
  const childB = 'session-44-child-b';
  const grand = 'session-44-grand';
  const unrelated = 'session-44-unrelated';
  writeTranscript(root, header(root), createdByGithubPr(101));
  writeTranscript(childA, header(childA, { parentSession: root, origin: 'subagent', delegationDepth: 1 }), createdByBash(201));
  writeTranscript(childB, header(childB, { parentSession: root, origin: 'subagent', delegationDepth: 1 }), createdByBash(202));
  writeTranscript(grand, header(grand, { parentSession: childA, origin: 'subagent', delegationDepth: 2 }), createdByBash(301));
  writeTranscript(unrelated, header(unrelated), createdByBash(401));

  // 深链（验证深度上限）：session-44-d1 -> d2 -> d3 -> d4 -> d5 -> d6
  let prev = null;
  for (let i = 1; i <= 6; i += 1) {
    const id = `session-44-d${i}`;
    writeTranscript(id, header(id, prev
      ? { parentSession: prev, origin: 'subagent', delegationDepth: i }
      : {}));
    prev = id;
  }

  __resetSessionLineageCache();
  const tree = await listSessionDescendants(root);
  const ids = tree.map((e) => e.id);
  ok(ids.includes(childA) && ids.includes(childB) && ids.includes(grand), '主会话的直接子代理与孙代理都必须找到');
  ok(!ids.includes(unrelated), '没有 parentSession 的无关会话不得混入');
  ok(tree.find((e) => e.id === childA)?.depth === 1, '子代理 depth 必须为 1');
  ok(tree.find((e) => e.id === grand)?.depth === 2, '孙代理 depth 必须为 2');
  ok(tree.find((e) => e.id === grand)?.parentId === childA, '孙代理的 parentId 必须是它的直接父会话');
  ok(ids[0] === childA || ids[0] === childB, '浅层会话必须排在深层之前（主视图优先合并）');

  const spawnsAfterFirst = __sessionLineageStats().spawns;
  const again = await listSessionDescendants(root);
  ok(again.length === tree.length, '重复枚举的结果必须一致');
  ok(__sessionLineageStats().spawns === spawnsAfterFirst, '会话头必须缓存：第二次不得再 spawn zstd');
  ok(__sessionLineageStats().cacheHits > 0, '第二次命中缓存必须被计数');

  const deep = await listSessionDescendants('session-44-d1');
  ok(deep.length === 4, '默认深度上限 4：d1 只能看到 d2–d5（4 层）');
  const shallow = await listSessionDescendants('session-44-d1', { maxDepth: 2 });
  ok(shallow.length === 2, 'maxDepth=2 时只看两层');

  const missing = await listSessionDescendants('session-44-does-not-exist');
  ok(Array.isArray(missing) && missing.length === 0, '找不到根会话 → 空数组（不抛异常）');

  /* ---------------------------------------------------------------- *
   * 三、路由：主 + 子代理合并，逐行标 origin
   * ---------------------------------------------------------------- */
  const { registerApiRoutes } = await import('../lib/api/routes.js');
  const routes = new Map();
  const webServer = {
    exact: new Map(), prefixes: new Map(),
    register(route) {
      (route.kind === 'exact' ? this.exact : this.prefixes).set(route.path, route);
      routes.set(route.path, route);
      return () => { routes.delete(route.path); };
    },
  };
  const stubExec = { run: async () => ({ ok: false, error: 'gh 不可用（测试降级桩）' }) };
  // HOME 已经指向临时目录：快照与转写都落在沙箱里，不会污染真实数据
  registerApiRoutes({ webServer }, stubExec, undefined, 15_000);
  const route = routes.get('/api/github/session-created-prs');

  async function invoke(query) {
    let payload = '';
    const res = { statusCode: 0, setHeader() {}, end(chunk) { payload = chunk; } };
    await route.handler({ method: 'GET', url: '/api/github/session-created-prs' + query }, res);
    return { status: res.statusCode, body: payload ? JSON.parse(payload) : null };
  }

  const { __resetCreatedPrTracker } = await import('../lib/session-pr-tracker.js');
  __resetCreatedPrTracker();

  const answer = await invoke('?sessionId=' + encodeURIComponent(root) + '&refresh=1&lite=1');
  ok(answer.status === 200 && answer.body.ok, '血缘会话的列表请求必须 200');
  const items = answer.body.data.items || [];
  const byNumber = new Map(items.map((it) => [it.number, it]));
  ok(byNumber.has(101) && byNumber.has(201) && byNumber.has(202) && byNumber.has(301), '主会话、子代理、孙代理的 PR 都要在列表里');
  ok(!byNumber.has(401), '无关会话的 PR 不得混进来');
  ok(answer.body.data.descendants === 3, 'descendants 必须报出 3 个子代理会话（childA/childB/grand）');
  ok(byNumber.get(101).origin === 'main' && byNumber.get(101).depth === 0, '主会话亲手建的 PR 标 main / depth 0');
  ok(byNumber.get(201).origin === 'subagent' && byNumber.get(201).depth === 1, '子代理 PR 标 subagent / depth 1');
  ok(byNumber.get(301).origin === 'subagent' && byNumber.get(301).depth === 2, '孙代理 PR 标 subagent / depth 2');
  ok(byNumber.get(201).originSessionId === childA, '必须回传创建它的会话 id，便于排查/提示');
  ok(items.map((it) => it.number).join(',') === '301,202,201,101', '必须按创建时间倒序（最新在前）');

  // 同一 repo#number 出现在两棵树里：只留一行，且口径以主会话为准
  const dup = 'session-44-dup-root';
  const dupChild = 'session-44-dup-child';
  writeTranscript(dup, header(dup), createdByGithubPr(777));
  writeTranscript(dupChild, header(dupChild, { parentSession: dup, origin: 'subagent', delegationDepth: 1 }), createdByBash(777));
  const dupAnswer = await invoke('?sessionId=' + encodeURIComponent(dup) + '&refresh=1&lite=1');
  const dupItems = dupAnswer.body.data.items || [];
  ok(dupItems.length === 1, '同一 repo#number 在整棵树里只能有一行');
  ok(dupItems[0].origin === 'main', '重复时 origin 必须保持 main（主会话优先）');

  // 没有子代理的普通会话：口径与改造前一致
  const solo = 'session-44-solo';
  writeTranscript(solo, header(solo), createdByGithubPr(900));
  const soloAnswer = await invoke('?sessionId=' + encodeURIComponent(solo) + '&refresh=1&lite=1');
  ok(soloAnswer.body.data.descendants === 0, '没有子代理时 descendants=0');
  ok((soloAnswer.body.data.items || []).every((it) => it.origin === 'main'), '没有子代理时所有行都是 main');
}

/* ------------------------------------------------------------------ *
 * 四、客户端产物：来源小标
 * ------------------------------------------------------------------ */
const bundle = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
ok(bundle.includes('ghsp-origin'), '浮窗/面板必须带来源小标样式 .ghsp-origin');
ok(bundle.includes('子代理'), '界面必须出现「子代理」字样');
ok(bundle.includes('origin === "subagent"') || bundle.includes('origin !== "subagent"'), '来源判断必须按 origin=subagent');
ok(bundle.includes('originSessionId'), '提示里要能带出创建 PR 的子会话 id');

/* ------------------------------------------------------------------ *
 * 汇总
 * ------------------------------------------------------------------ */
fs.rmSync(home, { recursive: true, force: true });
console.log(`\nPhase 44: ${pass}/${total} 通过`);
if (fails.length > 0) {
  console.error('失败用例：\n- ' + fails.join('\n- '));
  process.exit(1);
}
console.log('🎉 Phase 44 全部通过');
