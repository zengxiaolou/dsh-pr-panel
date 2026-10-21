// test/phase27.test.mjs - Phase 27 · 「前置 / 后验守卫」回归套件
//
// 本阶段给两条 Host 路由加了「先读状态 → 执行 → 再读状态确认」的守卫，专治
// **假成功**：`gh pr merge` 在已合并 / 已关闭 / 不可合并的 PR 上只打印一行提示，
// 退出码仍然是 0；`gh api .../reviews` 在自己发起的 PR 上要等 GitHub 回 422，
// 用户只看到一句看不懂的报错。两者都不会抛异常，所以只能靠守卫兜住。
//
// 覆盖范围（全部落在编译产物上，不改 src/、不跑 build）：
// A. POST /api/github/pr-merge（lib/api/routes-actions.js:1126）
//    前置 `pr view --json state,mergeStateStatus,autoMergeRequest` → `pr merge`
//    → 后验 `pr view --json state,autoMergeRequest,mergedAt`。
//    A1 已合并 400 且**一次 merge 都不执行** / A2 已关闭 400 /
//    A3 本来没开自动合并却要关 → 400 / A4 退出码 0 但状态没变 → 502 点明
//    「操作没有生效」并回吐 gh 原文 / A5 真成功 200 / A6 auto 后置仍为 null → 502 /
//    A7 disable-auto 双向 / A8 快乐路径的 argv 顺序与次数（恰好 3 次 gh）。
// B. POST /api/github/pr-review-submit（同文件:1054）
//    守卫 `pr view --json state,author` + `api user`：已合并 400 且零 reviews /
//    自己的 PR 上 APPROVE、REQUEST_CHANGES → 400，COMMENT 放行 / 他人 PR 放行 /
//    守卫本身失败时 **fail-open**（不拦，仍然发评审）。
//
// 设计口径与 phase25 一致：假 webServer {exact,prefixes,register} + 桩执行器记录
// argv 副本；桩按 argv 分派答案（前置 / 后验两个 `pr view` 靠 --json 字段表区分），
// 绝不按调用序号硬编码。断言一律经 mergeArgv() / reviewArgv() / 计数helper 定位，
// 不写 execCalls[1] 这种绝对下标——加一条 gh 调用就会整体错位。
//
// 放宽说明（2 处，均因产物行为比任务书更细，断言未降级）：
// 1. A3 的 400 文案是「PR #128 本来就没有开启自动合并」，任务书只要求「400 +
//    没有 merge 调用」。这里断言 400 + 文案含「自动合并」+ mergeCount()===0，
//    比「含 disable-auto」更贴近产物（文案里没有 disable-auto 这个词）。
// 2. B2 的 REQUEST_CHANGES 必须带 body，否则路由会先被「请求修改必须填写说明」
//    挡在 400，用例会因错误的守卫而假绿。本套件带 body 发请求，并额外断言错误
//    文案含「自己发起」，证明 400 出自自审守卫而不是参数校验。
//    同理 A2/A1 断言文案含「已关闭」/「已合并」，避免与 repo/number 校验的 400 混淆。

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runTests() {
  console.log('🧪 开始执行 Phase 27 前置 / 后验守卫回归测试\n');
  let total = 0;
  let passed = 0;

  function test(name, fn) {
    total++;
    try {
      const ret = fn();
      // 防呆：async 函数交给同步 test() 时，断言会在统计之后才失败（表现为
      // 「全部通过 + 尾部 unhandled rejection」），排查成本极高，这里直接点名。
      if (ret && typeof ret.then === 'function') {
        throw new Error('同步 test() 收到了 async 函数，请改用 asyncTest()');
      }
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
  // 零、测试脚手架：假 webServer + 按 argv 分派的桩执行器 + 流式 req/res
  // ============================================================
  const { registerApiRoutes } = await import('../lib/api/routes.js');

  // 假的 webServer：exact/prefixes 两张表 + register 收集器，重复注册直接抛错。
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

  // 桩执行器：记录每次 argv（副本），答案由 scenario 决定。
  // 复制 argv 是必要的——handler 复用同一个数组字面量时，直接存引用会让断言自欺。
  let execCalls = [];

  // 一次用例要摆的「世界状态」。合并路由的**前置**与**后验**是两次 `pr view`，
  // 只有 --json 字段表不同；分派时按字段表区分，绝不按调用序号猜。
  function defaultScenario() {
    return {
      // 前置：state,mergeStateStatus,autoMergeRequest
      preView: { ok: true, data: { state: 'OPEN', mergeStateStatus: 'CLEAN', autoMergeRequest: null } },
      // 后验：state,autoMergeRequest,mergedAt（默认「合并真的生效了」）
      postView: { ok: true, data: { state: 'MERGED', autoMergeRequest: null, mergedAt: '2026-10-20T00:00:00Z' } },
      merge: { ok: true, rawOutput: '' },
      // 评审路由的前置：state,author
      guard: { ok: true, data: { state: 'OPEN', author: { login: 'someone-else' } } },
      user: { ok: true, data: { login: 'me' } },
      review: { ok: true, data: { id: 1 } },
    };
  }

  let scenario = defaultScenario();

  /** 按 argv 分派：这是本套件的核心，答案只取决于「问的是什么」，不取决于次数。 */
  function scenarioExec(args) {
    if (args[0] === 'pr' && args[1] === 'view') {
      const json = args[args.indexOf('--json') + 1] || '';
      // 合并路由的后验带 mergedAt；评审路由的守卫带 author；其余归前置。
      if (json.includes('author')) return scenario.guard;
      if (json.includes('mergedAt')) return scenario.postView;
      return scenario.preView;
    }
    if (args[0] === 'pr' && args[1] === 'merge') return scenario.merge;
    if (args[0] === 'api' && args[1] === 'user') return scenario.user;
    if (args[0] === 'api' && /\/pulls\/\d+\/reviews$/.test(String(args[1] || ''))) return scenario.review;
    return { ok: true, data: {} };
  }

  function resetExec() {
    execCalls = [];
    scenario = defaultScenario();
  }

  const stubExec = {
    async run(args, opts = {}) {
      execCalls.push({ args: Array.from(args), opts });
      return scenarioExec(Array.from(args));
    },
    resolveWorkspaceRepoRoot() {
      return null;
    },
  };

  registerApiRoutes({ webServer }, stubExec, undefined, 15_000);

  // ---- 定位 helper：只认「问的是什么」，不认下标 ----

  /** 所有 `pr view` 调用 */
  function viewCalls() {
    return execCalls.filter((c) => c.args[0] === 'pr' && c.args[1] === 'view');
  }
  /** 合并路由的前置 `pr view`（带 mergeStateStatus） */
  function preViewArgv() {
    const hit = viewCalls().find((c) => c.args.includes('--json') && String(c.args[c.args.indexOf('--json') + 1]).includes('mergeStateStatus'));
    return hit ? hit.args : null;
  }
  /** 合并路由的后验 `pr view`（带 mergedAt） */
  function postViewArgv() {
    const hit = viewCalls().find((c) => c.args.includes('--json') && String(c.args[c.args.indexOf('--json') + 1]).includes('mergedAt'));
    return hit ? hit.args : null;
  }
  /** 记录里真正的那条 `gh pr merge` argv（前置 / 后验的 pr view 不算） */
  function mergeArgv() {
    const hit = execCalls.find((c) => c.args[0] === 'pr' && c.args[1] === 'merge');
    return hit ? hit.args : null;
  }
  function mergeCount() {
    return execCalls.filter((c) => c.args[0] === 'pr' && c.args[1] === 'merge').length;
  }
  /** 记录里真正的那条 `gh api .../reviews` argv（守卫的 pr view / api user 不算） */
  function reviewArgv() {
    const hit = execCalls.find((c) => c.args[0] === 'api' && /\/pulls\/\d+\/reviews$/.test(String(c.args[1] || '')));
    return hit ? hit.args : null;
  }
  function reviewCount() {
    return execCalls.filter((c) => c.args[0] === 'api' && /\/pulls\/\d+\/reviews$/.test(String(c.args[1] || ''))).length;
  }
  /** `gh api user` 次数（自审守卫的第二跳） */
  function userCount() {
    return execCalls.filter((c) => c.args[0] === 'api' && c.args[1] === 'user').length;
  }
  /** 调用序列的骨相：`['pr view','pr merge','pr view']`，用于钉住顺序 */
  function callShape() {
    return execCalls.map((c) => `${c.args[0]} ${c.args[1]}`);
  }

  function makeRes() {
    const res = {
      statusCode: 0,
      headers: {},
      payload: '',
      setHeader(name, value) {
        this.headers[String(name).toLowerCase()] = value;
      },
      end(chunk) {
        this.payload = chunk === undefined ? '' : String(chunk);
      },
    };
    return res;
  }

  // 最小 req：handler 只依赖 url/method 与 on('data')/on('end')/on('error') 三件事。
  function makeReq({ url, method = 'POST' }) {
    const listeners = new Map();
    const req = {
      url,
      method,
      headers: {},
      on(event, fn) {
        if (!listeners.has(event)) listeners.set(event, []);
        listeners.get(event).push(fn);
        return req;
      },
      /** 按真实 Node 流的顺序投递：0..n 个 data chunk，随后恰好一个 end */
      feed(chunks) {
        for (const chunk of chunks || []) {
          for (const fn of listeners.get('data') || []) fn(chunk);
        }
        for (const fn of listeners.get('end') || []) fn();
      },
    };
    return req;
  }

  // 统一调用器：先同步启动 handler（它在首个 await 之前就把 data/end 监听挂好），
  // 再投递 body，最后等待 handler 完成。
  async function callRoute(handler, { url, method = 'POST', payload, chunks, raw } = {}) {
    const req = makeReq({ url, method });
    const res = makeRes();
    const pending = handler(req, res);
    if (Array.isArray(chunks)) {
      req.feed(chunks);
    } else if (raw !== undefined) {
      req.feed([raw]);
    } else if (payload !== undefined) {
      req.feed([JSON.stringify(payload)]);
    } else {
      req.feed([]);
    }
    await pending;
    let body = null;
    if (res.payload) {
      try {
        body = JSON.parse(res.payload);
      } catch {
        body = { __unparsable: res.payload };
      }
    }
    return { status: res.statusCode, body, headers: res.headers };
  }

  const mergeRoute = routes.get('/api/github/pr-merge');
  const reviewRoute = routes.get('/api/github/pr-review-submit');

  // 合法起点，守卫用例只在它上面改 scenario
  const validMerge = () => ({ repo: 'acme/demo', number: 128 });
  const validReview = (event = 'APPROVE') => ({ repo: 'acme/demo', number: 128, event });

  // ============================================================
  // 一、路由注册
  // ============================================================
  console.log('\n--- 1. 两条路由的注册形态 ---');

  test('pr-merge 与 pr-review-submit 均已注册在 exact 表上', () => {
    assert(mergeRoute, '/api/github/pr-merge 必须由 registerApiRoutes 注册');
    assert(reviewRoute, '/api/github/pr-review-submit 必须由 registerApiRoutes 注册');
    for (const [p, route] of [
      ['/api/github/pr-merge', mergeRoute],
      ['/api/github/pr-review-submit', reviewRoute],
    ]) {
      assert.strictEqual(route.kind, 'exact', `${p} 必须是 exact 路由`);
      assert.strictEqual(typeof route.handler, 'function', `${p} 必须有可调用 handler`);
      assert(webServer.exact.has(p), `${p} 必须落进 webServer.exact 路由表`);
      assert(!webServer.prefixes.has(p), `${p} 不得误注册为前缀路由`);
    }
  });

  // ============================================================
  // 二、pr-merge 前置守卫
  // ============================================================
  console.log('\n--- 2. pr-merge 前置守卫：状态不对就不许执行 merge ---');

  await asyncTest('A1 前置 view 返回 MERGED → 400「已合并」，且一次 merge 都不执行', async () => {
    resetExec();
    scenario.preView = { ok: true, data: { state: 'MERGED', mergeStateStatus: 'UNKNOWN', autoMergeRequest: null } };

    const { status, body } = await callRoute(mergeRoute.handler, { payload: { ...validMerge() } });

    assert.strictEqual(status, 400, '已合并的 PR 再合并必须 400，不能 200');
    assert.strictEqual(body.ok, false);
    assert(typeof body.error === 'string' && body.error.includes('已合并'), '错误必须点明「已合并」，用户才懂为什么没动静');
    assert.strictEqual(mergeCount(), 0, '前置守卫拦下时绝不能执行 gh pr merge（gh 会退出码 0 谎报成功）');
    // 桩只该看见那一次前置 view：没有 merge，也没有后验
    assert.strictEqual(execCalls.length, 1, `只允许 1 次 gh 调用（前置 view），实际 ${execCalls.length}`);
    assert.deepStrictEqual(
      preViewArgv(),
      ['pr', 'view', '128', '--repo', 'acme/demo', '--json', 'state,mergeStateStatus,autoMergeRequest'],
      '前置守卫的 argv 必须一字不差（字段表缺 autoMergeRequest 就判不出「本来开着」）',
    );
    assert.strictEqual(postViewArgv(), null, '被前置拦下时不得有后验 view');
  });

  await asyncTest('A2 前置 view 返回 CLOSED → 400，零 merge', async () => {
    resetExec();
    scenario.preView = { ok: true, data: { state: 'CLOSED', mergeStateStatus: 'UNKNOWN', autoMergeRequest: null } };

    const { status, body } = await callRoute(mergeRoute.handler, { payload: { ...validMerge() } });

    assert.strictEqual(status, 400, '已关闭的 PR 不能再合并');
    assert.strictEqual(body.ok, false);
    assert(typeof body.error === 'string' && body.error.includes('已关闭'), '错误必须点明「已关闭」（与 repo/number 校验的 400 区分开）');
    assert.strictEqual(mergeCount(), 0, '已关闭时绝不能执行 gh pr merge');
    assert.strictEqual(execCalls.length, 1, '只允许前置 view 一次');
  });

  await asyncTest('A3 action=disable-auto 但前置 autoMergeRequest 为 null → 400，零 merge', async () => {
    resetExec();
    scenario.preView = { ok: true, data: { state: 'OPEN', mergeStateStatus: 'CLEAN', autoMergeRequest: null } };

    const { status, body } = await callRoute(mergeRoute.handler, {
      payload: { ...validMerge(), action: 'disable-auto' },
    });

    assert.strictEqual(status, 400, '没有自动合并可关时必须 400，而不是「关了但其实是空转」');
    assert.strictEqual(body.ok, false);
    assert(typeof body.error === 'string' && body.error.includes('自动合并'), '错误必须点明自动合并这件事');
    assert.strictEqual(mergeCount(), 0, '无对象可关时绝不能执行 gh pr merge --disable-auto');
    assert.strictEqual(execCalls.length, 1, '只允许前置 view 一次');
  });

  await asyncTest('A4 假成功：merge 退出码 0 但后验仍 OPEN → 502「操作没有生效」并回吐 gh 原文', async () => {
    resetExec();
    scenario.preView = { ok: true, data: { state: 'OPEN', mergeStateStatus: 'BLOCKED', autoMergeRequest: null } };
    scenario.merge = { ok: true, rawOutput: 'Pull request is not mergeable' };
    // 后验仍是 OPEN：gh 打印了一行提示、退出码 0，什么都没发生
    scenario.postView = { ok: true, data: { state: 'OPEN', autoMergeRequest: null, mergedAt: null } };

    const { status, body } = await callRoute(mergeRoute.handler, { payload: { ...validMerge() } });

    assert.strictEqual(status, 502, 'gh 退出码 0 但效果为零，必须 502，绝不能 200');
    assert.strictEqual(body.ok, false);
    assert(typeof body.error === 'string' && body.error.includes('操作没有生效'), '错误必须点明「操作没有生效」，这是本守卫的全部意义');
    assert(body.error.includes('Pull request is not mergeable'), '必须把 gh 原文回吐出来，否则用户无从判断为什么不可合并');
    assert(body.error.includes('OPEN'), '必须带上后验观测到的实际状态');
    assert.strictEqual(mergeCount(), 1, 'merge 本身确实被尝试过一次（拦的是「谎报」，不是「不许尝试」）');
    assert.strictEqual(execCalls.length, 3, '前置 view + merge + 后验 view = 3 次 gh');
    assert.deepStrictEqual(
      postViewArgv(),
      ['pr', 'view', '128', '--repo', 'acme/demo', '--json', 'state,autoMergeRequest,mergedAt'],
      '后验 argv 必须一字不差',
    );
  });

  // ============================================================
  // 三、pr-merge 后验守卫（成功路径 + 三种动作的效果判定）
  // ============================================================
  console.log('\n--- 3. pr-merge 后验守卫：三种动作各自的效果判定 ---');

  await asyncTest('A5 真成功：前置 OPEN → merge ok → 后验 MERGED → 200 且回吐 state=MERGED', async () => {
    resetExec();
    const { status, body } = await callRoute(mergeRoute.handler, { payload: { ...validMerge() } });

    assert.strictEqual(status, 200, '效果确认后才 200');
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.data.state, 'MERGED', 'data.state 必须来自**后验**回读，而不是前置或假设值');
    assert.strictEqual(body.data.action, 'merge');
    assert.strictEqual(body.data.method, 'squash');
  });

  await asyncTest('A6 action=auto：后验 autoMergeRequest 仍为 null → 502 提及「自动合并仍未开启」；已置位 → 200', async () => {
    // 6a. 开了但没开上（仓库没启用分支保护是最常见的真实原因）
    resetExec();
    scenario.preView = { ok: true, data: { state: 'OPEN', mergeStateStatus: 'CLEAN', autoMergeRequest: null } };
    scenario.merge = { ok: true, rawOutput: 'Auto-merge is not allowed on this repository' };
    scenario.postView = { ok: true, data: { state: 'OPEN', autoMergeRequest: null, mergedAt: null } };

    const failed = await callRoute(mergeRoute.handler, { payload: { ...validMerge(), action: 'auto' } });
    assert.strictEqual(failed.status, 502, '自合并没开上必须 502');
    assert.strictEqual(failed.body.ok, false);
    assert(
      typeof failed.body.error === 'string' && failed.body.error.includes('自动合并仍未开启'),
      '错误必须点明「自动合并仍未开启」并提示常见原因，否则用户只会以为按钮坏了',
    );
    assert.strictEqual(mergeCount(), 1, 'auto 只执行一次 merge');
    assert.deepStrictEqual(
      mergeArgv(),
      ['pr', 'merge', '128', '--repo', 'acme/demo', '--auto', '--squash'],
      'auto 的 argv 必须带 --auto 与 method flag',
    );

    // 6b. 真的开上了
    resetExec();
    scenario.preView = { ok: true, data: { state: 'OPEN', mergeStateStatus: 'CLEAN', autoMergeRequest: null } };
    scenario.postView = { ok: true, data: { state: 'OPEN', autoMergeRequest: { enabledBy: { login: 'me' } }, mergedAt: null } };

    const ok = await callRoute(mergeRoute.handler, { payload: { ...validMerge(), action: 'auto' } });
    assert.strictEqual(ok.status, 200, '后验 autoMergeRequest 已置位 → 200');
    assert.strictEqual(ok.body.data.action, 'auto');
    assert(ok.body.data.message.includes('自动合并'), 'message 必须点明自动合并');
  });

  await asyncTest('A7 action=disable-auto：后验为 null → 200；后验仍置位 → 502', async () => {
    // 7a. 关掉了
    resetExec();
    scenario.preView = { ok: true, data: { state: 'OPEN', mergeStateStatus: 'CLEAN', autoMergeRequest: { enabledBy: { login: 'me' } } } };
    scenario.postView = { ok: true, data: { state: 'OPEN', autoMergeRequest: null, mergedAt: null } };

    const closed = await callRoute(mergeRoute.handler, { payload: { ...validMerge(), action: 'disable-auto' } });
    assert.strictEqual(closed.status, 200, '后验已关闭 → 200');
    assert.strictEqual(closed.body.data.action, 'disable-auto');
    assert.deepStrictEqual(mergeArgv(), ['pr', 'merge', '128', '--repo', 'acme/demo', '--disable-auto']);

    // 7b. 说关了其实没关
    resetExec();
    scenario.preView = { ok: true, data: { state: 'OPEN', mergeStateStatus: 'CLEAN', autoMergeRequest: { enabledBy: { login: 'me' } } } };
    scenario.postView = { ok: true, data: { state: 'OPEN', autoMergeRequest: { enabledBy: { login: 'me' } }, mergedAt: null } };

    const stuck = await callRoute(mergeRoute.handler, { payload: { ...validMerge(), action: 'disable-auto' } });
    assert.strictEqual(stuck.status, 502, '后验仍开着 → 必须 502');
    assert.strictEqual(stuck.body.ok, false);
    assert(
      typeof stuck.body.error === 'string' && stuck.body.error.includes('自动合并仍未关闭'),
      '错误必须点明「自动合并仍未关闭」',
    );
  });

  await asyncTest('A8 快乐路径的调用骨相：恰好 3 次 gh，顺序 view → merge → view，argv 逐元素相等', async () => {
    resetExec();
    const { status } = await callRoute(mergeRoute.handler, { payload: { ...validMerge() } });

    assert.strictEqual(status, 200);
    assert.strictEqual(execCalls.length, 3, `恰好 3 次 gh（前置 + merge + 后验），实际 ${execCalls.length}`);
    assert.strictEqual(mergeCount(), 1, 'merge 恰好一次');
    assert.deepStrictEqual(
      callShape(),
      ['pr view', 'pr merge', 'pr view'],
      '顺序必须是「先读状态 → 执行 → 再读状态」，后验跑到 merge 之前就等于没验',
    );
    assert.deepStrictEqual(
      mergeArgv(),
      ['pr', 'merge', '128', '--repo', 'acme/demo', '--squash'],
      'merge argv 逐元素相等',
    );
    // 前置与后验的 --json 字段表不同，各自锁死
    assert.deepStrictEqual(viewCalls()[0].args, [
      'pr',
      'view',
      '128',
      '--repo',
      'acme/demo',
      '--json',
      'state,mergeStateStatus,autoMergeRequest',
    ]);
    assert.deepStrictEqual(viewCalls()[1].args, [
      'pr',
      'view',
      '128',
      '--repo',
      'acme/demo',
      '--json',
      'state,autoMergeRequest,mergedAt',
    ]);
  });

  await asyncTest('前置 view 自身失败 → 502 fail-closed（与评审路由的 fail-open 相反）', async () => {
    resetExec();
    scenario.preView = { ok: false, error: 'network down' };

    const { status, body } = await callRoute(mergeRoute.handler, { payload: { ...validMerge() } });

    assert.strictEqual(status, 502, '读不到状态就不能合并——合并是不可逆的，这里必须 fail-closed');
    assert.strictEqual(body.ok, false);
    assert.strictEqual(body.error, 'network down', '必须透出前置失败的原因');
    assert.strictEqual(mergeCount(), 0, '状态未确认时绝不能执行 gh pr merge');
  });

  // ============================================================
  // 四、pr-review-submit 前置守卫
  // ============================================================
  console.log('\n--- 4. pr-review-submit 前置守卫：状态 / 自审 ---');

  await asyncTest('B1 守卫 view 返回 MERGED → 400「不能再提交评审」，零 /reviews 调用', async () => {
    resetExec();
    scenario.guard = { ok: true, data: { state: 'MERGED', author: { login: 'someone-else' } } };

    const { status, body } = await callRoute(reviewRoute.handler, { payload: { ...validReview('APPROVE') } });

    assert.strictEqual(status, 400, '已合并的 PR 不能再评审，必须 400');
    assert.strictEqual(body.ok, false);
    assert(
      typeof body.error === 'string' && body.error.includes('不能再提交评审'),
      '错误必须点明「不能再提交评审」，而不是把 GitHub 的 422 原样丢给用户',
    );
    assert.strictEqual(reviewCount(), 0, '守卫拦下时绝不能发 /reviews 请求');
    assert.strictEqual(userCount(), 0, '状态已否决，不必再问「我是谁」（省一次 gh api）');
    assert.deepStrictEqual(
      execCalls[0].args,
      ['pr', 'view', '128', '--repo', 'acme/demo', '--json', 'state,author'],
      '守卫 argv 必须一字不差',
    );
  });

  await asyncTest('B2 自己的 PR：APPROVE / REQUEST_CHANGES → 400；COMMENT → 放行 200', async () => {
    // 2a. 批准自己的 PR：GitHub 会回 422，提前拦
    resetExec();
    scenario.guard = { ok: true, data: { state: 'OPEN', author: { login: 'me' } } };
    const approveSelf = await callRoute(reviewRoute.handler, { payload: { ...validReview('APPROVE') } });
    assert.strictEqual(approveSelf.status, 400, '不能批准自己发起的 PR');
    assert.strictEqual(approveSelf.body.ok, false);
    assert(
      typeof approveSelf.body.error === 'string' && approveSelf.body.error.includes('不能批准或请求修改自己发起的 PR'),
      '错误必须点明「不能批准或请求修改自己发起的 PR」并给出替代路径',
    );
    assert.strictEqual(reviewCount(), 0, '自审被拦时绝不能发 /reviews');
    assert.strictEqual(userCount(), 1, '自审判定必须真的问过 gh api user（否则是拿空串瞎改）');

    // 2b. 请求修改自己的 PR：同样 400。带 body，否则会先被「必须填写说明」挡下而假绿。
    resetExec();
    scenario.guard = { ok: true, data: { state: 'OPEN', author: { login: 'me' } } };
    const changesSelf = await callRoute(reviewRoute.handler, {
      payload: { ...validReview('REQUEST_CHANGES'), body: '请修改一下' },
    });
    assert.strictEqual(changesSelf.status, 400, '不能请求修改自己发起的 PR');
    assert(
      typeof changesSelf.body.error === 'string' && changesSelf.body.error.includes('自己发起'),
      '错误必须出自自审守卫（含「自己发起」），而不是「请求修改必须填写说明」的参数校验',
    );
    assert.strictEqual(reviewCount(), 0, '自审被拦时绝不能发 /reviews');

    // 2c. 评论自己的 PR 是合法的，必须放行
    resetExec();
    scenario.guard = { ok: true, data: { state: 'OPEN', author: { login: 'me' } } };
    const commentSelf = await callRoute(reviewRoute.handler, {
      payload: { ...validReview('COMMENT'), body: '自己顶一下' },
    });
    assert.strictEqual(commentSelf.status, 200, 'COMMENT 不受自审限制，必须放行');
    assert.strictEqual(commentSelf.body.ok, true);
    assert.strictEqual(reviewCount(), 1, '刚好发一次 /reviews');
    assert.deepStrictEqual(
      reviewArgv(),
      [
        'api',
        'repos/acme/demo/pulls/128/reviews',
        '--method',
        'POST',
        '-f',
        'event=COMMENT',
        '-f',
        'body=自己顶一下',
      ],
      'COMMENT 的 argv 逐元素相等',
    );
  });

  await asyncTest('B3 守卫 author 是别人 → 正常放行，200 且一次 /reviews', async () => {
    resetExec();
    scenario.guard = { ok: true, data: { state: 'OPEN', author: { login: 'someone-else' } } };

    const { status, body } = await callRoute(reviewRoute.handler, { payload: { ...validReview('APPROVE') } });

    assert.strictEqual(status, 200, '给别人的 PR 批准必须放行');
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.data.event, 'APPROVE');
    assert.strictEqual(reviewCount(), 1, '刚好发一次 /reviews');
    assert.deepStrictEqual(
      reviewArgv(),
      ['api', 'repos/acme/demo/pulls/128/reviews', '--method', 'POST', '-f', 'event=APPROVE'],
      'APPROVE 的 argv 逐元素相等，且不带 body（空 body 不该塞 -f body=）',
    );
    assert.strictEqual(mergeCount(), 0, '评审路径不得误触 merge');
  });

  await asyncTest('B4 守卫 view 自身失败 → fail-open：不拦，仍然发一次 /reviews', async () => {
    resetExec();
    scenario.guard = { ok: false, error: 'gh: not authenticated' };

    const { status, body } = await callRoute(reviewRoute.handler, { payload: { ...validReview('APPROVE') } });

    assert.strictEqual(status, 200, '守卫只是「提前说清楚」，读不到状态时不得替用户否决操作（fail-open）');
    assert.strictEqual(body.ok, true);
    assert.strictEqual(reviewCount(), 1, '守卫失败也必须把评审发出去，否则一次网络抖动就变成功能不可用');
    assert.strictEqual(userCount(), 0, 'guard 未拿到 data 时不必再问 gh api user');
    assert.deepStrictEqual(
      reviewArgv(),
      ['api', 'repos/acme/demo/pulls/128/reviews', '--method', 'POST', '-f', 'event=APPROVE'],
      'fail-open 后的 argv 必须与正常路径一致',
    );
  });

  // ============================================================
  // 五、静态契约：守卫的输入字段表
  // ============================================================
  console.log('\n--- 5. 编译产物静态契约：守卫确实问了该问的字段 ---');

  const actionsSrc = fs.readFileSync(path.join(__dirname, '../lib/api/routes-actions.js'), 'utf8');

  // 按「整张字段表」精确比对，不用 includes：pr-detail 与 pr-list 的 --json 也含
  // mergeStateStatus / mergedAt，用子串匹配会把它们一起算进来（2 条命中），
  // 断言就退化成「某处出现过」，锁不住守卫本身。多行拼接的字段表同样被这条正则捕获。
  function jsonFieldLists() {
    return [...actionsSrc.matchAll(/'--json'\s*,\s*'([^']+)'/g)].map((m) => m[1]);
  }

  test('前置 view 的字段表恰为 state,mergeStateStatus,autoMergeRequest（唯一一条）', () => {
    // 「本来开着吗」只能从 autoMergeRequest 读；少了它，disable-auto 的前置判断恒为 false。
    const pre = jsonFieldLists().filter((l) => l === 'state,mergeStateStatus,autoMergeRequest');
    assert.strictEqual(pre.length, 1, `前置字段表必须恰好一条，实际 ${pre.length}`);
  });

  test('后验 view 的字段表恰为 state,autoMergeRequest,mergedAt（唯一一条）', () => {
    const post = jsonFieldLists().filter((l) => l === 'state,autoMergeRequest,mergedAt');
    assert.strictEqual(post.length, 1, `后验字段表必须恰好一条（含 mergedAt 证明确实落地），实际 ${post.length}`);
    assert(post[0].split(',').includes('autoMergeRequest'), '后验字段表必须含 autoMergeRequest（auto / disable-auto 的效果全靠它）');
  });

  test('评审守卫的 --json 恰为 state,author（唯一一条）', () => {
    const guard = jsonFieldLists().filter((l) => l === 'state,author');
    assert.strictEqual(guard.length, 1, `评审守卫字段表必须恰好一条 state,author，实际 ${guard.length}`);
  });

  console.log('\n========================================');
  console.log(`Phase 27 Test Result: ${passed}/${total} PASSED`);
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
