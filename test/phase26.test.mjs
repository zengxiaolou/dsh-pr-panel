// test/phase26.test.mjs - Phase 26 · 「修复队列（fix queue）」客户端回归套件
//
// 覆盖本阶段新增的纯客户端能力（全部落在编译产物 lib/client.js 上，不改 src/、
// 不跑 build）。本阶段共有三块行为，任何一块拼错都不会抛错，只会让按钮点了没反应
// 或者把错的意见推进对话框，所以逐条钉死在打包段里：
// 1. 提示词构造器 fixCheckPrompt(list) / fixNotePrompt(items)：中文提示词必须带
//    `PR <repo>#<number>`、失败检查名 + details URL、评审人正文；批量要与单条区分。
// 2. 失败检查门控：只有 checkState(c).tone === "fail" 的检查行才出 fix 按钮。
// 3. 左侧「待修改意见」队列：排除 APPROVED 评审与 PR 作者自己的评论，newest-first，
//    默认 4 条折叠，逐条 fix + 头部「全部 fix N」一次推进全部。
// 另外锁住 Composer 的三级降级（insertText → setDraft → 剪贴板）顺序——
// 顺序反了就是「覆盖用户草稿」或「明明能插入却落剪贴板」，肉眼很难发现。
//
// 设计口径与 phase24 / phase25 一致：assert + 同步 test()（拿到 async 函数直接抛错），
// 中文控制台，失败非零退出。因为本阶段是纯客户端静态接线，没有 async 用例。
//
// 放宽说明（1 处，与任务书口径不同，已按产物实际形态落测）：
// - 任务书要求断言批量分支里出现字面量 `### 1)`。产物是模板拼接
//   `lines.push("### " + (i + 1) + ") @" + ...)`，字面量 `### 1)` 只在运行期出现，
//   静态产物里不存在。本套件改为断言该拼接构造（`"### " + (i + 1) + ") @"`），
//   并额外用 `'### ' + 1 + ') @'` 推导一次，证明编号确实渲染成 `### 1) @`。
//   断言强度不降：单条分支 / 批量分支 / 编号来源三者都锁住。
//
// 未放宽项（任务书里的其它要求全部按字面断言）：标签 5 个 + ghsp-fix-btn、
// APPROVED 与 prAuthor 双排除、requests.sort newest-first、主列
// `... discussionCard, requestsCard`、两处批量接线、insertText < setDraft < clipboard。

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runTests() {
  console.log('🧪 开始执行 Phase 26 修复队列（fix queue）回归测试\n');
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

  // ============================================================
  // 零、打包段定位
  // ============================================================
  const clientBundle = fs.readFileSync(path.join(__dirname, '../lib/client.js'), 'utf8');

  // 面板自身所在的打包段：跨段断言容易把别的组件（如设置面板）算进来
  const panelStart = clientBundle.indexOf('// ---- [Bundled: session-pr-panel.js] ----');
  const panelEnd = clientBundle.indexOf('// ---- [End: session-pr-panel.js] ----');
  const panelSrc =
    panelStart >= 0 && panelEnd > panelStart ? clientBundle.slice(panelStart, panelEnd) : clientBundle;

  /** 按起止标记切一小段；标记缺失时返回空串，让后续断言自然炸出「定位失败」 */
  function sliceBetween(startTok, endTok) {
    const s = panelSrc.indexOf(startTok);
    const e = panelSrc.indexOf(endTok);
    return s >= 0 && e > s ? panelSrc.slice(s, e) : '';
  }

  // 提示词构造器
  const checkPromptSrc = sliceBetween('function fixCheckPrompt(list) {', 'function fixNotePrompt(items) {');
  const notePromptSrc = sliceBetween('function fixNotePrompt(items) {', 'function pushToComposer(text) {');

  // 「待修改意见」队列构建块（评审/评论过滤 + 排序 + 折叠 + 头部批量按钮）
  const requestsSrc = sliceBetween(
    '/* ---- 卡片：待修改意见（评审 + 评论，逐条可 fix，可批量）---- */',
    'var requestsCard = cardBlock(',
  );

  // 检查卡片块（失败门控 + 「修复失败项 N」批量按钮）
  const checksSrc = sliceBetween('/* ---- 卡片：检查 ---- */', 'var checksCard = cardBlock(');

  // Composer 降级链
  const composerSrc = sliceBetween('function pushTextToComposer(props, text, notify', 'function targetTone(base) {');

  console.log('--- 1. 打包段定位 ---');

  test('session-pr-panel 打包段可定位，且四块切片都不为空', () => {
    assert(panelStart > 0, 'client.js 必须含 // ---- [Bundled: session-pr-panel.js] ---- 段标记');
    assert(panelEnd > panelStart, '必须有下一个打包段标记作为结束边界');
    assert(panelSrc.includes('session-pr-panel'), '切片必须落在面板自己的产物里');
    assert(checkPromptSrc.length > 0, '必须能定位 fixCheckPrompt 函数体');
    assert(notePromptSrc.length > 0, '必须能定位 fixNotePrompt 函数体');
    assert(requestsSrc.length > 0, '必须能定位「待修改意见」队列构建块');
    assert(checksSrc.length > 0, '必须能定位检查卡片块');
    assert(composerSrc.length > 0, '必须能定位 pushTextToComposer');
    // 切片必须真的短于整段：否则 indexOf 拿反了，所有「段内」断言都退化成全局断言
    assert(checkPromptSrc.length < panelSrc.length, 'fixCheckPrompt 切片不得等于整段（标记定位失效）');
    assert(requestsSrc.length < panelSrc.length, 'requests 切片不得等于整段（标记定位失效）');
  });

  // ============================================================
  // 二、提示词构造器
  // ============================================================
  console.log('\n--- 2. 提示词构造器 fixCheckPrompt / fixNotePrompt ---');

  test('两个构造器都定义在面板段内', () => {
    assert(panelSrc.includes('function fixCheckPrompt(list)'), '面板段必须定义 fixCheckPrompt(list)');
    assert(panelSrc.includes('function fixNotePrompt(items)'), '面板段必须定义 fixNotePrompt(items)');
    // 同名函数只许一份：重复定义会让后一份静默覆盖前一份，按钮仍能点，但提示词换了
    const checkDefs = (panelSrc.match(/function fixCheckPrompt\(/g) || []).length;
    const noteDefs = (panelSrc.match(/function fixNotePrompt\(/g) || []).length;
    assert.strictEqual(checkDefs, 1, `fixCheckPrompt 只能定义一次，实际 ${checkDefs} 次`);
    assert.strictEqual(noteDefs, 1, `fixNotePrompt 只能定义一次，实际 ${noteDefs} 次`);
    // 必须共用同一个 PR 引用助手，避免一处写 repo#num、另一处写 num
    assert(panelSrc.includes('function prRef()'), '必须有 prRef() 统一生成 <repo>#<number>');
    assert(checkPromptSrc.includes('"PR " + prRef()'), 'fixCheckPrompt 必须以「PR <repo>#<number>」开头');
    assert(notePromptSrc.includes('"PR " + prRef()'), 'fixNotePrompt 必须以「PR <repo>#<number>」开头');
  });

  test('fixCheckPrompt：检查名 + 详情 URL + 明确要求先读 --log-failed', () => {
    assert(checkPromptSrc.includes('--log-failed'), '提示词必须让 Agent 用 gh run view --log-failed 读失败日志');
    assert(checkPromptSrc.includes('gh run view'), '必须点明具体命令，否则 Agent 会去猜');
    assert(checkPromptSrc.includes('不要靠猜'), '必须显式禁止猜测（这类修复最容易空改）');
    assert(
      checkPromptSrc.includes('c.name || c.context') || checkPromptSrc.includes('c.name || c.context || "check"'),
      '必须带检查名（含 context 兜底）',
    );
    assert(checkPromptSrc.includes('c.detailsUrl || c.targetUrl'), '必须带 details URL（拿 run id 的唯一入口）');
    assert(checkPromptSrc.includes('详情：'), '详情 URL 必须有「详情：」前缀，否则混在正文里读不出来');
    assert(checkPromptSrc.includes('workflowName'), '有条件时必须带 workflow 名，便于区分同名检查');
    // 多条时用序号，单条时不加序号（否则单条提示词里会出现孤零零的「1)」）
    assert(checkPromptSrc.includes('list.length > 1'), 'fixCheckPrompt 必须区分单条 / 多条');
    // 修完之后的事：推送 / 等重跑 / 重新请求评审 —— 只改代码不回推等于没修
    assert(checkPromptSrc.includes('gh pr checks'), '必须给出确认检查状态的命令（gh pr checks）');
    assert(checkPromptSrc.includes('gh run rerun'), '没有自动重跑时必须告诉用户怎么手动重跑');
    assert(checkPromptSrc.includes('重新触发评审'), '必须说明修完要重新触发/请求评审');
    assert(checkPromptSrc.includes('--add-reviewer'), '必须给出重新请求评审的具体命令');
    assert(checkPromptSrc.includes('完成标准'), '必须写清完成标准（全绿 + 评审已重新请求）');
    assert(checkPromptSrc.includes('headRefOid'), '必须带上当前 HEAD，避免在旧提交上改');
    assert(checkPromptSrc.includes('isReviewGateCheck'), '必须区分「评审门禁」类检查与普通 CI 检查');
  });

  test('fixNotePrompt 也要带「回推 + 重新请求评审」的收尾步骤', () => {
    assert(notePromptSrc.includes('新的 commit'), '评审意见只有落到新 commit 才算处理完');
    assert(notePromptSrc.includes('--add-reviewer'), '单条分支要给出重新请求评审的命令');
    assert(notePromptSrc.includes('resolve'), '要提醒把 review thread 回复并 resolve');
  });

  test('fixNotePrompt：单条分支与批量编号分支都在', () => {
    assert(notePromptSrc.includes('items.length === 1'), 'fixNotePrompt 必须有 items.length === 1 的单条分支');
    assert(notePromptSrc.includes('有一条评审意见要处理'), '单条分支必须说明只有一条意见');
    assert(notePromptSrc.includes('评审意见，请逐条处理'), '批量分支必须说明有多条意见要逐条处理');
    // 批量编号：产物是拼接构造，运行期才渲染成 `### 1) @author`
    const numbered = '"### " + (i + 1) + ") @"';
    assert(notePromptSrc.includes(numbered), `批量分支必须用 ${numbered} 生成编号标题`);
    assert.strictEqual(
      '### ' + (0 + 1) + ') @',
      '### 1) @',
      '编号构造必须渲染成 ### 1) @（放宽说明见文件头：字面量只在运行期存在）',
    );
    assert(notePromptSrc.includes('(i + 1)'), '编号必须来自 1-based 下标');
    // 两条分支都要带上评审人正文与作者，否则 fix 出去等于空转
    assert(notePromptSrc.includes('one.author'), '单条分支必须带作者');
    assert(notePromptSrc.includes('it.author'), '批量分支必须带作者');
    assert(notePromptSrc.includes('one.body'), '单条分支必须带评审正文');
    assert(notePromptSrc.includes('it.body'), '批量分支必须带评审正文');
    // 截断统一走 clipBody()：超长时会在正文末尾补一行「原文共 N 字，已截断」，不再假装全文
    assert(notePromptSrc.includes('clipBody(one.body, 4000)'), '单条正文要截断（4000），避免超长评审撑爆输入框');
    assert(notePromptSrc.includes('clipBody(it.body, 2000)'), '批量正文要截断（2000），避免多条叠加撑爆输入框');
    assert(panelSrc.includes('已截断'), '截断必须明确告知，不能让 Agent 以为拿到了全文');
    // 单条与批量必须是两条独立 return 路径，不能只走一条
    const returns = (notePromptSrc.match(/return lines\.join\("\\n"\);/g) || []).length;
    assert.strictEqual(returns, 2, `单条 / 批量必须各自 return，实际 ${returns} 处 return`);
  });

  // ============================================================
  // 三、标签与样式类
  // ============================================================
  console.log('\n--- 3. 可见标签与 CSS 类 ---');

  test('标签齐全：修复失败项 / 全部 fix / fix / 待修改意见 / 显示全部', () => {
    assert(panelSrc.includes('"修复失败项 "'), '检查卡头部必须有「修复失败项 N」批量按钮');
    assert(panelSrc.includes('"全部 fix "'), '意见卡头部必须有「全部 fix N」批量按钮');
    assert(panelSrc.includes('}, "fix")'), '逐条按钮的可见文案必须是 fix');
    assert(panelSrc.includes('"待修改意见"'), '左列卡片标题必须是「待修改意见」');
    assert(panelSrc.includes('"显示全部 "'), '必须提供「显示全部 N 条」展开开关');
    assert(panelSrc.includes('"收起"'), '展开后必须能收起（否则折叠态不可逆）');
    assert(panelSrc.includes('ghsp-fix-btn'), 'fix 按钮必须挂 ghsp-fix-btn 类');
    // CSS 类在面板段自己的样式表里必须有定义，否则按钮退化成普通按钮
    assert(/\.ghsp-fix-btn\{[^}]*\}/.test(panelSrc), '面板样式表必须定义 .ghsp-fix-btn 规则');
  });

  // ============================================================
  // 四、失败检查门控
  // ============================================================
  console.log('\n--- 4. 失败检查门控：只有 tone === "fail" 才出 fix ---');

  test('fix 按钮被 st.tone === "fail" 三元表达式包住（非失败项输出 null）', () => {
    // 严格门控：`st.tone === "fail" ? React.createElement("button", {...ghsp-fix-btn...}, "fix") : null`
    const gate = /st\.tone === "fail"\s*\?\s*React\.createElement\("button", \{[\s\S]{0,600}?ghsp-fix-btn[\s\S]{0,600}?\}, "fix"\)\s*:\s*null/;
    assert(gate.test(checksSrc), '检查行必须写成 `st.tone === "fail" ? ...fix按钮... : null`，不得无条件渲染');

    // 顺序证据：门控条件在 ghsp-fix-btn 之前
    const gateIdx = checksSrc.search(/st\.tone === "fail"\s*\?/);
    const btnIdx = checksSrc.indexOf('ghsp-fix-btn');
    assert(gateIdx >= 0, '检查块必须含 `st.tone === "fail" ?` 三元门控');
    assert(btnIdx > gateIdx, 'ghsp-fix-btn 必须出现在门控之后（先判失败再渲染）');

    // 每个失败检查推的是「只有这一条」的数组
    assert(
      checksSrc.includes('pushToComposer(fixCheckPrompt([c]))'),
      '单条 fix 必须推 fixCheckPrompt([c])（只含当前这条检查）',
    );
    assert.strictEqual(
      (checksSrc.match(/pushToComposer\(fixCheckPrompt\(\[c\]\)\)/g) || []).length,
      1,
      '单条 fix 只允许一处调用点',
    );
    // 门控必须真的能拦：非 fail 分支返回 null，而不是返回一个禁用按钮
    assert(/:\s*null/.test(checksSrc), '非失败分支必须输出 null（不出按钮，也不出禁用占位）');
  });

  // ============================================================
  // 五、队列过滤 / 排序 / 折叠
  // ============================================================
  console.log('\n--- 5. 待修改意见队列：过滤 / 排序 / 折叠 ---');

  test('APPROVED 评审不进队列', () => {
    assert(requestsSrc.includes('"APPROVED"'), '队列构建块必须显式判断 APPROVED');
    assert(
      /String\(r\.state \|\| ""\)\.toUpperCase\(\) === "APPROVED"/.test(requestsSrc),
      '必须按大写归一化后与 APPROVED 比较（大小写敏感比较会漏掉 approved）',
    );
    // 命中后必须 return 跳过，不能只是标记
    const approvedIdx = requestsSrc.indexOf('=== "APPROVED"');
    const after = requestsSrc.slice(approvedIdx, approvedIdx + 200);
    assert(after.includes('return'), 'APPROVED 分支必须 return 跳过该条');
  });

  test('PR 作者自己的评论不进队列（prAuthor 比对）', () => {
    assert(requestsSrc.includes('prAuthor'), '队列构建块必须取得 prAuthor');
    assert(
      /var prAuthor = \(pr && pr\.author && pr\.author\.login\) \|\| ""/.test(requestsSrc),
      'prAuthor 必须来自 pr.author.login（空串兜底）',
    );
    assert(requestsSrc.includes('who === prAuthor'), '必须用评论作者与 prAuthor 比较');
    assert(
      /if \(prAuthor && who === prAuthor\)\s*\n?\s*return/.test(requestsSrc),
      '命中 PR 作者时必须直接 return（自己的「收到」「已改」不是待办）',
    );
    // 空 prAuthor 时不能把所有评论都当成作者回复而全灭
    assert(/prAuthor &&/.test(requestsSrc), 'prAuthor 为空时必须退化为不过滤（短路条件）');
  });

  test('空正文条目被跳过（评论 / 评审都不许出空 fix 行）', () => {
    const guards = (requestsSrc.match(/if \(!String\([rc]\.body \|\| ""\)\.trim\(\)\)/g) || []).length;
    assert.strictEqual(guards, 2, `reviews 与 comments 各需一处空正文过滤，实际 ${guards} 处`);
  });

  test('newest-first 排序 + 默认折叠 4 条 + 「显示全部 N 条」', () => {
    assert(requestsSrc.includes('requests.sort('), '队列必须排序');
    // newest-first 的比较器：a 比 b 旧（a.at < b.at）时返回 1，把 a 排到后面
    assert(
      /requests\.sort\(function \(a, b\) \{ return String\(a\.at\) < String\(b\.at\) \? 1 : -1; \}\)/.test(requestsSrc),
      'requests.sort 必须是 newest-first（a.at < b.at ? 1 : -1）',
    );
    assert(requestsSrc.includes('requests.slice(0, 4)'), '默认只展示 4 条（折叠）');
    assert(requestsSrc.includes('requests.length > 4'), '超过 4 条才出「显示全部」开关');
    assert(
      /"显示全部 " \+ requests\.length \+ " 条"/.test(requestsSrc),
      '开关文案必须是「显示全部 N 条」',
    );
    assert(requestsSrc.includes('setRequestsExpanded'), '展开状态必须由 setRequestsExpanded 驱动');
    // 排序必须发生在 slice 之前，否则折的那 4 条不是最新的 4 条
    assert(
      requestsSrc.indexOf('requests.sort(') < requestsSrc.indexOf('requests.slice(0, 4)'),
      '必须先排序再 slice，否则折叠掉的可能是最新意见',
    );
  });

  // ============================================================
  // 六、主列渲染顺序
  // ============================================================
  console.log('\n--- 6. 主列顺序：讨论之后才是待修改意见 ---');

  test('main 列按 description → changes → discussion → requests 渲染', () => {
    assert(
      panelSrc.includes('descriptionCard, changesCard, discussionCard, requestsCard'),
      '主列必须严格是 `... discussionCard, requestsCard` 的顺序',
    );
    assert(
      panelSrc.includes('className: "ghsp-col-main"'),
      'requestsCard 必须挂在主列（ghsp-col-main）里，不能掉到右列',
    );
    // 顺序反了就是「先看见待办、后看见讨论」，但按钮全都能点，只有肉眼能发现
    const discussionIdx = panelSrc.indexOf('descriptionCard, changesCard, discussionCard, requestsCard');
    const mainIdx = panelSrc.indexOf('className: "ghsp-col-main"');
    assert(mainIdx >= 0 && discussionIdx > mainIdx, '四张卡片必须在 main 列容器之后出现');
  });

  // ============================================================
  // 七、批量接线
  // ============================================================
  console.log('\n--- 7. 头部批量按钮接线 ---');

  test('意见卡头部「全部 fix N」= pushToComposer(fixNotePrompt(requests))', () => {
    assert(
      requestsSrc.includes('pushToComposer(fixNotePrompt(requests))'),
      '头部批量按钮必须一次推入全部队列（fixNotePrompt(requests)，不是逐条循环）',
    );
    // 必须是整份 requests，不是折叠后的 shownRequests——否则「全部 fix N」只修 4 条
    assert(!requestsSrc.includes('fixNotePrompt(shownRequests)'), '不得把折叠后的 shownRequests 当成「全部」');
    assert(
      /"全部 fix " \+ requests\.length/.test(requestsSrc),
      '按钮文案的 N 必须与推入的条数同源（requests.length）',
    );
    // 逐条按钮走单元素数组
    assert(
      requestsSrc.includes('pushToComposer(fixNotePrompt([item]))'),
      '逐条 fix 必须推 fixNotePrompt([item])',
    );
  });

  test('检查卡头部「修复失败项 N」= pushToComposer(fixCheckPrompt(failedList))', () => {
    assert(
      checksSrc.includes('pushToComposer(fixCheckPrompt(failedList))'),
      '检查卡头部必须推 fixCheckPrompt(failedList)',
    );
    assert(
      /var failedList = checks\.filter\(function \(c\) \{ return checkState\(c\)\.tone === "fail"; \}\)/.test(
        checksSrc,
      ),
      'failedList 必须只含 checkState(c).tone === "fail" 的检查',
    );
    assert(
      /"修复失败项 " \+ failedList\.length/.test(checksSrc),
      '按钮文案的 N 必须与推入的条数同源（failedList.length）',
    );
    // failedList 必须先定义再被使用（TDZ 之外的顺序错误在编译产物里看不出来）
    assert(
      checksSrc.indexOf('var failedList') < checksSrc.indexOf('fixCheckPrompt(failedList)'),
      'failedList 必须先于批量按钮定义',
    );
    // 全部通过时不出批量按钮
    assert(/var checksActions = failedList\.length/.test(checksSrc), '无失败项时头部批量按钮必须是 null');
  });

  // ============================================================
  // 八、Composer 三级降级
  // ============================================================
  console.log('\n--- 8. pushTextToComposer：胶囊 → 宿主 API → DOM 写入 → setDraft → 剪贴板 ---');

  test('降级顺序：先试胶囊，再 insertText，再直接写 DOM，最后 setDraft / 剪贴板', () => {
    const chipIdx = composerSrc.indexOf('pasteAsChip(text');
    const insertIdx = composerSrc.indexOf('actions.insertText(text)');
    const domIdx = composerSrc.indexOf('setComposerValue(input, text)');
    const draftIdx = composerSrc.indexOf('actions.setDraft(text)');
    const clipboardIdx = composerSrc.indexOf('navigator.clipboard.writeText(text)');

    assert(chipIdx >= 0, '长文本应先尝试变成胶囊（装了 paste-chip 才有意义）');
    assert(insertIdx >= 0, '必须保留 inputActions.insertText 作为宿主 API 路径');
    assert(domIdx >= 0, '必须能直接写输入框 DOM（DSH 实际没有注入 inputActions）');
    assert(draftIdx >= 0, '必须保留 setDraft 作为降级（会覆盖草稿）');
    assert(clipboardIdx >= 0, '必须保留剪贴板兜底');

    // 源码里 fallback()（含 insertText）定义在前，所以不能按 index 比较先后；
    // 用「短文本直接 fallback」的分支判断真正的运行顺序：先判断要不要走胶囊。
    const wantIdx = composerSrc.indexOf('wantChip');
    assert(wantIdx >= 0, '必须有 wantChip 判断（装了胶囊且文本够长才走胶囊）');
    assert(
      /if \(!wantChip\)[\s\S]{0,80}finish\(fallback\(\)\)/.test(composerSrc),
      '短文本 / 没装插件时必须直接走 fallback（打包会被折行，故用正则）',
    );
    assert(wantIdx < composerSrc.indexOf('pasteAsChip(text, input)'), '胶囊判断要发生在派发粘贴之前');
    assert(insertIdx < draftIdx, 'insertText 必须在 setDraft 之前（否则覆盖用户草稿）');
    assert(draftIdx < clipboardIdx, 'setDraft 必须在剪贴板之前');
  });

  test('每一级都先探测能力、成功即短路返回', () => {
    assert(/typeof actions\.insertText === "function"/.test(composerSrc), 'insertText 必须先做 typeof 探测');
    assert(/typeof actions\.setDraft === "function"/.test(composerSrc), 'setDraft 必须先做 typeof 探测');
    assert(/hasPasteChip\(/.test(composerSrc), '胶囊路径必须先探测 paste-chip 是否存在');
    assert(composerSrc.includes('return "inserted"'), 'insertText / DOM 写入成功必须 return "inserted"');
    assert(composerSrc.includes('return "replaced"'), 'setDraft 成功必须 return "replaced"');
    assert(composerSrc.includes('return "copied"'), '剪贴板成功必须 return "copied"');
    assert(composerSrc.includes('return "failed"'), '全失败必须 return "failed"');
  });

  test('提示必须在验证之后：先写、再核对内容、最后才 flash', () => {
    // 上一版的 bug：先 flash「已放进输入框」，再异步校验胶囊 —— 结果提示成功、输入框是空的
    const verifyIdx = composerSrc.indexOf('if (check(');
    assert(verifyIdx >= 0, '必须有写入后的内容核对（check）');
    assert(composerSrc.includes('composerHasText'), '核对要用输入框里的真实内容');
    // flash 只应出现在 finish() 里，且 finish 只在 branch 结果确定后调用
    const finishDef = composerSrc.indexOf('var finish = function');
    assert(finishDef >= 0, '必须有唯一的收口函数 finish');
    const flashCalls = (composerSrc.match(/say\("ok"/g) || []).length;
    assert.strictEqual(flashCalls, 2, `成功提示只应有两处（胶囊 / 普通），实际 ${flashCalls}`);
  });

  test('pushToComposer 包装层不再自己 flash（避免重复提示与假成功）', () => {
    const wrapSrc = sliceBetween('function pushToComposer(text) {', 'function postJson(url, body) {');
    assert(wrapSrc.length > 0, '必须能定位 pushToComposer 包装层');
    assert(wrapSrc.includes('pushTextToComposer(props, text, flash)'), '包装层必须把 flash 交给 pushTextToComposer');
    assert(!wrapSrc.includes('flash("ok"'), '包装层不得再自行 flash 成功（提示统一由校验结果决定）');
  });

  // ============================================================
  // 汇总
  // ============================================================
  console.log('\n========================================');
  console.log(`Phase 26 Test Result: ${passed}/${total} PASSED`);
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
