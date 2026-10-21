// test/phase23.test.mjs - Phase 23 · 「PR 评论 / 行内评论」写路由契约回归测试套件
//
// 覆盖本阶段新增的两条写路径（全部落在 lib/api/routes-actions.js，已编译产物）：
// 1. POST /api/github/pr-comment：会话评论（gh pr comment，issue comment 语义）。
//    重点不是「能不能发」，而是**校验矩阵**与**argv 形状**——argv 必须是数组且逐元素
//    等于期望值，这才能证明没有把 repo/body 拼进 shell 字符串（注入面）；
// 2. POST /api/github/pr-inline-comment：行内评论（gh api REST，CLI 无等价子命令）。
//    除同一套校验矩阵外，额外覆盖 path/line/commit_id 的白名单约束与 side 的缺省语义
//    （缺省 RIGHT、显式 LEFT 透传），以及 `-f` / `-F` 两种传参位的区分；
// 3. lib/api/routes-actions.js 的静态契约：pr-detail 的 `--json` 字段表必须带 headRefOid
//    （行内评论的 commit_id 就取它），pr-detail 必须支持显式 repo query。
//
// 设计口径：全程用桩执行器，不触网、不真发评论。写路由一旦被误改成「先执行再校验」，
// 桩执行器的调用计数就会暴露它——因此每个 400 用例都额外断言 exec 零调用。

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 行内评论的 commit_id 用真实形态的 40 位 sha（校验正则是 7-64 位十六进制）
const SHA = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';
const MAX_COMMENT_CHARS = 64_000;

