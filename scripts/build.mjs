import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientPath = path.resolve(__dirname, '../lib/client.js');

/**
 * 版本一致性校验：package.json 与 src/version.ts 必须同版。
 */
function assertVersionConsistency() {
  const pkgPath = path.resolve(__dirname, '../package.json');
  const versionTsPath = path.resolve(__dirname, '../src/version.ts');
  const pkgVersion = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version;
  const m = fs.readFileSync(versionTsPath, 'utf8').match(/CURRENT_PLUGIN_VERSION\s*=\s*'([^']+)'/);
  const srcVersion = m ? m[1] : null;
  if (!srcVersion || pkgVersion !== srcVersion) {
    console.error(`[build] ❌ 版本号不一致: package.json=${pkgVersion}, src/version.ts=${srcVersion}`);
    console.error('[build]    请同步后重新构建（假更新横幅的根源，见 npm-publish.yml 取版逻辑）');
    process.exit(1);
  }
  console.log(`[build] ✅ 版本一致性校验通过: v${pkgVersion}`);
}

/**
 * 轻量 CSS 压缩：去除多行注释与冗余换行，保留关键样式选择器。
 */
function compressCss(code) {
  return code.replace(/const GITHUB_PANEL_CSS = `([\s\S]*?)`;/, (_, css) => {
    const minified = css
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('/*'))
      .join('\n');
    return `const GITHUB_PANEL_CSS = \`\n${minified}\n\`;`;
  });
}

/**
 * 前端模块化 Bundle 聚合器：
 * 将 lib/ui/ 下各独立子模块按正确的依赖拓扑与切片顺序注入到 lib/client.js。
 */
function bundleClient() {
  if (!fs.existsSync(clientPath)) {
    console.error('[build] 未找到 lib/client.js:', clientPath);
    process.exit(1);
  }

  // 防复发闸门：ui/ 下的模块如果没登记进下面的显式列表，就不会被打进 bundle，
  // 而调用处只会得到 undefined —— 运行期表现为「面板一片空白」，非常难查。
  // 所以在这里静态清点一次，构建时就吼出来。
  const knownModules = new Set([
    'utils.js', 'icons.js', 'markdown-lite.js', 'session-pr-panel.js',
    'tw.generated.js',
  ]);

  const uiDir = path.resolve(__dirname, '../lib/ui');
  if (!fs.existsSync(uiDir)) {
    let content = fs.readFileSync(clientPath, 'utf8');
    content = content.replace(/\bexport\s*\{[\s\S]*?\}\s*;?/g, '').trim() + '\n';
    fs.writeFileSync(clientPath, content, 'utf8');
    return;
  }

  try {
    const missing = fs.readdirSync(uiDir)
      .filter((name) => name.endsWith('.js') && !knownModules.has(name));
    if (missing.length > 0) {
      // 直接失败而不是警告：这种漏登记在运行期只会表现为「面板一片空白」，
      // 排查成本极高（2026-10-20 实际踩过：PrReviewModal 未登记 → 整个右侧栏白屏）。
      console.error('[build] ❌ 以下 ui 模块未登记进 bundle 清单，调用处会拿到 undefined:', missing.join(', '));
      console.error('[build]    请在 scripts/build.mjs 的 leadingModules / trailingModules 中登记它们。');
      process.exit(1);
    }
  } catch (err) {
    console.warn('[build] ⚠️ 无法清点 ui 目录:', err?.message || err);
  }

  // 1. 前置子模块
  const leadingModules = [
    // 顺序有讲究：markdown-lite 必须在 session-pr-panel 之前（后者直接引用裸标识符）
    'tw.generated.js',
    'utils.js',
    'icons.js',
    'markdown-lite.js',
    'session-pr-panel.js',
  ];

  let leadingCode = '';
  for (const mod of leadingModules) {
    const modPath = path.join(uiDir, mod);
    if (fs.existsSync(modPath)) {
      let code = fs.readFileSync(modPath, 'utf8');
      code = code.replace(/^\s*import\s+[^;]+;\s*$/gm, '');
      code = code.replace(/\bexport\s+(async\s+)?(function|const|var|let|class)\b/g, '$1$2');
      code = code.replace(/\bexport\s*\{[^}]*\}\s*;?/g, '');
      // 每个模块带一对起止标记：测试按段落切片时不必依赖「下一个模块叫什么」
      leadingCode += `\n// ---- [Bundled: ${mod}] ----\n` + code.trim() + `\n// ---- [End: ${mod}] ----\n`;
    }
  }

  // 2. 后置子模块（当前为空；保留机制给将来需要「最后拼接」的模块）
  let trailingCode = '';
  // 全景驾驶舱已下线：workspace-panel.js 不再进 bundle（文件保留，回滚时改回这一行即可）
  const trailingModules = [];
  for (const mod of trailingModules) {
    const modPath = path.join(uiDir, mod);
    if (fs.existsSync(modPath)) {
      let code = fs.readFileSync(modPath, 'utf8');
      code = code.replace(/^\s*import\s+[^;]+;\s*$/gm, '');
      code = code.replace(/\bexport\s+(async\s+)?(function|const|var|let|class)\b/g, '$1$2');
      code = code.replace(/\bexport\s*\{[^}]*\}\s*;?/g, '');
      trailingCode += `\n// ---- [Bundled: ${mod}] ----\n` + code.trim() + `\n// ---- [End: ${mod}] ----\n`;
    }
  }

  let mainContent = fs.readFileSync(clientPath, 'utf8');
  mainContent = mainContent.replace(/^\s*import\s+[^;]+from\s+['"][^'"]*ui\/[^'"]*['"]\s*;?\s*$/gm, '');
  mainContent = mainContent.replace(/\bexport\s*\{[\s\S]*?\}\s*;?/g, '');

  const reactRequireMarker = 'var React = require("react");';
  const markerIdx = mainContent.indexOf(reactRequireMarker);
  if (markerIdx >= 0) {
    const injectPos = markerIdx + reactRequireMarker.length;
    mainContent = mainContent.slice(0, injectPos) + '\n' + leadingCode + '\n' + mainContent.slice(injectPos);
  }

  const applyMarker = 'function apply(ctx)';
  const applyIdx = mainContent.indexOf(applyMarker);
  if (applyIdx >= 0) {
    mainContent = mainContent.slice(0, applyIdx) + trailingCode + '\n\n    ' + mainContent.slice(applyIdx);
  } else {
    mainContent += '\n' + trailingCode;
  }

  mainContent = mainContent.trim() + '\n';

  // 刚性防线：客户端闭包内绝对不能含有裸 export 语句，防止浏览器触发 Uncaught SyntaxError: Unexpected token 'export' 崩溃
  const illegalExportMatch = mainContent.match(/\bexport\s+(async\s+)?(function|const|var|let|class)\b/);
  if (illegalExportMatch) {
    console.error('[build] ❌ 严重语法错误：lib/client.js 闭包内检测到非法残留的 export 关键字:', illegalExportMatch[0]);
    process.exit(1);
  }

  // 原子写：直接 writeFileSync 会有一瞬间「文件被截断」的窗口，而宿主在 watch 这个文件、
  // 浏览器也在 HMR 期间读它——读到半截就会整段解析失败，插件从页面上整个消失（实测踩过）。
  const tmpPath = clientPath + '.tmp-' + process.pid;
  fs.writeFileSync(tmpPath, mainContent, 'utf8');
  fs.renameSync(tmpPath, clientPath);
  console.log('[build] ✅ 已成功聚合前端子模块并完成 CSS 压缩瘦身');
}

bundleClient();
assertVersionConsistency();
