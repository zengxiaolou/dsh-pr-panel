// test/phase39.test.mjs - Phase 39 · 外部内容的链接/图片白名单（XSS 面）
//
// PR 正文与评审评论是外部输入。之前 `[x](target)` 的 target 直接进 href：
// `[点我](javascript:alert(1))` 能在 Electron 渲染进程里执行脚本（那里挂着 DSH bridge）；
// `![x](file:///etc/passwd)` 能把本机文件当图片显示。
//
// 现在只放行 http(s) 链接与 https/base64 图片，其余降级为纯文本。

import assert from 'node:assert';
import { createRenderer } from './render/react-stub.mjs';

let pass = 0; let total = 0; const fails = [];
function ok(cond, name) { total += 1; if (cond) pass += 1; else { fails.push(name); console.error('❌ ' + name); } }

const mod = await import('../lib/ui/markdown-lite.js');
const React = globalThis.React;
const tree = mod.renderMarkdownLite(React.createElement, [
  '正常链接 [GitHub](https://github.com/acme/demo)',
  '危险链接 [点我](javascript:alert(1))',
  '文件链接 [本地](file:///etc/passwd)',
  '图片 ![shot](https://user-images.githubusercontent.com/a.png)',
  '危险图片 ![x](file:///etc/passwd)',
].join('\n\n'));

function walk(node, fn) {
  if (!node) return;
  if (Array.isArray(node)) { node.forEach((n) => walk(n, fn)); return; }
  if (typeof node === 'string') { fn(node); return; }
  if (typeof node !== 'object') return;
  fn(node);
  walk(node.children || node.kids || [], fn);
}
const anchors = [];
const imgs = [];
walk(tree, (n) => {
  if (n && n.type === 'a') anchors.push(n.props || {});
  if (n && n.type === 'img') imgs.push(n.props || {});
});

ok(anchors.length === 1, `只应保留 1 个合法链接（实际 ${anchors.length}）`);
ok(anchors[0].href === 'https://github.com/acme/demo', '合法 https 链接必须保留');
ok(anchors[0].rel === 'noopener noreferrer', '外链必须带 rel=noopener noreferrer');
ok(!anchors.some((a) => /^javascript:/i.test(String(a.href || ''))), 'javascript: 链接绝不能进 href');
ok(!anchors.some((a) => /^file:/i.test(String(a.href || ''))), 'file: 链接绝不能进 href');

ok(imgs.length === 1, `只应保留 1 张合法图片（实际 ${imgs.length}）`);
ok(/^https:\/\//.test(imgs[0].src), 'https 图片保留');
ok(!imgs.some((i) => /^file:/i.test(String(i.src || ''))), 'file: 图片绝不能渲染');

// 危险链接降级后仍可读
const texts = [];
walk(tree, (n) => { if (typeof n === 'string') texts.push(n); });
ok(texts.some((t) => t.includes('链接已隐藏')), '不安全的链接必须留下「链接已隐藏」提示，而不是凭空消失');

// 客户端兜底：window.open 之前也要校验 scheme
const fs = await import('node:fs');
const client = fs.readFileSync('lib/client.js', 'utf8');
const idx = client.indexOf('function openUrlFallback');
const seg = client.slice(idx, idx + 600);
ok(/\\^https\?:\\\/\\\/\$?\/i\.test/.test(seg) || /\^https\?:/i.test(seg), 'openUrlFallback 必须校验 http(s) scheme');
assert.ok(idx > 0);

console.log(`\n===== Phase 39: ${pass}/${total} PASS =====`);
process.exit(fails.length ? 1 : 0);