async function runTests() {
  console.log('🧪 开始执行 Phase 23 PR 评论写路由契约测试\n');
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
  // 零、测试脚手架：假 webServer + 可换返回值的桩执行器 + 流式 req/res
  // ============================================================
  const { registerApiRoutes } = await import('../lib/api/routes.js');

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

  // 桩执行器：记录每次 argv（副本），返回值由当前用例通过 setExecResult 指定。
  // 复制 argv 是必要的——handler 复用同一个数组字面量时，直接存引用会让断言自欺。
  let execCalls = [];
  let execResult = { ok: true, data: {} };
  function setExecResult(next) {
    execCalls = [];
    execResult = next;
  }
  function resetExec() {
    setExecResult({ ok: true, data: {} });
  }
  const stubExec = {
    async run(args, opts = {}) {
      execCalls.push({ args: Array.from(args), opts });
      return typeof execResult === 'function' ? execResult(args, opts) : execResult;
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

  // 最小 req：handler 只依赖 url/method 与 on('data')/on('end')/on('error') 三件事，
  // 因此这里提供事件挂载器 + 显式投递器，投递时机由 invoke 控制（见下）。
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
  // 再投递 body，最后等待 handler 完成。chunks 可显式给出分片，用于验证流式收集。
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

  const commentRoute = routes.get('/api/github/pr-comment');
  const inlineRoute = routes.get('/api/github/pr-inline-comment');

  // 两条路由共用的合法起点，非法用例只在它上面改一个字段
  const validInline = () => ({
    repo: 'acme/demo',
    number: 128,
    body: '这一行需要加锁',
    path: 'src/lock.ts',
    line: 42,
    commit_id: SHA,
  });

  // ============================================================
  // 一、POST /api/github/pr-comment
  // ============================================================
  console.log('\n--- 1. /api/github/pr-comment 路由契约 ---');

  test('路由已注册在 exact 表上，且 handler 为函数', () => {
    assert(commentRoute, '/api/github/pr-comment 必须由 registerApiRoutes 注册');
    assert.strictEqual(commentRoute.kind, 'exact', '必须是 exact 路由（无 query 的 POST）');
    assert.strictEqual(typeof commentRoute.handler, 'function', '必须有可调用 handler');
    assert(webServer.exact.has('/api/github/pr-comment'), '必须落进 webServer.exact 路由表');
    assert(!webServer.prefixes.has('/api/github/pr-comment'), '不得误注册为前缀路由');
    assert(webServer.registered.includes('/api/github/pr-comment'), 'register() 必须真实收到该路径');
  });

  await asyncTest('GET → 405，且不执行任何 gh 命令', async () => {
    resetExec();
    const { status, body } = await callRoute(commentRoute.handler, {
      url: '/api/github/pr-comment',
      method: 'GET',
    });
    assert.strictEqual(status, 405, '写路由必须拒绝 GET');
    assert.strictEqual(body.ok, false, 'ok 必须为 false');
    assert(typeof body.message === 'string' && body.message.includes('POST'), '错误信息必须点明仅支持 POST');
    assert.strictEqual(execCalls.length, 0, '405 必须在触达 gh 之前返回');
  });

  await asyncTest('repo 非法（无斜杠 / 段首为 - / 空串 / 三段）→ 400，且 exec 零调用', async () => {
    resetExec();
    // 这些形状既覆盖语法非法，也覆盖「把参数拼成 -something」的 gh 选项注入面
    for (const badRepo of ['acme', '-bad/repo', '', '   ', 'acme/', '/acme', 'acme/demo/extra', 'acme/de mo']) {
      const { status, body } = await callRoute(commentRoute.handler, {
        payload: { repo: badRepo, number: 128, body: '内容' },
      });
      assert.strictEqual(status, 400, `repo=${JSON.stringify(badRepo)} 必须 400`);
      assert.strictEqual(body.ok, false);
      assert(typeof body.error === 'string' && body.error.includes('repo'), `repo=${JSON.stringify(badRepo)} 的错误必须点明 repo`);
    }
    assert.strictEqual(execCalls.length, 0, '校验失败时绝不能先执行 gh');
  });

  await asyncTest('number 非法（0 / 负数 / 小数 / 非数字）→ 400，且 exec 零调用', async () => {
    resetExec();
    for (const badNumber of [0, -1, 1.5, 'abc', undefined, null, '']) {
      const { status } = await callRoute(commentRoute.handler, {
        payload: { repo: 'acme/demo', number: badNumber, body: '内容' },
      });
      assert.strictEqual(status, 400, `number=${JSON.stringify(badNumber)} 必须 400`);
    }
    assert.strictEqual(execCalls.length, 0, '校验失败时绝不能先执行 gh');
  });

  await asyncTest('body 为空/纯空白 → 400；纯空白必须视为空（trim 语义）', async () => {
    resetExec();
    for (const badBody of ['', '   ', '\n\t ', undefined]) {
      const { status, body } = await callRoute(commentRoute.handler, {
        payload: { repo: 'acme/demo', number: 128, body: badBody },
      });
      assert.strictEqual(status, 400, `body=${JSON.stringify(badBody)} 必须 400`);
      assert(typeof body.error === 'string' && body.error.includes('评论'), '错误信息必须点明评论内容');
    }
    assert.strictEqual(execCalls.length, 0, '校验失败时绝不能先执行 gh');
  });

  await asyncTest('body 超上限（64001 字符）→ 400；恰好 64000 字符放行', async () => {
    resetExec();
    const tooLong = await callRoute(commentRoute.handler, {
      payload: { repo: 'acme/demo', number: 128, body: 'a'.repeat(MAX_COMMENT_CHARS + 1) },
    });
    assert.strictEqual(tooLong.status, 400, '超上限必须 400');
    assert(tooLong.body.error.includes(String(MAX_COMMENT_CHARS)), '错误信息必须点明上限值，便于前端截断');
    assert.strictEqual(execCalls.length, 0, '超限时绝不能先执行 gh');

    resetExec();
    const atLimit = await callRoute(commentRoute.handler, {
      payload: { repo: 'acme/demo', number: 128, body: 'a'.repeat(MAX_COMMENT_CHARS) },
    });
    assert.strictEqual(atLimit.status, 200, '恰好等于上限属于合法（> 才是超限）');
    assert.strictEqual(execCalls.length, 1, '合法请求必须执行一次 gh');
    assert.strictEqual(execCalls[0].args[6].length, MAX_COMMENT_CHARS, 'argv 里的 body 必须原样保留长度');
  });

  await asyncTest('happy path：argv 逐元素相等，证明未做 shell 字符串拼接', async () => {
    resetExec();
    const repo = 'acme/demo';
    const number = 128;
    const body = '这一段建议补上并发测试';
    const { status, body: resBody } = await callRoute(commentRoute.handler, {
      payload: { repo, number, body },
    });

    assert.strictEqual(status, 200, '合法请求必须 200');
    assert.strictEqual(resBody.ok, true);
    assert.strictEqual(resBody.data.repo, repo, '回吐 repo');
    assert.strictEqual(resBody.data.number, number, '回吐 number');
    assert.strictEqual(execCalls.length, 1, '只执行一次 gh');

    // 数组逐元素相等是「无 shell 插值」的核心证据：
    // 含空格/分号/反引号的 body 仍是单个 argv，不会被 sh -c 拆开或执行。
    assert.deepStrictEqual(execCalls[0].args, ['pr', 'comment', String(number), '--repo', repo, '--body', body]);
    assert.strictEqual(execCalls[0].args[4], repo, 'repo 必须紧跟在 --repo 之后');
    assert.strictEqual(execCalls[0].args[5], '--body', 'body 必须走 --body 参数位');
  });

  await asyncTest('带 shell 元字符的 body 仍作为单个 argv 传递（注入面回归）', async () => {
    resetExec();
    const body = 'a; rm -rf / && echo `whoami` $(id) "x" \'y\'';
    const { status } = await callRoute(commentRoute.handler, {
      payload: { repo: 'acme/demo', number: 7, body },
    });
    assert.strictEqual(status, 200);
    assert.strictEqual(execCalls.length, 1);
    assert.strictEqual(execCalls[0].args[6], body, '元字符必须原样留在第 7 个 argv 元素内');
    assert.strictEqual(execCalls[0].args.length, 7, '不得因元字符被拆成更多 argv');
  });

  await asyncTest('number 以字符串给出时归一化为十进制字符串', async () => {
    resetExec();
    const { status } = await callRoute(commentRoute.handler, {
      payload: { repo: 'acme/demo', number: '128', body: '内容' },
    });
    assert.strictEqual(status, 200, '数字字符串应被接受');
    assert.deepStrictEqual(execCalls[0].args, ['pr', 'comment', '128', '--repo', 'acme/demo', '--body', '内容']);
  });

  await asyncTest('body 分片送达（多个 data chunk）仍能完整收集', async () => {
    resetExec();
    const payload = { repo: 'acme/demo', number: 9, body: '分片投递的评论内容' };
    const text = JSON.stringify(payload);
    const chunks = [text.slice(0, 7), text.slice(7, 40), text.slice(40)];
    const { status } = await callRoute(commentRoute.handler, {
      url: '/api/github/pr-comment',
      chunks,
    });
    assert.strictEqual(status, 200, '分片 body 必须被正确拼接');
    assert.strictEqual(execCalls[0].args[6], payload.body, '分片拼接后 body 必须与原文一致');
  });

  await asyncTest('畸形 JSON body → 400（按缺字段处理，不得 500 崩）', async () => {
    resetExec();
    const { status } = await callRoute(commentRoute.handler, {
      url: '/api/github/pr-comment',
      raw: '{"repo":"acme/demo", 坏掉了',
    });
    assert.strictEqual(status, 400, '畸形 JSON 必须降级为 400');
    assert.strictEqual(execCalls.length, 0, '畸形请求绝不能触达 gh');
  });

  await asyncTest('gh 返回 { ok:false, error } → 502 并原样透出该 error', async () => {
    setExecResult({ ok: false, error: 'boom' });
    const { status, body } = await callRoute(commentRoute.handler, {
      payload: { repo: 'acme/demo', number: 128, body: '内容' },
    });
    assert.strictEqual(status, 502, '上游失败必须是 502 而不是 200');
    assert.strictEqual(body.ok, false, 'ok 必须为 false');
    assert.strictEqual(body.error, 'boom', '必须把 gh 的 error 原样透出，便于前端展示');
  });

  await asyncTest('gh 返回 { ok:false } 无 error → 502 并给出兜底文案', async () => {
    setExecResult({ ok: false });
    const { status, body } = await callRoute(commentRoute.handler, {
      payload: { repo: 'acme/demo', number: 128, body: '内容' },
    });
    assert.strictEqual(status, 502, '无 error 的上游失败同样 502');
    assert(typeof body.error === 'string' && body.error.length > 0, '必须给出可读兜底文案');
  });

  resetExec();

  // ============================================================
  // 二、POST /api/github/pr-inline-comment
  // ============================================================
  console.log('\n--- 2. /api/github/pr-inline-comment 路由契约 ---');

  test('路由已注册在 exact 表上，且 handler 为函数', () => {
    assert(inlineRoute, '/api/github/pr-inline-comment 必须由 registerApiRoutes 注册');
    assert.strictEqual(inlineRoute.kind, 'exact', '必须是 exact 路由');
    assert.strictEqual(typeof inlineRoute.handler, 'function', '必须有可调用 handler');
    assert(webServer.exact.has('/api/github/pr-inline-comment'), '必须落进 webServer.exact 路由表');
    assert(!webServer.prefixes.has('/api/github/pr-inline-comment'), '不得误注册为前缀路由');
    assert(webServer.registered.includes('/api/github/pr-inline-comment'), 'register() 必须真实收到该路径');
  });

  await asyncTest('GET → 405，且不执行任何 gh 命令', async () => {
    resetExec();
    const { status, body } = await callRoute(inlineRoute.handler, {
      url: '/api/github/pr-inline-comment',
      method: 'GET',
    });
    assert.strictEqual(status, 405, '写路由必须拒绝 GET');
    assert.strictEqual(body.ok, false);
    assert(typeof body.message === 'string' && body.message.includes('POST'), '错误信息必须点明仅支持 POST');
    assert.strictEqual(execCalls.length, 0, '405 必须在触达 gh 之前返回');
  });

  await asyncTest('repo 非法 → 400，且 exec 零调用', async () => {
    resetExec();
    for (const badRepo of ['acme', '-bad/repo', '', 'acme/', '/acme', 'acme/demo/extra']) {
      const { status, body } = await callRoute(inlineRoute.handler, {
        payload: { ...validInline(), repo: badRepo },
      });
      assert.strictEqual(status, 400, `repo=${JSON.stringify(badRepo)} 必须 400`);
      assert(typeof body.error === 'string' && body.error.includes('repo'), '错误必须点明 repo');
    }
    assert.strictEqual(execCalls.length, 0, '校验失败时绝不能先执行 gh');
  });

  await asyncTest('number 非法 → 400，且 exec 零调用', async () => {
    resetExec();
    for (const badNumber of [0, -1, 1.5, 'abc', undefined]) {
      const { status } = await callRoute(inlineRoute.handler, {
        payload: { ...validInline(), number: badNumber },
      });
      assert.strictEqual(status, 400, `number=${JSON.stringify(badNumber)} 必须 400`);
    }
    assert.strictEqual(execCalls.length, 0, '校验失败时绝不能先执行 gh');
  });

  await asyncTest('body 为空/纯空白 → 400', async () => {
    resetExec();
    for (const badBody of ['', '   ', undefined]) {
      const { status } = await callRoute(inlineRoute.handler, {
        payload: { ...validInline(), body: badBody },
      });
      assert.strictEqual(status, 400, `body=${JSON.stringify(badBody)} 必须 400`);
    }
    assert.strictEqual(execCalls.length, 0, '校验失败时绝不能先执行 gh');
  });

  await asyncTest('path 非法（空 / 纯空白 / 绝对路径 / 含 .. / 超 1024）→ 400', async () => {
    resetExec();
    const badPaths = ['', '   ', '/abs/x.go', 'a/../b.go', '..', 'x'.repeat(1100)];
    for (const badPath of badPaths) {
      const { status, body } = await callRoute(inlineRoute.handler, {
        payload: { ...validInline(), path: badPath },
      });
      assert.strictEqual(status, 400, `path 长度=${badPath.length} 的输入必须 400: ${JSON.stringify(badPath.slice(0, 24))}`);
      assert(typeof body.error === 'string' && body.error.includes('path'), '错误必须点明 path');
    }
    assert.strictEqual(execCalls.length, 0, '校验失败时绝不能先执行 gh');
  });

  await asyncTest('line 非法（0 / -1 / 1000001 / 非数字）→ 400', async () => {
    resetExec();
    for (const badLine of [0, -1, 1_000_001, 'x', undefined]) {
      const { status, body } = await callRoute(inlineRoute.handler, {
        payload: { ...validInline(), line: badLine },
      });
      assert.strictEqual(status, 400, `line=${JSON.stringify(badLine)} 必须 400`);
      assert(typeof body.error === 'string' && body.error.includes('line'), '错误必须点明 line');
    }
    assert.strictEqual(execCalls.length, 0, '校验失败时绝不能先执行 gh');
  });

  await asyncTest('commit_id 非法（空 / 6 位 / 65 位 / 非十六进制）→ 400', async () => {
    resetExec();
    for (const badSha of ['', 'xyz', '123', 'zzzzzzz', 'a'.repeat(65)]) {
      const { status, body } = await callRoute(inlineRoute.handler, {
        payload: { ...validInline(), commit_id: badSha },
      });
      assert.strictEqual(status, 400, `commit_id=${JSON.stringify(badSha)} 必须 400`);
      assert(typeof body.error === 'string' && body.error.includes('commit_id'), '错误必须点明 commit_id');
    }
    assert.strictEqual(execCalls.length, 0, '校验失败时绝不能先执行 gh');
  });

  await asyncTest('happy path：side 缺省 ⇒ RIGHT，argv 逐元素相等', async () => {
    resetExec();
    const payload = {
      repo: 'acme/demo',
      number: 128,
      body: '这一行需要加锁',
      path: 'src/lock.ts',
      line: 42,
      commit_id: SHA,
    };
    const { status, body: resBody } = await callRoute(inlineRoute.handler, { payload });

    assert.strictEqual(status, 200, '合法请求必须 200');
    assert.strictEqual(resBody.ok, true);
    assert.strictEqual(resBody.data.repo, 'acme/demo', '回吐 repo');
    assert.strictEqual(resBody.data.number, 128, '回吐 number');
    assert.strictEqual(resBody.data.path, 'src/lock.ts', '回吐 path');
    assert.strictEqual(resBody.data.line, 42, '回吐 line');
    assert.strictEqual(execCalls.length, 1, '只执行一次 gh');

    // 数组逐元素相等：REST 端点由 repo/number 拼出，其余字段走 -f / -F 参数位。
    // line 用 -F（数字）而非 -f（字符串），是 gh api 的类型语义，必须被锁住。
    assert.deepStrictEqual(execCalls[0].args, [
      'api',
      'repos/acme/demo/pulls/128/comments',
      '--method',
      'POST',
      '-f',
      'body=这一行需要加锁',
      '-f',
      'path=src/lock.ts',
      '-f',
      'side=RIGHT',
      '-F',
      'line=42',
      '-f',
      `commit_id=${SHA}`,
    ]);
    const argv = execCalls[0].args;
    assert.strictEqual(argv[0], 'api', '必须走 gh api 而不是其它子命令');
    assert.strictEqual(argv[2], '--method', '必须显式声明 --method');
    assert.strictEqual(argv[3], 'POST', '--method 的取值必须是 POST');
    assert.strictEqual(argv[argv.indexOf('line=42') - 1], '-F', 'line 必须走 -F 数字位');
  });

  await asyncTest("side:'LEFT' 原样透传（行内评论要能落在删除行上）", async () => {
    resetExec();
    const { status } = await callRoute(inlineRoute.handler, {
      payload: { ...validInline(), side: 'LEFT' },
    });
    assert.strictEqual(status, 200);
    assert(execCalls[0].args.includes('side=LEFT'), 'LEFT 必须原样传递');
    assert(!execCalls[0].args.includes('side=RIGHT'), '不得把 LEFT 改写成 RIGHT');
  });

  await asyncTest('side 为其它值（含小写）一律回落 RIGHT', async () => {
    resetExec();
    for (const side of ['MIDDLE', 'left', '', null, undefined]) {
      resetExec();
      const { status } = await callRoute(inlineRoute.handler, {
        payload: { ...validInline(), side },
      });
      assert.strictEqual(status, 200, `side=${JSON.stringify(side)} 应被视为缺省而非报错`);
      assert(execCalls[0].args.includes('side=RIGHT'), `side=${JSON.stringify(side)} 必须回落 RIGHT`);
    }
  });

  await asyncTest('行内评论的 path 元字符不被拆分（单 argv 回归）', async () => {
    resetExec();
    const filePath = 'src/weird name;$(id).ts';
    const { status } = await callRoute(inlineRoute.handler, {
      payload: { ...validInline(), path: filePath },
    });
    assert.strictEqual(status, 200);
    assert(execCalls[0].args.includes(`path=${filePath}`), 'path 必须整体作为单个 argv 元素');
    assert.strictEqual(execCalls[0].args.length, 14, '不得因元字符产生额外 argv');
  });

  await asyncTest('gh 返回 { ok:false, error } → 502 并原样透出该 error', async () => {
    setExecResult({ ok: false, error: 'boom' });
    const { status, body } = await callRoute(inlineRoute.handler, { payload: validInline() });
    assert.strictEqual(status, 502, '上游失败必须 502');
    assert.strictEqual(body.ok, false);
    assert.strictEqual(body.error, 'boom', '必须透出 gh 的原始 error');
  });

  await asyncTest('畸形 JSON body → 400（不得 500 崩）', async () => {
    resetExec();
    const { status } = await callRoute(inlineRoute.handler, {
      url: '/api/github/pr-inline-comment',
      raw: 'not json at all',
    });
    assert.strictEqual(status, 400, '畸形 JSON 必须降级为 400');
    assert.strictEqual(execCalls.length, 0, '畸形请求绝不能触达 gh');
  });

  resetExec();

  // ============================================================
  // 三、lib/api/routes-actions.js 静态契约
  // ============================================================
  console.log('\n--- 3. lib/api/routes-actions.js 静态契约 ---');

  const actionsSrc = fs.readFileSync(path.join(__dirname, '../lib/api/routes-actions.js'), 'utf8');

  test('pr-view 的 --json 字段表包含 headRefOid（行内评论 commit_id 的来源）', () => {
    // 抓出所有 `'--json', 'field,field,...'` 的参数对，逐条检查
    const lists = [];
    const re = /'--json',\s*'([^']+)'/g;
    let m;
    while ((m = re.exec(actionsSrc)) !== null) lists.push(m[1]);
    assert(lists.length > 0, 'routes-actions.js 至少应有一处 --json 字段表');

    // 2026-10-21：详情字段拆成 coreFields 常量 + withThread 分支（thread 单独请求），
    // 因此字段表不再是单个字面量。这里把常量也纳入候选，并额外要求 thread 分支存在。
    const coreMatch = actionsSrc.match(/const coreFields = '([^']+)'/);
    assert(coreMatch, 'pr-detail 必须保留 coreFields 字段常量');
    const coreFields = coreMatch[1].split(',').map((s) => s.trim());
    for (const required of ['headRefName', 'headRefOid', 'statusCheckRollup', 'reviewDecision', 'mergeStateStatus', 'autoMergeRequest']) {
      assert(coreFields.includes(required), `coreFields 必须包含 ${required}（前端据此渲染，缺一会退化成白屏）`);
    }
    assert(/withThread \? `\$\{coreFields\},commits,files,reviews,comments`/.test(actionsSrc),
      'withThread 分支必须补上 commits/files/reviews/comments');
    assert(actionsSrc.includes("'--json', 'reviews,comments,commits'"),
      '/api/github/pr-thread 必须单独取 reviews,comments,commits');
    assert(!/\s/.test(coreMatch[1].replace(/,/g, '')), '--json 字段表不得含空格（gh 按逗号解析）');
  });

  test('pr-detail 支持显式 repo query：显式 repo 时不再解析工作区仓库', () => {
    const start = actionsSrc.indexOf("path: '/api/github/pr-detail'");
    assert(start > 0, '必须存在 /api/github/pr-detail 路由');
    const nextRoute = actionsSrc.indexOf("path: '/api/github/", start + 10);
    const detailSrc = actionsSrc.slice(start, nextRoute > 0 ? nextRoute : actionsSrc.length);

    assert(detailSrc.includes("searchParams.get('repo')"), '必须从 query 读取 repo');
    assert(detailSrc.includes('explicitRepo'), '必须有 explicitRepo 判定（显式 repo 与工作区仓库二选一）');
    // 关键语义：显式 repo 时 repoRoot 必须为 null，避免用工作区仓库去解析别人的 PR 编号
    assert(
      /explicitRepo\s*\?\s*null\s*:\s*executor\.resolveWorkspaceRepoRoot/.test(detailSrc),
      '显式 repo 时不得解析工作区仓库（同名编号会张冠李戴）',
    );
    // 显式 repo 必须真的拼进 gh 参数
    assert(
      /repoArgs\s*=\s*explicitRepo\s*\?\s*\['--repo',\s*explicitRepo\]\s*:\s*\[\]/.test(detailSrc),
      '显式 repo 必须拼成 --repo owner/repo',
    );
    assert(detailSrc.includes('...repoArgs'), 'pr view / pr diff 都必须带上 repoArgs');
    assert(detailSrc.includes('headRefOid'), 'pr-detail 的字段表必须含 headRefOid');
    assert(!detailSrc.includes('repoRoot.root ='), '不得把工作区根硬塞给显式 repo 场景');
  });

  test('两条写路由的校验必须发生在 executor.run 之前（先验后写）', () => {
    const sliceRoute = (routePath) => {
      const start = actionsSrc.indexOf(`path: '${routePath}'`);
      assert(start > 0, `必须存在路由 ${routePath}`);
      const next = actionsSrc.indexOf("path: '/api/github/", start + 10);
      return actionsSrc.slice(start, next > 0 ? next : actionsSrc.length);
    };

    const commentSrc = sliceRoute('/api/github/pr-comment');
    const commentBodyIdx = commentSrc.indexOf("['pr', 'comment'");
    assert(commentBodyIdx > 0, 'pr-comment 必须调用 gh pr comment');
    for (const guard of ['REPO_ARG_RE.test(repo)', 'Number.isInteger(number)', 'body.length > MAX_COMMENT_CHARS']) {
      assert(commentSrc.indexOf(guard) < commentBodyIdx, `${guard} 必须早于 gh 调用（否则非法输入会先落库）`);
    }

    const inlineSrc = sliceRoute('/api/github/pr-inline-comment');
    const inlineCallIdx = inlineSrc.indexOf('repos/${repo}/pulls/${number}/comments');
    assert(inlineCallIdx > 0, 'pr-inline-comment 必须调用 REST 端点');
    for (const guard of ['filePath.startsWith', "filePath.includes('..')", 'Number.isInteger(line)', "commitId"]) {
      assert(inlineSrc.indexOf(guard) < inlineCallIdx, `${guard} 校验必须早于 gh 调用`);
    }
    assert(inlineSrc.includes("'-F'"), 'line 必须走 -F（数字）参数位');
  });

  console.log('\n========================================');
  console.log(`Phase 23 Test Result: ${passed}/${total} PASSED`);
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
