/**
 * 把 Tailwind 源编译成可被客户端 bundle 内联的 CSS 模块。
 *
 * 为什么是「构建期编译」而不是运行时：插件的客户端是手写 IIFE，运行时只有
 * require('react')，没有 CSS 打包器；Tailwind 的 JIT 也无法在浏览器里跑。
 * 所以流程固定为：tw.src.css --tailwind--> CSS 文本 --包成 TS 模块--> 被
 * styles.ts 拼接进那一个 <style> 里。
 *
 * 产物 src/ui/tw.generated.ts 是生成文件，不要手改；改 src/ui/tw.src.css。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const input = path.join(root, 'src/ui/tw.src.css');
const outCss = path.join(root, 'src/ui/.tw.generated.css');
const outTs = path.join(root, 'src/ui/tw.generated.ts');

if (!fs.existsSync(input)) {
  console.error('[build:css] 缺少 src/ui/tw.src.css');
  process.exit(1);
}

console.log('[build:css] 编译 Tailwind…');
const cliArgs = [
  '-i', input,
  '-o', outCss,
  // 不传 --content：命令行会覆盖 tailwind.config.cjs 的 content，
  // 导致 @layer components 被树摇清空（实测产出 0 条 .gh2-* 规则）
  '--minify',
];

// 优先用 devDependencies 里的 tailwind（可离线复现），没有再退回 npx 拉取
const localBin = path.join(root, 'node_modules/.bin/tailwindcss');
if (fs.existsSync(localBin)) {
  execFileSync(localBin, cliArgs, { cwd: root, stdio: 'inherit' });
} else {
  console.warn('[build:css] 未找到本地 tailwindcss，回退 npx（首次需联网）');
  execFileSync('npx', ['--yes', 'tailwindcss@3.4.17', ...cliArgs], { cwd: root, stdio: 'inherit' });
}

const css = fs.readFileSync(outCss, 'utf8');
// 反引号与 ${ 会提前结束模板字符串，必须转义后才能安全内联
const safe = css.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');

const ts = `/**
 * 由 scripts/build-css.mjs 生成，请勿手改。
 * 源文件：src/ui/tw.src.css（Tailwind + @apply）
 */
export const TW_CSS = \`
${safe}
\`;
`;
fs.writeFileSync(outTs, ts, 'utf8');
fs.rmSync(outCss, { force: true });
console.log(`[build:css] 完成 → src/ui/tw.generated.ts（${css.length} 字符 CSS）`);
