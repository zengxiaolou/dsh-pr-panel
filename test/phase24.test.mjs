// test/phase24.test.mjs - Phase 24 · 「PR 详情瘦身 / 独立 diff / 跨仓评审」三条新链路回归套件
//
// 覆盖本阶段新增的三处行为（全部落在 lib/api/routes-actions.js 的编译产物上）：
// 1. GET /api/github/pr-detail?withDiff=0：只要元数据，**不得**再顺带执行 `gh pr diff`。
//    大 PR 的 diff 会拖死详情面板（实测 75 文件要 30s），因此「少执行一条命令」本身就是契约；
//    同时保留默认路径（不带 withDiff / withDiff=1）仍执行 pr diff，证明老调用方零感知。
// 2. GET /api/github/pr-diff：独立的 diff 拉取端点。显式 repo 时不得解析工作区仓库
//    （否则同名 PR 编号会张冠李戴）；diff 失败 **在带内** 返回（200 + diffError），
//    因为前端把它当作「内容加载失败」渲染，而不是整页错误。
// 3. POST /api/github/pr-review-submit：跨仓评审（gh api REST）。校验矩阵 + argv 形状，
//    其中 body 上限必须与评论路由共用 64000 常量。
// 4. lib/client.js 产物：两栏布局（ghsp-cols/col-main/col-side）、目标分支徽章（ghsp-target）、
//    新端点接线，以及旧的分段 Tab 栏（ghsp-seg-btn / aria-selected）已从面板组件移除。
//
// 设计口径与 phase23 完全一致：桩执行器记录 argv、不发真请求；每个 400 用例额外断言
// exec 零调用，避免「先执行再校验」把非法输入带进 gh。
//
// 环境说明（relaxation）：
// - 工作区仓库解析由桩 executor.resolveWorkspaceRepoRoot 控制（返回 null），
//   因此「临时非 git 目录 → 400」是确定性的，不依赖本机是否恰好有最近活跃工作区。
// - 第 4 节对 ghsp-seg-btn 的断言做了收窄：整个 bundle 里该字符串仍以 **CSS 选择器**
//   形式残留 3 处（.ghsp-seg-btn / :hover / .active），要求「bundle 里完全不存在」不可达。
//   实际校验的是「JSX 里不再使用该 class」：所有出现都必须带前导 `.`（选择器），
//   且不再出现 `"ghsp-seg` 这样的 className 字面量、面板组件内不再出现 aria-selected。

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 评论 / 评审正文共用的上限（与 routes-actions.js 里的 MAX_COMMENT_CHARS 同源）
const MAX_COMMENT_CHARS = 64_000;

