// 生成 README 用的界面预览页（用插件自己的 CSS + 与组件一致的标记，示例数据）。
// 用途：截图不必依赖运行中的 DSH，也不会拍到真实仓库信息。
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
// CSS 直接从构建产物里取，避免样式漂移（之前用外置文件，新加的类没跟上）
const bundle = fs.readFileSync(path.join(root, 'lib/client.js'), 'utf8');
const cssStart = bundle.indexOf('.ghsp-card{');
const q1 = bundle.lastIndexOf('"', cssStart);
const q2 = bundle.indexOf('"', cssStart);
const css = bundle.slice(q1 + 1, q2).replace(/\\n/g, '\n');

const SHIM = `
button{font:inherit;color:inherit;background:transparent;border:0;padding:0;text-align:inherit;cursor:pointer}
:root{
  --dsw-alias-bg-base:#0d1117; --dsw-alias-bg-layer-1:#161b22; --dsw-alias-bg-layer-2:#21262d;
  --dsw-alias-label-primary:#e6edf3; --dsw-alias-label-secondary:#9198a1; --dsw-alias-label-tertiary:#6e7681;
  --dsw-alias-border-l1:#30363d; --dsw-alias-border-l2:#30363d; --dsw-alias-brand-primary:#2f81f7;
  --dsw-alias-state-success-primary:#3fb950; --dsw-alias-state-warn-primary:#d29922;
  --dsw-specific-menu:rgba(22,27,34,.86); --dsw-menu-backdrop-filter:blur(18px) saturate(1.3);
}
html,body{margin:0;background:#0a0d12;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC",sans-serif;color:#e6edf3}
.stage{width:880px;height:700px;display:flex;align-items:center;justify-content:center;overflow:hidden;
  background:radial-gradient(900px 480px at 50% 0%, #141d28 0%, #0a0d12 65%)}
.stage .ghsp-overlay{position:static !important;right:auto !important;bottom:auto !important}
.stage .ghsp-card{width:420px !important;height:auto;max-height:600px !important;display:flex;flex-direction:column;overflow:hidden}
.stage .ghsp-lanes,.stage .ghsp-ocards{flex:1 1 auto;min-height:0;overflow:auto}
.stage .ghsp-run-row{align-items:center}
.stage .stage-pad{height:0}
`;

function avatar(letter, color) {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32">'
    + '<circle cx="16" cy="16" r="16" fill="' + color + '"/>'
    + '<text x="16" y="21" font-family="sans-serif" font-size="14" fill="#fff" text-anchor="middle">' + letter + '</text></svg>';
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}

function row(n, title, badge, base, repo, letter, color, dot, checks, attn) {
  const tone = base.startsWith('release') ? 'release' : base === 'test' ? 'test' : 'dev';
  return '<li><button class="ghsp-row"><div class="ghsp-row-top">'
    + '<img class="ghsp-av" width="13" height="13" alt="" src="' + avatar(letter, color) + '">'
    + '<span class="ghsp-row-num">#' + n + '</span>'
    + '<span class="ghsp-row-title">' + title + '</span>'
    + '<span class="ghsp-badge ' + badge + '">' + badge + '</span>'
    + (attn ? '<span class="ghsp-attn ' + attn + '">' + (attn === 'blocker' ? '!' : '待') + '</span>' : '') + '</div>'
    + '<div class="ghsp-row-meta"><span class="ghsp-target ' + tone + '">→ ' + base + '</span>'
    + '<span class="ghsp-row-repo">' + repo + '</span>'
    + '<span class="ghsp-checks"><span class="ghsp-dot ' + dot + '"></span>'
    + '<span class="ghsp-checks-num">' + checks + '</span></span></div></button></li>';
}

function lane(chip, id, name, count, rows) {
  return '<div class="ghsp-lane"><button class="ghsp-lane-head ghsp-lane-toggle">'
    + '<span class="ghsp-lane-chevron">▾</span>'
    + '<span class="ghsp-lane-chip ' + id + '">' + chip + '</span>'
    + '<span class="ghsp-lane-name">' + name + '</span>'
    + '<span class="ghsp-lane-count">' + count + '</span></button>'
    + '<ul class="ghsp-list">' + rows + '</ul></div>';
}

const HEAD = '<div class="ghsp-card-head">'
  + '<span style="display:inline-flex;color:#e6edf3">◉</span>'
  + '<span class="ghsp-card-title">本会话提交的 PR</span>'
  + '<span class="ghsp-card-sub">12 · 刚刚</span>'
  + '<button class="ghsp-icon-btn">⟳</button><button class="ghsp-icon-btn">≡</button></div>';

function tabs(active) {
  const one = (key, label, count) => '<button class="ghsp-otab' + (key === active ? ' active' : '')
    + '" aria-pressed="' + (key === active) + '">' + label
    + (count ? '<span class="ghsp-otab-count">' + count + '</span>' : '') + '</button>';
  return '<div class="ghsp-otabs" role="group">' + one('pr', '功能', 12) + one('project', '项目') + one('ci', 'CI/CD') + '</div>';
}

