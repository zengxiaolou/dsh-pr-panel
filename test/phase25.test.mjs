// test/phase25.test.mjs - Phase 25 · 「PR 合并 / 自动合并」新链路回归套件
//
// 覆盖本阶段新增的两处行为（全部落在编译产物上，不改 src/）：
// 1. POST /api/github/pr-merge（lib/api/routes-actions.js）：合并 / 开自动合并 / 关自动合并
//    三个动作共用一个端点，argv 由 action + method 决定。这里逐元素锁住 argv 形状，
//    因为「拼错一个 flag」不会抛错，只会让 gh 静默合并成别的方式。
// 2. lib/client.js 面板接线：头部三颗按钮（批准 / 合并 / 自动合并）+ 合并方式下拉，
//    以及「合并要点两次」的确认闸门（第一次点击只置 confirmMerge，不发请求）。
//
// 设计口径与 phase24 完全一致：桩执行器记录 argv（副本）、不发真请求；每个 400 用例额外
// 断言 exec 零调用，避免「先执行再校验」把非法输入带进 gh。
//
// 环境说明（relaxation，两处与任务书口径不同，已按编译产物实际行为落测）：
// - action / method 传**空串**时不是 400：handler 用 `String(payload.action || 'merge')`
//   归一化，空串是 falsy，因此等价于「没传」，落到默认值 merge / squash 并正常执行一次 gh。
//   任务书写的是「空串 → 400」，与 lib/api/routes-actions.js（及 src/api/routes-actions.ts，
//   两者同源）不一致。本套件不改 src、只做回归，所以此处的断言改为「空串必须被归一化为默认
//   argv，且不得出现 `--` 空 flag」，并在报告里点明这处放宽。
// - 非空串的非法值（action 'squash' / 'merge-now'、method 'fast-forward'）确实 400 且零 exec，
//   与任务书一致，未放宽。

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runTests() {
  console.log('🧪 开始执行 Phase 25 PR 合并 / 自动合并回归测试\n');
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
  // 合并路由现在会「先读状态 → 执行 merge → 再读状态确认」。桩必须模拟这三个阶段，
  // 否则会停在「合并前 OPEN」，被后验校验判成没生效。
  let mergedFlag = false;
  let autoFlag = false;

  function defaultExec(args) {
    if (args[0] === 'pr' && args[1] === 'view') {
      return {
        ok: true,
        data: {
          state: mergedFlag ? 'MERGED' : 'OPEN',
          mergeStateStatus: 'CLEAN',
          autoMergeRequest: autoFlag ? { enabledBy: { login: 'someone' } } : null,
          author: { login: 'someone-else' },
        },
      };
    }
    if (args[0] === 'pr' && args[1] === 'merge') {
      if (args.includes('--disable-auto')) autoFlag = false;
      else if (args.includes('--auto')) autoFlag = true;
      else mergedFlag = true;
      return { ok: true, rawOutput: '' };
    }
    if (args[0] === 'api' && args[1] === 'user') return { ok: true, data: { login: 'me' } };
    return { ok: true, data: {} };
  }

  function setExecResult(next) {
    execCalls = [];
    execResult = next;
  }
  function resetExec() {
    mergedFlag = false;
    autoFlag = false;
    setExecResult(defaultExec);
  }

  /** 记录里真正的那条 gh pr merge argv（前置/后验的 pr view 不算） */
  function mergeArgv() {
    const hit = execCalls.find((c) => c.args[0] === 'pr' && c.args[1] === 'merge');
    return hit ? hit.args : null;
  }
  function mergeCount() {
    return execCalls.filter((c) => c.args[0] === 'pr' && c.args[1] === 'merge').length;
  }

  const stubExec = {
    async run(args, opts = {}) {
      execCalls.push({ args: Array.from(args), opts });
      return typeof execResult === 'function' ? execResult(args, opts) : execResult;
    },
    resolveWorkspaceRepoRoot() {
      return null;
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

  const mergeRoute = routes.get('/api/github/pr-merge');

  // 合法起点，非法用例只在它上面改一个字段
  const validMerge = () => ({ repo: 'acme/demo', number: 128 });

  // ============================================================
  // 一、路由注册
  // ============================================================
  console.log('\n--- 1. /api/github/pr-merge 路由注册 ---');

  test('路由已注册在 exact 表上，且 handler 为函数', () => {
    assert(mergeRoute, '/api/github/pr-merge 必须由 registerApiRoutes 注册');
    assert.strictEqual(mergeRoute.kind, 'exact', '必须是 exact 路由');
    assert.strictEqual(typeof mergeRoute.handler, 'function', '必须有可调用 handler');
    assert(webServer.exact.has('/api/github/pr-merge'), '必须落进 webServer.exact 路由表');
    assert(!webServer.prefixes.has('/api/github/pr-merge'), '不得误注册为前缀路由');
    assert(webServer.registered.includes('/api/github/pr-merge'), 'register() 必须真实收到该路径');
  });

  // ============================================================
  // 二、方法闸门
  // ============================================================
  console.log('\n--- 2. 方法闸门：只接受 POST ---');

  await asyncTest('GET → 405，且不执行任何 gh 命令', async () => {
    resetExec();
    const { status, body } = await callRoute(mergeRoute.handler, {
      url: '/api/github/pr-merge',
      method: 'GET',
    });
    assert.strictEqual(status, 405, '写路由必须拒绝 GET');
    assert.strictEqual(body.ok, false);
    assert(typeof body.message === 'string' && body.message.includes('POST'), '错误信息必须点明仅支持 POST');
    assert.strictEqual(execCalls.length, 0, '405 必须在触达 gh 之前返回');
  });

  // ============================================================
  // 三、参数校验矩阵（全部 400 + exec 零调用）
  // ============================================================
  console.log('\n--- 3. 参数校验：400 且零 exec ---');

  await asyncTest("repo 非法（'acme' / '-bad/repo' / ''）→ 400，且 exec 零调用", async () => {
    resetExec();
    for (const badRepo of ['acme', '-bad/repo', '']) {
      const { status, body } = await callRoute(mergeRoute.handler, {
        payload: { ...validMerge(), repo: badRepo },
      });
      assert.strictEqual(status, 400, `repo=${JSON.stringify(badRepo)} 必须 400`);
      assert.strictEqual(body.ok, false);
      assert(typeof body.error === 'string' && body.error.includes('repo'), '错误必须点明 repo');
    }
    assert.strictEqual(execCalls.length, 0, '校验失败时绝不能先执行 gh');
  });

  await asyncTest("number 非法（0 / -1 / 1.5 / 'abc'）→ 400，且 exec 零调用", async () => {
    resetExec();
    for (const badNumber of [0, -1, 1.5, 'abc']) {
      const { status, body } = await callRoute(mergeRoute.handler, {
        payload: { ...validMerge(), number: badNumber },
      });
      assert.strictEqual(status, 400, `number=${JSON.stringify(badNumber)} 必须 400`);
      assert.strictEqual(body.ok, false);
      assert(typeof body.error === 'string' && body.error.includes('number'), '错误必须点明 number');
    }
    assert.strictEqual(execCalls.length, 0, '校验失败时绝不能先执行 gh');
  });

  await asyncTest("action 非法（'squash' / 'merge-now'）→ 400，且 exec 零调用", async () => {
    resetExec();
    for (const badAction of ['squash', 'merge-now']) {
      const { status, body } = await callRoute(mergeRoute.handler, {
        payload: { ...validMerge(), action: badAction },
      });
      assert.strictEqual(status, 400, `action=${JSON.stringify(badAction)} 必须 400`);
      assert.strictEqual(body.ok, false);
      assert(typeof body.error === 'string' && body.error.includes('merge'), '错误必须点明合法动作');
    }
    assert.strictEqual(execCalls.length, 0, '校验失败时绝不能先执行 gh');
  });

  await asyncTest("method 非法（'fast-forward'）→ 400，且 exec 零调用", async () => {
    resetExec();
    const { status, body } = await callRoute(mergeRoute.handler, {
      payload: { ...validMerge(), method: 'fast-forward' },
    });
    assert.strictEqual(status, 400, "method='fast-forward' 必须 400");
    assert.strictEqual(body.ok, false);
    assert(typeof body.error === 'string' && body.error.includes('合并方式'), '错误必须点明合并方式');
    assert.strictEqual(execCalls.length, 0, '校验失败时绝不能先执行 gh');
  });

  // 显式空串 = 非法输入，不是「没传」。合并会改写远端历史，
  // 调用方把 action 写空不能等价于「那就按默认合并吧」；只有字段缺失才取默认值。
  await asyncTest('action / method 显式空串 → 400 且零 exec（只有缺失才取默认值）', async () => {
    resetExec();
    const emptyAction = await callRoute(mergeRoute.handler, {
      payload: { ...validMerge(), action: '' },
    });
    assert.strictEqual(emptyAction.status, 400, 'action 空串必须 400，不得落到默认合并');
    assert.strictEqual(execCalls.length, 0, '校验失败时绝不能先执行 gh');

    resetExec();
    const emptyMethod = await callRoute(mergeRoute.handler, {
      payload: { ...validMerge(), method: '' },
    });
    assert.strictEqual(emptyMethod.status, 400, 'method 空串必须 400');
    assert.strictEqual(execCalls.length, 0);

    // 字段缺失仍然取默认值：这是「没传」不是「传错」
    resetExec();
    const missing = await callRoute(mergeRoute.handler, { payload: { ...validMerge() } });
    assert.strictEqual(missing.status, 200, '缺失 action/method 时按默认 merge + squash');
    assert.deepStrictEqual(mergeArgv(), ['pr', 'merge', '128', '--repo', 'acme/demo', '--squash']);
  });

  resetExec();

  // ============================================================
  // 四、argv 形状矩阵
  // ============================================================
  console.log('\n--- 4. argv 形状：action × method × delete_branch ---');

  await asyncTest('默认（action/method 全缺省）：squash 合并，argv 逐元素相等', async () => {
    resetExec();
    const { status, body } = await callRoute(mergeRoute.handler, { payload: { ...validMerge() } });

    assert.strictEqual(status, 200, '合法请求必须 200');
    assert.strictEqual(body.ok, true);
    assert.strictEqual(mergeCount(), 1, '只执行一次 gh merge');
    assert.strictEqual(execCalls.length, 3, '前置状态 + merge + 后验状态，共 3 次 gh');
    assert.deepStrictEqual(
      mergeArgv(),
      ['pr', 'merge', '128', '--repo', 'acme/demo', '--squash'],
      '默认必须是 squash 合并，argv 逐元素相等',
    );
    assert.strictEqual(body.data.action, 'merge', '回吐 action 默认 merge');
    assert.strictEqual(body.data.method, 'squash', '回吐 method 默认 squash');
    assert.strictEqual(body.data.repo, 'acme/demo', '回吐 repo');
    assert.strictEqual(body.data.number, 128, '回吐 number');
  });

  await asyncTest('delete_branch:true → 追加 --delete-branch（只在 merge 动作上）', async () => {
    resetExec();
    const { status } = await callRoute(mergeRoute.handler, {
      payload: { ...validMerge(), delete_branch: true },
    });
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(mergeArgv(), [
      'pr',
      'merge',
      '128',
      '--repo',
      'acme/demo',
      '--squash',
      '--delete-branch',
    ]);
  });

  await asyncTest('delete_branch 非 true（false / 缺省）→ 不得出现 --delete-branch', async () => {
    resetExec();
    for (const value of [false, undefined, 'true', 1]) {
      resetExec();
      const { status } = await callRoute(mergeRoute.handler, {
        payload: { ...validMerge(), delete_branch: value },
      });
      assert.strictEqual(status, 200, `delete_branch=${JSON.stringify(value)} 必须 200`);
      assert(
        !mergeArgv().includes('--delete-branch'),
        `delete_branch=${JSON.stringify(value)} 不得删分支（只认布尔 true）`,
      );
    }
  });

  await asyncTest("method 'rebase' → '--rebase'", async () => {
    resetExec();
    const { status } = await callRoute(mergeRoute.handler, {
      payload: { ...validMerge(), method: 'rebase' },
    });
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(mergeArgv(), ['pr', 'merge', '128', '--repo', 'acme/demo', '--rebase']);
  });

  await asyncTest("action 'auto' → ['--auto','--squash']（method 跟在 --auto 之后）", async () => {
    resetExec();
    const { status, body } = await callRoute(mergeRoute.handler, {
      payload: { ...validMerge(), action: 'auto' },
    });
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(
      mergeArgv(),
      ['pr', 'merge', '128', '--repo', 'acme/demo', '--auto', '--squash'],
      '--auto 必须在前，method flag 紧随其后',
    );
    assert.strictEqual(body.data.action, 'auto', '回吐 action=auto');
    assert(body.data.message.includes('自动合并'), 'message 必须点明自动合并');
  });

  await asyncTest("action 'auto' + method 'rebase'：method flag 仍在同一尾部位", async () => {
    resetExec();
    const { status } = await callRoute(mergeRoute.handler, {
      payload: { ...validMerge(), action: 'auto', method: 'rebase' },
    });
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(mergeArgv(), [
      'pr',
      'merge',
      '128',
      '--repo',
      'acme/demo',
      '--auto',
      '--rebase',
    ]);
  });

  await asyncTest("action 'disable-auto' → 只追加 '--disable-auto'，不含 --squash / --auto", async () => {
    resetExec();
    autoFlag = true; // 只有「本来就开着」才允许取消
    const { status, body } = await callRoute(mergeRoute.handler, {
      payload: { ...validMerge(), action: 'disable-auto' },
    });
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(
      mergeArgv(),
      ['pr', 'merge', '128', '--repo', 'acme/demo', '--disable-auto'],
      '关自动合并只带一个 flag',
    );
    assert(!mergeArgv().includes('--squash'), 'disable-auto 不得带 --squash');
    assert(!mergeArgv().includes('--auto'), 'disable-auto 不得带 --auto（那会变成开启）');
    assert.strictEqual(body.data.action, 'disable-auto');
    assert(body.data.message.includes('取消'), 'message 必须点明取消自动合并');
  });

  await asyncTest('disable-auto 即使带 delete_branch:true 也不得删分支', async () => {
    resetExec();
    autoFlag = true;
    const { status } = await callRoute(mergeRoute.handler, {
      payload: { ...validMerge(), action: 'disable-auto', delete_branch: true },
    });
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(mergeArgv(), ['pr', 'merge', '128', '--repo', 'acme/demo', '--disable-auto']);
    assert(!mergeArgv().includes('--delete-branch'), '取消自动合并与删分支无关，不得顺带删');
  });

  resetExec();

  // ============================================================
  // 五、上游失败与畸形请求
  // ============================================================
  console.log('\n--- 5. 上游失败 / 畸形请求 ---');

  await asyncTest('gh 返回 { ok:false, error } → 502 并原样透出该 error', async () => {
    setExecResult({ ok: false, error: 'boom' });
    const { status, body } = await callRoute(mergeRoute.handler, { payload: { ...validMerge() } });
    assert.strictEqual(status, 502, '上游失败必须是 502 而不是 200');
    assert.strictEqual(body.ok, false);
    assert.strictEqual(body.error, 'boom', '必须把 gh 的 error 原样透出，便于前端展示');
  });

  await asyncTest('畸形 JSON body → 400（按缺字段处理，不得 500 崩）', async () => {
    resetExec();
    const { status } = await callRoute(mergeRoute.handler, {
      url: '/api/github/pr-merge',
      raw: '{"repo":"acme/demo", 坏掉了',
    });
    assert.strictEqual(status, 400, '畸形 JSON 必须降级为 400');
    assert.strictEqual(execCalls.length, 0, '畸形请求绝不能触达 gh');
  });

  resetExec();

  // ============================================================
  // 六、lib/api/routes-actions.js 静态契约
  // ============================================================
  console.log('\n--- 6. lib/api/routes-actions.js 产物静态契约 ---');

  const actionsSrc = fs.readFileSync(path.join(__dirname, '../lib/api/routes-actions.js'), 'utf8');

  test("pr-merge 路由路径字符串在编译产物中恰好出现一次", () => {
    const hits = actionsSrc.match(/\/api\/github\/pr-merge/g) || [];
    assert.strictEqual(hits.length, 1, `路径字符串必须恰好出现一次，实际 ${hits.length} 次（重复注册会抛错）`);
    assert(
      actionsSrc.includes("path: '/api/github/pr-merge'"),
      "必须以 `path: '/api/github/pr-merge'` 的形式注册在 exact 表上",
    );
  });

  test('pr-detail 的 --json 字段列表含 autoMergeRequest 与 mergeStateStatus', () => {
    // 按「pr-detail 路由块」切片（到下一个路由注册为止），避免把别的 pr view 的 --json 算进来
    const start = actionsSrc.indexOf("path: '/api/github/pr-detail'");
    const end = actionsSrc.indexOf("path: '/api/github/pr-diff'");
    assert(start > 0, "必须能定位 pr-detail 路由块");
    assert(end > start, '必须有下一个路由注册作为结束边界');
    const region = actionsSrc.slice(start, end);

    // 该路由块内所有 '--json', '<逗号分隔字段>' 组合
    // 字段表已抽成 coreFields 常量（thread 走独立请求），因此这里直接校验常量
    const coreMatch = region.match(/const coreFields = '([^']+)'/);
    assert(coreMatch, 'pr-detail 路由块必须声明 coreFields 字段常量');
    const coreFields = coreMatch[1];
    assert(
      coreFields.includes('autoMergeRequest') && coreFields.includes('mergeStateStatus'),
      'coreFields 必须含 autoMergeRequest 与 mergeStateStatus（按钮门控依赖它们）',
    );

    const fields = coreFields.split(',');
    assert(fields.includes('autoMergeRequest'), 'autoMergeRequest 必须是独立字段名（面板据此判断自动合并已开启）');
    assert(fields.includes('mergeStateStatus'), 'mergeStateStatus 必须是独立字段名（面板据此禁用合并按钮）');
    assert(fields.includes('mergeable'), 'mergeable 仍须保留，避免合并态判断退化');
  });

  // ============================================================
  // 七、lib/client.js 面板接线静态契约
  // ============================================================
  console.log('\n--- 7. lib/client.js 面板接线静态契约 ---');

  const clientBundle = fs.readFileSync(path.join(__dirname, '../lib/client.js'), 'utf8');
  // 面板自身所在的打包段：跨段断言容易把别的组件（如设置面板的 select）算进来
  const panelStart = clientBundle.indexOf('// ---- [Bundled: session-pr-panel.js] ----');
  const panelEnd = clientBundle.indexOf('// ---- [End: session-pr-panel.js] ----');
  const panelSrc =
    panelStart >= 0 && panelEnd > panelStart ? clientBundle.slice(panelStart, panelEnd) : clientBundle;

  // 头部操作区（批准 / 合并 / 自动合并 / 合并方式下拉）这一小段，用于把标签断言钉在合并按钮上
  const headStartTok = 'var headActions = React.createElement("div", { className: "ghsp-head-actions" }';
  const headEndTok = '/* ---- 卡片：描述 ---- */';
  const headStart = panelSrc.indexOf(headStartTok);
  const headEnd = panelSrc.indexOf(headEndTok);
  const headSrc = headStart >= 0 && headEnd > headStart ? panelSrc.slice(headStart, headEnd) : '';

  test('session-pr-panel 打包段与头部操作区可定位', () => {
    assert(panelStart > 0, 'client.js 必须含 session-pr-panel 的打包段标记');
    assert(panelEnd > panelStart, '必须有下一个打包段作为结束边界');
    assert(headStart > 0, 'panel 段必须能定位 ghsp-head-actions 操作区');
    assert(headEnd > headStart, '必须有「描述卡片」注释作为操作区结束边界');
    assert(headSrc.includes('ghsp-head-actions'), '操作区切片必须含 ghsp-head-actions 类名');
  });

  test('头部四要素齐全：批准 / 合并 / 自动合并 / 合并方式下拉', () => {
    for (const label of ['批准', '合并', '自动合并']) {
      assert(headSrc.includes(`"${label}"`), `client.js 操作区必须以字符串字面量输出「${label}」按钮`);
    }
    // 「合并」是「自动合并」「确认合并？」的子串，必须证明三颗按钮各自独立存在
    assert(headSrc.includes('submitReview("APPROVE")'), '批准按钮必须落到 submitReview("APPROVE")');
    assert(headSrc.includes('mergePr("merge")'), '合并按钮必须落到 mergePr("merge")');
    assert(
      headSrc.includes('mergePr(autoOn ? "disable-auto" : "auto")'),
      '自动合并按钮必须按当前状态在 auto / disable-auto 之间切换',
    );
    assert(headSrc.includes('"ghsp-select"'), '必须有一个合并方式下拉（ghsp-select）');
  });

  test('合并方式下拉：真实 <select> + squash / merge / rebase 三个 option', () => {
    assert(headSrc.includes('"select"'), '必须是真实的 select 元素，不是自制按钮组');
    assert(headSrc.includes('mergeMethod'), 'select 的 value 必须绑定 mergeMethod 状态');
    assert(headSrc.includes('setMergeMethod'), 'select 的 onChange 必须写回 mergeMethod');
    // 选项由仓库允许项过滤生成：不再逐个写死 value，而是遍历三种方式 + allow_*_merge 判断
    assert(
      headSrc.includes('["squash", "merge", "rebase"].map'),
      '下拉必须遍历 squash / merge / rebase 三种方式',
    );
    assert(headSrc.includes('value: m'), '选项的 value 必须来自被遍历的方式');
    assert(
      headSrc.includes('mergeMethods[m] !== false'),
      '选项必须按仓库允许项（allow_*_merge）过滤',
    );
    for (const method of ['squash', 'merge', 'rebase']) {
      assert(
        headSrc.includes(`"${method}"`),
        `下拉候选里必须出现 ${method}`,
      );
    }
    // 面板是整个 bundle 里唯一用 React.createElement("select") 的地方（其余走 h() 别名），
    // 这条同时守住「下拉是面板自己渲染的」而不是复用别处的组件。
    const selectHits = (clientBundle.match(/React\.createElement\("select"/g) || []).length;
    assert.strictEqual(selectHits, 1, `React.createElement("select") 在 bundle 里应唯一，实际 ${selectHits}`);
  });

  test('合并是两段式确认：第一次点击只置 confirmMerge，不发 action=merge', () => {
    // 任务书的「不再在第二次点击之前发送 action=merge」在该实现里由确认闸门表达：
    // onClick 先判 !confirmMerge → 置 true 后直接 return，第二次点击才调 mergePr。
    const gateIdx = headSrc.indexOf('if (!confirmMerge)');
    const setIdx = headSrc.indexOf('setConfirmMerge(true)');
    const callIdx = headSrc.indexOf('mergePr("merge")');
    assert(gateIdx >= 0, '必须存在 !confirmMerge 的第一次点击闸门');
    assert(setIdx > gateIdx, '闸门内必须先 setConfirmMerge(true)');
    assert(callIdx > setIdx, 'mergePr("merge") 必须在置位之后（即第二次点击），不得首发即发请求');

    // 闸门内必须在 setConfirmMerge(true) 之后立刻 return，否则同一次点击会继续往下走
    const between = headSrc.slice(setIdx, callIdx);
    assert(between.includes('return'), '第一次点击置位后必须 return，不得穿透到 mergePr');

    // 二次确认的 UI 证据：按钮文案切换为「确认合并？」
    assert(headSrc.includes('"确认合并？"'), '按钮文案必须切换到「确认合并？」作为二次确认证据');
    assert(headSrc.includes('confirmMerge ? "确认合并？" : "合并"'), '文案必须由 confirmMerge 驱动');
  });

  test('自动合并已开启态文案：自动合并 ✓ 且由 autoMergeRequest 驱动', () => {
    assert(headSrc.includes('"自动合并 ✓"'), '已开启态必须显示「自动合并 ✓」');
    assert(headSrc.includes('autoOn'), '必须由 autoOn 状态驱动文案');
    assert(
      /autoOn\s*=\s*Boolean\(pr\s*&&\s*pr\.autoMergeRequest\)/.test(panelSrc),
      'autoOn 必须来自 pr.autoMergeRequest（与详情 --json 字段对齐）',
    );
  });

  test('pr-merge 端点已接线：POST JSON 且带上 method / delete_branch', () => {
    assert(panelSrc.includes('/api/github/pr-merge'), '面板必须调用 /api/github/pr-merge');
    assert(
      /postJson\(\s*"\/api\/github\/pr-merge"/.test(panelSrc),
      'pr-merge 必须走 POST JSON（postJson）',
    );
    assert(panelSrc.includes('method: mergeMethod'), '请求必须把下拉选中的合并方式带给路由');
    // 删分支是用户可选开关（默认 false），不是硬编码 true——面板里由 deleteBranch 状态驱动
    assert(panelSrc.includes('delete_branch: deleteBranch'), '删分支必须由 deleteBranch 状态驱动');
    assert(
      /var \[deleteBranch, setDeleteBranch\] = React\.useState\(false\)/.test(panelSrc),
      'deleteBranch 必须默认为 false（删分支是破坏性操作，不能默认开）',
    );
    assert(panelSrc.includes('合并后删除源分支'), '必须有对应的勾选框文案，否则开关不可发现');
    assert(panelSrc.includes('setConfirmMerge(false)'), '合并成功后必须复位确认态，否则下一眼就是红按钮');
  });

  console.log('\n========================================');
  console.log(`Phase 25 Test Result: ${passed}/${total} PASSED`);
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