async function runTests() {
  console.log('🧪 开始执行 Phase 24 PR 详情 / diff / 跨仓评审回归测试\n');
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
  // 零、测试脚手架：假 webServer + 桩执行器 + 流式 req/res
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

  // 桩执行器：记录每次 argv（副本），返回值由当前用例通过 setExecResult 指定。
  // 复制 argv 是必要的——handler 复用同一个数组字面量时，直接存引用会让断言自欺。
  let execCalls = [];
  let execResult = { ok: true, data: {} };
  // 工作区仓库解析同样打桩：显式 repo 用例据此断言「一次都没调用」，
  // 回退用例则固定返回 null，让「未关联仓库 → 400」不依赖本机环境。
  let resolveCalls = [];
  let resolveResult = null;

  // 评审路由会先 `pr view --json state,author` + `api user` 做前置校验，
  // 默认桩必须把这两条答成「open 且作者不是我」，否则 happy path 会被误挡。
  function defaultExec(args) {
    if (args[0] === 'pr' && args[1] === 'view') return { ok: true, data: { state: 'OPEN', author: { login: 'someone-else' } } };
    if (args[0] === 'api' && args[1] === 'user') return { ok: true, data: { login: 'me' } };
    return { ok: true, data: {} };
  }
  function setExecResult(next) {
    execCalls = [];
    execResult = next;
  }
  function resetExec() {
    setExecResult(defaultExec);
    resolveCalls = [];
    resolveResult = null;
  }
  /** 真正那条 reviews 提交调用（前置的 pr view / api user 不算） */
  function reviewArgv() {
    const hit = execCalls.find((c) => c.args[0] === 'api' && String(c.args[1] || '').includes('/reviews'));
    return hit ? hit.args : null;
  }
  function reviewCount() {
    return execCalls.filter((c) => c.args[0] === 'api' && String(c.args[1] || '').includes('/reviews')).length;
  }
  function setResolveResult(next) {
    resolveCalls = [];
    resolveResult = next;
  }

  const stubExec = {
    async run(args, opts = {}) {
      execCalls.push({ args: Array.from(args), opts });
      return typeof execResult === 'function' ? execResult(args, opts) : execResult;
    },
    resolveWorkspaceRepoRoot(cwd) {
      resolveCalls.push(cwd);
      return resolveResult;
    },
  };

  registerApiRoutes({ webServer }, stubExec, undefined, 15_000);

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

  const detailRoute = routes.get('/api/github/pr-detail');
  const diffRoute = routes.get('/api/github/pr-diff');
  const reviewSubmitRoute = routes.get('/api/github/pr-review-submit');

  // 用于「非法 repo 回退到工作区解析」的临时非 git 目录（桩解析器对它固定返回 null）
  const tmpNonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghsp-phase24-'));

  // ============================================================
  // 一、GET /api/github/pr-detail（withDiff 瘦身）
  // ============================================================
  console.log('\n--- 1. /api/github/pr-detail 的 withDiff 契约 ---');

  test('路由已注册在 exact 表上，且 handler 为函数', () => {
    assert(detailRoute, '/api/github/pr-detail 必须由 registerApiRoutes 注册');
    assert.strictEqual(detailRoute.kind, 'exact', '必须是 exact 路由');
    assert.strictEqual(typeof detailRoute.handler, 'function', '必须有可调用 handler');
    assert(webServer.exact.has('/api/github/pr-detail'), '必须落进 webServer.exact 路由表');
    assert(webServer.registered.includes('/api/github/pr-detail'), 'register() 必须真实收到该路径');
  });

  await asyncTest('withDiff=0：只执行 pr view，不执行 pr diff，diff 为空且无 diffError', async () => {
    resetExec();
    setExecResult({ ok: true, data: { number: 128, title: 'demo' } });
    const { status, body } = await callRoute(detailRoute.handler, {
      url: `/api/github/pr-detail?number=128&repo=${encodeURIComponent('acme/demo')}&withDiff=0`,
      method: 'GET',
    });

    assert.strictEqual(status, 200, '合法请求必须 200');
    assert.strictEqual(body.ok, true);
    assert.strictEqual(execCalls.length, 1, 'withDiff=0 必须只执行一次 gh（元数据），不得顺带拉 diff');
    assert.deepStrictEqual(execCalls[0].args.slice(0, 2), ['pr', 'view'], '唯一调用必须是 gh pr view');
    assert(!execCalls.some((c) => c.args[0] === 'pr' && c.args[1] === 'diff'), 'withDiff=0 不得出现 pr diff argv');

    assert.strictEqual(body.data.diff, '', '跳过 diff 时 diff 必须是空串（前端据此显示占位）');
    assert.strictEqual(body.data.diffError, undefined, '主动跳过 diff 不是错误，diffError 必须缺省');
    assert.strictEqual(body.data.diffTruncated, false, '未拉取时不得标记为截断');
    assert.strictEqual(body.data.repo, 'acme/demo', '回吐显式 repo');
    assert.strictEqual(body.data.repoRoot, null, '显式 repo 时不得回吐工作区仓库根');
  });

  await asyncTest('默认路径（不带 withDiff）：pr view 之后再执行一次 pr diff', async () => {
    resetExec();
    setExecResult((args) =>
      args[1] === 'diff' ? { ok: true, rawOutput: 'diff --git a/x b/x\n' } : { ok: true, data: { number: 128 } },
    );
    const { status, body } = await callRoute(detailRoute.handler, {
      url: `/api/github/pr-detail?number=128&repo=${encodeURIComponent('acme/demo')}`,
      method: 'GET',
    });

    assert.strictEqual(status, 200);
    assert.strictEqual(execCalls.length, 2, '默认路径必须执行两次 gh（view + diff），老调用方零感知');
    assert.deepStrictEqual(execCalls[0].args.slice(0, 2), ['pr', 'view'], '第一条必须是 pr view');
    assert.deepStrictEqual(execCalls[1].args, ['pr', 'diff', '128', '--repo', 'acme/demo'], '第二条必须是 pr diff');
    assert(body.data.diff.includes('diff --git'), '默认路径必须把 diff 原样回吐');
    assert.strictEqual(body.data.diffError, undefined, '成功时不得有 diffError');
  });

  await asyncTest('withDiff=1：显式要求 diff 时同样执行 pr diff（不得被 =0 判定误伤）', async () => {
    resetExec();
    setExecResult((args) =>
      args[1] === 'diff' ? { ok: true, rawOutput: 'diff --git a/y b/y\n' } : { ok: true, data: { number: 9 } },
    );
    const { status, body } = await callRoute(detailRoute.handler, {
      url: `/api/github/pr-detail?number=9&repo=${encodeURIComponent('acme/demo')}&withDiff=1`,
      method: 'GET',
    });

    assert.strictEqual(status, 200);
    assert.strictEqual(execCalls.length, 2, 'withDiff=1 必须保留 diff 拉取');
    assert.deepStrictEqual(execCalls[1].args, ['pr', 'diff', '9', '--repo', 'acme/demo']);
    assert(body.data.diff.includes('diff --git'), '必须回吐 diff');
  });

  resetExec();

  // ============================================================
  // 二、GET /api/github/pr-diff（独立 diff 端点）
  // ============================================================
  console.log('\n--- 2. /api/github/pr-diff 路由契约 ---');

  test('路由已注册在 exact 表上，且 handler 为函数', () => {
    assert(diffRoute, '/api/github/pr-diff 必须由 registerApiRoutes 注册');
    assert.strictEqual(diffRoute.kind, 'exact', '必须是 exact 路由');
    assert.strictEqual(typeof diffRoute.handler, 'function', '必须有可调用 handler');
    assert(webServer.exact.has('/api/github/pr-diff'), '必须落进 webServer.exact 路由表');
    assert(!webServer.prefixes.has('/api/github/pr-diff'), '不得误注册为前缀路由');
    assert(webServer.registered.includes('/api/github/pr-diff'), 'register() 必须真实收到该路径');
  });

  await asyncTest('POST → 405，且不执行任何 gh 命令', async () => {
    resetExec();
    const { status, body } = await callRoute(diffRoute.handler, {
      url: `/api/github/pr-diff?number=128&repo=${encodeURIComponent('acme/demo')}`,
      method: 'POST',
    });
    assert.strictEqual(status, 405, '只读 diff 端点必须拒绝 POST');
    assert.strictEqual(body.ok, false);
    assert(typeof body.message === 'string' && body.message.includes('GET'), '错误信息必须点明仅支持 GET');
    assert.strictEqual(execCalls.length, 0, '405 必须在触达 gh 之前返回');
  });

  await asyncTest('缺少 / 非法 number → 400，且 exec 零调用', async () => {
    resetExec();
    for (const badNumber of [undefined, '', 0, -1, 1.5, 'abc']) {
      const qs = badNumber === undefined ? 'repo=acme/demo' : `number=${encodeURIComponent(String(badNumber))}&repo=acme/demo`;
      const { status, body } = await callRoute(diffRoute.handler, {
        url: `/api/github/pr-diff?${qs}`,
        method: 'GET',
      });
      assert.strictEqual(status, 400, `number=${JSON.stringify(badNumber)} 必须 400`);
      assert.strictEqual(body.ok, false);
      assert(typeof body.error === 'string' && body.error.includes('number'), '错误必须点明 number');
    }
    assert.strictEqual(execCalls.length, 0, '校验失败时绝不能先执行 gh');
  });

  await asyncTest('显式 repo：argv 带 --repo，且完全不解析工作区仓库（无 cwd 也不 400）', async () => {
    resetExec();
    setExecResult({ ok: true, rawOutput: 'diff --git a/x b/x\n' });
    const { status, body } = await callRoute(diffRoute.handler, {
      // 故意不传 cwd：显式 repo 场景下 gh 只在 process.cwd() 里跑，工作区仓库无关
      url: `/api/github/pr-diff?number=128&repo=${encodeURIComponent('acme/demo')}`,
      method: 'GET',
    });

    assert.strictEqual(status, 200, '显式 repo 时不得因「未关联工作区」而 400');
    assert.strictEqual(resolveCalls.length, 0, '显式 repo 时不得调用 resolveWorkspaceRepoRoot（同名编号会张冠李戴）');
    assert.strictEqual(execCalls.length, 1, '只执行一次 gh pr diff');
    assert.deepStrictEqual(execCalls[0].args, ['pr', 'diff', '128', '--repo', 'acme/demo'], 'argv 必须逐元素相等');
    assert.strictEqual(execCalls[0].opts.rawText, true, 'diff 必须走 rawText（不得尝试 JSON.parse）');
    assert(body.data.number, '回吐 number');
    assert.strictEqual(body.data.repo, 'acme/demo', '回吐显式 repo');
    assert.strictEqual(body.data.diffError, undefined, '成功时不得有 diffError');
  });

  await asyncTest("非法 repo（'acme' / '-x/y'）回退工作区解析：临时非 git 目录下不是 200+diff", async () => {
    resetExec();
    setResolveResult(null); // 桩：临时目录解析不到仓库根
    for (const badRepo of ['acme', '-x/y']) {
      setResolveResult(null);
      setExecResult({ ok: true, rawOutput: 'diff --git a/x b/x\n' });
      execCalls = [];
      const { status, body } = await callRoute(diffRoute.handler, {
        url: `/api/github/pr-diff?number=128&repo=${encodeURIComponent(badRepo)}&cwd=${encodeURIComponent(tmpNonGitDir)}`,
        method: 'GET',
      });
      // 环境容忍：这里只要求「不是 200 + 真 diff」；桩固定返回 null，因此实际为 400。
      assert(
        status === 400 || status === 502,
        `repo=${JSON.stringify(badRepo)} 必须回退工作区解析并失败（400/502），实际 ${status}`,
      );
      assert(!(status === 200 && body?.data?.diff), `repo=${JSON.stringify(badRepo)} 不得返回 200 + diff`);
      assert(resolveCalls.length > 0, '非法 repo 必须回退到工作区仓库解析');
      if (status === 400) {
        assert(typeof body.error === 'string' && body.error.includes('工作区'), '400 必须点明未关联工作区');
      }
      assert.strictEqual(execCalls.length, 0, '解析失败时绝不能先执行 gh');
    }
  });

  await asyncTest('成功：桩返回 rawOutput → 200 且 data.diff 含 diff --git', async () => {
    resetExec();
    setExecResult({ ok: true, rawOutput: 'diff --git a/x b/x\n' });
    const { status, body } = await callRoute(diffRoute.handler, {
      url: `/api/github/pr-diff?number=128&repo=${encodeURIComponent('acme/demo')}`,
      method: 'GET',
    });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.ok, true);
    assert(typeof body.data.diff === 'string' && body.data.diff.includes('diff --git'), '必须回吐 diff 文本');
    assert.strictEqual(body.data.diffError, undefined, '成功时不得有 diffError');
    assert.strictEqual(body.data.diffTruncated, false, '未截断时必须为 false');
  });

  await asyncTest('失败：{ok:false,error} → 仍 200，但 diff 为空且 diffError 有值（带内报错）', async () => {
    resetExec();
    setExecResult({ ok: false, error: 'boom' });
    const { status, body } = await callRoute(diffRoute.handler, {
      url: `/api/github/pr-diff?number=128&repo=${encodeURIComponent('acme/demo')}`,
      method: 'GET',
    });
    assert.strictEqual(status, 200, 'diff 失败必须在带内上报（前端按内容错误渲染），不得整页 502');
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.data.diff, '', '失败时 diff 必须是空串');
    assert(body.data.diffError, 'diffError 必须有值');
    assert.strictEqual(body.data.diffError, 'boom', '必须透出 gh 的原始 error');
  });

  resetExec();

  // ============================================================
  // 三、POST /api/github/pr-review-submit（跨仓评审）
  // ============================================================
  console.log('\n--- 3. /api/github/pr-review-submit 路由契约 ---');

  test('路由已注册在 exact 表上，且 handler 为函数', () => {
    assert(reviewSubmitRoute, '/api/github/pr-review-submit 必须由 registerApiRoutes 注册');
    assert.strictEqual(reviewSubmitRoute.kind, 'exact', '必须是 exact 路由');
    assert.strictEqual(typeof reviewSubmitRoute.handler, 'function', '必须有可调用 handler');
    assert(webServer.exact.has('/api/github/pr-review-submit'), '必须落进 webServer.exact 路由表');
    assert(!webServer.prefixes.has('/api/github/pr-review-submit'), '不得误注册为前缀路由');
    assert(webServer.registered.includes('/api/github/pr-review-submit'), 'register() 必须真实收到该路径');
  });

  // 合法起点，非法用例只在它上面改一个字段
  const validReview = () => ({ repo: 'acme/demo', number: 128, event: 'APPROVE' });

  await asyncTest('GET → 405，且不执行任何 gh 命令', async () => {
    resetExec();
    const { status, body } = await callRoute(reviewSubmitRoute.handler, {
      url: '/api/github/pr-review-submit',
      method: 'GET',
    });
    assert.strictEqual(status, 405, '写路由必须拒绝 GET');
    assert.strictEqual(body.ok, false);
    assert(typeof body.message === 'string' && body.message.includes('POST'), '错误信息必须点明仅支持 POST');
    assert.strictEqual(execCalls.length, 0, '405 必须在触达 gh 之前返回');
  });

  await asyncTest('repo 非法（无斜杠 / 段首为 - / 空串 / 三段）→ 400，且 exec 零调用', async () => {
    resetExec();
    for (const badRepo of ['acme', '-bad/repo', '', '   ', 'acme/', '/acme', 'acme/demo/extra', 'acme/de mo']) {
      const { status, body } = await callRoute(reviewSubmitRoute.handler, {
        payload: { ...validReview(), repo: badRepo },
      });
      assert.strictEqual(status, 400, `repo=${JSON.stringify(badRepo)} 必须 400`);
      assert.strictEqual(body.ok, false);
      assert(typeof body.error === 'string' && body.error.includes('repo'), '错误必须点明 repo');
    }
    assert.strictEqual(execCalls.length, 0, '校验失败时绝不能先执行 gh');
  });

  await asyncTest('number 非法（0 / 负数 / 小数 / 非数字）→ 400，且 exec 零调用', async () => {
    resetExec();
    for (const badNumber of [0, -1, 1.5, 'abc', undefined, null, '']) {
      const { status } = await callRoute(reviewSubmitRoute.handler, {
        payload: { ...validReview(), number: badNumber },
      });
      assert.strictEqual(status, 400, `number=${JSON.stringify(badNumber)} 必须 400`);
    }
    assert.strictEqual(execCalls.length, 0, '校验失败时绝不能先执行 gh');
  });

  await asyncTest('event 非法（LGTM / 空 / 拼错）→ 400，且 exec 零调用', async () => {
    resetExec();
    for (const badEvent of ['LGTM', '', undefined, 'APPROVED', 'REQUEST_CHANGE']) {
      const { status, body } = await callRoute(reviewSubmitRoute.handler, {
        payload: { ...validReview(), event: badEvent },
      });
      assert.strictEqual(status, 400, `event=${JSON.stringify(badEvent)} 必须 400`);
      assert(typeof body.error === 'string' && body.error.includes('评审类型'), '错误必须点明评审类型');
    }
    assert.strictEqual(execCalls.length, 0, '校验失败时绝不能先执行 gh');
  });

  await asyncTest('REQUEST_CHANGES 无正文（空 / 纯空白）→ 400，且 exec 零调用', async () => {
    resetExec();
    for (const badBody of ['', '   ', '\n\t ', undefined]) {
      const { status, body } = await callRoute(reviewSubmitRoute.handler, {
        payload: { ...validReview(), event: 'REQUEST_CHANGES', body: badBody },
      });
      assert.strictEqual(status, 400, `body=${JSON.stringify(badBody)} 必须 400（请求修改必须说明原因）`);
      assert(typeof body.error === 'string' && body.error.includes('说明'), '错误必须点明需要说明');
    }
    assert.strictEqual(execCalls.length, 0, '校验失败时绝不能先执行 gh');
  });

  await asyncTest('正文超上限（64001）→ 400 且点明 64000；恰好 64000 放行', async () => {
    resetExec();
    const tooLong = await callRoute(reviewSubmitRoute.handler, {
      payload: { ...validReview(), body: 'a'.repeat(MAX_COMMENT_CHARS + 1) },
    });
    assert.strictEqual(tooLong.status, 400, '超上限必须 400');
    assert(
      tooLong.body.error.includes(String(MAX_COMMENT_CHARS)),
      '错误信息必须点明上限 64000，便于前端截断',
    );
    assert.strictEqual(execCalls.length, 0, '超限时绝不能先执行 gh');

    resetExec();
    const atLimit = await callRoute(reviewSubmitRoute.handler, {
      payload: { ...validReview(), body: 'a'.repeat(MAX_COMMENT_CHARS) },
    });
    assert.strictEqual(atLimit.status, 200, '恰好等于上限属于合法（> 才是超限）');
    assert.strictEqual(reviewCount(), 1, '合法请求必须执行一次 reviews 提交');
    assert.strictEqual(execCalls.length, 3, '前置状态 + 前置身份 + 提交，共 3 次 gh');
    assert(reviewArgv().includes(`body=${'a'.repeat(MAX_COMMENT_CHARS)}`), 'argv 里的 body 必须原样保留长度');
  });

  await asyncTest('happy path（无正文）：argv 逐元素相等，证明未做 shell 字符串拼接', async () => {
    resetExec();
    const { status, body } = await callRoute(reviewSubmitRoute.handler, {
      payload: { ...validReview() },
    });

    assert.strictEqual(status, 200, '合法请求必须 200');
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.data.repo, 'acme/demo', '回吐 repo');
    assert.strictEqual(body.data.number, 128, '回吐 number');
    assert.strictEqual(body.data.event, 'APPROVE', '回吐 event');
    assert.strictEqual(reviewCount(), 1, '只执行一次 reviews 提交');
    assert.strictEqual(execCalls.length, 3, '前置状态 + 前置身份 + 提交，共 3 次 gh');
    assert.deepStrictEqual(reviewArgv(), [
      'api',
      'repos/acme/demo/pulls/128/reviews',
      '--method',
      'POST',
      '-f',
      'event=APPROVE',
    ]);
  });

  await asyncTest('happy path（带正文）：追加 -f body=...，且正文是单个 argv 元素', async () => {
    resetExec();
    const reviewBody = '实现没问题，但请补一个边界用例';
    const { status } = await callRoute(reviewSubmitRoute.handler, {
      payload: { ...validReview(), body: reviewBody },
    });

    assert.strictEqual(status, 200);
    assert.strictEqual(reviewCount(), 1);
    assert.strictEqual(execCalls.length, 3);
    assert.deepStrictEqual(reviewArgv(), [
      'api',
      'repos/acme/demo/pulls/128/reviews',
      '--method',
      'POST',
      '-f',
      'event=APPROVE',
      '-f',
      `body=${reviewBody}`,
    ]);
    assert.strictEqual(reviewArgv()[7], `body=${reviewBody}`, '正文必须整体作为单个 argv 元素');
  });

  await asyncTest('COMMENT 事件无正文也放行（评论不强制说明）', async () => {
    resetExec();
    const { status } = await callRoute(reviewSubmitRoute.handler, {
      payload: { ...validReview(), event: 'COMMENT' },
    });
    assert.strictEqual(status, 200);
    assert(reviewArgv().includes('event=COMMENT'), 'event 必须原样透传');
  });

  await asyncTest('gh 返回 { ok:false, error } → 502 并原样透出该 error', async () => {
    setExecResult({ ok: false, error: 'boom' });
    const { status, body } = await callRoute(reviewSubmitRoute.handler, {
      payload: { ...validReview() },
    });
    assert.strictEqual(status, 502, '上游失败必须是 502 而不是 200');
    assert.strictEqual(body.ok, false);
    assert.strictEqual(body.error, 'boom', '必须把 gh 的 error 原样透出，便于前端展示');
  });

  await asyncTest('畸形 JSON body → 400（按缺字段处理，不得 500 崩）', async () => {
    resetExec();
    const { status } = await callRoute(reviewSubmitRoute.handler, {
      url: '/api/github/pr-review-submit',
      raw: '{"repo":"acme/demo", 坏掉了',
    });
    assert.strictEqual(status, 400, '畸形 JSON 必须降级为 400');
    assert.strictEqual(execCalls.length, 0, '畸形请求绝不能触达 gh');
  });

  resetExec();

  // ============================================================
  // 四、lib/client.js 产物静态契约
  // ============================================================
  console.log('\n--- 4. lib/client.js 产物静态契约 ---');

  const clientBundle = fs.readFileSync(path.join(__dirname, '../lib/client.js'), 'utf8');
  // 面板自身所在的打包段：跨段断言容易把别的组件的 aria-selected 算进来
  const panelStart = clientBundle.indexOf('// ---- [Bundled: session-pr-panel.js] ----');
  const panelEnd = clientBundle.indexOf('// ---- [End: session-pr-panel.js] ----');
  const panelSrc =
    panelStart >= 0 && panelEnd > panelStart ? clientBundle.slice(panelStart, panelEnd) : clientBundle;

  test('session-pr-panel 打包段可定位（避免整段断言退化成全局搜字符串）', () => {
    assert(panelStart > 0, 'client.js 必须含 session-pr-panel 的打包段标记');
    assert(panelEnd > panelStart, '必须有下一个打包段作为结束边界');
    assert(panelSrc.includes('ghsp-cols'), '面板段必须包含两栏布局');
  });

  test('两栏布局类名齐全：ghsp-cols / ghsp-col-main / ghsp-col-side', () => {
    for (const cls of ['ghsp-cols', 'ghsp-col-main', 'ghsp-col-side']) {
      assert(panelSrc.includes(cls), `client.js 面板段必须包含 ${cls}`);
    }
    assert(panelSrc.includes('className: "ghsp-cols"'), '必须有真实的 JSX 使用点，而不只是 CSS 定义');
    assert(panelSrc.includes('className: "ghsp-col-main"'), '主栏必须有 JSX 使用点');
    assert(panelSrc.includes('className: "ghsp-col-side"'), '侧栏必须有 JSX 使用点');
  });

  test('目标分支徽章：ghsp-target 使用 + .ghsp-target.main 配色映射', () => {
    assert(panelSrc.includes('ghsp-target'), 'client.js 面板段必须包含 ghsp-target');
    // 使用点必须由 targetTone 决定色调，否则 main/release/test 会是同一颗灰徽章
    assert(
      /className:\s*"ghsp-target "\s*\+\s*targetTone\(/.test(panelSrc),
      'ghsp-target 的色调必须由 targetTone(base) 决定',
    );
    assert(/\.ghsp-target\.main\s*\{/.test(panelSrc), '必须有 .ghsp-target.main 的 CSS 规则');
    assert(/'main'|"main"/.test(panelSrc), 'targetTone 必须识别 main 分支');
  });

  test('新端点已接线：pr-diff 与 pr-review-submit', () => {
    assert(panelSrc.includes('/api/github/pr-diff'), '面板必须调用 /api/github/pr-diff');
    assert(panelSrc.includes('/api/github/pr-review-submit'), '面板必须调用 /api/github/pr-review-submit');
    // diff 请求必须带 number，否则路由侧直接 400
    assert(/\/api\/github\/pr-diff\?number=/.test(panelSrc), 'pr-diff 请求必须带 number 参数');
    // 评审提交必须 POST JSON
    assert(
      /postJson\(\s*"\/api\/github\/pr-review-submit"/.test(panelSrc),
      'pr-review-submit 必须走 POST JSON',
    );
  });

  test('旧分段 Tab 栏彻底移除：ghsp-seg* 与 aria-selected 都不再出现', () => {
    // 死样式也清了（2026-10-20 收尾）：CSS 选择器、className 字面量、aria-selected 一并断言不存在。
    assert(!panelSrc.includes('ghsp-seg'), '面板段不得再出现 ghsp-seg*（JSX 与 CSS 都不允许）');
    assert(!panelSrc.includes('aria-selected'), '面板组件不得再输出 aria-selected');
  });

  test('v4：diff 懒加载闸门 + 骨架屏 + 失败检查高亮', () => {
    // 不点「加载 diff」就不发请求：闸门变量与按钮文案都要在
    assert(panelSrc.includes('wantDiff'), '必须有 diff 懒加载的开关状态');
    assert(panelSrc.includes('加载 diff'), '必须有「加载 diff」入口');
    assert(panelSrc.includes('ghsp-skel-row'), '拉取中必须给骨架行，而不是空白');
    assert(panelSrc.includes('ghsp-check') && panelSrc.includes('ghsp-checks-summary'), '检查卡片必须有汇总行');
    // 失败检查要高亮（CSS 里也得有对应规则）
    assert(/\.ghsp-check\.fail/.test(clientBundle), '失败检查必须有高亮样式');
    assert(panelSrc.includes('"ghsp-check" + (st.tone === "fail" ? " fail" : "")'), '失败检查必须加上 fail 类');
  });

  test('面板正文改用两栏而非 Tab 页：ghsp-cols 是面板 body 的直接子节点', () => {
    // 旧实现是「分段按钮 + 互斥 hidden 页」，新实现是同屏两栏；用同一条 JSX 行锁住结构。
    assert(
      /className:\s*"ghsp-cols"\s*\}\s*,\s*React\.createElement\("main",\s*\{\s*className:\s*"ghsp-col-main"/.test(panelSrc),
      'ghsp-cols 必须直接包含 main.ghsp-col-main',
    );
    // v4 起侧栏承载的是三张卡片（检查/评审/操作），卡片由 cardBlock() 统一包壳
    assert(
      /className:\s*"ghsp-col-side"\s*\}[\s\S]{0,200}checksCard/.test(panelSrc),
      '侧栏必须承载 checksCard（检查/评审/操作区）',
    );
    assert(panelSrc.includes('ghsp-card-block'), 'v4 的每个分区都必须包在卡片壳里');
  });

  // 收尾：清理临时目录（失败也不影响测试结论）
  try {
    fs.rmSync(tmpNonGitDir, { recursive: true, force: true });
  } catch {
    /* 临时目录清理失败不影响断言结果 */
  }

  console.log('\n========================================');
  console.log(`Phase 24 Test Result: ${passed}/${total} PASSED`);
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