function page(name, body) {
  const html = '<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>' + name + '</title>'
    + '<style>' + SHIM + '</style><style>' + css + '</style></head>'
    + '<body><div class="stage">' + body + '</div></body></html>';
  fs.writeFileSync(path.join(root, 'docs/preview', name + '.html'), html);
}

const lanes = lane('PENDING', 'pending', 'refund-asset', 2,
    row(4291, 'fix(refund): 退款资产按币种分桶统计', 'open', 'development', 'acme/wallet-api', 'W', '#1f6feb', 'fail', '4/6', 'blocker')
  + row(4288, 'fix(refund): 月度退款口径与账单对齐', 'open', 'test', 'acme/wallet-api', 'H', '#8250df', 'pending', '6/6', 'todo'))
  + lane('DONE', 'done', 'bill-remap', 4,
    row(4271, 'fix(bill): 回迁 test 上漏进 development 的读时映射', 'merged', 'development', 'acme/wallet-api', 'Z', '#238636', 'pass', '9/9', '')
  + row(4270, 'fix(bill): 账单读时映射修复（open-api 兼容）', 'merged', 'test', 'acme/wallet-api', 'Z', '#238636', 'pass', '9/9', '')
  + row(4268, 'chore(dev): 部署账单读时映射修复', 'merged', 'release/v1.4', 'acme/wallet-api', 'L', '#9e6a03', 'pass', '9/9', ''));

page('overlay-feature', '<div class="ghsp-overlay"><section class="ghsp-card">' + HEAD + tabs('pr')
  + '<div class="ghsp-empty2">已显示 8 / 12 条，继续下滑加载更多</div>'
  + '<div class="ghsp-lanes">' + lanes + '</div></section></div>');

const projects = '<div class="ghsp-ocards">'
  + '<div class="ghsp-pcard"><div class="ghsp-pcard-top"><span class="ghsp-pcard-repo">wallet-api</span><span class="ghsp-pcard-wt">218 wt</span></div>'
  + '<div class="ghsp-pcard-use"><span class="ghsp-pcard-dot">●</span><span class="ghsp-pcard-name">worktrees/bill-remap-dev-r4</span><span class="ghsp-pcard-dirty">2 未提交</span></div>'
  + '<div class="ghsp-pcard-branch">fix/bill-remap-backport-to-dev-r4<span class="ghsp-pcard-more"> · 本会话另用 1 个</span></div></div>'
  + '<div class="ghsp-pcard"><div class="ghsp-pcard-top"><span class="ghsp-pcard-repo">wallet-web</span><span class="ghsp-pcard-wt">37 wt</span></div>'
  + '<div class="ghsp-pcard-use"><span class="ghsp-pcard-dot">●</span><span class="ghsp-pcard-name">wallet-web</span></div>'
  + '<div class="ghsp-pcard-branch">fix/portal-stats-accountbill</div></div>'
  + '<div class="ghsp-pcard"><div class="ghsp-pcard-top"><span class="ghsp-pcard-repo">wallet-ios</span><span class="ghsp-pcard-wt">本地无副本</span></div></div>'
  + '</div>';
page('overlay-project', '<div class="ghsp-overlay"><section class="ghsp-card">' + HEAD + tabs('project') + projects + '</section></div>');

const runs = '<div class="ghsp-ocards">'
  + '<div class="ghsp-pcard"><div class="ghsp-pcard-top"><span class="ghsp-pcard-repo">wallet-api</span><span class="ghsp-pcard-wt">2 个 PR 分支</span></div>'
  + '<div class="ghsp-prruns"><div class="ghsp-prruns-head"><span class="ghsp-prruns-num">#4291</span><span class="ghsp-prruns-branch">fix/refund-asset-bucket → development</span></div>'
  + '<button class="ghsp-run-row"><span class="ghsp-dot pending"></span>'
  + '<span class="ghsp-run-main"><span class="ghsp-run-name"><span class="ghsp-run-phase">PR 校验</span>CI</span><span class="ghsp-run-sub">Build and test</span></span>'
  + '<span class="ghsp-run-right">3/13</span><span class="ghsp-oscard-go">↗</span></button></div>'
  + '<div class="ghsp-prruns"><div class="ghsp-prruns-head"><span class="ghsp-prruns-num">#4271</span><span class="ghsp-prruns-branch">fix/bill-remap-backport-to-dev-r4 → development</span></div>'
  + '<button class="ghsp-run-row"><span class="ghsp-dot pass"></span>'
  + '<span class="ghsp-run-main"><span class="ghsp-run-name"><span class="ghsp-run-phase after">合并后</span>Deploy</span><span class="ghsp-run-sub">push</span></span>'
  + '<span class="ghsp-run-right">6m 前</span><span class="ghsp-oscard-go">↗</span></button></div>'
  + '<div class="ghsp-empty2">另有 1 个 PR 分支近 30 分钟没有运行</div></div></div>';
page('overlay-ci', '<div class="ghsp-overlay"><section class="ghsp-card">' + HEAD + tabs('ci') + runs + '</section></div>');

console.log('previews generated');
