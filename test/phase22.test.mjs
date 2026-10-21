// test/phase22.test.mjs - Phase 22 · 「本会话新建的 PR」专项回归测试套件
//
// 覆盖本次改造的四条链路（与「对话里出现过的 PR」严格划清口径）：
// 1. session-pr-tracker：进程内登记簿（parsePrUrl 容错、repo#number 去重、最新在前）；
// 2. session-pr-scan：纯函数转写扫描——只认 create（github_pr create / github_api POST /pulls /
//    bash gh pr create），view/review/merge/comment 与 dry_run 一律不算，去重保序；
// 3. /api/github/session-created-prs 路由：缺 sessionId → 400；未知会话 → 200 空列表 + reason；
//    登记过的会话 → 200 并回吐该 PR（gh 取不到元数据时容忍 missing: true）；
// 4. lib/client.js 产物：浮窗入口存在、全局 cockpit 注册已移除、factory 内无裸 export。
//
// 环境依赖说明：路由的元数据补全走真实 gh。断网/未登录时不作为失败——只校验
// repo + number + 200 这三个与网络无关的事实；gh 命令另加 2.5s 上限，防止断网
// 把整个套件拖到 20s 以上。

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runTests() {
  console.log('🧪 开始执行 Phase 22 会话新建 PR 专项回归测试\n');
  let total = 0;
  let passed = 0;

  function test(name, fn) {
    total++;
    try {
      fn();
      passed++;
      console.log(`✅ PASS: ${name}`);
    } catch (e) {
      console.error(`❌ FAIL: ${name}`);
      console.error(e);
    }
  }

  async function asyncTest(name, fn) {
    total++;
    try {
      await fn();
      passed++;
      console.log(`✅ PASS: ${name}`);
    } catch (e) {
      console.error(`❌ FAIL: ${name}`);
      console.error(e);
    }
  }

  // ============================================================
  // 一、登记簿：parsePrUrl 容错 + 去重 + 最新在前
  // ============================================================
  console.log('\n--- 1. Session PR Tracker (parse / dedupe / ordering) ---');

  const {
    parsePrUrl,
    recordCreatedPr,
    listSessionCreatedPrs,
    __resetCreatedPrTracker,
  } = await import('../lib/session-pr-tracker.js');

  test('parsePrUrl 精确拆出 owner/repo 与 PR 编号', () => {
    assert.deepStrictEqual(parsePrUrl('https://github.com/acme/demo/pull/128'), { repo: 'acme/demo', number: 128 });
    assert.deepStrictEqual(parsePrUrl('https://github.com/acme/demo/pull/9?diff=split'), { repo: 'acme/demo', number: 9 });
    assert.deepStrictEqual(parsePrUrl('http://github.com/org-name/repo.name/pull/7'), { repo: 'org-name/repo.name', number: 7 });
    assert.deepStrictEqual(parsePrUrl('看这个 https://github.com/a/b/pull/3 谢谢'), { repo: 'a/b', number: 3 });
  });

  test('parsePrUrl 对垃圾输入一律返回 null，绝不臆造 PR', () => {
    for (const bad of [
      '',
      'not a url',
      'https://github.com/acme/demo/issues/5',
      'https://gitlab.com/acme/demo/pull/1',
      'https://github.com/acme/demo/pull/0',
      'https://github.com/acme/demo/pull/abc',
      'https://github.com/acme/demo/pull/',
      null,
      undefined,
      42,
      {},
    ]) {
      assert.strictEqual(parsePrUrl(bad), null, `应忽略非法输入: ${String(bad)}`);
    }
  });

  test('recordCreatedPr 拒绝空会话 id 与垃圾 URL（返回 null 且不落库）', () => {
    __resetCreatedPrTracker();
    assert.strictEqual(recordCreatedPr('', 'https://github.com/acme/demo/pull/1'), null, '空会话 id 不登记');
    assert.strictEqual(recordCreatedPr('   ', 'https://github.com/acme/demo/pull/1'), null, '纯空白会话 id 不登记');
    assert.strictEqual(recordCreatedPr('sess-x', 'https://github.com/acme/demo/issues/2'), null, 'issue 链接不登记');
    assert.strictEqual(recordCreatedPr('sess-x', 'garbage'), null, '垃圾 URL 不登记');
    assert.deepStrictEqual(listSessionCreatedPrs('sess-x'), [], '被拒绝的登记不得留下任何行');
    __resetCreatedPrTracker();
  });

  test('recordCreatedPr 按 repo#number 去重：同一 PR 重复登记只有一行', () => {
    __resetCreatedPrTracker();
    const first = recordCreatedPr('sess-dup', 'https://github.com/acme/demo/pull/128');
    const second = recordCreatedPr('sess-dup', 'https://github.com/acme/demo/pull/128');
    assert(first && second, '两次登记都应成功返回行');
    const rows = listSessionCreatedPrs('sess-dup');
    assert.strictEqual(rows.length, 1, '同一 repo#number 只保留一行');
    assert.strictEqual(rows[0].repo, 'acme/demo');
    assert.strictEqual(rows[0].number, 128);
    assert.strictEqual(rows[0].via, 'tool', '途经标记默认 tool');

    // 大小写不同的同一 PR 仍视为重复
    recordCreatedPr('sess-dup', 'https://github.com/ACME/Demo/pull/128');
    assert.strictEqual(listSessionCreatedPrs('sess-dup').length, 1, 'repo 大小写差异不得产生第二行');
    __resetCreatedPrTracker();
  });

  await asyncTest('listSessionCreatedPrs 最新在前，且会话之间互不串台', async () => {
    __resetCreatedPrTracker();
    recordCreatedPr('sess-order', 'https://github.com/acme/demo/pull/1', 'tool');
    await sleep(8);
    recordCreatedPr('sess-order', 'https://github.com/acme/demo/pull/2', 'bash');
    await sleep(8);
    recordCreatedPr('sess-order', 'https://github.com/acme/demo/pull/3', 'api');
    recordCreatedPr('sess-other', 'https://github.com/acme/demo/pull/99');

    const rows = listSessionCreatedPrs('sess-order');
    assert.deepStrictEqual(rows.map((r) => r.number), [3, 2, 1], '必须按登记时间倒序（最新在前）');
    assert.deepStrictEqual(rows.map((r) => r.via), ['api', 'bash', 'tool'], '途经标记随登记来源保留');

    const other = listSessionCreatedPrs('sess-other');
    assert.deepStrictEqual(other.map((r) => r.number), [99], '不同会话只看到自己的 PR');
    assert.deepStrictEqual(listSessionCreatedPrs('sess-unregistered'), [], '未登记的会话返回空数组');
    __resetCreatedPrTracker();
  });

  test('__resetCreatedPrTracker 彻底清空登记簿', () => {
    recordCreatedPr('sess-reset', 'https://github.com/acme/demo/pull/5');
    assert.strictEqual(listSessionCreatedPrs('sess-reset').length, 1);
    __resetCreatedPrTracker();
    assert.strictEqual(listSessionCreatedPrs('sess-reset').length, 0, 'reset 后不得残留任何行');
  });

  // ============================================================
  // 二、纯函数转写扫描：只认「新建」，去重保序
  // ============================================================
  console.log('\n--- 2. scanCreatedPrsFromTranscript (create-only 口径) ---');

  const { scanCreatedPrsFromTranscript, readSessionCreatedPrs } = await import('../lib/session-pr-scan.js');

  // 转写行构造器：与 DSH session.v4.jsonl 的真实形状逐字段对齐
  const callLine = (seq, time, callId, name, args) => JSON.stringify({
    type: 'tool/call',
    seq,
    time,
    data: { callId, name, arguments: typeof args === 'string' ? args : JSON.stringify(args) },
  });
  const resultLine = (seq, time, callId, text) => JSON.stringify({
    type: 'tool/result',
    seq,
    time,
    data: { toolCallId: callId, message: { role: 'tool', content: [{ type: 'text', text }] } },
  });
  const transcript = (...lines) => lines.join('\n');

  test('github_pr create 的 tool/result 里出现 PR 链接 → 认定为新建', () => {
    const refs = scanCreatedPrsFromTranscript(transcript(
      callLine(1, 1000, 'a', 'github_pr', { action: 'create' }),
      resultLine(2, 1100, 'a', '已创建 https://github.com/acme/demo/pull/128'),
    ));
    assert.strictEqual(refs.length, 1, '应扫出 1 条新建 PR');
    assert.strictEqual(refs[0].repo, 'acme/demo');
    assert.strictEqual(refs[0].number, 128);
    assert.strictEqual(refs[0].via, 'tool', 'github_pr 来源标记为 tool');
  });

  test('github_pr 的 view / review / merge / comment 一律不算新建', () => {
    for (const action of ['view', 'review', 'merge', 'comment', 'list']) {
      const refs = scanCreatedPrsFromTranscript(transcript(
        callLine(1, 1000, 'a', 'github_pr', { action }),
        resultLine(2, 1100, 'a', 'https://github.com/acme/demo/pull/128'),
      ));
      assert.deepStrictEqual(refs, [], `action=${action} 不得被当成新建`);
    }
  });

  test('dry_run: true 的 create 不算新建（预演没有产生 PR）', () => {
    const asObject = scanCreatedPrsFromTranscript(transcript(
      callLine(1, 1000, 'a', 'github_pr', { action: 'create', dry_run: true }),
      resultLine(2, 1100, 'a', 'would create https://github.com/acme/demo/pull/128'),
    ));
    assert.deepStrictEqual(asObject, [], 'dry_run 为布尔 true 时必须排除');

    const asString = scanCreatedPrsFromTranscript(transcript(
      callLine(1, 1000, 'a', 'github_pr', '{"action":"create","dry_run":true}'),
      resultLine(2, 1100, 'a', 'https://github.com/acme/demo/pull/129'),
    ));
    assert.deepStrictEqual(asString, [], 'arguments 为原始 JSON 字符串时同样排除');
  });

  test('bash 命令含 gh pr create → 认定新建；gh pr list 不算', () => {
    const created = scanCreatedPrsFromTranscript(transcript(
      callLine(1, 1000, 'b', 'bash', { command: 'gh pr create --title "feat: x" --body "y"' }),
      resultLine(2, 1200, 'b', 'https://github.com/acme/demo/pull/130'),
    ));
    assert.strictEqual(created.length, 1, 'gh pr create 应扫出 1 条');
    assert.strictEqual(created[0].number, 130);
    assert.strictEqual(created[0].via, 'bash', 'bash 来源标记为 bash');

    const listed = scanCreatedPrsFromTranscript(transcript(
      callLine(1, 1000, 'c', 'bash', { command: 'gh pr list --state all' }),
      resultLine(2, 1200, 'c', 'https://github.com/acme/demo/pull/130'),
    ));
    assert.deepStrictEqual(listed, [], 'gh pr list 不得被当成新建');
  });

  test('github_api POST 到 /pulls → 认定新建；到 /pulls/<n> 或 GET 不算', () => {
    const created = scanCreatedPrsFromTranscript(transcript(
      callLine(1, 1000, 'd', 'github_api', { method: 'POST', endpoint: 'repos/acme/demo/pulls' }),
      resultLine(2, 1300, 'd', '{"html_url":"https://github.com/acme/demo/pull/131"}'),
    ));
    assert.strictEqual(created.length, 1, 'POST /pulls 应扫出 1 条');
    assert.strictEqual(created[0].via, 'api', 'github_api 来源标记为 api');

    const subPath = scanCreatedPrsFromTranscript(transcript(
      callLine(1, 1000, 'e', 'github_api', { method: 'POST', endpoint: 'repos/acme/demo/pulls/131/reviews' }),
      resultLine(2, 1300, 'e', 'https://github.com/acme/demo/pull/131'),
    ));
    assert.deepStrictEqual(subPath, [], '/pulls/<n>/… 属于子资源，不得算新建');

    const getPull = scanCreatedPrsFromTranscript(transcript(
      callLine(1, 1000, 'f', 'github_api', { method: 'GET', endpoint: 'repos/acme/demo/pulls' }),
      resultLine(2, 1300, 'f', 'https://github.com/acme/demo/pull/131'),
    ));
    assert.deepStrictEqual(getPull, [], 'GET /pulls 是列举，不得算新建');
  });

  test('callId 不匹配的 result 不得被借用（结果必须归属创建调用）', () => {
    const refs = scanCreatedPrsFromTranscript(transcript(
      callLine(1, 1000, 'create-1', 'github_pr', { action: 'create' }),
      resultLine(2, 1100, 'other-call', 'https://github.com/acme/demo/pull/132'),
    ));
    assert.deepStrictEqual(refs, [], '不同 callId 的 result 必须忽略');

    const noCall = scanCreatedPrsFromTranscript(transcript(
      resultLine(2, 1100, 'ghost', 'https://github.com/acme/demo/pull/132'),
    ));
    assert.deepStrictEqual(noCall, [], '没有对应 tool/call 的孤立 result 必须忽略');
  });

  test('重复的同一 PR 去重且保持首次出现顺序', () => {
    const refs = scanCreatedPrsFromTranscript(transcript(
      callLine(1, 1000, 'a', 'github_pr', { action: 'create' }),
      resultLine(2, 1100, 'a', 'https://github.com/acme/demo/pull/140'),
      callLine(3, 2000, 'b', 'bash', { command: 'gh pr create --fill' }),
      resultLine(4, 2100, 'b', 'https://github.com/acme/demo/pull/140'),
      callLine(5, 3000, 'c', 'github_api', { method: 'POST', endpoint: 'repos/acme/demo/pulls' }),
      resultLine(6, 3100, 'c', 'https://github.com/acme/demo/pull/141'),
    ));
    assert.deepStrictEqual(refs.map((r) => r.number), [140, 141], '去重保序：140 只出现一次且在前');
    assert.strictEqual(refs[0].via, 'tool', '去重保留首次出现的来源');
  });

  test('单次 result 中多条 PR 链接全部收下；非 PR 链接忽略', () => {
    const refs = scanCreatedPrsFromTranscript(transcript(
      callLine(1, 1000, 'a', 'bash', { command: 'gh pr create && gh pr create' }),
      resultLine(2, 1100, 'a', [
        'https://github.com/acme/demo/pull/150',
        'https://github.com/acme/demo/pull/151',
        'https://github.com/acme/demo/issues/152',
        'https://example.com/acme/demo/pull/153',
      ].join('\n')),
    ));
    assert.deepStrictEqual(refs.map((r) => r.number), [150, 151], '两条 PR 都收，issue/非 github 域名忽略');
  });

  test('容错：空文本、非 JSON 行、content 为纯字符串、shell 别名均安全处理', () => {
    assert.deepStrictEqual(scanCreatedPrsFromTranscript(''), [], '空文本返回空数组');
    assert.deepStrictEqual(scanCreatedPrsFromTranscript(null), [], 'null 返回空数组');
    assert.deepStrictEqual(scanCreatedPrsFromTranscript(undefined), [], 'undefined 返回空数组');
    assert.deepStrictEqual(scanCreatedPrsFromTranscript('这不是 JSON\n{"type":"tool/call", 坏掉了}'), [], '非 JSON 行安全跳过');

    // message.content 直接是字符串（个别 transcript 版本如此）
    const stringContent = scanCreatedPrsFromTranscript([
      callLine(1, 1000, 'a', 'github_pr', { action: 'create' }),
      JSON.stringify({ type: 'tool/result', seq: 2, time: 1100, data: { toolCallId: 'a', message: { role: 'tool', content: 'https://github.com/acme/demo/pull/160' } } }),
    ].join('\n'));
    assert.deepStrictEqual(stringContent.map((r) => r.number), [160], 'content 为字符串时同样能扫出链接');

    // shell 别名等价于 bash
    const shellAlias = scanCreatedPrsFromTranscript(transcript(
      callLine(1, 1000, 's', 'shell', { script: 'gh pr create --fill' }),
      resultLine(2, 1100, 's', 'https://github.com/acme/demo/pull/161'),
    ));
    assert.deepStrictEqual(shellAlias.map((r) => r.number), [161], 'shell 别名与 bash 同口径');
  });

  // readSessionCreatedPrs 是异步的（同步 inflate 会按住 Host 事件循环，见 session-pr-scan.ts）
  await asyncTest('readSessionCreatedPrs 对不存在的会话安全降级（空 refs + 原因说明）', async () => {
    const result = await readSessionCreatedPrs('session-that-does-not-exist-phase22', { force: true });
    assert(Array.isArray(result.refs), 'refs 必须是数组');
    assert.strictEqual(result.refs.length, 0, '不存在的会话不得返回任何 refs');
    assert.strictEqual(result.transcript, null, '找不到转写文件时 transcript 为 null');
    assert(typeof result.reason === 'string' && result.reason.length > 0, '必须给出可读的 reason，便于前端提示');
  });

  // ============================================================
  // 三、HTTP 路由：注册 + 400 + 未知会话 200 空列表 + 登记会话 200
  // ============================================================
  console.log('\n--- 3. /api/github/session-created-prs 路由契约 ---');

  const { registerApiRoutes } = await import('../lib/api/routes.js');
  const { GhExecutor } = await import('../lib/executor.js');

  // 假的 webServer：exact/prefixes 两张表 + register 收集器，重复注册直接抛错
  // （与宿主真实 WebServer 的 duplicate route 行为一致，便于暴露注册冲突）。
  function makeFakeWebServer() {
    const routes = new Map();
    const webServer = {
      exact: new Map(),
      prefixes: new Map(),
      registered: [],
      register(route) {
        const table = route.kind === 'exact' ? this.exact : this.prefixes;
        if (table.has(route.path)) {
          throw new Error(`duplicate route: ${route.kind} ${route.path}`);
        }
        table.set(route.path, route);
        routes.set(route.path, route);
        this.registered.push(route.path);
        return () => {
          table.delete(route.path);
          routes.delete(route.path);
        };
      },
    };
    return { webServer, routes };
  }

  const { webServer, routes } = makeFakeWebServer();

  // gh 是否可用（未登录/离线时降级为桩执行器，但仍校验与网络无关的事实）
  let ghReady = false;
  try {
    execFileSync('gh', ['auth', 'status'], { stdio: 'ignore', timeout: 5000 });
    ghReady = true;
  } catch {
    ghReady = false;
  }

  const realExec = new GhExecutor();
  // 元数据补全只在快路径上跑：给 gh 加 2.5s 上限，断网时不会把套件拖到 20s 以上
  const boundedExec = {
    run: (args, opts = {}) => realExec.run(args, { ...opts, timeoutMs: Math.min(opts.timeoutMs || 2500, 2500) }),
  };
  const stubExec = {
    run: async () => ({ ok: false, error: 'gh 不可用（测试降级桩）' }),
  };
  const routeExec = ghReady ? boundedExec : stubExec;
  console.log(`   环境探针：gh auth status ${ghReady ? '可用（真实元数据）' : '不可用（降级为桩，跳过元数据断言）'}`);

  registerApiRoutes({ webServer }, routeExec, undefined, 15_000);

  const targetRoute = routes.get('/api/github/session-created-prs');

  async function invoke(handler, { url, method = 'GET' }) {
    const res = {
      statusCode: 0,
      setHeader() {},
      end() {},
    };
    let payload = '';
    res.end = (chunk) => { payload = chunk; };
    await handler({ method, url }, res);
    return { status: res.statusCode, body: payload ? JSON.parse(payload) : null };
  }

  test('路由已注册在 exact 表上，且 handler 为函数', () => {
    assert(targetRoute, '/api/github/session-created-prs 必须由 registerApiRoutes 注册');
    assert.strictEqual(targetRoute.kind, 'exact', '必须是 exact 路由（带 query 的 GET）');
    assert.strictEqual(typeof targetRoute.handler, 'function', '必须有可调用 handler');
    assert(webServer.exact.has('/api/github/session-created-prs'), '必须落进 webServer.exact 路由表');
    assert(!webServer.prefixes.has('/api/github/session-created-prs'), '不得误注册为前缀路由');
    assert(webServer.registered.includes('/api/github/session-created-prs'), 'register() 必须真实收到该路径');
  });

  await asyncTest('缺少 sessionId → 400，且给出可读错误', async () => {
    const { status, body } = await invoke(targetRoute.handler, { url: '/api/github/session-created-prs' });
    assert.strictEqual(status, 400, '缺 sessionId 必须 400');
    assert.strictEqual(body.ok, false, 'ok 必须为 false');
    assert(typeof body.error === 'string' && body.error.includes('sessionId'), '错误信息必须点明缺少 sessionId');

    const blank = await invoke(targetRoute.handler, { url: '/api/github/session-created-prs?sessionId=%20%20' });
    assert.strictEqual(blank.status, 400, '纯空白 sessionId 同样视为缺失（400）');
  });

  await asyncTest('未知 sessionId → 200 且 items: []，并附 reason 说明', async () => {
    const { status, body } = await invoke(targetRoute.handler, {
      url: '/api/github/session-created-prs?sessionId=session-that-does-not-exist-phase22',
    });
    assert.strictEqual(status, 200, '未知会话不是错误，必须 200');
    assert.strictEqual(body.ok, true, 'ok 必须为 true');
    assert(Array.isArray(body.data.items), 'data.items 必须是数组');
    assert.strictEqual(body.data.items.length, 0, '未知会话不得凭空返回 PR');
    assert.strictEqual(body.data.total, 0, 'total 应为 0');
    assert(typeof body.data.reason === 'string' && body.data.reason.length > 0, '必须附 reason（前端据此提示）');
    assert.strictEqual(body.data.sessionId, 'session-that-does-not-exist-phase22', '回显请求的 sessionId');
  });

  await asyncTest('登记过的会话 → 200 并回吐该 PR（repo + number 必须正确，元数据缺失容忍）', async () => {
    __resetCreatedPrTracker();
    const sessionId = 'sess-phase22-route';
    const recorded = recordCreatedPr(sessionId, 'https://github.com/acme/demo/pull/128', 'tool');
    assert(recorded, '登记必须成功');

    try {
      const { status, body } = await invoke(targetRoute.handler, {
        url: `/api/github/session-created-prs?sessionId=${encodeURIComponent(sessionId)}`,
      });
      assert.strictEqual(status, 200, '登记过的会话必须 200');
      assert.strictEqual(body.ok, true);
      assert.strictEqual(body.data.items.length, 1, '必须回吐 1 条刚登记的 PR');
      const item = body.data.items[0];
      assert.strictEqual(item.repo, 'acme/demo', 'repo 必须原样透出');
      assert.strictEqual(item.number, 128, 'number 必须原样透出');
      assert.strictEqual(item.url, 'https://github.com/acme/demo/pull/128', 'gh 取不到元数据时回退到标准 PR 链接');
      assert.strictEqual(typeof item.missing, 'boolean', 'missing 标记必须存在（前端据此降级绘制）');
      assert.strictEqual(item.via, 'tool', 'via 途经标记必须透出');
      if (ghReady) {
        // gh 可用时只断言「字段齐全」，具体取值允许 UNKNOWN（仓库可能不存在/无权限）
        assert(typeof item.title === 'string' && item.title.length > 0, 'gh 可用时 title 必须有兜底值');
        assert(typeof item.state === 'string' && item.state.length > 0, 'gh 可用时 state 必须有兜底值');
        assert(item.checks && typeof item.checks.state === 'string', 'CI 归约必须始终是三态对象');
      } else {
        assert.strictEqual(item.missing, true, 'gh 不可用时必须显式标记 missing: true');
      }
    } finally {
      __resetCreatedPrTracker();
    }
  });

  await asyncTest('非 GET 方法 → 405，且不回吐任何数据', async () => {
    const { status, body } = await invoke(targetRoute.handler, {
      url: '/api/github/session-created-prs?sessionId=sess-phase22-route',
      method: 'POST',
    });
    assert.strictEqual(status, 405, '写方法必须被拒绝');
    assert.strictEqual(body.ok, false);
    assert(!('items' in body), '405 响应不得夹带 items');
  });

  // ============================================================
  // 四、客户端产物自检：浮窗入口在、全局 cockpit 入口已拆、无裸 export
  // ============================================================
  console.log('\n--- 4. lib/client.js 自包含产物断言 ---');

  const bundle = fs.readFileSync(path.join(__dirname, '../lib/client.js'), 'utf8');

  test('Bundle 包含会话 PR 浮窗的三条关键标识', () => {
    assert(bundle.includes('session-created-prs'), '必须请求 /api/github/session-created-prs');
    assert(bundle.includes('ghsp-overlay'), '必须包含 ghsp-overlay 浮窗容器样式');
    assert(bundle.includes('github-pr'), '必须包含 github-pr 右列 tab 类型');
  });

  test('全局 cockpit 入口已移除：无 main/github slot 注册、无 sidebar.panellist', () => {
    assert(!bundle.includes('slots.register({ name: "main", key: "github"'), '不得恢复全局 main 槽位注册（入口已改成浮窗）');
    assert(!bundle.includes('sidebar.panellist'), '不得再注册 sidebar.panellist 面板');
    assert(bundle.includes('shell.overlay'), '替代入口必须是 shell.overlay 浮窗');
    assert(bundle.includes('github-session-pr'), '浮窗 slot id 必须是 github-session-pr');
  });

  test('Bundle 是经典脚本产物：无裸 export 语句（factory 内必须走 exports.*）', () => {
    assert(!/^\s*export\s/m.test(bundle), '不得出现裸 export 语句（构建已剥除）');
    assert(bundle.includes('exports.apply'), '导出必须挂在 exports 对象上');
  });

  console.log('\n========================================');
  console.log(`Phase 22 Test Result: ${passed}/${total} PASSED`);
  console.log('========================================');

  if (passed !== total) {
    console.error(`\n❌ ${total - passed} 项断言失败`);
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
