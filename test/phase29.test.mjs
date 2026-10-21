// test/phase29.test.mjs - Phase 29 · 「合并方式探测 / 多行行内评论 / 面板增补」回归套件
//
// 本阶段三块新能力，全部落在**编译产物**上（不改 src/、不跑 build、不重启）：
//
// A. GET /api/github/repo-merge-methods?repo=owner/name（lib/api/routes-actions.js）
//    GitHub 只在**仓库对象**上给 allow_squash_merge / allow_merge_commit /
//    allow_rebase_merge，PR 对象上没有这三个字段。面板据此过滤合并方式下拉，
//    免得用户选一个必然被 405/422 拒绝的方式。语义口径是 `!== false`：
//    **字段缺失 ≠ 禁止**（企业版/旧 API 不回该字段时不能把功能锁死）。
//    另外带 5 分钟缓存（同一仓库连续两次请求只跑一次 gh），失败**不**入缓存。
//
// B. POST /api/github/pr-inline-comment 多行评论（同文件）
//    GitHub 用 start_line + line 表示一个区间，且要求 start_line < line；
//    gh api 的参数形态是 `-F start_line=N -f start_side=RIGHT`（注意 start_line
//    用 -F 走数字类型，start_side 用 -f 走字符串）。单行评论必须**一字不变**。
//
// C. lib/client.js 的面板段（session-pr-panel 与 sync-settings-modal 两个 bundle
//    标记之间）：diff 分段展开、Shift 区间选择、合并方式过滤、以及 routes-actions
//    里 createdPrMetaCache 的有界 LRU。这些都是纯前端/纯静态契约，用源码切片断言
//    而不是跑 DOM——phase28 已经从「渲染后行为」角度验过 diff 懒加载，本阶段补的是
//    「产物里到底有没有这些标识」这层，两者互补而非重复。
//
// 设计口径与 phase27 一致：假 webServer {exact,prefixes,register} + 按 **argv 分派**
// 的桩执行器（绝不按调用序号猜），argv 断言一律 deepStrictEqual 到逐元素。
// 缓存/计数类断言只看 execCalls 条数，不看下标。
//
// 放宽说明（1 处，因产物行为比任务书描述更细，断言未降级）：
// 1. B1 任务书写「start_line / start_side 紧跟在单行参数之后，且 line 仍是**最后一个**
//    参数」。产物实际是先把单行参数（… -F line=N -f commit_id=SHA）拼完，再整体
//    push('-F', start_line, '-f', start_side)，所以 line 后面还有 commit_id 与
//    start_line/start_side 三个参数——它不是最后一项。
//    这里改为更强的等价断言：argv === 单行基线 **逐元素相等的前缀** + 恰好
//    ['-F', 'start_line=N', '-f', 'start_side=SIDE'] 的**严格后缀**；另外单独钉
//    「line= 在整条 argv 里只出现一次且值不变」「start_line 值 < line 值」。
//    这样既锁住「多行字段是追加的、不重排也不重复单行参数」，也锁住了区间语义。

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runTests() {
  console.log('🧪 开始执行 Phase 29 合并方式 / 多行评论 / 面板增补回归测试\n');
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
        this.registered.push(route.path);
        return () => {
          table.delete(route.path);
        };
      },
    };
    return { webServer };
  }

  const { webServer } = makeFakeWebServer();

  // 桩执行器：记录每次 argv（副本），答案由 scenario 决定。
  let execCalls = [];

  // 一次用例要摆的「世界状态」。
  // repo    → 仓库设置（allow_*_merge 三个开关）
  // inline  → 行内评论 REST 的返回
  function defaultScenario() {
    return {
      // 默认：squash 开、merge 关、rebase 开（任务书 A3 的那份）
      repo: { ok: true, data: { allow_squash_merge: true, allow_merge_commit: false, allow_rebase_merge: true } },
      inline: { ok: true, data: { id: 1 } },
    };
  }

  let scenario = defaultScenario();

  /** 按 argv 分派：答案只取决于「问的是什么端点」，不取决于第几次调用。 */
  function scenarioExec(args) {
    if (args[0] === 'api') {
      const target = String(args[1] || '');
      // 行内评论：repos/O/R/pulls/N/comments（review comment 的 REST 端点）
      if (/\/pulls\/\d+\/comments$/.test(target)) return scenario.inline;
      // 仓库设置：repos/O/R（恰好两段，不带子资源）
      if (/^repos\/[^/]+\/[^/]+$/.test(target)) return scenario.repo;
    }
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

  /** 所有 `gh api repos/O/R`（仓库设置）调用 */
  function repoCalls() {
    return execCalls.filter((c) => c.args[0] === 'api' && /^repos\/[^/]+\/[^/]+$/.test(String(c.args[1] || '')));
  }

  /** 记录里真正的那条行内评论 argv（`/pulls/N/comments`） */
  function commentArgv() {
    const hit = execCalls.find((c) => c.args[0] === 'api' && /\/pulls\/\d+\/comments$/.test(String(c.args[1] || '')));
    return hit ? hit.args : null;
  }

  function commentCount() {
    return execCalls.filter((c) => c.args[0] === 'api' && /\/pulls\/\d+\/comments$/.test(String(c.args[1] || ''))).length;
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

  const mergeMethodsRoute = webServer.exact.get('/api/github/repo-merge-methods');
  const inlineRoute = webServer.exact.get('/api/github/pr-inline-comment');

  /** GET 合并方式的便捷调用器：repo 原样进 query，缺省则表示「不给 repo」 */
  async function getMergeMethods(repo, method = 'GET') {
    const url = repo === undefined
      ? '/api/github/repo-merge-methods'
      : '/api/github/repo-merge-methods?repo=' + encodeURIComponent(repo);
    return callRoute(mergeMethodsRoute.handler, { url, method });
  }

  // 合法起点：行内评论的单行基线。
  const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
  function inlinePayload(extra = {}) {
    return {
      repo: 'acme/demo',
      number: 128,
      body: '这里要改',
      path: 'src/app.ts',
      line: 24,
      side: 'RIGHT',
      commit_id: SHA,
      ...extra,
    };
  }

  /** 单行评论的「基线 argv」：多行用例必须是在它后面追加，而不是重排。 */
  function singleLineArgs({ side = 'RIGHT', line = 24 } = {}) {
    return [
      'api',
      'repos/acme/demo/pulls/128/comments',
      '--method',
      'POST',
      '-f', 'body=这里要改',
      '-f', 'path=src/app.ts',
      '-f', `side=${side}`,
      '-F', `line=${line}`,
      '-f', `commit_id=${SHA}`,
    ];
  }

  // ============================================================
  // 一、路由注册
  // ============================================================
  console.log('\n--- 1. 两条新路由的注册形态 ---');

  test('repo-merge-methods 与 pr-inline-comment 均已注册在 exact 表上', () => {
    assert(mergeMethodsRoute, '/api/github/repo-merge-methods 必须由 registerApiRoutes 注册');
    assert(inlineRoute, '/api/github/pr-inline-comment 必须由 registerApiRoutes 注册');
    for (const [p, route] of [
      ['/api/github/repo-merge-methods', mergeMethodsRoute],
      ['/api/github/pr-inline-comment', inlineRoute],
    ]) {
      assert.strictEqual(route.kind, 'exact', `${p} 必须是 exact 路由`);
      assert.strictEqual(typeof route.handler, 'function', `${p} 必须有可调用 handler`);
      assert(webServer.exact.has(p), `${p} 必须落进 webServer.exact 路由表`);
      assert(!webServer.prefixes.has(p), `${p} 不得误注册为前缀路由`);
    }
  });

  // ============================================================
  // 二、A. repo-merge-methods：参数守卫 / 语义口径 / 缓存 / 报错归因
  // ============================================================
  console.log('\n--- 2. repo-merge-methods 入参守卫与 405 ---');

  await asyncTest('A1 repo 缺失或非法（acme / -x/y / 空）→ 400，且一次 gh 都不跑', async () => {
    for (const repo of ['acme', '-x/y', '']) {
      resetExec();
      const { status, body } = await getMergeMethods(repo);

      assert.strictEqual(status, 400, `repo=${JSON.stringify(repo)} 必须 400`);
      assert.strictEqual(body.ok, false);
      assert(typeof body.error === 'string' && body.error.includes('仓库'), `repo=${JSON.stringify(repo)} 的错误必须点明仓库问题`);
      assert.strictEqual(execCalls.length, 0, `repo=${JSON.stringify(repo)} 校验没过就绝不能调 gh`);
    }

    // 连 query 都不给（不是空串，而是根本没有这个参数）
    resetExec();
    const missing = await getMergeMethods(undefined);
    assert.strictEqual(missing.status, 400, '完全不带 repo 参数必须 400');
    assert.strictEqual(execCalls.length, 0, '没 repo 时不得调 gh');
  });

  await asyncTest('A2 非 GET（POST）→ 405，且一次 gh 都不跑', async () => {
    resetExec();
    const { status, body } = await getMergeMethods('acme/demo', 'POST');

    assert.strictEqual(status, 405, '该路由只读，POST 必须 405');
    assert.strictEqual(body.ok, false);
    assert(typeof body.message === 'string' && body.message.includes('GET'), '405 文案必须点明只支持 GET');
    assert.strictEqual(execCalls.length, 0, '方法不对时绝不能调 gh');
  });

  console.log('\n--- 3. repo-merge-methods 正常路径：三个开关的映射 ---');

  await asyncTest('A3 快乐路径：squash 开 / merge 关 / rebase 开 → 200 且 argv 一字不差', async () => {
    resetExec();
    const { status, body } = await getMergeMethods('acme/demo');

    assert.strictEqual(status, 200, '正常读取必须 200');
    assert.strictEqual(body.ok, true);
    assert.deepStrictEqual(
      body.data,
      { repo: 'acme/demo', squash: true, merge: false, rebase: true, squashOnly: false },
      'data 必须是面板直接可用的四字段形状（含回显 repo，方便多仓并发时对号入座）',
    );
    assert.strictEqual(repoCalls().length, 1, '恰好一次 gh api 仓库设置');
    assert.deepStrictEqual(
      repoCalls()[0].args,
      ['api', 'repos/acme/demo'],
      'argv 必须恰好是 gh api repos/OWNER/NAME（多一个字段就得改缓存与断言）',
    );
  });

  await asyncTest('A4 只允许 squash → squashOnly=true（面板据此提示「只能压缩」）', async () => {
    resetExec();
    scenario.repo = { ok: true, data: { allow_squash_merge: true, allow_merge_commit: false, allow_rebase_merge: false } };

    const { status, body } = await getMergeMethods('acme/only-squash');

    assert.strictEqual(status, 200);
    assert.deepStrictEqual(
      body.data,
      { repo: 'acme/only-squash', squash: true, merge: false, rebase: false, squashOnly: true },
      'squashOnly 必须是「squash 开 且 另两种显式关闭」才为真',
    );
  });

  await asyncTest('A5 字段缺失（{}）按「允许」处理：!== false 语义 → 三个全 true', async () => {
    resetExec();
    // 企业版 / 旧 API 可能不回这三个字段；此时若按「缺失=禁止」处理，面板会一个方式都选不了
    scenario.repo = { ok: true, data: {} };

    const { status, body } = await getMergeMethods('acme/no-flags');

    assert.strictEqual(status, 200);
    assert.deepStrictEqual(
      body.data,
      { repo: 'acme/no-flags', squash: true, merge: true, rebase: true, squashOnly: false },
      '缺字段必须落到「允许」一侧（!== false 而不是 === true）',
    );
  });

  console.log('\n--- 4. repo-merge-methods 缓存：5 分钟内同仓库不重复打 gh ---');

  await asyncTest('A6 两次同仓库 → 只跑一次 gh；换仓库 → 再多一次', async () => {
    resetExec();

    const first = await getMergeMethods('acme/cache-hit');
    assert.strictEqual(first.status, 200);
    assert.strictEqual(repoCalls().length, 1, '首次必须真的去问 gh');

    const second = await getMergeMethods('acme/cache-hit');
    assert.strictEqual(second.status, 200, '命中缓存仍然是 200');
    assert.strictEqual(repoCalls().length, 1, '第二次必须命中缓存，不能再打 gh（5 分钟窗口）');
    assert.deepStrictEqual(second.body, first.body, '缓存回的 body 必须与首次完全一致');

    const other = await getMergeMethods('acme/cache-other');
    assert.strictEqual(other.status, 200);
    assert.strictEqual(repoCalls().length, 2, '换了仓库就必须重新问一次');
    assert.deepStrictEqual(
      repoCalls()[1].args,
      ['api', 'repos/acme/cache-other'],
      '缓存键必须是「仓库」而不是「这条路由」，否则换仓库会串味',
    );
    assert.deepStrictEqual(other.body.data.repo, 'acme/cache-other', '第二个仓库的 data 必须属于它自己');
  });

  await asyncTest('A7 上游 404 → 502：既给人话提示，也回吐 gh 原文；失败不入缓存', async () => {
    resetExec();
    scenario.repo = { ok: false, error: 'gh: Not Found (HTTP 404)' };

    const { status, body } = await getMergeMethods('acme/gone');

    assert.strictEqual(status, 502, '读不到仓库设置必须 502，绝不能假装「都允许」而返回 200');
    assert.strictEqual(body.ok, false);
    assert(
      typeof body.error === 'string' && body.error.includes('找不到这个仓库或 PR'),
      '必须给出人话提示「找不到这个仓库或 PR」，而不是把 gh 原文直接丢给用户',
    );
    assert(
      body.error.includes('gh: Not Found (HTTP 404)'),
      '必须保留 gh 原文，方便排查时对照',
    );
    assert.strictEqual(execCalls.length, 1, '失败路径只尝试一次');

    // 失败不缓存：再来一次仍然要打 gh（否则一次网络抖动会让面板 5 分钟内一直报错）
    const again = await getMergeMethods('acme/gone');
    assert.strictEqual(again.status, 502, '第二次仍然是失败');
    assert.strictEqual(execCalls.length, 2, '失败结果不得入缓存，第二次必须重新尝试');
  });

  // ============================================================
  // 五、B. pr-inline-comment：多行区间支持
  // ============================================================
  console.log('\n--- 5. pr-inline-comment 多行区间：参数拼接 ---');

  await asyncTest('B1 start_line 合法（< line）→ 追加 -F start_line / -f start_side=RIGHT，单行参数原样不动', async () => {
    resetExec();
    const { status, body } = await callRoute(inlineRoute.handler, {
      payload: inlinePayload({ line: 24, start_line: 20 }),
    });

    assert.strictEqual(status, 200, '合法多行评论必须放行');
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.data.line, 24, 'data.line 仍是区间结束行');
    assert.strictEqual(commentCount(), 1, '恰好发一次 /pulls/N/comments');

    const argv = commentArgv();
    const base = singleLineArgs({ line: 24 });
    // 前置：单行参数逐元素相等（多行是「追加」，不是「重排/覆盖」）
    assert.deepStrictEqual(
      argv.slice(0, base.length),
      base,
      '多行评论的前半段必须与单行评论逐元素相同（body/path/side/line/commit_id 一个都不许动）',
    );
    // 后缀：恰好这两个参数，且顺序固定
    assert.deepStrictEqual(
      argv.slice(base.length),
      ['-F', 'start_line=20', '-f', 'start_side=RIGHT'],
      'start_line 必须用 -F（数字类型），start_side 必须用 -f，且紧跟在单行参数之后',
    );
    assert.deepStrictEqual(argv, base.concat(['-F', 'start_line=20', '-f', 'start_side=RIGHT']), '整条 argv 逐元素相等');

    // 区间语义：line 只出现一次、值不变；start_line 只有一个且严格小于 line
    assert.deepStrictEqual(
      argv.filter((a) => a.startsWith('line=')),
      ['line=24'],
      'line= 必须只出现一次，且仍然是区间结束行（不能被 start_line 抢占或改写）',
    );
    assert.deepStrictEqual(
      argv.filter((a) => a.startsWith('start_line=')),
      ['start_line=20'],
      'start_line= 必须恰好一次',
    );
    const startValue = Number(String(argv.find((a) => a.startsWith('start_line='))).split('=')[1]);
    const lineValue = Number(argv.find((a) => a.startsWith('line=')).split('=')[1]);
    assert(startValue < lineValue, `start_line(${startValue}) 必须严格小于 line(${lineValue})，否则 GitHub 会 422`);
  });

  await asyncTest('B2 start_line >= line 或非正整数（0 / -3 / x / 1.5）→ 400，零 gh 调用', async () => {
    for (const startLine of [24, 30, 0, -3, 'x', 1.5]) {
      resetExec();
      const { status, body } = await callRoute(inlineRoute.handler, {
        payload: inlinePayload({ line: 24, start_line: startLine }),
      });

      const label = `start_line=${JSON.stringify(startLine)}`;
      assert.strictEqual(status, 400, `${label} 必须 400`);
      assert.strictEqual(body.ok, false);
      assert(typeof body.error === 'string' && body.error.includes('start_line'), `${label} 的错误必须点明 start_line`);
      assert.strictEqual(execCalls.length, 0, `${label} 校验没过就绝不能调 gh（GitHub 只会回一个 422）`);
    }
  });

  await asyncTest('B3 start_line 缺失 → 单行评论行为一字不变（没有 start_line / start_side）', async () => {
    resetExec();
    const { status } = await callRoute(inlineRoute.handler, { payload: inlinePayload() });

    assert.strictEqual(status, 200);
    assert.strictEqual(commentCount(), 1);
    const argv = commentArgv();
    assert.deepStrictEqual(argv, singleLineArgs(), '不传 start_line 时 argv 必须与改造前完全相同');
    assert.strictEqual(
      argv.filter((a) => a.includes('start_line') || a.includes('start_side')).length,
      0,
      '单行评论绝不能带 start_line / start_side（GitHub 会当成非法区间）',
    );
  });

  await asyncTest('B4 side=LEFT + start_line → start_side 也跟着 LEFT', async () => {
    resetExec();
    const { status } = await callRoute(inlineRoute.handler, {
      payload: inlinePayload({ line: 24, start_line: 20, side: 'LEFT' }),
    });

    assert.strictEqual(status, 200, 'LEFT 侧的多行评论同样合法');
    assert.deepStrictEqual(
      commentArgv(),
      singleLineArgs({ side: 'LEFT', line: 24 }).concat(['-F', 'start_line=20', '-f', 'start_side=LEFT']),
      'start_side 必须与 side 保持一致（LEFT 区间却给 RIGHT 会被 GitHub 拒）',
    );
  });

  // ============================================================
  // 六、C. 客户端产物的静态契约
  // ============================================================
  console.log('\n--- 6. 客户端面板段（bundle 标记之间）的静态契约 ---');

  const clientSrc = fs.readFileSync(path.join(__dirname, '../lib/client.js'), 'utf8');
  const PANEL_START = '// ---- [Bundled: session-pr-panel.js] ----';
  const PANEL_END = '// ---- [End: session-pr-panel.js] ----';

  const panelSeg = (() => {
    const start = clientSrc.indexOf(PANEL_START);
    const end = clientSrc.indexOf(PANEL_END);
    assert(start >= 0, `client.js 必须保留 bundle 标记 ${PANEL_START}`);
    assert(end > start, `client.js 必须保留 bundle 标记 ${PANEL_END}，且排在面板标记之后`);
    return clientSrc.slice(start, end);
  })();

  // 断言命中都在面板段内，避免整份 client.js 里别处的同名字符串造成假绿。
  function panelHas(token) {
    return panelSeg.includes(token);
  }

  test('C1 diff 分段展开：按 2000 行分批，setShowAll 已删除、没有 1e9 兜底', () => {
    assert(panelHas('nextChunkLabel'), '必须保留 nextChunkLabel（批次文案的唯一入口）');
    assert(panelHas('继续加载 2000 行'), '剩余超过一批时必须说「继续加载 2000 行」');
    assert(panelHas('显示剩余'), '剩余不足一批时必须说「显示剩余 N 行」');
    assert(
      panelHas('Math.min(rows.length, cap + 2000)'),
      '「看更多」必须按 cap + 2000 推进并夹到 rows.length（不能越界）',
    );
    // 旧实现用 1e9 当 cap 一次性铺全量 DOM，长 diff 会把面板卡死
    assert(!panelHas('1e9'), '面板段不得再出现 1e9 这种「一次性全量」魔法数');
    assert(!panelHas('setShowAll'), 'setShowAll 这套一次性展开的状态必须已被 setShownTo 取代');
  });

  test('C2 Shift 区间选择：rangeLabel / shiftKey / start_line / 评论条渲染区间文案', () => {
    assert(panelHas('rangeLabel'), '必须保留 rangeLabel（单行 :12 / 多行 :12–18 的统一文案）');
    assert(panelHas('shiftKey'), '必须读到 ev.shiftKey，否则 Shift+点击选不了区间');
    assert(panelHas('start_line'), '客户端必须把区间起点以 start_line 传给后端');
    assert(panelHas('rangeLabel(lineSel)'), '评论条必须渲染 rangeLabel(lineSel)，用户才知道自己选了几行');
    // 只做 includes 会被「别处也用了 rangeLabel(lineSel)」蒙混过去（浮窗/剪贴板也用它），
    // 这里精确到评论条头部那一段代码，确认是**评论条自己**在渲染区间文案。
    // 注意锚点要取 JSX 用法（className: "ghsp-commentbar-head"）：CSS 里也有同名的
    // `.ghsp-commentbar-head{}` 选择器，用裸类名当锚点会落在样式表上。
    const barHeadAt = panelSeg.indexOf('className: "ghsp-commentbar-head"');
    assert(barHeadAt >= 0, '面板必须渲染落点评论条（className: "ghsp-commentbar-head"）');
    assert(
      panelSeg.slice(barHeadAt, barHeadAt + 400).includes('rangeLabel(lineSel)'),
      '评论条头部必须直接用 rangeLabel(lineSel) 渲出「:12–18」，而不是只显示起始行',
    );
  });

  test('C3 合并方式：拉 repo-merge-methods，按 !== false 过滤，非法值自动回退', () => {
    assert(panelHas('/api/github/repo-merge-methods'), '面板必须调用合并方式探测接口');
    assert(panelHas('mergeMethods[m] !== false'), '过滤口径必须是 !== false（字段缺失=允许）');
    // 同上：`!== false` 在「某个方式是否可点」里也出现过一次，这里精确到
    // 「构造 allowed 集合」的那一行，确保过滤真的发生在合并方式下拉的数据源上。
    assert(
      panelHas('["squash", "merge", "rebase"].filter(function (m) { return mergeMethods[m] !== false; })'),
      'allowed 集合必须由 mergeMethods 按 !== false 过滤得出（面板下拉的数据源）',
    );
    assert(
      panelHas('allowed.indexOf(mergeMethod) === -1'),
      '当前选中的方式不在允许集合里时必须自动回退到 allowed[0]，否则用户会卡在一个必然被拒的方式上',
    );
  });

  test('C4 createdPrMetaCache 有界：size > 240 时淘汰最老的一条', () => {
    const actionsSrc = fs.readFileSync(path.join(__dirname, '../lib/api/routes-actions.js'), 'utf8');
    assert(
      actionsSrc.includes('createdPrMetaCache.size > 240'),
      'createdPrMetaCache 必须显式设上限（按 repo#number 无限增长会拖垮长跑进程）',
    );
    // 光有阈值没有淘汰动作等于没设上限，两条一起钉住
    assert(/createdPrMetaCache\.delete\(/.test(actionsSrc), '超出上限时必须真的 delete 掉最老的一条');
    assert(actionsSrc.includes('createdPrMetaCache.keys().next().value'), '淘汰对象必须是 Map 迭代序最老的键（FIFO/LRU 近似）');
  });

  console.log('\n========================================');
  console.log(`Phase 29 Test Result: ${passed}/${total} PASSED`);
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
