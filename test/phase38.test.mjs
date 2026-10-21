// test/phase38.test.mjs - Phase 38 · 冷启动快照（重启后浮窗立刻有内容）
//
// 痛点：重启 DSH 后第一次打开浮窗要等一次完整聚合（≈1.5s，网络差更久）。
// 现在把上一次成功结果落盘，重启后的第一拍直接返回快照（实测 1ms），
// 下一拍轮询再换成真数据——用「最多一个轮询周期的旧值」换「立刻出现」。
//
// 用两个子进程模拟「重启」：子进程里用桩执行器（不触网），断言
// 1. 第一次调用 fromSnapshot=false，且磁盘写下了快照；
// 2. 第二个进程（新进程 = 重启）调用 fromSnapshot=true 且 items 完整；
// 3. 带 refresh=1 时不走快照（用户明确要新数据）；
// 4. 快照文件损坏时不能 500（当作没有快照）。

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

let pass = 0; let total = 0; const fails = [];
function ok(cond, name) { total += 1; if (cond) pass += 1; else { fails.push(name); console.error('❌ ' + name); } }

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ghsnap-'));
const scriptPath = path.join(home, 'probe.mjs');
fs.writeFileSync(scriptPath, `
const { registerApiRoutes } = await import(${JSON.stringify(path.join(repoRoot, 'lib/api/routes.js'))});
const { recordCreatedPr } = await import(${JSON.stringify(path.join(repoRoot, 'lib/session-pr-tracker.js'))});
const routes = new Map();
const webServer = { exact: new Map(), prefixes: new Map(), register(r) { (r.kind === 'exact' ? this.exact : this.prefixes).set(r.path, r); routes.set(r.path, r); return () => {}; } };
let calls = 0;
const stub = { async run(args) {
  calls += 1;
  if (args.includes('graphql')) return { ok: true, data: { data: { repository: { p0: {
    number: 3975, title: 'snapshot PR', state: 'MERGED', isDraft: false, url: 'u', author: { login: 'u' },
    baseRefName: 'development', headRefName: 'h', additions: 3, deletions: 1, changedFiles: 1, reviewDecision: '',
    statusCheckRollup: { state: 'SUCCESS' }, createdAt: '', updatedAt: '', mergedAt: '',
  } } } } };
  return { ok: true, data: { number: 3975, title: 'fallback', state: 'OPEN' } };
} };
registerApiRoutes({ webServer }, stub, undefined, 15000);
const sid = 'phase38-session';
recordCreatedPr(sid, 'https://github.com/acme/demo/pull/3975', 'tool');
const url = process.argv[2];
const t0 = Date.now();
let out = '';
const res = { statusCode: 0, setHeader() {}, end(c) { out += c; } };
await routes.get('/api/github/session-created-prs').handler({ method: 'GET', url }, res);
const json = JSON.parse(out);
console.log(JSON.stringify({ status: res.statusCode, ms: Date.now() - t0, fromSnapshot: Boolean(json.data && json.data.fromSnapshot), total: json.data && json.data.total, calls }));
`, 'utf8');

function runProbe(query) {
  const stdout = execFileSync(process.execPath, [scriptPath, `/api/github/session-created-prs?sessionId=phase38-session${query}`], {
    env: { ...process.env, HOME: home },
    encoding: 'utf8',
    timeout: 60_000,
  });
  return JSON.parse(stdout.trim().split('\n').pop());
}

/* 1. 第一次：真实聚合 + 落盘 */
const first = runProbe('');
ok(first.status === 200, '第一次必须 200');
ok(first.fromSnapshot === false, '第一次不该来自快照（此时还没有快照）');
ok(first.calls >= 1, '第一次必须真的取数');
const snapFile = path.join(home, '.dsh/data/dsh-pr-panel/session-pr-snapshot.json');
ok(fs.existsSync(snapFile), '成功聚合后必须写入快照文件');

/* 2. 新进程（= 重启）走快照 */
const second = runProbe('');
ok(second.fromSnapshot === true, '重启后第一拍必须走快照');
ok(second.calls === 0, '走快照时不该再调用 gh');
ok(second.total === 1, '快照必须带回完整条目');
ok(second.ms < 200, `快照响应必须足够快（实际 ${second.ms}ms）`);

/* 3. refresh=1 穿透快照 */
const third = runProbe('&refresh=1');
ok(third.fromSnapshot === false, 'refresh=1 不得走快照');
ok(third.calls >= 1, 'refresh=1 必须真的取数');

/* 4. 损坏的快照文件不能导致 500 */
fs.writeFileSync(snapFile, '{ not json', 'utf8');
const fourth = runProbe('');
ok(fourth.status === 200, '快照损坏时必须正常回落到真实取数');
ok(fourth.fromSnapshot === false, '快照损坏时不得声称来自快照');

fs.rmSync(home, { recursive: true, force: true });
assert.ok(true);
console.log(`\n===== Phase 38: ${pass}/${total} PASS =====`);
process.exit(fails.length ? 1 : 0);
