/**
 * 会话 PR 通道：右下角浮窗（只列本会话新建的 PR）+ 右列 PR 面板（Codex 那种窄面板）。
 *
 * 设计取舍：
 * 1. 数据只有一条来源：/api/github/session-created-prs（Host 侧登记簿 + 转写回填）。
 *    浮窗和面板读同一个接口，不各自打 gh。
 * 2. 浮窗是 shell.overlay 里的一层，只在「本会话确实提过 PR」时渲染；没 PR 就
 *    return null —— 这个位置一旦常驻就会变成骚扰。
 * 3. 面板不重造数据：详情走现有 /api/github/pr-detail（补了 repo 参数，支持跨仓 PR），
 *    diff 复用它已经拉好的 unified patch。
 */
import { Lanes } from './pr-lanes.js';
import { runConclusionBadge, formatDurationMs } from './utils.js';
export const SESSION_PR_CSS = `
.ghsp-overlay{position:fixed;right:20px;bottom:148px;z-index:900;display:flex;flex-direction:column;align-items:flex-end;gap:8px;pointer-events:none;font-size:12px}
.ghsp-overlay>*{pointer-events:auto}

.ghsp-pill{display:inline-flex;align-items:center;gap:7px;height:30px;padding:0 11px 0 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-specific-menu,color-mix(in srgb, var(--dsw-alias-bg-base) 94%, #000 6%));backdrop-filter:var(--dsw-menu-backdrop-filter,blur(14px) saturate(1.35));-webkit-backdrop-filter:var(--dsw-menu-backdrop-filter,blur(14px) saturate(1.35));color:var(--dsw-alias-label-primary);cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.34);transition:border-color .12s ease,transform .12s ease}
.ghsp-pill:hover{border-color:var(--dsw-alias-border-l2);transform:translateY(-1px)}
.ghsp-pill-text{font-weight:500;letter-spacing:.01em}
.ghsp-pill-delta{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.ghsp-pill-count{display:inline-flex;align-items:center;justify-content:center;min-width:16px;height:16px;padding:0 4px;border-radius:999px;background:var(--dsw-alias-brand-primary);color:#fff;font-size:10px;font-weight:600;line-height:1}

.ghsp-card{width:372px;max-height:min(56vh,470px);display:flex;flex-direction:column;border-radius:12px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-specific-menu,color-mix(in srgb, var(--dsw-alias-bg-base) 94%, #000 6%));backdrop-filter:var(--dsw-menu-backdrop-filter,blur(14px) saturate(1.35));-webkit-backdrop-filter:var(--dsw-menu-backdrop-filter,blur(14px) saturate(1.35));box-shadow:0 18px 44px rgba(0,0,0,.34);overflow:hidden}
.ghsp-card-head{display:flex;align-items:center;gap:8px;padding:9px 10px 9px 12px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.ghsp-card-title{flex:1;min-width:0;font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ghsp-card-sub{font-size:11px;color:var(--dsw-alias-label-secondary)}
.ghsp-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:6px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.ghsp-icon-btn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.ghsp-list{margin:0;padding:4px;list-style:none;overflow:auto}
/* 阶段/功能泳道：标题行吸顶，滚动时仍知道自己在哪一段 */
.ghsp-lanes{overflow:auto;flex:1;min-height:0}
.ghsp-lane{padding-bottom:2px}
.ghsp-lane+.ghsp-lane{border-top:1px solid var(--dsw-alias-border-l2)}
.ghsp-lane-head{display:flex;align-items:center;gap:6px;padding:7px 10px 3px;position:sticky;top:0;background:var(--dsw-specific-menu,color-mix(in srgb, var(--dsw-alias-bg-base) 94%, #000 6%));backdrop-filter:var(--dsw-menu-backdrop-filter,blur(14px));-webkit-backdrop-filter:var(--dsw-menu-backdrop-filter,blur(14px));z-index:1}
/* 阶段胶囊：实心底色 + 白字。原来的「透明底 + 彩色描边」在深色背景上发虚，
   一排下来像一堆空框；实心块更容易一眼扫出「这是 Release 还是 Prod」。 */
.ghsp-lane-chip{font-size:9px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;padding:2px 7px;border-radius:999px;border:0;line-height:1.4;color:#fff;background:#6e7781}
/* tag 表达的是「这个功能完了没有」，不是它在哪个环境：
   pending 要处理（琥珀）、done 收工（绿）、closed 放弃（灰） */
.ghsp-lane-chip.pending{background:#bf8700}
.ghsp-lane-chip.done{background:#1a7f37}
.ghsp-lane-chip.closed{background:#6e7781}
.ghsp-lane-count{font-size:10px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.ghsp-lane-name{flex:1;min-width:0;font-size:11px;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ghsp-lane-chevron{font-size:9px;line-height:1;width:9px;flex:0 0 auto;color:var(--dsw-alias-label-secondary)}
.ghsp-lane-toggle{width:100%;border:0;background:transparent;font:inherit;text-align:left;cursor:pointer}
.ghsp-lane-toggle:hover .ghsp-lane-name,.ghsp-lane-toggle:hover .ghsp-lane-count{color:var(--dsw-alias-label-primary)}
.ghsp-lane.collapsed .ghsp-lane-head{padding-bottom:5px}
/* 浮窗 tab：功能 / 项目 / CI-CD */
.ghsp-otabs{display:flex;gap:2px;padding:6px 8px 2px}
.ghsp-otab{display:inline-flex;align-items:center;gap:4px;padding:2px 9px;border-radius:999px;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);font-size:11px;cursor:pointer}
.ghsp-otab:hover{color:var(--dsw-alias-label-primary)}
.ghsp-otab.active{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2)}
.ghsp-otab-count{font-size:9px;padding:0 4px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
/* 卡片式内容区：一块一张卡，卡片里放具体条目 */
.ghsp-ocards{display:flex;flex-direction:column;gap:6px;padding:6px 8px 8px;overflow:auto;flex:1;min-height:0}
.ghsp-ocards-sum{font-size:10px;color:var(--dsw-alias-label-secondary);padding:0 2px}
.ghsp-oscard{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:6px 8px;background:var(--dsw-alias-bg-layer-1)}
.ghsp-oscard-head{display:flex;align-items:center;gap:6px;min-width:0}
.ghsp-oscard-title{flex:1;min-width:0;font-size:12px;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ghsp-oscard-sub{flex:0 0 auto;font-size:10px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:52%}
.ghsp-wts{margin:4px 0 0;padding:0;list-style:none}
.ghsp-wt{display:flex;align-items:center;gap:5px;padding:1px 2px;font-size:10px;color:var(--dsw-alias-label-secondary)}
.ghsp-wt.current{color:var(--dsw-alias-label-primary)}
.ghsp-wt-mark{font-size:8px;flex:0 0 auto}
.ghsp-wt-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:44%}
.ghsp-wt-branch{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary)}
.ghsp-wt-tag{flex:0 0 auto;font-size:9px;padding:0 4px;border-radius:4px;border:1px solid currentColor;color:var(--dsw-alias-state-warn-primary,#9a6700)}
.ghsp-wt.more{font-size:9px;color:var(--dsw-alias-label-tertiary)}
.ghsp-bar-wrap{height:3px;margin-top:5px;border-radius:2px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}
.ghsp-bar-fill{height:100%;background:var(--dsw-alias-brand-primary,#2f81f7);transition:width .3s ease}
.ghsp-empty2{padding:14px 10px;text-align:center;font-size:11px;color:var(--dsw-alias-label-secondary)}

/* 浮窗里的「项目 / worktree」区块 */
.ghsp-ws{border-top:1px solid var(--dsw-alias-border-l2)}
.ghsp-ws-head{display:flex;align-items:center;gap:6px;width:100%;padding:6px 10px;border:0;background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;text-align:left}
.ghsp-ws-head:hover{background:var(--dsw-alias-bg-layer-2)}
.ghsp-ws-label{font-size:10px;font-weight:700;letter-spacing:.06em;color:var(--dsw-alias-label-secondary)}
.ghsp-ws-sum,.ghsp-ws-muted{font-size:10px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ghsp-ws-chevron{margin-left:auto;font-size:9px;color:var(--dsw-alias-label-secondary)}
.ghsp-ws-list{margin:0;padding:0 6px 6px;list-style:none}
.ghsp-ws-project+.ghsp-ws-project{margin-top:2px}
.ghsp-ws-row{display:flex;align-items:center;gap:5px;padding:2px 4px;border-radius:6px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.ghsp-ws-row.proj{width:100%;border:0;background:transparent;cursor:pointer;text-align:left}
.ghsp-ws-row.proj:hover{background:var(--dsw-alias-bg-layer-2)}
.ghsp-ws-row.sub{padding-left:14px;font-size:10px}
.ghsp-ws-row.more{padding-left:14px;font-size:9px;color:var(--dsw-alias-label-tertiary)}
.ghsp-ws-chevron2{width:8px;flex:0 0 auto;font-size:8px;color:var(--dsw-alias-label-secondary)}
.ghsp-ws-wts{margin:0;padding:0;list-style:none}
.ghsp-ws-row.current{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}
.ghsp-ws-mark{font-size:8px;flex:0 0 auto}
.ghsp-ws-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:46%}
.ghsp-ws-branch{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px;color:var(--dsw-alias-label-tertiary)}
.ghsp-ws-tag{flex:0 0 auto;font-size:9px;padding:0 4px;border-radius:4px;border:1px solid var(--dsw-alias-border-l2)}
.ghsp-ws-tag.prunable{color:var(--dsw-alias-state-warn-primary,#9a6700);border-color:currentColor}

/* 浮窗里的 CI/CD 紧凑条 */
.ghsp-ci{border-top:1px solid var(--dsw-alias-border-l2);border-bottom:1px solid var(--dsw-alias-border-l2)}
.ghsp-ci-head{display:flex;align-items:center;gap:6px;width:100%;padding:6px 10px;border:0;background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;text-align:left}
.ghsp-ci-head:hover{background:var(--dsw-alias-bg-layer-2)}
.ghsp-ci-label{font-size:10px;font-weight:700;letter-spacing:.06em;color:var(--dsw-alias-label-secondary)}
.ghsp-ci-sum,.ghsp-ci-muted{font-size:10px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.ghsp-ci-chevron{margin-left:auto;font-size:9px;color:var(--dsw-alias-label-secondary)}
.ghsp-ci-list{margin:0;padding:0 6px 6px;list-style:none}
.ghsp-ci-row{display:flex;align-items:center;gap:6px;padding:3px 4px;border-radius:6px;font-size:11px}
.ghsp-ci-row:hover{background:var(--dsw-alias-bg-layer-2)}
.ghsp-ci-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ghsp-ci-time{flex:0 0 auto;font-size:10px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.ghsp-mode-bar{display:flex;align-items:center;gap:4px;padding:6px 10px 2px}
.ghsp-mode-btn{padding:1px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);font-size:10px;line-height:1.7;cursor:pointer}
.ghsp-mode-btn:hover{color:var(--dsw-alias-label-primary)}
.ghsp-mode-btn.active{border-color:var(--dsw-alias-brand-primary,#2f81f7);color:var(--dsw-alias-brand-primary,#2f81f7);background:rgba(47,129,247,.1)}
.ghsp-row{display:flex;flex-direction:column;gap:4px;width:100%;padding:8px 9px;border-radius:8px;border:0;background:transparent;text-align:left;cursor:pointer;color:inherit}
.ghsp-row:hover{background:var(--dsw-alias-bg-layer-2)}
.ghsp-row-top{display:flex;align-items:center;gap:6px;min-width:0}
.ghsp-row-num{font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.ghsp-row-title{flex:1;min-width:0;font-size:12px;line-height:1.35;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ghsp-row-bottom{display:flex;align-items:center;gap:8px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.ghsp-row-meta{display:flex;align-items:center;gap:7px;min-width:0;font-size:11px;color:var(--dsw-alias-label-secondary)}
.ghsp-row-repo{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:0 1 auto}
/* 来源小标：这个 PR 是派下去的子代理会话建的，不是主会话亲手建的 */
.ghsp-origin{display:inline-flex;align-items:center;height:14px;padding:0 5px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);font-size:9px;font-weight:600;letter-spacing:.04em;flex:0 0 auto;white-space:nowrap}
.ghsp-add{color:var(--dsw-alias-state-success-primary,#3fb950)}.ghsp-del{color:var(--dsw-alias-state-error-primary,#f85149)}
.ghsp-dot{width:6px;height:6px;border-radius:50%;flex:0 0 auto}
.ghsp-dot.pass{background:var(--dsw-alias-state-success-primary,#3fb950)}.ghsp-dot.fail{background:var(--dsw-alias-state-error-primary,#f85149)}.ghsp-dot.pending{background:var(--dsw-alias-state-warn-primary,#d29922)}.ghsp-dot.none{background:var(--dsw-alias-state-idle-primary)}

.ghsp-badge{display:inline-flex;align-items:center;height:17px;padding:0 6px;border-radius:999px;font-size:10px;font-weight:600;letter-spacing:.02em;border:1px solid transparent}
.ghsp-badge.open{color:var(--dsw-alias-state-success-primary,#3fb950);border-color:color-mix(in srgb, var(--dsw-alias-state-success-primary,#3fb950) 40%, transparent);background:color-mix(in srgb, var(--dsw-alias-state-success-primary,#3fb950) 10%, transparent)}
.ghsp-badge.draft{color:var(--dsw-alias-label-secondary);border-color:var(--dsw-alias-border-l2)}
.ghsp-badge.merged{color:#a371f7;border-color:rgba(163,113,247,.4);background:rgba(163,113,247,.1)}
.ghsp-badge.closed{color:var(--dsw-alias-state-error-primary,#f85149);border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary,#f85149) 40%, transparent);background:color-mix(in srgb, var(--dsw-alias-state-error-primary,#f85149) 10%, transparent)}
.ghsp-badge.unknown{color:var(--dsw-alias-label-secondary);border-color:var(--dsw-alias-border-l2)}

.ghsp-panel{display:flex;flex-direction:column;height:100%;min-height:0;font-size:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);overflow:hidden}
/* 头部做成与内容卡片同宽、同圆角的卡片：原来它是通栏底色，而下面两列有 10px 内缩，
   视觉上像是「头部比内容宽一截」 */
.ghsp-head{flex:0 0 auto;margin:10px 10px 0;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}
.ghsp-head-top{display:flex;align-items:center;gap:8px;min-width:0}
.ghsp-repo{font-size:11px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ghsp-num{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.ghsp-head-actions{margin-left:auto;display:flex;align-items:center;gap:2px}
.ghsp-title{margin:5px 0 0;font-size:13px;line-height:1.45;font-weight:600;color:var(--dsw-alias-label-primary);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.ghsp-meta{display:flex;flex-wrap:wrap;align-items:center;gap:6px 8px;margin-top:6px;font-size:11px;color:var(--dsw-alias-label-secondary);min-width:0}
.ghsp-branch{display:inline-flex;align-items:center;gap:5px;max-width:100%;min-width:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px}
.ghsp-branch>span:first-child{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.ghsp-checks{display:inline-flex;align-items:center;gap:5px}

.ghsp-scroll{flex:1 1 auto;min-height:0;overflow:auto;overscroll-behavior:contain}
.ghsp-file{border-bottom:1px solid var(--dsw-alias-border-l1)}
.ghsp-file-head{display:flex;align-items:center;gap:7px;width:100%;padding:7px 10px;border:0;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);cursor:pointer;text-align:left;position:sticky;top:0;z-index:1}
.ghsp-file-head:hover{background:var(--dsw-alias-bg-layer-2)}
.ghsp-caret{width:10px;flex:0 0 auto;color:var(--dsw-alias-label-secondary);transition:transform .12s ease}
.ghsp-caret.open{transform:rotate(90deg)}
.ghsp-path{flex:1;min-width:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;text-align:left}
.ghsp-stat{font-size:10.5px;font-variant-numeric:tabular-nums;white-space:nowrap}
.ghsp-diff{margin:0;padding:2px 0 6px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:1.55;background:var(--dsw-alias-bg-base);overflow-x:auto}
.ghsp-line{display:block;padding:0 10px;white-space:pre;tab-size:2}
.ghsp-line.add{background:color-mix(in srgb, var(--dsw-alias-state-success-primary,#3fb950) 13%, transparent);color:var(--dsw-alias-state-success-primary,#3fb950)}
.ghsp-line.del{background:color-mix(in srgb, var(--dsw-alias-state-error-primary,#f85149) 13%, transparent);color:var(--dsw-alias-state-error-primary,#f85149)}
.ghsp-line.hunk{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);margin:4px 0;padding-top:2px;padding-bottom:2px}
.ghsp-line.meta{color:var(--dsw-alias-label-secondary);opacity:.75}
.ghsp-more{padding:6px 10px;font-size:11px;color:var(--dsw-alias-label-secondary)}

.ghsp-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;height:100%;padding:24px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:12px}
.ghsp-empty strong{color:var(--dsw-alias-label-primary);font-size:13px}
.ghsp-skeleton{padding:14px 12px;display:flex;flex-direction:column;gap:8px}
.ghsp-bar{height:10px;border-radius:5px;background:var(--dsw-alias-bg-layer-2);animation:ghsp-pulse 1.2s ease-in-out infinite}
.ghsp-bar.w60{width:60%}.ghsp-bar.w40{width:40%}.ghsp-bar.w80{width:80%}
@keyframes ghsp-pulse{0%,100%{opacity:.55}50%{opacity:1}}
.ghsp-error{padding:14px 12px;font-size:12px;color:var(--dsw-alias-state-error-primary);display:flex;flex-direction:column;gap:8px;align-items:flex-start}
.ghsp-btn{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 9px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:11px;cursor:pointer}
.ghsp-btn:hover{border-color:var(--dsw-alias-border-l2)}
.ghsp-tabs{display:flex;align-items:center;gap:6px;padding:6px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);overflow-x:auto;flex:0 0 auto}
.ghsp-tab{display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);font-size:11px;cursor:pointer;white-space:nowrap}
.ghsp-tab.active{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2)}

/* ---- v2：更强的状态对比 + 面板分段 ---- */
.ghsp-badge{height:18px;padding:0 7px;font-size:10px;letter-spacing:.02em;border-width:1px}
.ghsp-badge.open{color:#1a7f37;background:rgba(26,127,55,.10);border-color:rgba(26,127,55,.4)}
.ghsp-badge.merged{color:#6e40c9;background:rgba(110,64,201,.10);border-color:rgba(110,64,201,.4)}
.ghsp-badge.closed{color:#cf222e;background:rgba(207,34,46,.10);border-color:rgba(207,34,46,.4)}
.ghsp-badge.draft{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2)}
.ghsp-badge.unknown{color:var(--dsw-alias-label-secondary);background:transparent;border-color:var(--dsw-alias-border-l2)}
body[data-ds-dark-theme] .ghsp-badge.open{color:#3fb950;background:rgba(63,185,80,.16);border-color:rgba(63,185,80,.5)}
body[data-ds-dark-theme] .ghsp-badge.merged{color:#b392f0;background:rgba(163,113,247,.18);border-color:rgba(163,113,247,.5)}
body[data-ds-dark-theme] .ghsp-badge.closed{color:#f85149;background:rgba(248,81,73,.18);border-color:rgba(248,81,73,.5)}


.ghsp-sec{padding:10px 12px}
.ghsp-sec-title{padding:8px 12px 4px;font-size:10px;font-weight:600;letter-spacing:.06em;color:var(--dsw-alias-label-secondary);text-transform:uppercase}
.ghsp-muted{color:var(--dsw-alias-label-secondary);font-size:11px}
.ghsp-actions{display:flex;flex-wrap:wrap;gap:6px}
.ghsp-btn-primary{background:var(--dsw-alias-brand-primary);border-color:transparent;color:#fff}
.ghsp-btn-primary:hover{filter:brightness(1.08)}
.ghsp-btn[disabled]{opacity:.5;cursor:default}
.ghsp-btn-primary[disabled]{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}

.ghsp-md{font-size:12px;line-height:1.65;color:var(--dsw-alias-label-primary);word-break:break-word}
.ghsp-md p{margin:0 0 8px}
.ghsp-md h3,.ghsp-md h4,.ghsp-md h5{margin:12px 0 6px;font-size:12.5px;font-weight:600}
.ghsp-md ul,.ghsp-md ol{margin:0 0 8px;padding-left:18px}
.ghsp-md li{margin:2px 0}
.ghsp-md code{padding:1px 4px;border-radius:4px;background:var(--dsw-alias-bg-layer-2);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px}
.ghsp-md pre{margin:0 0 8px;padding:8px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);overflow:auto}
.ghsp-md pre code{background:transparent;padding:0}
.ghsp-md a{color:var(--dsw-alias-brand-primary);text-decoration:none}
.ghsp-md img{max-width:100%;border-radius:6px}
.ghsp-md blockquote{margin:0 0 8px;padding-left:8px;border-left:2px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}

.ghsp-note{padding:9px 12px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.ghsp-note-head{display:flex;align-items:center;gap:6px;margin-bottom:5px;font-size:11px}
.ghsp-note-author{font-weight:600;color:var(--dsw-alias-label-primary)}
.ghsp-note-time{margin-left:auto;color:var(--dsw-alias-label-secondary);font-size:10px}
.ghsp-note .ghsp-icon-btn{margin-left:6px}

.ghsp-commit{display:flex;align-items:center;gap:8px;padding:3px 12px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.ghsp-commit code{color:var(--dsw-alias-label-secondary);font-size:10.5px}
.ghsp-commit-msg{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary)}

.ghsp-check{display:flex;align-items:center;gap:8px;padding:4px 0;font-size:11px}
.ghsp-check-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ghsp-check-state{color:var(--dsw-alias-label-secondary);font-size:10.5px}

.ghsp-notice{margin:8px 12px;padding:8px 10px;border-radius:8px;font-size:11px;line-height:1.5;color:var(--dsw-alias-state-warn-primary,#d29922);background:color-mix(in srgb, var(--dsw-alias-state-warn-primary,#d29922) 12%, transparent)}
.ghsp-file-row{display:flex;align-items:center;gap:8px;padding:5px 12px;font-size:11px}
.ghsp-file-row:hover{background:var(--dsw-alias-bg-layer-2)}
.ghsp-file-row .ghsp-path{flex:1}
.ghsp-file-head{display:flex;align-items:center;gap:2px;padding:0 6px 0 10px}
.ghsp-file-toggle{display:flex;flex:1;align-items:center;gap:7px;min-width:0;padding:7px 4px;border:0;background:transparent;color:inherit;cursor:pointer;text-align:left}
.ghsp-file-action{flex:0 0 auto;width:auto;padding:0 6px;font-size:10.5px}

.ghsp-line.pickable{cursor:pointer}
.ghsp-line.pickable:hover{background:var(--dsw-alias-bg-layer-2)}
.ghsp-line.sel{background:color-mix(in srgb, var(--dsw-alias-brand-primary) 22%, transparent);outline:1px solid var(--dsw-alias-brand-primary);outline-offset:-1px}

.ghsp-commentbar{flex:0 0 auto;display:flex;flex-direction:column;gap:6px;padding:9px 12px 10px;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.ghsp-commentbar-head{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.ghsp-commentbar-head>span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ghsp-textarea{width:100%;min-height:54px;max-height:160px;resize:vertical;padding:6px 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:11px;line-height:1.5;font-family:inherit;outline:none}
.ghsp-textarea:focus{border-color:var(--dsw-alias-brand-primary)}

.ghsp-toast{flex:0 0 auto;margin:8px 12px 0;padding:6px 9px;border-radius:8px;font-size:11px}
.ghsp-toast.ok{color:var(--dsw-alias-state-success-primary,#3fb950);background:color-mix(in srgb, var(--dsw-alias-state-success-primary,#3fb950) 12%, transparent)}
.ghsp-toast.error{color:var(--dsw-alias-state-error-primary,#f85149);background:color-mix(in srgb, var(--dsw-alias-state-error-primary,#f85149) 12%, transparent)}
.ghsp-toast.info{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2)}

/* ---- v3：左右两栏 + 目标分支语义色 ---- */
.ghsp-panel{container-type:inline-size}
.ghsp-cols{flex:1 1 auto;min-height:0;display:grid;grid-template-columns:minmax(0,1fr) 248px}
.ghsp-col-main{min-width:0;overflow:auto;padding-bottom:8px}
.ghsp-col-side{min-width:0;overflow:auto;padding:10px 10px 16px;border-left:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.ghsp-block{padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.ghsp-block:last-child{border-bottom:0}
.ghsp-block-title{display:flex;align-items:center;gap:8px;margin-bottom:8px;font-size:11px;font-weight:600;letter-spacing:.03em;color:var(--dsw-alias-label-secondary);text-transform:uppercase}
.ghsp-block-meta{margin-left:auto;font-weight:400;text-transform:none;letter-spacing:0;color:var(--dsw-alias-label-secondary)}
.ghsp-side-block{display:flex;flex-direction:column;gap:5px;padding-bottom:12px;margin-bottom:12px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.ghsp-side-block:last-child{border-bottom:0;margin-bottom:0;padding-bottom:0}
.ghsp-side-title{font-size:10px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--dsw-alias-label-secondary)}
.ghsp-sub-title{font-size:10px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--dsw-alias-label-secondary);margin:8px 0 4px}

.ghsp-target{display:inline-flex;align-items:center;justify-content:center;height:17px;max-width:132px;padding:0 6px;border-radius:999px;font-size:10px;font-weight:600;line-height:1;border:1px solid transparent;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:0 0 auto}
/* 默认（浅色主题）：深字 + 浅底；深色主题在下面改成亮字 + 半透明底 */
.ghsp-target.main{color:#6e40c9;background:rgba(110,64,201,.10);border-color:rgba(110,64,201,.35)}
.ghsp-target.release{color:#9a6700;background:rgba(154,103,0,.10);border-color:rgba(154,103,0,.35)}
.ghsp-target.test{color:#0f7b8a;background:rgba(15,123,138,.10);border-color:rgba(15,123,138,.35)}
.ghsp-target.dev{color:#0b57d0;background:rgba(11,87,208,.10);border-color:rgba(11,87,208,.35)}
.ghsp-target.other{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2)}
body[data-ds-dark-theme] .ghsp-target.main{color:#d2a8ff;background:rgba(163,113,247,.18);border-color:rgba(163,113,247,.5)}
body[data-ds-dark-theme] .ghsp-target.release{color:#e3b341;background:rgba(210,153,34,.18);border-color:rgba(210,153,34,.5)}
body[data-ds-dark-theme] .ghsp-target.test{color:#39c5cf;background:rgba(57,197,207,.16);border-color:rgba(57,197,207,.45)}
body[data-ds-dark-theme] .ghsp-target.dev{color:#58a6ff;background:rgba(88,166,255,.16);border-color:rgba(88,166,255,.45)}

@container (max-width: 620px) {
  /* 窄栏：整块一起滚（两列各自滚动会互相抢高度），主内容在前，审批/操作跟在后面 */
  .ghsp-cols{grid-template-columns:1fr;overflow:auto}
  .ghsp-col-main{order:1;overflow:visible}
  .ghsp-col-side{order:2;overflow:visible;border-left:0;border-top:1px solid var(--dsw-alias-border-l1)}
  .ghsp-head{padding:10px 10px 9px}
  .ghsp-meta{row-gap:4px}
  /* 窄栏里分支 + 目标 tag 单独占一整行，别把分支名挤成「p…」 */
  .ghsp-meta .ghsp-branch{flex:1 1 100%;margin-top:2px}
}

/* ---- v4：卡片式分区 + 懒加载骨架 + 高亮 ---- */
.ghsp-col-main,.ghsp-col-side{display:flex;flex-direction:column;gap:10px;padding:10px}
.ghsp-col-side{background:transparent;border-left:1px solid var(--dsw-alias-border-l1)}
.ghsp-card-block{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);overflow:hidden;flex:0 0 auto}
.ghsp-card-head2{display:flex;align-items:center;gap:8px;padding:9px 12px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.ghsp-card-block-title{font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-secondary)}
.ghsp-card-block-meta{margin-left:auto;font-size:11px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.ghsp-card-block-actions{margin-left:auto;display:flex;align-items:center;gap:6px}
.ghsp-card-block-meta + .ghsp-card-block-actions{margin-left:8px}
.ghsp-card-body{padding:10px 12px}
.ghsp-card-body.flush{padding:0}
.ghsp-card-body .ghsp-file:last-child{border-bottom:0}
.ghsp-card-body .ghsp-note:last-child{border-bottom:0}

.ghsp-btn-sm{height:21px;padding:0 7px;font-size:10.5px}
.ghsp-inline-loading{display:inline-flex;align-items:center;gap:6px;font-size:10.5px;color:var(--dsw-alias-label-secondary)}
.ghsp-spinner{width:10px;height:10px;border-radius:50%;border:1.5px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary);animation:ghsp-spin .7s linear infinite}
@keyframes ghsp-spin{to{transform:rotate(360deg)}}
.ghsp-skel-row{height:10px;border-radius:5px;background:var(--dsw-alias-bg-layer-2);margin:8px 12px;animation:ghsp-pulse 1.2s ease-in-out infinite}
.ghsp-fade{position:relative;max-height:280px;overflow:hidden}
.ghsp-fade:after{content:"";position:absolute;left:0;right:0;bottom:0;height:64px;background:linear-gradient(to bottom,transparent,var(--dsw-alias-bg-layer-1))}
.ghsp-more-btn{margin-top:6px}

.ghsp-file.active{background:color-mix(in srgb, var(--dsw-alias-brand-primary) 7%, transparent)}
.ghsp-check.fail{background:color-mix(in srgb, var(--dsw-alias-state-error-primary,#f85149) 9%, transparent);border-radius:6px;padding-left:6px;padding-right:6px;margin-left:-6px;margin-right:-6px}
.ghsp-checks-summary{display:flex;align-items:center;gap:6px;padding-bottom:6px;margin-bottom:2px;border-bottom:1px dashed var(--dsw-alias-border-l1);font-size:11px;color:var(--dsw-alias-label-secondary)}
.ghsp-check-chip.fail{color:var(--dsw-alias-state-error-primary)}
.ghsp-check-chip.pending{color:var(--dsw-alias-state-warn-primary)}
.ghsp-check-chip.pass{color:var(--dsw-alias-state-success-primary)}

/* ---- 头部审批按钮 ---- */
.ghsp-head-actions{display:flex;align-items:center;gap:6px;margin-left:auto;flex-wrap:wrap}
.ghsp-btn-danger{background:color-mix(in srgb, var(--dsw-alias-state-error-primary,#f85149) 22%, transparent);border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary,#f85149) 55%, transparent);color:var(--dsw-alias-state-error-primary,#f85149)}
.ghsp-btn-on{background:color-mix(in srgb, var(--dsw-alias-brand-primary) 18%, transparent);border-color:color-mix(in srgb, var(--dsw-alias-brand-primary) 50%, transparent);color:var(--dsw-alias-brand-primary)}
.ghsp-select{height:21px;padding:0 4px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:10.5px;cursor:pointer;outline:none}
.ghsp-select:hover{border-color:var(--dsw-alias-border-l2)}
.ghsp-check-row{display:flex;align-items:center;gap:6px;margin-top:8px;font-size:11px;color:var(--dsw-alias-label-secondary);cursor:pointer;user-select:none}
.ghsp-check-row input{accent-color:var(--dsw-alias-brand-primary);width:12px;height:12px;margin:0}
.ghsp-fix-btn{height:19px;padding:0 6px;font-size:10px;letter-spacing:.02em}
.ghsp-request{padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.ghsp-request:last-of-type{border-bottom:0}
.ghsp-request .ghsp-note-head{margin-bottom:4px}
.ghsp-clamp{display:-webkit-box;-webkit-line-clamp:8;-webkit-box-orient:vertical;overflow:hidden}

/* ---- 头部审批按钮：绿色、有厚度 ---- */
.ghsp-head-actions .ghsp-btn{height:24px;padding:0 10px;font-size:11px;font-weight:600;border-radius:7px;transition:background .12s ease,box-shadow .12s ease,transform .06s ease,border-color .12s ease}
.ghsp-head-actions .ghsp-btn:not([disabled]):active{transform:translateY(1px)}

.ghsp-btn-approve{color:#2ea043;border-color:rgba(46,160,67,.55);background:linear-gradient(180deg,rgba(46,160,67,.16),rgba(46,160,67,.07));box-shadow:inset 0 1px 0 rgba(255,255,255,.06)}
.ghsp-btn-approve:hover{background:linear-gradient(180deg,rgba(46,160,67,.26),rgba(46,160,67,.12));border-color:rgba(46,160,67,.75);box-shadow:0 0 0 3px rgba(46,160,67,.12)}
body:not([data-ds-dark-theme]) .ghsp-btn-approve{color:#1a7f37;border-color:rgba(26,127,55,.45);background:linear-gradient(180deg,rgba(26,127,55,.10),rgba(26,127,55,.04))}

.ghsp-btn-merge{color:#fff;border-color:rgba(35,134,54,.9);background:linear-gradient(180deg,#2ea043,#238636);box-shadow:inset 0 1px 0 rgba(255,255,255,.16),0 2px 8px rgba(35,134,54,.35)}
.ghsp-btn-merge:hover{background:linear-gradient(180deg,#3fb950,#2ea043);box-shadow:inset 0 1px 0 rgba(255,255,255,.2),0 3px 12px rgba(46,160,67,.45)}
body:not([data-ds-dark-theme]) .ghsp-btn-merge{background:linear-gradient(180deg,#1f883d,#1a7f37);border-color:rgba(26,127,55,.9)}

.ghsp-btn-auto{color:var(--dsw-alias-label-secondary);border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1)}
.ghsp-btn-auto:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2)}
.ghsp-btn-auto.on{color:#2ea043;border-color:rgba(46,160,67,.55);background:linear-gradient(180deg,rgba(46,160,67,.18),rgba(46,160,67,.08));box-shadow:inset 0 1px 0 rgba(255,255,255,.06)}
body:not([data-ds-dark-theme]) .ghsp-btn-auto.on{color:#1a7f37}

.ghsp-head-actions .ghsp-btn[disabled]{background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);box-shadow:none;opacity:.7}
.ghsp-head-actions .ghsp-select{height:24px;border-radius:7px;padding:0 6px;font-size:11px}
.ghsp-more{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 10px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.ghsp-menu{position:fixed;z-index:1000;min-width:168px;padding:4px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-specific-menu,color-mix(in srgb, var(--dsw-alias-bg-base) 94%, #000 6%));backdrop-filter:var(--dsw-menu-backdrop-filter,blur(14px) saturate(1.35));-webkit-backdrop-filter:var(--dsw-menu-backdrop-filter,blur(14px) saturate(1.35));box-shadow:0 12px 32px rgba(0,0,0,.4)}
.ghsp-menu-head{padding:5px 8px 6px;font-size:10.5px;color:var(--dsw-alias-label-secondary);border-bottom:1px solid var(--dsw-alias-border-l1);margin-bottom:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ghsp-menu-item{display:block;width:100%;padding:6px 9px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font-size:11.5px;text-align:left;cursor:pointer}
.ghsp-menu-item:hover{background:var(--dsw-alias-bg-layer-2)}
.ghsp-hint{position:fixed;bottom:186px;right:20px;max-width:360px;padding:6px 10px;border-radius:8px;font-size:11px;color:var(--dsw-alias-label-primary);background:var(--dsw-specific-menu,color-mix(in srgb, var(--dsw-alias-bg-base) 94%, #000 6%));backdrop-filter:var(--dsw-menu-backdrop-filter,blur(14px) saturate(1.35));-webkit-backdrop-filter:var(--dsw-menu-backdrop-filter,blur(14px) saturate(1.35));border:1px solid var(--dsw-alias-border-l2);box-shadow:0 8px 24px rgba(0,0,0,.35);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ghsp-drag-handle{cursor:grab;user-select:none}
.ghsp-drag-handle:active{cursor:grabbing}
/* 系统开了「减弱透明度」时退回不透明——与宿主自己的侧栏处理一致 */
@media (prefers-reduced-transparency: reduce) {
  .ghsp-pill,.ghsp-card,.ghsp-lane-head,.ghsp-menu,.ghsp-hint{background:var(--dsw-alias-bg-base);backdrop-filter:none;-webkit-backdrop-filter:none}
}

.ghsp-pill{cursor:grab}
.ghsp-pill:active{cursor:grabbing}
.ghsp-card-age{font-size:10px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;opacity:.8}
.ghsp-icon-btn.spinning svg{animation:ghsp-spin .8s linear infinite}
.ghsp-icon-btn[disabled]{opacity:.6;cursor:default}
.ghsp-detail-age{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;opacity:.75}
.ghsp-file-toggle{width:16px;height:16px;padding:0;border:0;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:10px;line-height:1}
.ghsp-file-toggle.ghost{cursor:default;opacity:.5}
.ghsp-btn:disabled{opacity:.5;cursor:not-allowed}
.ghsp-head-actions .ghsp-btn-merge:disabled{background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);box-shadow:none}
.ghsp-blocked{font-size:10.5px;color:var(--dsw-alias-state-warn-primary,#d29922);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:220px}
`;
let sessionPrStyleEl = null;
/** 绑定一次 visibilitychange：窗口回到前台立刻补一次，后台停掉轮询 */
export function watchSessionPrVisibility() {
    if (prVisibilityBound || typeof document === "undefined" || !document.addEventListener)
        return () => { };
    prVisibilityBound = true;
    // 回到前台：用户就是要看最新状态，直接绕缓存
    var handler = function () { retunePolling(!document.hidden); };
    document.addEventListener("visibilitychange", handler);
    // 窗口重新获得焦点（切完 GitHub 网页回来）同样立刻刷新
    var onFocus = function () { retunePolling(true); };
    try {
        window.addEventListener("focus", onFocus);
    }
    catch (e) { /* 忽略 */ }
    return () => {
        try {
            document.removeEventListener("visibilitychange", handler);
        }
        catch (e) { /* 忽略 */ }
        try {
            window.removeEventListener("focus", onFocus);
        }
        catch (e) { /* 忽略 */ }
        prVisibilityBound = false;
    };
}
/** 插件卸载时把模块级状态清干净（面板计数泄漏会让浮窗永远不出现） */
export function resetSessionPrModuleState() {
    openPanelCount = 0;
    prSubscribers.length = 0;
    stopSessionPrPolling();
}
/** 供 client.ts 在插件卸载时清掉轮询定时器（模块级单例的清理口） */
export function stopSessionPrPollingExport() {
    try {
        stopSessionPrPolling();
    }
    catch (e) { /* 未开始轮询时无事可做 */ }
}
/** 注入/刷新本模块的样式（与主面板样式分开，避免 theme/change 时丢一半） */
export function injectSessionPrStyles() {
    if (typeof document === "undefined")
        return () => { };
    if (sessionPrStyleEl && sessionPrStyleEl.parentNode) {
        sessionPrStyleEl.textContent = SESSION_PR_CSS;
        return () => { };
    }
    var style = document.createElement("style");
    style.id = "dsh-github-session-pr-styles";
    style.textContent = SESSION_PR_CSS;
    document.head.appendChild(style);
    sessionPrStyleEl = style;
    return () => {
        if (style.parentNode)
            style.parentNode.removeChild(style);
        if (sessionPrStyleEl === style)
            sessionPrStyleEl = null;
    };
}
/* ------------------------------------------------------------------ *
 * 状态与数据
 * ------------------------------------------------------------------ */
/** 当前正在看的会话（与 DSH 自己的「主视图」判定保持一致） */
function selectMainSession(state) {
    var byId = state && state.byId;
    if (!byId)
        return null;
    for (var id in byId) {
        var row = byId[id];
        if (row && row.retainedBy && row.retainedBy.mainView > 0)
            return id;
    }
    return null;
}
/** 会话的本地工作目录（worktree 是文件系统概念，必须用它） */
function useSessionCwd(useSessions, sessionId) {
    return useSessions(function (sessions) {
        if (!sessionId)
            return null;
        return sessions?.byId?.[sessionId]?.cwd || null;
    }) || null;
}
function useMainSessionId(useSessions) {
    // 父组件已经确认 useSessions 是函数（否则根本不挂载这个组件），这里无条件调用一次，
    // 保持 hook 顺序恒定——不要再套 typeof 判断，那会让"能力到没到"改变 hook 数量。
    var id = useSessions(selectMainSession);
    return id || null;
}
var openPanelCount = 0;
var prStore = { sid: null, items: [], loading: false, error: null, at: 0, signature: "" };
var prSubscribers = [];
var prTimer = null;
var prTimerSid = null;
var prVisibilityBound = false;
var prInflightSid = null;
/** false = 浮窗首屏只要数量与编号（不跑 gh）；展开卡片 / 打开面板后置 true，补元数据 */
var prWantFull = false;
/** 每 N 次轮询强制绕一次缓存：host 侧元数据有 TTL，纯靠缓存轮询永远落后一个 TTL */
var prTickCount = 0;
/** 连续失败次数：GitHub 抖动/断网时不要每 8 秒砸一次，指数退避到 64s */
var prFailStreak = 0;
var PR_FORCE_EVERY = 3;
var prLastForceAt = 0;
/** 浮窗卡片是否展开：展开时用户就在盯它，按「在看」的节奏刷 */
var overlayCardOpen = false;
function publishPrStore(next) {
    prStore = next;
    prSubscribers.slice().forEach(function (fn) {
        try {
            fn();
        }
        catch (e) { /* 单个订阅者出错不能拖垮其余界面 */ }
    });
}
function prSignature(items) {
    return (items || []).map(function (i) {
        return [i.repo, i.number, i.state, i.isDraft ? 1 : 0, i.additions, i.deletions, i.updatedAt || "",
            (i.checks && i.checks.state) || "", i.missing ? 1 : 0].join(":");
    }).join("|");
}
function loadSessionPrs(sid, force) {
    if (!sid)
        return;
    if (force) {
        prLastForceAt = Date.now();
        // 手动/强制刷新要有可见反馈：卡片上的 ⟳ 会转起来
        if (!prStore.refreshing)
            publishPrStore(Object.assign({}, prStore, { refreshing: true }));
    }
    // 同一会话单飞；切了会话就别被上一个会话的请求挡住（它的响应会被 sid 校验丢掉）
    if (prInflightSid === sid && !force)
        return;
    prInflightSid = sid;
    var qs = "/api/github/session-created-prs?sessionId=" + encodeURIComponent(sid)
        + (force ? "&refresh=1" : "")
        + (prWantFull ? "" : "&lite=1");
    fetch(qs, { headers: { accept: "application/json" } })
        .then(function (r) { return r.json(); })
        .then(function (json) {
        // 会话已经切走：这一发是旧会话的，丢掉不要覆盖新状态
        if (prStore.sid !== sid)
            return;
        if (json && json.ok) {
            if (prFailStreak > 0) {
                prFailStreak = 0;
                schedulePolling();
            }
            var items = (json.data && json.data.items) || [];
            var sig = prSignature(items);
            if (sig === prStore.signature) {
                // 内容没变：items 保持同一引用（不触发 diff 重算），但时间戳要通知出去，
                // 否则「刚刚/Ns」永远停在旧值，用户会以为刷新没生效。
                publishPrStore(Object.assign({}, prStore, { loading: false, error: null, at: Date.now() }));
            }
            else {
                publishPrStore({ sid: sid, items: items, loading: false, error: null, at: Date.now(), signature: sig });
            }
        }
        else {
            prFailStreak += 1;
            schedulePolling();
            publishPrStore(Object.assign({}, prStore, { loading: false, error: (json && (json.error || json.message)) || "读取失败" }));
        }
    })
        .catch(function (err) {
        if (prStore.sid !== sid)
            return;
        prFailStreak += 1;
        schedulePolling();
        publishPrStore(Object.assign({}, prStore, { loading: false, error: String((err && err.message) || err) }));
    })
        .finally(function () {
        if (prInflightSid === sid)
            prInflightSid = null;
    });
}
/** 切到某个会话的轮询；同一会话重复调用是幂等的 */
function ensureSessionPrPolling(sid) {
    if (!sid)
        return;
    if (prTimerSid === sid)
        return;
    prTimerSid = sid;
    if (prTimer) {
        clearInterval(prTimer);
        prTimer = null;
    }
    // 立刻清空旧会话的行：切换会话时最忌讳把上一个会话的 PR 继续挂在浮窗上
    publishPrStore({ sid: sid, items: [], loading: true, error: null, at: 0, signature: "" });
    loadSessionPrs(sid, false);
    schedulePolling();
}
/**
 * 轮询节奏跟着「看得多认真」走：
 * - 面板开着（正在看 diff / 检查）→ 8s；
 * - 只有浮窗挂着 → 30s（只是想知道有没有新 PR，不需要秒级）；
 * - 窗口在后台 → 完全停（回来时 visibilitychange 会立刻补一次）。
 * 原来不管什么状态都 8s，一天下来是几千次请求，白烧。
 */
function prPollInterval() {
    try {
        if (typeof document !== "undefined" && document.hidden)
            return 0;
    }
    catch (e) { /* 无 document 环境忽略 */ }
    var base = (openPanelCount > 0 || overlayCardOpen) ? 8000 : 30000;
    if (prFailStreak > 0) {
        var factor = Math.min(1 << Math.min(prFailStreak, 3), 8); // ×2 ×4 ×8，封顶 8 倍
        return Math.min(base * factor, 120000);
    }
    return base;
}
function schedulePolling() {
    if (prTimer) {
        clearInterval(prTimer);
        prTimer = null;
    }
    var sid = prTimerSid;
    if (!sid)
        return;
    var every = prPollInterval();
    if (every <= 0)
        return;
    var pollingSid = sid;
    prTimer = setInterval(function () {
        prTickCount += 1;
        // 每 PR_FORCE_EVERY 拍绕一次缓存；其余拍走缓存，省 gh
        loadSessionPrs(pollingSid, prTickCount % PR_FORCE_EVERY === 0);
    }, every);
}
/** 面板开合 / 窗口可见性变化时，按新节奏重排（同一会话） */
function retunePolling(force) {
    var sid = prTimerSid;
    if (!sid)
        return;
    schedulePolling();
    if (prPollInterval() > 0)
        loadSessionPrs(sid, force === true);
}
/** 切到「要完整元数据」：浮窗展开、或面板挂载时调用 */
function requestFullSessionPrs() {
    if (prWantFull)
        return;
    prWantFull = true;
    if (prTimerSid)
        loadSessionPrs(prTimerSid, true);
}
function stopSessionPrPolling() {
    if (prTimer)
        clearInterval(prTimer);
    prTimer = null;
    prTimerSid = null;
}
/** 订阅单例 store；sessionId 变化时切换轮询目标 */
function useSessionCreatedPrs(sessionId) {
    var [, bump] = React.useReducer(function (n) { return n + 1; }, 0);
    React.useEffect(function () {
        var listener = function () { bump(); };
        prSubscribers.push(listener);
        ensureSessionPrPolling(sessionId);
        return function () {
            var idx = prSubscribers.indexOf(listener);
            if (idx >= 0)
                prSubscribers.splice(idx, 1);
            // 没有任何订阅者了就不再空转（插件卸载/界面都关了）
            if (prSubscribers.length === 0)
                stopSessionPrPolling();
        };
    }, [sessionId]);
    var refresh = React.useCallback(function () {
        if (sessionId)
            loadSessionPrs(sessionId, true);
    }, [sessionId]);
    // store 属于别的会话时先给一个干净的加载态，别把别人的 PR 显示出来
    var state = prStore.sid === sessionId
        ? prStore
        : { sid: sessionId, items: [], loading: Boolean(sessionId), error: null, at: 0, signature: "" };
    return [state, refresh];
}
function prStateKey(item) {
    var state = String((item && item.state) || "").toUpperCase();
    if (state === "MERGED")
        return "merged";
    if (state === "CLOSED")
        return "closed";
    if (item && item.isDraft)
        return "draft";
    if (state === "OPEN")
        return "open";
    return "unknown";
}
function prStateLabel(key) {
    if (key === "merged")
        return "merged";
    if (key === "closed")
        return "closed";
    if (key === "draft")
        return "draft";
    if (key === "open")
        return "open";
    return "?";
}
/**
 * 来源小标：这个 PR 是子代理会话建的。
 *
 * 为什么要标：PR 可能是主会话派下去的发版子代理提的，用户没亲手点过「创建 PR」。
 * 不标出来就会疑惑「这东西怎么会在这个会话里」；标一眼，语义就闭合了。
 * 主会话亲手建的 PR 保持原样（多一个标等于噪音）。
 */
function renderOriginTag(item) {
    if (!item || item.origin !== "subagent")
        return null;
    var title = "由子代理会话创建";
    if (item.depth > 1)
        title += "（第 " + item.depth + " 层）";
    if (item.originSessionId)
        title += "：" + item.originSessionId;
    return React.createElement("span", { className: "ghsp-origin", title: title }, "子代理");
}
/* ------------------------------------------------------------------ *
 * 浮窗
 * ------------------------------------------------------------------ */
/**
 * 一条 workflow → 一行文案（浮窗用的紧凑版，可单测）：
 *   运行中 → "3/13 步"；完成 → "12m 前"；失败 → "失败 · 12m 前"；排队 → "排队中"
 */
/** 自带的相对时间（不依赖 bundle 注入的 formatRelativeTime，便于单测直接 import） */
function shortAgo(iso) {
    if (!iso)
        return '';
    var t = Date.parse(String(iso));
    if (!isFinite(t))
        return '';
    var sec = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (sec < 60)
        return sec + 's 前';
    var min = Math.round(sec / 60);
    if (min < 60)
        return min + 'm 前';
    var h = Math.round(min / 60);
    if (h < 24)
        return h + 'h 前';
    return Math.round(h / 24) + 'd 前';
}
export function ciWorkflowLine(wf) {
    var latest = (wf && wf.latest) || {};
    var status = String(latest.status || '').toLowerCase();
    var conclusion = String(latest.conclusion || '').toLowerCase();
    var active = latest.active;
    var when = shortAgo(latest.completedAt || latest.updatedAt || '');
    if (status === 'in_progress') {
        var steps = active && active.stepsTotal > 0
            ? Math.min(active.stepsDone + 1, active.stepsTotal) + '/' + active.stepsTotal + ' 步'
            : '运行中';
        return { tone: 'pending', text: steps, title: (wf && wf.name ? wf.name + ' · ' : '') + steps + (active && active.stepName ? ' · ' + active.stepName : '') };
    }
    if (status === 'queued' || status === 'waiting' || status === 'requested') {
        return { tone: 'pending', text: '排队中', title: (wf && wf.name) || '' };
    }
    if (conclusion === 'failure' || conclusion === 'timed_out' || conclusion === 'startup_failure') {
        return { tone: 'fail', text: when ? '失败 · ' + when : '失败', title: (wf && wf.name ? wf.name + ' · ' : '') + '最近一次失败' + (when ? '（' + when + '）' : '') };
    }
    if (conclusion === 'cancelled' || conclusion === 'skipped') {
        return { tone: 'none', text: when ? '已取消 · ' + when : '已取消', title: (wf && wf.name) || '' };
    }
    return { tone: 'pass', text: when || '已完成', title: (wf && wf.name ? wf.name + ' · ' : '') + '最近一次通过' + (when ? '（' + when + '）' : '') };
}
function CiPipelineCard(props) {
    var cwd = props && props.cwd;
    var repo = props && props.repo;
    var [state, setState] = React.useState({ loading: true, error: null, data: null });
    var [tick, setTick] = React.useState(0);
    var [visible, setVisible] = React.useState(false);
    var rootRef = React.useRef(null);
    // 分页显示是 DOM 层的（data-tab-page + hidden），React 并不知道当前在哪个 tab。
    // 所以盯住自己所在分页的 hidden：Actions 分页没打开时一个请求都不发。
    // 这也顺带解决了「进面板就多打一次 Actions API」的白烧额度。
    React.useEffect(function () {
        var el = rootRef.current;
        var page = el && el.closest ? el.closest("[data-tab-page]") : null;
        if (!page) {
            setVisible(true);
            return;
        }
        setVisible(!page.hidden);
        if (typeof MutationObserver !== "function")
            return;
        var obs = new MutationObserver(function () { setVisible(!page.hidden); });
        obs.observe(page, { attributes: true, attributeFilter: ["hidden"] });
        return function () { obs.disconnect(); };
    }, []);
    React.useEffect(function () {
        if (!visible)
            return;
        if (!cwd && !repo)
            return;
        var alive = true;
        var load = function (force) {
            var controller = typeof AbortController === "function" ? new AbortController() : null;
            var qs = "/api/github/ci-pipeline?limit=8";
            if (cwd)
                qs += "&cwd=" + encodeURIComponent(String(cwd));
            if (repo)
                qs += "&repo=" + encodeURIComponent(String(repo));
            if (force)
                qs += "&refresh=1";
            var timer = setTimeout(function () { if (controller)
                controller.abort(); }, 20000);
            if (!state.data)
                setState(function (prev) { return { loading: true, error: null, data: prev.data }; });
            fetch(qs, { headers: { accept: "application/json" }, signal: controller ? controller.signal : undefined })
                .then(function (r) { return r.json(); })
                .then(function (json) {
                if (!alive)
                    return;
                if (json && json.ok && json.data)
                    setState({ loading: false, error: null, data: json.data });
                else
                    setState(function (prev) {
                        return { loading: false, error: (json && (json.error || json.message)) || "读取 CI 流水线失败", data: prev.data };
                    });
            })
                .catch(function (err) {
                if (!alive)
                    return;
                setState(function (prev) {
                    return { loading: false, error: String((err && err.message) || err), data: prev.data };
                });
            })
                .then(function () { clearTimeout(timer); });
        };
        load(tick > 0);
        // 20s 一轮：目的是让「运行中」的进度条会走，不追求实时；
        // 页面切到后台时停轮询，回到前台由 visibilitychange 那个 effect 重新触发。
        var interval = setInterval(function () {
            try {
                if (typeof document !== "undefined" && document.visibilityState === "hidden")
                    return;
            }
            catch (e) { /* 无 DOM 环境就当可见 */ }
            load(false);
        }, 20000);
        return function () { alive = false; clearInterval(interval); };
    }, [visible, cwd, repo, tick]);
    var data = state.data;
    var workflows = (data && data.workflows) || [];
    var totals = (data && data.totals) || { workflows: 0, running: 0, queued: 0, failed: 0 };
    var head = React.createElement("div", { style: { display: "flex", alignItems: "center", gap: "6px", marginBottom: "6px" } }, React.createElement("h3", { className: "gh2-section-title", style: { margin: 0 } }, "CI/CD"), React.createElement("span", { className: "gh2-section-count" }, String(workflows.length)), totals.running ? React.createElement("span", { className: "gh2-chip gh2-chip--busy" }, totals.running + " 运行中") : null, totals.queued ? React.createElement("span", { className: "gh2-chip gh2-chip--idle" }, totals.queued + " 排队") : null, totals.failed ? React.createElement("span", { className: "gh2-chip gh2-chip--bad" }, totals.failed + " 失败") : null, React.createElement("button", {
        type: "button",
        className: "gh2-icon-btn",
        title: "立即刷新 CI 流水线（绕过 15s 缓存）",
        style: { marginLeft: "auto" },
        onClick: function () { setTick(tick + 1); },
    }, "↻"));
    var wrap = function (body) {
        return React.createElement("div", { ref: rootRef, className: "dsh-github-section" }, head, body);
    };
    // 死路状态要给出口：重试按钮 + 权限提示。
    // 「读不到 Actions」最可能是 token 缺 actions:read，只显示一行原因等于让人干瞪眼。
    var retryBtn = React.createElement("button", {
        type: "button",
        className: "gh2-quick-btn",
        style: { marginTop: "6px" },
        onClick: function () { setTick(tick + 1); },
    }, "重试");
    var withScopeHint = function (text) {
        var needScope = /权限|permission|scope|403|forbidden/i.test(String(text || ""));
        return React.createElement("div", { className: "gh2-empty" }, text, needScope
            ? React.createElement("div", { style: { marginTop: "4px", color: "var(--dsw-alias-label-tertiary)", fontSize: "10px" } }, "拉取 Actions 需要 actions:read：`gh auth refresh -h github.com -s actions`")
            : null, retryBtn);
    };
    if (state.loading && !data)
        return wrap(React.createElement("div", { className: "gh2-empty" }, "读取 CI 流水线…"));
    if (state.error && !data)
        return wrap(withScopeHint("CI 读取失败：" + state.error));
    if (data && data.available === false) {
        return wrap(withScopeHint(data.reason || "这个仓库没有可读的 Actions 运行记录"));
    }
    if (workflows.length === 0)
        return wrap(React.createElement("div", { className: "gh2-empty" }, "暂无工作流运行"));
    return wrap(React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: "6px" } }, workflows.map(function (wf) {
        var latest = (wf && wf.latest) || {};
        var stats = (wf && wf.stats) || {};
        var badge = runConclusionBadge(latest.conclusion, latest.status);
        // 组件层只定义了 ok/bad/warn/busy/idle 五种色调（tw.src.css），
        // 用 success/error 这类「语义名」会拿不到样式，徽章变成无色文本。
        var tone = badge.tone === "green" ? "ok" : badge.tone === "red" ? "bad"
            : badge.tone === "yellow" ? "warn" : badge.tone === "blue" ? "busy" : "idle";
        var active = latest.active;
        var statusLower = String(latest.status || "").toLowerCase();
        var when = latest.completedAt
            ? formatRelativeTime(latest.completedAt) + "完成"
            : (statusLower === "in_progress" ? "运行中" : statusLower === "queued" ? "排队中" : "");
        var dur = formatDurationMs(latest.durationMs);
        var rate = typeof stats.successRate === "number" ? Math.round(stats.successRate * 100) + "%" : "";
        // 运行中：说「已经跑了多久」+「历史均值多少」，让人能判断是不是卡住了。
        // 光有进度条看不出「这 4 分钟是正常还是异常」。
        var startedMs = Date.parse(String(latest.startedAt || ""));
        var elapsed = statusLower === "in_progress" && isFinite(startedMs) && startedMs > 0
            ? formatDurationMs(Date.now() - startedMs) : "";
        var avg = stats.avgDurationMs ? formatDurationMs(stats.avgDurationMs) : "";
        var metaParts = [
            when,
            dur ? "用时 " + dur : "",
            elapsed ? "已跑 " + elapsed + (avg ? " / 均值 " + avg : "") : "",
            rate ? "成功率 " + rate : "",
            !elapsed && avg ? "均值 " + avg : "",
            latest.headBranch || "",
        ].filter(Boolean);
        return React.createElement("div", {
            key: String(wf.id || wf.name),
            style: {
                padding: "6px 8px", borderRadius: "8px",
                border: "1px solid var(--dsw-alias-border-l2)",
                background: "var(--dsw-alias-bg-layer-1, transparent)",
            },
        }, React.createElement("div", { style: { display: "flex", alignItems: "center", gap: "6px", minWidth: 0 } }, React.createElement("span", { className: "gh2-dot gh2-dot--" + tone, title: badge.label }), React.createElement("a", {
            href: latest.url || undefined, target: "_blank", rel: "noreferrer",
            title: (wf.name || "") + "\n" + badge.label,
            style: { flex: 1, minWidth: 0, fontSize: "12px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--dsw-alias-label-primary)" },
        }, wf.name || "workflow"), React.createElement("span", { className: "gh2-chip gh2-chip--" + tone, style: { fontSize: "10px" } }, badge.label.replace(/^[^\u4e00-\u9fa5]+/, "").trim())), 
        // 正在跑的：job 名 + 第几步 + 进度条（这就是「走到哪一步」）
        active
            ? React.createElement("div", { style: { marginTop: "5px" } }, React.createElement("div", { style: { fontSize: "10px", color: "var(--dsw-alias-label-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, (active.stepsTotal > 0
                ? "第 " + Math.min(active.stepsDone + 1, active.stepsTotal) + "/" + active.stepsTotal + " 步"
                : active.jobStatus.toLowerCase()) +
                (active.stepName ? " · " + active.stepName : "") +
                " · " + active.job), React.createElement("div", {
                style: { height: "3px", marginTop: "3px", borderRadius: "2px", background: "var(--dsw-alias-bg-layer-2)", overflow: "hidden" },
                title: active.stepsDone + "/" + active.stepsTotal + " 步完成",
            }, React.createElement("div", {
                style: {
                    width: Math.round((Number(active.ratio) || 0) * 100) + "%",
                    height: "100%",
                    background: "var(--dsw-alias-brand-primary, #2f81f7)",
                    transition: "width .3s ease",
                },
            })))
            : null, React.createElement("div", { style: { marginTop: "4px", fontSize: "10px", color: "var(--dsw-alias-label-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, title: metaParts.join(" · ") }, metaParts.join(" · ")));
    }), (Number(totals.workflows) || 0) > workflows.length
        ? React.createElement("div", {
            style: { fontSize: "10px", color: "var(--dsw-alias-label-secondary)", paddingLeft: "2px" },
            title: "只展示最近 " + workflows.length + " 个 workflow；总数与失败数按全量统计",
        }, "另有 " + (Number(totals.workflows) - workflows.length) + " 个 workflow 未显示（失败数按全量算）")
        : null));
}
/**
 * 浮窗里的 CI/CD 紧凑条。
 * 为什么浮窗也要有：用户看的是浮窗，右列面板的「本会话 PR」列表页不一定打开过，
 * 把 CI/CD 只放在面板里等于没有入口。
 * 只显示最近 3 个 workflow 的一行摘要，点标题行可以展开看全部（打开面板）。
 */
/**
 * 浮窗里的「项目」区块：当前仓库 + 分支 + git worktree 列表。
 *
 * 为什么值得单独一块：多 worktree 开发时最常见的事故是「在错的 worktree 里改文件」。
 * 把「这个会话属于哪个仓库、有几个 worktree、我当前在哪个」摆在浮窗上，比事后排查便宜。
 */
/**
 * 读 JSON 的安全版：宿主版本落后（路由不存在）时返回的是纯文本 "not found"，
 * 直接 res.json() 会抛 "Unexpected token 'o'"，用户只看到一串解析错误。
 * 这里把「非 JSON」翻译成一句能行动的话。
 */
function readJsonSafe(res) {
    return res.text().then(function (text) {
        try {
            return JSON.parse(text);
        }
        catch (e) {
            var status = res && res.status ? 'HTTP ' + res.status : '响应异常';
            return { ok: false, error: '接口不可用（' + status + '）：宿主可能还没重启到当前版本' };
        }
    });
}
/**
 * worktree 展示顺序与截断（纯函数，可单测）：
 * 当前所在排第一，其次主 worktree，最后其余；超出 cap 的折成「另 N 个」。
 * 为什么必须截断：一个仓库可能有十几个 worktree（实测 zlzh-base 有 14 个），
 * 全列会把这个 372px 的浮窗撑爆。
 */
export function limitWorktrees(list, cap = 8) {
    var arr = Array.isArray(list) ? list.slice() : [];
    var rank = function (wt) { return wt && wt.isCurrent ? 0 : (wt && wt.isMain ? 1 : 2); };
    arr.sort(function (a, b) {
        var d = rank(a) - rank(b);
        if (d !== 0)
            return d;
        return String((a && a.name) || "").localeCompare(String((b && b.name) || ""));
    });
    var limit = Math.max(1, cap);
    return { shown: arr.slice(0, limit), hidden: Math.max(0, arr.length - limit) };
}
/**
 * 浮窗里的「项目」视图：每个项目一张卡片，卡片里列出它的 worktree。
 * 只负责内容，不画头部——tab 由外层统一提供。
 */
/**
 * 浮窗顶部的 tab 切换：功能 / 项目 / CI/CD。
 * 为什么用 tab 而不是纵向堆三块：372px 宽的浮窗里堆三块，每块都只能露出两三行，
 * 反而看不清；tab 一次只给一块完整空间，切换成本只有一次点击。
 */
function overlayTabBar(tab, onChange, prCount) {
    var defs = [
        { key: "pr", label: "功能", count: prCount },
        { key: "project", label: "项目", count: null },
        { key: "ci", label: "CI/CD", count: null },
    ];
    // 用 role=group + aria-pressed：这是「一组切换按钮」，不是真正的 ARIA tab
    // （没有 tabpanel 关联，硬套 role=tab 反而错），也避免和旧分段栏的守卫冲突。
    return React.createElement("div", { className: "ghsp-otabs", role: "group" }, defs.map(function (d) {
        var active = tab === d.key;
        return React.createElement("button", {
            key: d.key,
            type: "button",
            "aria-pressed": active ? "true" : "false",
            className: "ghsp-otab" + (active ? " active" : ""),
            onClick: function () { onChange(d.key); },
        }, d.label, d.count != null ? React.createElement("span", { className: "ghsp-otab-count" }, String(d.count)) : null);
    }));
}
function WorkspaceBlock(props) {
    var cwd = props && props.cwd;
    var repos = Array.isArray(props && props.repos) ? props.repos : [];
    var [state, setState] = React.useState({ loading: true, data: null, error: null });
    React.useEffect(function () {
        if (!cwd)
            return;
        var alive = true;
        var qs = "/api/github/workspace-info?cwd=" + encodeURIComponent(String(cwd));
        if (repos.length)
            qs += "&repos=" + encodeURIComponent(repos.join(","));
        fetch(qs, { headers: { accept: "application/json" } })
            .then(readJsonSafe)
            .then(function (json) {
            if (!alive)
                return;
            if (json && json.ok && json.data)
                setState({ loading: false, data: json.data, error: null });
            else
                setState({ loading: false, data: null, error: (json && (json.error || json.message)) || "读取失败" });
        })
            .catch(function (err) {
            if (!alive)
                return;
            setState({ loading: false, data: null, error: String((err && err.message) || err) });
        });
        return function () { alive = false; };
    }, [cwd, repos.join(",")]);
    if (!cwd)
        return React.createElement("div", { className: "ghsp-empty2" }, "当前标签页没有绑定会话");
    if (state.loading && !state.data)
        return React.createElement("div", { className: "ghsp-empty2" }, "读取中…");
    if (state.error)
        return React.createElement("div", { className: "ghsp-empty2" }, state.error);
    var projects = (state.data && state.data.projects) || [];
    if (!projects.length)
        return React.createElement("div", { className: "ghsp-empty2" }, "本会话还没有关联项目");
    return React.createElement("div", { className: "ghsp-ocards" }, projects.map(function (proj) {
        var wts = proj.worktrees || [];
        var limited = limitWorktrees(wts, 6);
        var shortName = String(proj.repo || "").split("/").pop();
        return React.createElement("div", { key: proj.repo, className: "ghsp-oscard" }, React.createElement("div", { className: "ghsp-oscard-head" }, React.createElement("span", { className: "ghsp-oscard-title", title: proj.localPath || proj.repo }, shortName), React.createElement("span", { className: "ghsp-oscard-sub" }, proj.localPath ? (proj.branch || "（无分支）") : "本地无副本", proj.localPath && typeof proj.dirtyCount === "number" && proj.dirtyCount > 0 ? " · " + proj.dirtyCount + " 未提交" : "", wts.length > 1 ? " · " + wts.length + " wt" : "")), wts.length
            ? React.createElement("ul", { className: "ghsp-wts" }, limited.shown.map(function (wt) {
                return React.createElement("li", { key: wt.path, className: "ghsp-wt" + (wt.isCurrent ? " current" : ""), title: wt.path }, React.createElement("span", { className: "ghsp-wt-mark" }, wt.isCurrent ? "●" : "○"), React.createElement("span", { className: "ghsp-wt-name" }, String(wt.name || wt.path)), React.createElement("span", { className: "ghsp-wt-branch" }, wt.detached ? "(detached)" : (wt.branch || "")), wt.prunable ? React.createElement("span", { className: "ghsp-wt-tag" }, "可清理") : null);
            }).concat(limited.hidden > 0
                ? [React.createElement("li", { key: "more", className: "ghsp-wt more" }, "另 " + limited.hidden + " 个")]
                : []))
            : null);
    }));
}
/**
 * 浮窗里的「CI/CD」视图：每个 workflow 一张卡片。
 * 运行中给步骤进度条；已结束给「多久前 + 成功率」。
 */
function CiPipelineStrip(props) {
    var repo = props && props.repo;
    var [state, setState] = React.useState({ loading: true, data: null, error: null });
    React.useEffect(function () {
        if (!repo)
            return;
        var alive = true;
        var qs = "/api/github/ci-pipeline?limit=6&repo=" + encodeURIComponent(String(repo));
        fetch(qs, { headers: { accept: "application/json" } })
            .then(readJsonSafe)
            .then(function (json) {
            if (!alive)
                return;
            if (json && json.ok && json.data)
                setState({ loading: false, data: json.data, error: null });
            else
                setState({ loading: false, data: null, error: (json && (json.error || json.message)) || "读取失败" });
        })
            .catch(function (err) {
            if (!alive)
                return;
            setState({ loading: false, data: null, error: String((err && err.message) || err) });
        });
        return function () { alive = false; };
    }, [repo]);
    if (!repo)
        return React.createElement("div", { className: "ghsp-empty2" }, "还没有关联仓库");
    if (state.loading && !state.data)
        return React.createElement("div", { className: "ghsp-empty2" }, "读取中…");
    if (state.error)
        return React.createElement("div", { className: "ghsp-empty2" }, state.error);
    var data = state.data;
    if (data && data.available === false)
        return React.createElement("div", { className: "ghsp-empty2" }, data.reason || "读不到 Actions 运行记录");
    var workflows = (data && data.workflows) || [];
    var totals = (data && data.totals) || {};
    if (!workflows.length)
        return React.createElement("div", { className: "ghsp-empty2" }, "暂无工作流运行");
    return React.createElement("div", { className: "ghsp-ocards" }, React.createElement("div", { className: "ghsp-ocards-sum" }, String(totals.workflows || workflows.length) + " 个 workflow"
        + (totals.running ? " · " + totals.running + " 运行中" : "")
        + (totals.failed ? " · " + totals.failed + " 失败" : "")), workflows.map(function (wf) {
        var line = ciWorkflowLine(wf);
        var active = wf.latest && wf.latest.active;
        return React.createElement("div", { key: String(wf.id || wf.name), className: "ghsp-oscard" }, React.createElement("div", { className: "ghsp-oscard-head" }, React.createElement("span", { className: "ghsp-dot " + (line.tone === 'fail' ? 'fail' : line.tone === 'pending' ? 'pending' : line.tone === 'none' ? 'none' : 'pass') }), React.createElement("span", { className: "ghsp-oscard-title", title: line.title }, String(wf.name || "workflow")), React.createElement("span", { className: "ghsp-oscard-sub" }, line.text)), active
            ? React.createElement("div", { className: "ghsp-bar-wrap" }, React.createElement("div", { className: "ghsp-bar-fill", style: { width: Math.round((Number(active.ratio) || 0) * 100) + "%" } }))
            : null);
    }));
}
export function SessionPrOverlay(props) {
    // useSessions 是宿主注入的 hook：它没到位的首帧不能调用，否则下一帧多一个 hook 会炸。
    // 所以按「有没有」分成两个组件，让 React 用挂载/卸载来处理能力到达，而不是改变 hook 数量。
    if (typeof (props && props.useSessions) !== "function")
        return null;
    return React.createElement(SessionPrOverlayInner, props);
}
/** 浮窗位置：localStorage 持久化；坏数据当作没设置 */
const OVERLAY_POS_KEY = "dsh-pr-panel:overlay-pos";
function loadOverlayPos() {
    try {
        var raw = localStorage.getItem(OVERLAY_POS_KEY);
        if (!raw)
            return null;
        var v = JSON.parse(raw);
        if (!v || typeof v.x !== "number" || typeof v.y !== "number")
            return null;
        if (!isFinite(v.x) || !isFinite(v.y))
            return null;
        return { x: v.x, y: v.y };
    }
    catch (e) {
        return null;
    }
}
function saveOverlayPos(pos) {
    try {
        if (!pos)
            localStorage.removeItem(OVERLAY_POS_KEY);
        else
            localStorage.setItem(OVERLAY_POS_KEY, JSON.stringify({ x: Math.round(pos.x), y: Math.round(pos.y) }));
    }
    catch (e) { /* 隐私模式/配额满：位置不持久化，但拖拽本身仍然可用 */ }
}
/** 「刚刚 / 12s / 2m」——让用户看得见新鲜度，而不是猜 */
function ageLabel(at) {
    if (!at)
        return "";
    var sec = Math.max(0, Math.round((Date.now() - at) / 1000));
    if (sec < 5)
        return "刚刚";
    if (sec < 60)
        return sec + "s";
    var min = Math.round(sec / 60);
    return min + "m";
}
function SessionPrOverlayInner(props) {
    var sessionId = useMainSessionId(props.useSessions);
    var sessionCwd = useSessionCwd(props.useSessions, sessionId);
    var pair = useSessionCreatedPrs(sessionId);
    var state = pair[0];
    var refresh = pair[1];
    var [open, setOpen] = React.useState(false);
    // 浮窗 tab：功能 / 项目 / CI-CD
    var [overlayTab, setOverlayTab] = React.useState("pr");
    // 右键菜单：{x, y, item}；同时用一个短 toast 反馈「已复制」
    var [menu, setMenu] = React.useState(null);
    var [hint, setHint] = React.useState(null);
    /* ---------------- 拖拽：位置持久化到 localStorage ---------------- */
    var [pos, setPos] = React.useState(function () { return loadOverlayPos(); });
    var dragRef = React.useRef(null);
    var movedRef = React.useRef(false);
    function overlayStyle() {
        if (!pos)
            return undefined;
        return { left: pos.x + "px", top: pos.y + "px", right: "auto", bottom: "auto" };
    }
    function onDragStart(ev) {
        if (!ev || (ev.button !== undefined && ev.button !== 0))
            return;
        var wrap = ev.currentTarget && ev.currentTarget.closest ? ev.currentTarget.closest(".ghsp-overlay") : null;
        var rect = wrap && wrap.getBoundingClientRect ? wrap.getBoundingClientRect() : { left: 0, top: 0, width: 360, height: 240 };
        dragRef.current = {
            startX: ev.clientX || 0,
            startY: ev.clientY || 0,
            origX: pos ? pos.x : (rect.left || 0),
            origY: pos ? pos.y : (rect.top || 0),
            w: rect.width || 360,
            h: rect.height || 240,
        };
        movedRef.current = false;
        try {
            document.addEventListener("mousemove", onDragMove, true);
            document.addEventListener("mouseup", onDragEnd, true);
            // 拖的时候别顺手选中背后的正文
            if (document.body && document.body.style)
                document.body.style.userSelect = "none";
        }
        catch (e) { /* 无 DOM 环境忽略 */ }
        if (ev.preventDefault)
            ev.preventDefault();
    }
    function clampPos(x, y, w, h) {
        var vw = 1280;
        var vh = 800;
        try {
            vw = window.innerWidth || vw;
            vh = window.innerHeight || vh;
        }
        catch (e) { /* 忽略 */ }
        // 至少留 80px 在视口内，避免拖出去后再也抓不到
        var minX = 8 - w + 80;
        var maxX = vw - 80;
        var minY = 8;
        var maxY = vh - 40;
        return { x: Math.min(Math.max(x, minX), maxX), y: Math.min(Math.max(y, minY), maxY) };
    }
    function onDragMove(ev) {
        var d = dragRef.current;
        if (!d)
            return;
        var dx = (ev.clientX || 0) - d.startX;
        var dy = (ev.clientY || 0) - d.startY;
        if (!movedRef.current && Math.abs(dx) + Math.abs(dy) < 4)
            return; // 抖动阈值：没真的拖就别接管
        movedRef.current = true;
        setPos(clampPos(d.origX + dx, d.origY + dy, d.w, d.h));
    }
    function onDragEnd() {
        dragRef.current = null;
        try {
            document.removeEventListener("mousemove", onDragMove, true);
            document.removeEventListener("mouseup", onDragEnd, true);
            if (document.body && document.body.style)
                document.body.style.userSelect = "";
        }
        catch (e) { /* 忽略 */ }
        if (movedRef.current)
            saveOverlayPos(posRef.current);
    }
    // 拖动结束时要拿到最新 pos（setState 是异步的），用 ref 同步一份
    var posRef = React.useRef(pos);
    posRef.current = pos;
    React.useEffect(function () {
        return function () {
            try {
                document.removeEventListener("mousemove", onDragMove, true);
                document.removeEventListener("mouseup", onDragEnd, true);
                if (document.body && document.body.style)
                    document.body.style.userSelect = "";
            }
            catch (e) { /* 忽略 */ }
        };
    }, []);
    function resetPos() {
        setPos(null);
        saveOverlayPos(null);
    }
    function closeMenu() { setMenu(null); }
    // 菜单开着时：点别处 / Esc / 滚动 都关掉（右键菜单不关会很脏）
    React.useEffect(function () {
        if (!menu)
            return;
        var onDown = function (ev) {
            var el = ev && ev.target;
            if (el && el.closest && el.closest(".ghsp-menu"))
                return;
            closeMenu();
        };
        var onKey = function (ev) { if (ev && ev.key === "Escape")
            closeMenu(); };
        var onScroll = function () { closeMenu(); };
        try {
            document.addEventListener("mousedown", onDown, true);
            document.addEventListener("keydown", onKey, true);
            window.addEventListener("scroll", onScroll, true);
            window.addEventListener("resize", onScroll);
        }
        catch (e) { /* 无 DOM 环境忽略 */ }
        return function () {
            try {
                document.removeEventListener("mousedown", onDown, true);
                document.removeEventListener("keydown", onKey, true);
                window.removeEventListener("scroll", onScroll, true);
                window.removeEventListener("resize", onScroll);
            }
            catch (e) { /* 忽略 */ }
        };
    }, [menu]);
    function flashHint(text) {
        setHint(text);
        try {
            setTimeout(function () { setHint(null); }, 2600);
        }
        catch (e) { /* 忽略 */ }
    }
    function prUrlOf(item) {
        return (item && item.url) || ("https://github.com/" + (item && item.repo) + "/pull/" + (item && item.number));
    }
    function copyPrLink(item) {
        var url = prUrlOf(item);
        try {
            if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(url).then(function () { flashHint("已复制链接 " + url); }, function () { flashHint("复制失败，链接：" + url); });
            }
            else {
                flashHint("复制失败，链接：" + url);
            }
        }
        catch (e) {
            flashHint("复制失败，链接：" + url);
        }
        closeMenu();
    }
    function openOnGitHub(item) {
        closeMenu();
        var url = prUrlOf(item);
        if (props && typeof props.onOpenUrl === "function")
            props.onOpenUrl(url);
        else {
            try {
                window.open(url, "_blank", "noopener,noreferrer");
            }
            catch (e) { /* 忽略 */ }
        }
    }
    var items = state.items || [];
    // 面板已经打开时不再悬浮：它盖住的就是刚打开的那一栏
    if (openPanelCount > 0)
        return null;
    if (!sessionId || items.length === 0)
        return null;
    var headline = items[0];
    var total = items.length;
    // 首帧 lite 只回了编号：这时按阶段切段会先冒出假的 Other 段，先平铺
    var pendingOnly = items.every(function (it) { return it.pending; });
    var overlayRow = function (item) {
        var rowKey = prStateKey(item);
        var checks = item.checks || { state: "none" };
        return React.createElement("li", { key: item.repo + "#" + item.number }, React.createElement("button", {
            type: "button",
            className: "ghsp-row",
            onClick: function () {
                if (props.onOpenPr)
                    props.onOpenPr({ repo: item.repo, number: item.number });
            },
            onContextMenu: function (ev) {
                if (ev && ev.preventDefault)
                    ev.preventDefault();
                var x = (ev && (ev.clientX || 0)) || 0;
                var y = (ev && (ev.clientY || 0)) || 0;
                setMenu({ x: x, y: y, item: item });
            },
        }, 
        // 两行：第一行只放编号 + 标题 + 状态，第二行放目标分支、仓库、来源、CI
        React.createElement("div", { className: "ghsp-row-top" }, React.createElement("span", { className: "ghsp-row-num" }, "#" + item.number), React.createElement("span", { className: "ghsp-row-title" }, item.pending ? "读取中…" : (item.title || "")), item.pending ? null : React.createElement("span", { className: "ghsp-badge " + (item.missing ? "unknown" : rowKey) }, item.missing ? "?" : prStateLabel(rowKey))), React.createElement("div", { className: "ghsp-row-meta" }, item.pending ? null : React.createElement(TargetTag, { base: item.baseRefName }), React.createElement("span", { className: "ghsp-row-repo", title: item.repo }, item.repo), renderOriginTag(item), item.pending
            ? React.createElement("span", { className: "ghsp-inline-loading" }, React.createElement("span", { className: "ghsp-spinner" }))
            : React.createElement("span", { className: "ghsp-dot " + (item.missing ? "none" : checks.state), title: "检查状态" }))));
    };
    // 整棵树里有没有子代理建的 PR：只用来改提示语，不改变行本身的渲染
    var hasSubagentPr = items.some(function (i) { return i && i.origin === "subagent"; });
    if (!open) {
        return React.createElement("div", { className: "ghsp-overlay", style: overlayStyle() }, React.createElement("button", {
            type: "button",
            className: "ghsp-pill",
            "aria-label": "展开本会话提交的 PR",
            onMouseDown: onDragStart,
            onDoubleClick: resetPos,
            onClick: function () {
                // 拖完那一下也会触发 click，别让它顺手把卡片展开
                if (movedRef.current) {
                    movedRef.current = false;
                    return;
                }
                setOpen(true);
                requestFullSessionPrs();
            },
            title: "本会话提交的 PR（可拖动，双击归位）",
        }, renderOctocat(13, "currentColor"), React.createElement("span", { className: "ghsp-pill-text" }, "PR"), React.createElement("span", { className: "ghsp-pill-delta" }, "#" + headline.number), total > 1 ? React.createElement("span", { className: "ghsp-pill-count" }, String(total)) : null, React.createElement("svg", { width: 10, height: 10, viewBox: "0 0 12 12", "aria-hidden": "true" }, React.createElement("path", { d: "M3 8l3-4 3 4", fill: "none", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round" }))));
    }
    return React.createElement("div", { className: "ghsp-overlay", style: overlayStyle() }, React.createElement("section", { className: "ghsp-card", "aria-label": "本会话提交的 PR" }, React.createElement("header", {
        className: "ghsp-card-head ghsp-drag-handle",
        onMouseDown: onDragStart,
        onDoubleClick: resetPos,
        title: "拖动移动，双击归位",
    }, renderOctocat(13, "currentColor"), React.createElement("span", { className: "ghsp-card-title" }, "本会话提交的 PR"), React.createElement("span", { className: "ghsp-card-sub" }, String(total)), hasSubagentPr ? React.createElement("span", { className: "ghsp-card-sub", title: "其中包含子代理会话创建的 PR" }, "含子代理") : null, React.createElement("span", { className: "ghsp-card-age", title: "数据更新时间" }, ageLabel(state.at)), React.createElement("button", {
        type: "button",
        className: "ghsp-icon-btn" + (state.refreshing ? " spinning" : ""),
        title: state.refreshing ? "刷新中…" : "刷新（立即绕过缓存）",
        "aria-label": "刷新",
        disabled: Boolean(state.refreshing),
        onClick: function () { refresh(); },
    }, React.createElement("svg", { width: 12, height: 12, viewBox: "0 0 12 12", "aria-hidden": "true" }, React.createElement("path", { d: "M10 6a4 4 0 1 1-1.2-2.8M10 1.5V4H7.5", fill: "none", stroke: "currentColor", strokeWidth: 1.3, strokeLinecap: "round", strokeLinejoin: "round" }))), React.createElement("button", { type: "button", className: "ghsp-icon-btn", title: "收起", "aria-label": "收起", onClick: function () { setOpen(false); overlayCardOpen = false; retunePolling(); } }, React.createElement("svg", { width: 12, height: 12, viewBox: "0 0 12 12", "aria-hidden": "true" }, React.createElement("path", { d: "M2 3h8M2 6h8M2 9h8", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round" })))), menu
        ? React.createElement("div", {
            className: "ghsp-menu",
            role: "menu",
            style: { left: menu.x + "px", top: menu.y + "px" },
            onContextMenu: function (ev) { if (ev && ev.preventDefault)
                ev.preventDefault(); },
        }, React.createElement("div", { className: "ghsp-menu-head" }, "#" + (menu.item && menu.item.number) + " " + (menu.item && menu.item.repo ? menu.item.repo : "")), React.createElement("button", {
            type: "button", role: "menuitem", className: "ghsp-menu-item",
            onClick: function () { closeMenu(); if (props.onOpenPr)
                props.onOpenPr({ repo: menu.item.repo, number: menu.item.number }); },
        }, "在面板里打开"), React.createElement("button", {
            type: "button", role: "menuitem", className: "ghsp-menu-item",
            onClick: function () { copyPrLink(menu.item); },
        }, "复制链接"), React.createElement("button", {
            type: "button", role: "menuitem", className: "ghsp-menu-item",
            onClick: function () { openOnGitHub(menu.item); },
        }, "跳转 GitHub"))
        : null, hint ? React.createElement("div", { className: "ghsp-hint" }, hint) : null, 
    // tab：功能 / 项目 / CI/CD，一次只渲染一块（不做隐藏渲染，省掉另外两次请求）
    overlayTabBar(overlayTab, setOverlayTab, total), overlayTab === "project"
        ? React.createElement(WorkspaceBlock, {
            cwd: sessionCwd,
            repos: items.map(function (it) { return String((it && it.repo) || ""); })
                .filter(function (r, i, arr) { return r && arr.indexOf(r) === i; }),
        })
        : (overlayTab === "ci"
            ? React.createElement(CiPipelineStrip, { repo: items[0] && items[0].repo })
            : null), 
    // 泳道而不是平铺：Dev→Test→Release→Prod 从上到下就是功能推进的方向。
    // 首帧 lite 只有编号（还没有 stage），先平铺，数据齐了再分段，避免闪一个假的 Other 段。
    overlayTab !== "pr"
        ? null
        : (pendingOnly
            ? React.createElement("ul", { className: "ghsp-list" }, items.map(overlayRow))
            : React.createElement(Lanes, { items: items, mode: "feature", rowFn: overlayRow }))));
}
/* ------------------------------------------------------------------ *
 * 右列面板
 * ------------------------------------------------------------------ */
/** 读取本 tab 的导航参数（repo / number）；不同 DSH 版本给的位置不一样，逐个兜 */
function readTabParams(props, info) {
    var out = {};
    try {
        var nav = info && info.tab && info.tab.navigation;
        if (nav && nav.params && typeof nav.params === "object")
            Object.assign(out, nav.params);
    }
    catch (e) { /* 导航参数缺失不算错 */ }
    try {
        if (info && info.tab && info.tab.params && typeof info.tab.params === "object")
            Object.assign(out, info.tab.params);
    }
    catch (e) { /* 同上 */ }
    try {
        if (props && props.params && typeof props.params === "object")
            Object.assign(out, props.params);
    }
    catch (e) { /* 同上 */ }
    return out;
}
/**
 * PR 讨论串（reviews / comments / commits）单独拉。
 *
 * 为什么拆：这一段占详情响应的大头（实测 55KB / 2s），和「头部+按钮」一起取，
 * 用户要等 2.4s 才看见任何东西；拆开后 1.6s 就能先看到头，讨论区再补。
 */
function usePrThread(repo, number, tick) {
    var [state, setState] = React.useState({ loading: false, data: null, error: null });
    React.useEffect(function () {
        if (!repo || !number) {
            setState({ loading: false, data: null, error: null });
            return;
        }
        var alive = true;
        setState(function (prev) { return { loading: true, data: prev.data, error: null }; });
        var controller = typeof AbortController === "function" ? new AbortController() : null;
        var timer = setTimeout(function () { if (controller)
            controller.abort(); }, 25000);
        fetch("/api/github/pr-thread?repo=" + encodeURIComponent(repo) + "&number=" + String(number)
            + (tick > 0 ? "&refresh=1" : ""), { headers: { accept: "application/json" }, signal: controller ? controller.signal : undefined })
            .then(function (r) { return r.json(); })
            .then(function (json) {
            if (!alive)
                return;
            if (json && json.ok && json.data)
                setState({ loading: false, data: json.data, error: null });
            else
                setState({ loading: false, data: null, error: (json && (json.error || json.message)) || "读取讨论失败" });
        })
            .catch(function (err) {
            if (!alive)
                return;
            setState({ loading: false, data: null, error: err && err.name === "AbortError" ? "读取讨论超时" : String((err && err.message) || err) });
        })
            .then(function () { clearTimeout(timer); });
        return function () { alive = false; };
    }, [repo, number, tick]);
    return state;
}
function usePrDetail(repo, number, reloadTick = 0, forceTick = 0) {
    var [state, setState] = React.useState({ loading: Boolean(number), error: null, pr: null, diff: "", diffError: "" });
    React.useEffect(function () {
        if (!number) {
            setState({ loading: false, error: null, pr: null, diff: "", diffError: "" });
            return;
        }
        var alive = true;
        setState(function (prev) {
            var same = prev && prev.pr && prev.pr.number === number;
            return {
                loading: true,
                error: null,
                pr: same ? prev.pr : null,
                diff: same ? prev.diff : "",
                diffError: "",
                // at 必须保留：它驱动「更新于 X」，每轮清空会让这一行闪一下（实测 8s 一次）
                at: same ? prev.at : 0,
            };
        });
        // withDiff=0：详情不等 diff。大 PR 的 gh pr diff 会跑满 30s，等它等于整页白屏。
        // thread（reviews/comments/commits）拆成独立请求：core 先画出来，讨论区后到
        var qs = "/api/github/pr-detail?withDiff=0&withThread=0&number=" + String(number)
            + (forceTick > 0 ? "&refresh=1" : "");
        if (repo)
            qs += "&repo=" + encodeURIComponent(repo);
        var controller = typeof AbortController === "function" ? new AbortController() : null;
        // 超时兜底：host 慢或挂住时不能让用户对着骨架屏无限等（「看不到数据」最像的现场）
        var timer = setTimeout(function () { if (controller)
            controller.abort(); }, 15000);
        fetch(qs, { headers: { accept: "application/json" }, signal: controller ? controller.signal : undefined })
            .then(function (r) { return r.json(); })
            .then(function (json) {
            if (!alive)
                return;
            if (json && json.ok && json.data && json.data.pr) {
                setState({ loading: false, error: null, pr: json.data.pr, diff: (json.data.diff) || "", diffError: (json.data.diffError) || "", at: Date.now() });
            }
            else if (json && json.ok) {
                // 「ok 但没有 pr」曾经被当成「还没读完」→ 永远骨架屏。空成功必须报错。
                setState({ loading: false, error: "PR 详情为空（Host 返回 ok 但缺少 pr 字段）", pr: null, diff: "", diffError: "" });
            }
            else {
                setState({ loading: false, error: (json && (json.error || json.message)) || "读取 PR 失败", pr: null, diff: "", diffError: "" });
            }
        })
            .catch(function (err) {
            if (!alive)
                return;
            var msg = err && err.name === "AbortError"
                ? "读取 PR 超时（15 秒）。可能是 gh 慢或仓库很大；点重试，或直接在 GitHub 打开。"
                : String((err && err.message) || err);
            setState({ loading: false, error: msg, pr: null, diff: "", diffError: "" });
        })
            .then(function () { clearTimeout(timer); });
        return function () { alive = false; };
    }, [repo, number, reloadTick, forceTick]);
    // 写操作成功后先本地改状态：按钮/徽标立刻变，真正的对账交给随后的后台刷新。
    // 不这么做的话，点完「合并」要等一次往返（~0.8s）界面才动，用户会以为没生效。
    var patch = function (fields) {
        setState(function (prev) {
            if (!prev || !prev.pr)
                return prev;
            return Object.assign({}, prev, { pr: Object.assign({}, prev.pr, fields) });
        });
    };
    return Object.assign({}, state, { patch });
}
/** 评论条的行号文案：单行 `:12`，多行 `:12–18` */
function rangeLabel(sel) {
    if (!sel)
        return "";
    var from = Math.min(sel.from || 0, sel.to || 0);
    var to = Math.max(sel.from || 0, sel.to || 0);
    if (!from)
        return "";
    return from === to ? ":" + from : ":" + from + "–" + to;
}
/** 展开按钮的文案：剩余超过一批就说「继续加载 N 行」，否则直接说「显示剩余 N 行」 */
function nextChunkLabel(remaining) {
    return remaining > 2000 ? "继续加载 2000 行（剩 " + remaining + "）" : "显示剩余 " + remaining + " 行";
}
function DiffBlock(props) {
    var rows = React.useMemo(function () { return diffLinesWithNumbers(props.text); }, [props.text]);
    // 单文件默认 400 行封顶；数据在内存里，所以「看更多」就地分段加载——
    // 一次铺一万行 DOM 会把面板卡住，2000 行一批既够读又不卡。
    var base = props.cap || 400;
    var [shownTo, setShownTo] = React.useState(base);
    var cap = Math.max(base, shownTo);
    var shown = rows.length > cap ? rows.slice(0, cap) : rows;
    // 只有「新文件里的行」才能挂 RIGHT 侧的行内评论：删除行没有新行号
    function pick(row, ev) {
        if (!props.onPickLine)
            return;
        if (row.kind !== "add" && row.kind !== "ctx")
            return;
        props.onPickLine(row.newLine || 0, ev);
    }
    return React.createElement("pre", { className: "ghsp-diff" }, shown.map(function (row, i) {
        var pickable = (row.kind === "add" || row.kind === "ctx") && row.newLine;
        var isSel = pickable && props.selectedLine && row.newLine >= props.selectedLine
            && row.newLine <= (props.selectedLineEnd || props.selectedLine);
        return React.createElement("code", {
            key: i,
            className: "ghsp-line " + row.kind + (pickable ? " pickable" : "") + (isSel ? " sel" : ""),
            onClick: pickable ? function (ev) { pick(row, ev); } : undefined,
            // 键盘可达：diff 行是「可点的 code 元素」，不补 role/tabIndex 就永远 Tab 不到
            role: pickable ? "button" : undefined,
            tabIndex: pickable ? 0 : undefined,
            "aria-label": pickable ? "评论第 " + (row.newLine || 0) + " 行" : undefined,
            onKeyDown: pickable
                ? function (ev) {
                    if (ev && (ev.key === "Enter" || ev.key === " ")) {
                        if (ev.preventDefault)
                            ev.preventDefault();
                        pick(row, ev);
                    }
                }
                : undefined,
            title: pickable ? "点击评论这一行（Shift+点击 选一段；Enter 也可以）" : undefined,
        }, (row.newLine ? String(row.newLine).padStart(4, " ") + " " : "     ") + (row.text || " "));
    }), rows.length > cap
        ? React.createElement("div", { className: "ghsp-more" }, React.createElement("span", null, "还有 " + (rows.length - cap) + " 行未显示"), React.createElement("button", {
            type: "button",
            className: "ghsp-btn ghsp-btn-sm",
            onClick: function () { setShownTo(Math.min(rows.length, cap + 2000)); },
        }, nextChunkLabel(rows.length - cap)))
        : null);
}
export function SessionPrPanel(props) {
    // 同上：useTabInfo 只有 tab 体内才注入，按有无分成两个组件，避免 hook 数量在两帧之间变化。
    if (typeof (props && props.useTabInfo) !== "function") {
        return React.createElement(SessionPrPanelBody, Object.assign({}, props, { __tabInfo: null }));
    }
    return React.createElement(SessionPrPanelWithInfo, props);
}
function SessionPrPanelWithInfo(props) {
    var info = props.useTabInfo();
    return React.createElement(SessionPrPanelBody, Object.assign({}, props, { __tabInfo: info }));
}
/**
 * 一行的行号：行内评论必须给 GitHub 一个「新文件的第几行」。
 * 统一 diff 里只有 hunk 头带区间，这里边扫边推。
 */
function diffLinesWithNumbers(text) {
    var rows = [];
    var lines = String(text || "").split("\n");
    var newNo = 0;
    var oldNo = 0;
    for (var i = 0; i < lines.length; i += 1) {
        var line = lines[i];
        if (line.indexOf("diff --git ") === 0)
            continue;
        if (line.indexOf("index ") === 0)
            continue;
        // ---/+++ 是文件头，不是内容行：GitHub 也不展示
        if (line.slice(0, 3) === "+++" || line.slice(0, 3) === "---")
            continue;
        var hm = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
        if (hm) {
            oldNo = Number(hm[1]);
            newNo = Number(hm[2]);
            rows.push({ kind: "hunk", text: line });
            continue;
        }
        if (line.indexOf("\\ No newline") === 0) {
            rows.push({ kind: "meta", text: line });
            continue;
        }
        var head = line.charAt(0);
        if (head === "+") {
            rows.push({ kind: "add", text: line, newLine: newNo });
            newNo += 1;
        }
        else if (head === "-") {
            rows.push({ kind: "del", text: line, oldLine: oldNo });
            oldNo += 1;
        }
        else {
            rows.push({ kind: "ctx", text: line, newLine: newNo, oldLine: oldNo });
            newNo += 1;
            oldNo += 1;
        }
    }
    return rows;
}
function reviewStateLabel(state) {
    var s = String(state || "").toUpperCase();
    if (s === "APPROVED")
        return "已批准";
    if (s === "CHANGES_REQUESTED")
        return "要求修改";
    if (s === "COMMENTED")
        return "评论";
    if (s === "DISMISSED")
        return "已忽略";
    return s || "评论";
}
function checkState(item) {
    var conclusion = String(item && item.conclusion || "").toUpperCase();
    var status = String(item && item.status || "").toUpperCase();
    var state = String(item && item.state || "").toUpperCase();
    if (status && status !== "COMPLETED")
        return { tone: "pending", label: "进行中" };
    if (state) {
        if (state === "SUCCESS")
            return { tone: "pass", label: "通过" };
        if (state === "PENDING")
            return { tone: "pending", label: "进行中" };
        return { tone: "fail", label: state.toLowerCase() };
    }
    if (conclusion === "SUCCESS" || conclusion === "NEUTRAL" || conclusion === "SKIPPED")
        return { tone: "pass", label: "通过" };
    if (conclusion === "FAILURE" || conclusion === "TIMED_OUT" || conclusion === "CANCELLED" || conclusion === "ACTION_REQUIRED")
        return { tone: "fail", label: conclusion.toLowerCase() };
    return { tone: "pending", label: conclusion ? conclusion.toLowerCase() : "等待中" };
}
function commitLabel(commit) {
    if (!commit)
        return "";
    return commit.messageHeadline || String(commit.messageBody || "").split("\n")[0] || commit.oid || "";
}
/* 把一段文本推进对话框：优先 insertText（追加，不动已输入的草稿），其次 setDraft，最后写剪贴板 */
function pushTextToComposer(props, text) {
    var actions = props && props.inputActions;
    if (actions && typeof actions.insertText === "function") {
        try {
            if (actions.insertText(text) !== false) {
                if (typeof actions.focus === "function")
                    actions.focus();
                return "inserted";
            }
        }
        catch (e) { /* 落到 setDraft */ }
    }
    if (actions && typeof actions.setDraft === "function") {
        try {
            actions.setDraft(text);
            if (typeof actions.focus === "function")
                actions.focus();
            return "replaced";
        }
        catch (e) { /* 落到剪贴板 */ }
    }
    try {
        if (navigator && navigator.clipboard) {
            navigator.clipboard.writeText(text);
            return "copied";
        }
    }
    catch (e) { /* 忽略 */ }
    return "failed";
}
/** 右列 PR 面板（Codex 式窄面板）：头部 + 变更/描述/讨论/检查 四个分段 + 评论动作 */
/** 目标分支语义色：同一条 PR 落到 main / release / test / dev，一眼要能分开 */
function targetTone(base) {
    var b = String(base || "").toLowerCase();
    if (!b)
        return "other";
    if (b === "main" || b === "master" || b === "prod" || b === "production")
        return "main";
    if (b.indexOf("release") === 0)
        return "release";
    if (b === "test" || b === "testing" || b === "qa" || b === "staging" || b === "stage" || b.indexOf("test") === 0)
        return "test";
    if (b === "dev" || b === "develop" || b === "development" || b.indexOf("dev") === 0)
        return "dev";
    return "other";
}
function targetLabel(base) {
    var b = String(base || "");
    if (!b)
        return "";
    // 长分支名截断，但保留语义前缀（release/xxx 至少能看到 release）
    return b.length > 18 ? b.slice(0, 17) + "…" : b;
}
function TargetTag(props) {
    var base = props && props.base;
    if (!base)
        return null;
    return React.createElement("span", {
        className: "ghsp-target " + targetTone(base),
        title: "目标分支：" + base,
    }, "→ " + targetLabel(base));
}
/** 单独的 diff 拉取：详情先出，diff 慢也不拖住整页 */
function usePrDiff(repo, number, reloadTick = 0, enabled = true) {
    var [state, setState] = React.useState({ loading: false, error: null, diff: "" });
    React.useEffect(function () {
        // 懒加载闸门：没点「加载 diff」就完全不发请求、不占骨架位
        if (!number || !enabled) {
            setState({ loading: false, error: null, diff: "" });
            return;
        }
        var alive = true;
        setState({ loading: true, error: null, diff: "" });
        var qs = "/api/github/pr-diff?number=" + String(number) + (repo ? "&repo=" + encodeURIComponent(repo) : "");
        var controller = typeof AbortController === "function" ? new AbortController() : null;
        // 客户端兜底超时：Host 侧的 gh 超时是 20s，这里给 30s，超时就明确报错而不是无限骨架
        var timer = setTimeout(function () { if (controller)
            controller.abort(); }, 30000);
        fetch(qs, { headers: { accept: "application/json" }, signal: controller ? controller.signal : undefined })
            .then(function (r) { return r.json(); })
            .then(function (json) {
            if (!alive)
                return;
            if (json && json.ok)
                setState({ loading: false, error: json.data && json.data.diffError ? String(json.data.diffError) : null, diff: (json.data && json.data.diff) || "" });
            else
                setState({ loading: false, error: (json && (json.error || json.message)) || "拉取 diff 失败", diff: "" });
        })
            .catch(function (err) {
            if (!alive)
                return;
            setState({ loading: false, error: String((err && err.name === "AbortError") ? "拉取 diff 超时" : ((err && err.message) || err)), diff: "" });
        })
            .then(function () { clearTimeout(timer); });
        return function () { alive = false; clearTimeout(timer); };
    }, [repo, number, reloadTick, enabled]);
    return state;
}
/**
 * 按文件取补丁（`/api/github/pr-files`）。
 *
 * 为什么需要：整份 diff 撞 GitHub 的 20000 行硬上限（或 30s 超时）时，面板就只剩
 * 「拉取失败」。按文件拿 patch 不受这个上限约束——大 PR 也能一个一个看。
 * 同时它还是文件清单的来源（详情 core 不再带 files 字段）。
 */
function usePrFiles(repo, number, tick = 0, enabled = true) {
    var [state, setState] = React.useState({ loading: false, error: null, files: [], truncated: false });
    React.useEffect(function () {
        if (!enabled || !repo || !number) {
            setState({ loading: false, error: null, files: [], truncated: false });
            return;
        }
        var alive = true;
        setState(function (prev) { return { loading: true, error: null, files: prev.files || [], truncated: prev.truncated || false }; });
        var controller = typeof AbortController === "function" ? new AbortController() : null;
        var timer = setTimeout(function () { if (controller)
            controller.abort(); }, 30000);
        fetch("/api/github/pr-files?repo=" + encodeURIComponent(repo) + "&number=" + String(number) + (tick > 0 ? "&refresh=1" : ""), { headers: { accept: "application/json" }, signal: controller ? controller.signal : undefined })
            .then(function (r) { return r.json(); })
            .then(function (json) {
            if (!alive)
                return;
            if (json && json.ok && json.data)
                setState({ loading: false, error: null, files: json.data.files || [], truncated: Boolean(json.data.truncated) });
            else
                setState({ loading: false, error: (json && (json.error || json.message)) || "读取文件补丁失败", files: [], truncated: false });
        })
            .catch(function (err) {
            if (!alive)
                return;
            setState({ loading: false, error: err && err.name === "AbortError" ? "读取文件补丁超时" : String((err && err.message) || err), files: [], truncated: false });
        })
            .then(function () { clearTimeout(timer); });
        return function () { alive = false; clearTimeout(timer); };
    }, [repo, number, tick, enabled]);
    return state;
}
/** 右列 PR 面板（v3）：左侧主展示（描述 / 变更 / 讨论），右侧审批与操作 */
/** 截断 markdown 时按行边界切：切在代码块/表格中间会渲染出半截标签 */
function clipMarkdown(text, limit) {
    var s = String(text || "");
    if (s.length <= limit)
        return s;
    var cut = s.slice(0, limit);
    var nl = cut.lastIndexOf("\n");
    if (nl > limit * 0.6)
        cut = cut.slice(0, nl);
    // 未闭合的代码围栏补一个，避免整段被当成代码
    var fences = (cut.match(/```/g) || []).length;
    if (fences % 2 === 1)
        cut += "\n```";
    return cut;
}
/** 右列 PR 面板（v4）：卡片式分区 + 懒加载 diff + 骨架屏 */
function SessionPrPanelBody(props) {
    // 面板自己开着的时候，右下角浮窗就是在盖自己：挂载计数让浮窗自动让位
    React.useEffect(function () {
        openPanelCount += 1;
        requestFullSessionPrs();
        publishPrStore(prStore);
        retunePolling();
        return function () {
            openPanelCount -= 1;
            publishPrStore(prStore);
            retunePolling();
        };
    }, []);
    var info = props.__tabInfo || null;
    var params = readTabParams(props, info);
    var sessionId = (props && props.sessionId) || null;
    var pair = useSessionCreatedPrs(sessionId);
    var list = pair[0];
    var initialNumber = Number(params.number) || null;
    var [selected, setSelected] = React.useState(initialNumber);
    var [selectedRepo, setSelectedRepo] = React.useState(params.repo || null);
    var [lineSel, setLineSel] = React.useState(null);
    var [comment, setComment] = React.useState("");
    var [sideComment, setSideComment] = React.useState("");
    var [busy, setBusy] = React.useState(null);
    var [notice, setNotice] = React.useState(null);
    var [reloadTick, setReloadTick] = React.useState(0);
    // 自动刷新只 bump 这个：元数据 30s 一刷，diff 不跟着重拉（几 MB 的 patch 没必要每 30s 传一次）
    var [detailTick, setDetailTick] = React.useState(0);
    // 讨论串的刷新节奏比 core 慢：它重（55KB），且内容只在有人评论时才变
    var [threadTick, setThreadTick] = React.useState(0);
    // diff 懒加载：不点不开拉。181 个文件的 PR 光 gh pr diff 就能跑满 30s，
    // 默认拉它等于让整个面板等一个「不怎么看」的区域。
    var [wantDiff, setWantDiff] = React.useState(false);
    var [expandedFiles, setExpandedFiles] = React.useState({});
    var [mergeMethod, setMergeMethod] = React.useState("squash");
    // 仓库允许哪几种合并方式（allow_*_merge 只在仓库对象上）——不查就会让人选一个必然被拒的方式
    var [mergeMethods, setMergeMethods] = React.useState(null);
    // 合并后是否删源分支：默认不删。删分支不可逆，必须用户显式勾。
    var [deleteBranch, setDeleteBranch] = React.useState(false);
    var [confirmMerge, setConfirmMerge] = React.useState(false);
    var [descExpanded, setDescExpanded] = React.useState(false);
    var [notesExpanded, setNotesExpanded] = React.useState(false);
    var [checksExpanded, setChecksExpanded] = React.useState(false);
    var [requestsExpanded, setRequestsExpanded] = React.useState(false);
    React.useEffect(function () {
        if (!selected)
            return;
        var timer = null;
        function refreshNow() {
            try {
                if (typeof document !== "undefined" && document.hidden)
                    return;
            }
            catch (e) { /* 忽略 */ }
            setDetailTick(function (n) { return n + 1; });
        }
        timer = setInterval(refreshNow, 10000);
        var onVisible = function () { refreshNow(); };
        try {
            if (typeof document !== "undefined" && document.addEventListener)
                document.addEventListener("visibilitychange", onVisible);
        }
        catch (e) { /* 忽略 */ }
        var onFocus = function () { refreshNow(); };
        try {
            if (typeof window !== "undefined" && window.addEventListener)
                window.addEventListener("focus", onFocus);
        }
        catch (e) { /* 忽略 */ }
        return function () {
            if (timer)
                clearInterval(timer);
            try {
                if (typeof document !== "undefined" && document.removeEventListener)
                    document.removeEventListener("visibilitychange", onVisible);
            }
            catch (e) { /* 忽略 */ }
            try {
                if (typeof window !== "undefined" && window.removeEventListener)
                    window.removeEventListener("focus", onFocus);
            }
            catch (e) { /* 忽略 */ }
        };
    }, [selected, selectedRepo]);
    React.useEffect(function () {
        var next = Number(params.number) || null;
        if (next && next !== selected) {
            setSelected(next);
            setSelectedRepo(params.repo || null);
            setLineSel(null);
            setComment("");
            setSideComment("");
            setWantDiff(false);
            setDescExpanded(false);
            setNotesExpanded(false);
            setChecksExpanded(false);
        }
    }, [params.number, params.repo]);
    React.useEffect(function () {
        if (!selectedRepo) {
            setMergeMethods(null);
            return;
        }
        var alive = true;
        fetch("/api/github/repo-merge-methods?repo=" + encodeURIComponent(selectedRepo), { headers: { accept: "application/json" } })
            .then(function (r) { return r.json(); })
            .then(function (json) {
            if (!alive)
                return;
            if (json && json.ok && json.data)
                setMergeMethods(json.data);
        })
            .catch(function () { });
        return function () { alive = false; };
    }, [selectedRepo]);
    // detailTick：自动刷新（吃 8s 缓存）；reloadTick：手动刷新/写操作后（穿透缓存）
    var detail = usePrDetail(selectedRepo, selected, detailTick, reloadTick);
    var thread = usePrThread(selectedRepo, selected, threadTick);
    // 把讨论串合进详情对象：下游（讨论/待修改意见/评审卡）无需关心数据来自两次请求
    var pr = detail.pr
        ? Object.assign({}, detail.pr, thread.data ? {
            reviews: thread.data.reviews || detail.pr.reviews || [],
            comments: thread.data.comments || detail.pr.comments || [],
            commits: thread.data.commits || detail.pr.commits || [],
        } : {})
        : null;
    var diffState = usePrDiff(selectedRepo, selected, reloadTick, wantDiff);
    React.useEffect(function () {
        if (!mergeMethods)
            return;
        var allowed = ["squash", "merge", "rebase"].filter(function (m) { return mergeMethods[m] !== false; });
        if (allowed.length === 0)
            return;
        if (allowed.indexOf(mergeMethod) === -1)
            setMergeMethod(allowed[0]);
    }, [mergeMethods, mergeMethod]);
    var diffParts = React.useMemo(function () {
        var nextFiles = splitDiffByFile(diffState.diff || "");
        var keep = {};
        // 默认只展开第一个文件：diff 不是这块的重点，先给个「能看」的入口
        if (nextFiles.length)
            keep[nextFiles[0].path] = true;
        return { files: nextFiles, open: keep };
    }, [diffState.diff]);
    var files = diffParts.files;
    var [openFiles, setOpenFiles] = React.useState({});
    function openUrl(url) {
        if (props && props.onOpenUrl)
            props.onOpenUrl(url);
        else if (url)
            window.open(url, "_blank", "noopener,noreferrer");
    }
    function flash(tone, text) {
        setNotice({ tone: tone, text: text });
        try {
            setTimeout(function () { setNotice(null); }, 4000);
        }
        catch (e) { /* 无定时器环境忽略 */ }
    }
    function selectItem(item) {
        setSelected(item.number);
        setSelectedRepo(item.repo);
        setLineSel(null);
        setComment("");
        setSideComment("");
        setWantDiff(false);
    }
    function composerText(kind) {
        var lines = [];
        var target = selectedRepo ? selectedRepo + "#" + selected : "#" + selected;
        if (kind === "pr") {
            lines.push("请处理这个 PR：" + target + " " + ((pr && pr.title) || ""));
            if (pr && pr.url)
                lines.push(pr.url);
            if (pr && pr.headRefName)
                lines.push("分支：" + pr.headRefName + " → " + (pr.baseRefName || "base"));
            lines.push("当前状态：" + ((pr && pr.state) || "?") + (pr && pr.isDraft ? "（draft）" : "") + "，改动 " + ((pr && pr.additions) || 0) + "+ / " + ((pr && pr.deletions) || 0) + "-，" + ((pr && pr.changedFiles) || 0) + " 个文件");
            if (pr && pr.reviewDecision)
                lines.push("评审结论：" + pr.reviewDecision);
            lines.push("");
            lines.push("请先看 diff 再动手；需要改的地方直接改代码，改完告诉我需要重新推哪些提交。");
        }
        else if (kind === "file" && lineSel) {
            lines.push("看这个改动：" + target + " 的 `" + lineSel.path + "`" + (lineSel.line ? " 第 " + lineSel.line + " 行" : ""));
            if (pr && pr.url)
                lines.push(pr.url);
            lines.push("");
            lines.push("请说明这里为什么这么改，以及是否有边界情况没覆盖；如果需要调整，直接给出改法。");
        }
        else {
            lines.push("关于 " + target + "：");
        }
        return lines.join("\n");
    }
    function clipBody(text, limit) {
        var s = String(text || "");
        return s.length > limit ? s.slice(0, limit) + "\n…（原文共 " + s.length + " 字，已截断）" : s;
    }
    function prRef() {
        return (selectedRepo || "") + "#" + selected;
    }
    /** 失败项里有没有「评审门禁」类检查（这类不是代码检查，修完要重新请求评审） */
    function isReviewGateCheck(c) {
        var name = String((c && (c.name || c.context)) || "");
        return /review|gate|approve|bot/i.test(name);
    }
    function fixCheckPrompt(list) {
        var lines = [];
        var sha = String((pr && pr.headRefOid) || "").slice(0, 8);
        var gateItems = list.filter(isReviewGateCheck);
        lines.push("PR " + prRef() + " 的检查没通过，请修到全绿。");
        lines.push("");
        lines.push("坐标");
        lines.push("- 仓库/编号：" + prRef());
        if (pr && pr.baseRefName)
            lines.push("- 目标分支：" + pr.baseRefName + (pr.headRefName ? " ← 源分支：" + pr.headRefName : ""));
        if (sha)
            lines.push("- 当前 HEAD：" + sha + "（先确认你改的就是这个提交之上，别修旧代码）");
        if (pr && pr.reviewDecision)
            lines.push("- 评审结论：" + pr.reviewDecision);
        if (pr && pr.url)
            lines.push("- PR：" + pr.url);
        lines.push("");
        lines.push("失败项（共 " + list.length + "）");
        list.forEach(function (c, i) {
            var name = c.name || c.context || "check";
            lines.push((list.length > 1 ? (i + 1) + ") " : "") + "「" + name + "」FAILED" + (c.workflowName ? "（workflow: " + c.workflowName + "）" : ""));
            if (c.detailsUrl || c.targetUrl)
                lines.push("   详情：" + (c.detailsUrl || c.targetUrl));
            if (isReviewGateCheck(c))
                lines.push("   性质：评审门禁（不是代码检查，见下面第 6 步）");
        });
        lines.push("");
        lines.push("怎么做");
        if (gateItems.length === list.length) {
            // 纯门禁：没有 workflow 日志可拉，失败原因只在评审意见里
            lines.push("1. 这类检查没有运行日志，原因看 PR 的评审意见，不要靠猜：`gh pr view " + String(selected) + " --json reviewDecision,reviews,comments`。");
        }
        else {
            lines.push("1. 先拉失败日志再动手，不要靠猜：`gh run view <run-id> --log-failed`（run id 在详情 URL 里），定位到具体断言/编译错误。");
        }
        lines.push("2. 只改与该失败相关的最小范围；不动无关文件、不 force-push、不 dismiss 别人的 review。");
        lines.push("3. 本地跑与失败检查等价的那条命令（workflow 里的测试/构建命令），确认本地先过。");
        lines.push("4. 提交并推送到源分支" + (pr && pr.headRefName ? " `" + pr.headRefName + "`" : "") + "。");
        lines.push("5. 推送后必须确认检查真的重跑了，而不是以为推完就完事：`gh pr checks " + String(selected) + " --watch`；若没有自动触发，用 `gh run rerun <run-id> --failed` 重跑。");
        if (gateItems.length > 0 || (pr && String(pr.reviewDecision || "").toUpperCase() !== "APPROVED")) {
            lines.push("6. 修完要**重新触发评审**：这是评审门禁类问题，光推代码不会自动放行——重新请求评审（`gh pr edit " + String(selected) + " --add-reviewer <reviewer>`，或在 PR 里 @ 对应 reviewer 说明已按意见修完），并确认 reviewDecision 变成 APPROVED 或新的一轮评审确实已触发。");
            lines.push("7. 回报：改了什么文件、本地验证命令与结果、推送的 commit sha、`gh pr checks " + String(selected) + "` 当前结果、评审是否已重新请求。");
        }
        else {
            lines.push("6. 回报：改了什么文件、本地验证命令与结果、推送的 commit sha、`gh pr checks " + String(selected) + "` 当前结果。");
        }
        lines.push("");
        lines.push("完成标准：上述检查全部变绿" + (gateItems.length > 0 ? "、且评审已重新请求并拿到结论" : "") + "；`gh pr checks " + String(selected) + "` 里不再有本次范围内的失败项。");
        return lines.join("\n");
    }
    function fixNotePrompt(items) {
        var lines = [];
        if (items.length === 1) {
            var one = items[0];
            lines.push("PR " + prRef() + " 有一条评审意见要处理：");
            lines.push("作者 @" + (one.author || "?") + " · " + reviewStateLabel(one.state || "COMMENTED"));
            lines.push("");
            lines.push(clipBody(one.body, 4000));
            lines.push("");
            lines.push("怎么做");
            lines.push("1. 按这条意见改代码，只改相关范围；不动无关文件、不 force-push。");
            lines.push("2. 本地跑相关测试/构建，确认能过再提交。");
            lines.push("3. 推送到源分支" + (pr && pr.headRefName ? " `" + pr.headRefName + "`" : "") + "——评审意见只有落到**新的 commit** 上才算处理完。");
            lines.push("4. **推完要重新请求评审**：GitHub 的 required_approving_review_count 不会因为新提交自动满足（多数仓库还要求 last-push approval）。重新请求 @" + (one.author || "<reviewer>") + " 复审（`gh pr edit " + String(selected) + " --add-reviewer " + (one.author || "<reviewer>") + "`，或在 PR 里 @ 对方说明已按意见修改）。");
            lines.push("5. 如果这是个对话线程：在对应 thread 里回一句「已在 <sha> 修复」并 resolve，别让意见挂着。");
            lines.push("6. 回报：改了哪些文件、本地验证结果、推送的 commit sha、复审是否已重新请求、线程是否已 resolve。");
            lines.push("做不到的部分说清原因，不要糊过去。");
            return lines.join("\n");
        }
        lines.push("PR " + prRef() + " 有 " + items.length + " 条评审意见，请逐条处理：");
        items.forEach(function (it, i) {
            lines.push("");
            lines.push("### " + (i + 1) + ") @" + (it.author || "?") + " · " + reviewStateLabel(it.state || "COMMENTED") + (it.at ? " · " + formatRelativeTime(it.at) : ""));
            lines.push(clipBody(it.body, 2000));
        });
        lines.push("");
        lines.push("怎么做");
        lines.push("1. 按编号逐条处理，只改相关范围；不动无关文件、不 force-push、不 dismiss 别人的 review。");
        lines.push("2. 每条都要能指到具体改动（文件/行）或说明为什么不做。");
        lines.push("3. 本地跑相关测试/构建后提交，推送到源分支" + (pr && pr.headRefName ? " `" + pr.headRefName + "`" : "") + "。");
        lines.push("4. **推完要重新请求评审**（新提交不会自动满足 required_approving_review_count，很多仓库还要求 last-push approval）：在 PR 里 @ 提出意见的评审人说明已全部处理，请复审；对应 review thread 逐条回复「已在 <sha> 修复」并 resolve。");
        lines.push("5. 全部处理完后跑一次 `gh pr checks " + String(selected) + "` 确认检查仍全绿，再回报。");
        lines.push("6. 回报格式：按编号列「改了什么 / 验证命令与结果 / 复审是否已请求」；有冲突或做不了的同样按编号说明原因。");
        return lines.join("\n");
    }
    function pushToComposer(text) {
        var how = pushTextToComposer(props, text);
        if (how === "failed")
            flash("error", "输入框不可用，也没有剪贴板权限");
        else if (how === "copied")
            flash("info", "输入框不可用，内容已复制到剪贴板");
        else
            flash("ok", "已放进输入框");
    }
    /** 面板里做过写操作后，浮窗那份列表也要立刻更新（否则卡片还显示旧状态） */
    function refreshSessionList() {
        setThreadTick(function (n) { return n + 1; });
        if (prTimerSid)
            loadSessionPrs(prTimerSid, true);
    }
    function postJson(url, body) {
        return fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json" },
            body: JSON.stringify(body),
        }).then(function (r) { return r.json(); });
    }
    async function sendPrComment(text, kindLabel) {
        if (!selectedRepo || !selected || !text.trim())
            return;
        setBusy("comment");
        try {
            var json = await postJson("/api/github/pr-comment", { repo: selectedRepo, number: selected, body: text.trim() });
            if (json && json.ok) {
                flash("ok", kindLabel + "已发布到 PR");
                refreshSessionList();
                setComment("");
                setSideComment("");
                setReloadTick(function (n) { return n + 1; });
            }
            else {
                flash("error", (json && (json.error || json.message)) || "发布失败");
            }
        }
        catch (err) {
            flash("error", String((err && err.message) || err));
        }
        finally {
            setBusy(null);
        }
    }
    async function sendInlineComment(text) {
        if (!selectedRepo || !selected || !lineSel || !text.trim())
            return;
        var sha = pr && pr.headRefOid;
        var from = Math.min(lineSel.from, lineSel.to);
        var to = Math.max(lineSel.from, lineSel.to);
        if (!sha) {
            await sendPrComment("`" + lineSel.path + "` " + rangeLabel(lineSel) + "：\n\n" + text.trim(), "评论");
            return;
        }
        setBusy("inline");
        try {
            var payload = {
                repo: selectedRepo,
                number: selected,
                body: text.trim(),
                path: lineSel.path,
                line: to,
                side: "RIGHT",
                commit_id: sha,
            };
            if (from !== to)
                payload.start_line = from;
            var json = await postJson("/api/github/pr-inline-comment", payload);
            if (json && json.ok) {
                flash("ok", "行内评论已发布");
                refreshSessionList();
                setComment("");
                setLineSel(null);
                setReloadTick(function (n) { return n + 1; });
            }
            else {
                flash("error", (json && (json.error || json.message)) || "发布失败");
            }
        }
        catch (err) {
            flash("error", String((err && err.message) || err));
        }
        finally {
            setBusy(null);
        }
    }
    async function mergePr(action) {
        if (!selectedRepo || !selected)
            return;
        setBusy(action);
        try {
            var json = await postJson("/api/github/pr-merge", {
                repo: selectedRepo,
                number: selected,
                action: action,
                method: mergeMethod,
                delete_branch: deleteBranch,
            });
            if (json && json.ok) {
                flash("ok", (json.data && json.data.message) || "已提交");
                // 乐观更新：先按用户意图改本地状态，避免「点了没反应」的那 0.8s
                if (action === "merge")
                    detail.patch({ state: "MERGED", mergedAt: new Date().toISOString() });
                else if (action === "auto")
                    detail.patch({ autoMergeRequest: { enabledAt: new Date().toISOString(), mergeMethod: mergeMethod } });
                else if (action === "disable-auto")
                    detail.patch({ autoMergeRequest: null });
                refreshSessionList();
                setThreadTick(function (n) { return n + 1; });
                setConfirmMerge(false);
                setReloadTick(function (n) { return n + 1; });
            }
            else {
                flash("error", (json && (json.error || json.message)) || "合并失败");
            }
        }
        catch (err) {
            flash("error", String((err && err.message) || err));
        }
        finally {
            setBusy(null);
        }
    }
    async function submitReview(event) {
        if (!selectedRepo || !selected)
            return;
        if (event === "REQUEST_CHANGES" && !sideComment.trim()) {
            flash("error", "请求修改必须先写说明");
            return;
        }
        setBusy(event);
        try {
            var json = await postJson("/api/github/pr-review-submit", {
                repo: selectedRepo,
                number: selected,
                event: event,
                body: sideComment.trim(),
            });
            if (json && json.ok) {
                flash("ok", (json.data && json.data.message) || "已提交");
                if (event === "APPROVE")
                    detail.patch({ reviewDecision: "APPROVED" });
                else if (event === "REQUEST_CHANGES")
                    detail.patch({ reviewDecision: "CHANGES_REQUESTED" });
                refreshSessionList();
                setThreadTick(function (n) { return n + 1; });
                setSideComment("");
                setReloadTick(function (n) { return n + 1; });
            }
            else {
                flash("error", (json && (json.error || json.message)) || "提交失败");
            }
        }
        catch (err) {
            flash("error", String((err && err.message) || err));
        }
        finally {
            setBusy(null);
        }
    }
    /* ---------------- 没有选中 PR：本会话列表 ---------------- */
    if (!selected) {
        var items = (list && list.items) || [];
        return React.createElement("div", { className: "ghsp-panel" }, React.createElement("header", { className: "ghsp-head" }, React.createElement("div", { className: "ghsp-head-top" }, renderOctocat(14, "currentColor"), React.createElement("span", { className: "ghsp-repo" }, "本会话提交的 PR"))), 
        // CI/CD 泳道：仓库级 workflow 视图（什么时候完成 / 走到第几步）。
        // 放在列表上方——它回答的是「这个仓库的 Actions 现在在干什么」，
        // 与下面「本会话提了哪些 PR」是两个问题。
        items.length > 0
            ? React.createElement(CiPipelineCard, { repo: items[0].repo })
            : null, items.length === 0
            ? (list && list.loading
                ? React.createElement("div", { className: "ghsp-skeleton" }, React.createElement("div", { className: "ghsp-bar w60" }), React.createElement("div", { className: "ghsp-bar w40" }))
                : (list && list.error
                    ? React.createElement("div", { className: "ghsp-error" }, React.createElement("span", null, "读取本会话 PR 失败：" + String(list.error)), React.createElement("button", { type: "button", className: "ghsp-btn", onClick: function () { pair[1](); } }, "重试"))
                    : React.createElement("div", { className: "ghsp-empty" }, React.createElement("strong", null, sessionId ? "本会话还没有提交 PR" : "这个标签页没有绑定会话"), React.createElement("span", null, sessionId
                        ? "用 github_pr 创建 PR 后这里会出现；主会话派下去的子代理会话建的 PR 也会收进来（带「子代理」小标）。"
                        : "它可能是上次启动恢复的旧标签：请从右下角浮窗重新打开，或直接刷新页面。"), React.createElement("span", { className: "ghsp-muted" }, "session: " + (sessionId || "（无）")))))
            : (function () {
                // 与浮窗同一条规则：lite 首帧还没有阶段，先平铺
                var pendingOnly = items.every(function (it) { return it.pending; });
                var panelRow = function (item) {
                    var missing = Boolean(item.missing);
                    var pending = Boolean(item.pending);
                    var stats = React.createElement("span", null, React.createElement("span", { className: "ghsp-add" }, "+" + (item.additions || 0)), " ", React.createElement("span", { className: "ghsp-del" }, "−" + (item.deletions || 0)));
                    return React.createElement("li", { key: item.repo + "#" + item.number }, React.createElement("button", { type: "button", className: "ghsp-row", onClick: function () { selectItem(item); } }, React.createElement("div", { className: "ghsp-row-top" }, React.createElement("span", { className: "ghsp-row-num" }, "#" + item.number), React.createElement("span", { className: "ghsp-row-title" }, pending ? "读取中…" : (item.title || "")), pending ? null : React.createElement("span", { className: "ghsp-badge " + (missing ? "unknown" : prStateKey(item)) }, missing ? "?" : prStateLabel(prStateKey(item)))), React.createElement("div", { className: "ghsp-row-bottom" }, React.createElement("span", null, item.repo), renderOriginTag(item), pending ? React.createElement("span", { className: "ghsp-inline-loading" }, React.createElement("span", { className: "ghsp-spinner" }), "读取中…")
                        : (missing ? React.createElement("span", null, "元数据暂不可用（gh 未登录或超时）") : stats))));
                };
                if (pendingOnly) {
                    return React.createElement("ul", { className: "ghsp-list", style: { padding: "6px" } }, items.map(panelRow));
                }
                return React.createElement(Lanes, { items: items, mode: "feature", rowFn: panelRow });
            })());
    }
    /* ---------------- 详情 ---------------- */
    function cardBlock(key, title, meta, actions, body, flush) {
        return React.createElement("section", { key: key, className: "ghsp-card-block" }, React.createElement("div", { className: "ghsp-card-head2" }, React.createElement("span", { className: "ghsp-card-block-title" }, title), meta ? React.createElement("span", { className: "ghsp-card-block-meta" }, meta) : null, actions ? React.createElement("span", { className: "ghsp-card-block-actions" }, actions) : null), React.createElement("div", { className: "ghsp-card-body" + (flush ? " flush" : "") }, body));
    }
    var stateKey = pr ? prStateKey({ state: pr.state, isDraft: pr.isDraft }) : "unknown";
    var reviews = (pr && pr.reviews) || [];
    var comments = (pr && pr.comments) || [];
    var commits = (pr && pr.commits) || [];
    var checks = (pr && pr.statusCheckRollup) || [];
    var filesState = usePrFiles(selectedRepo, selected, threadTick, Boolean(selected && selectedRepo));
    // 文件清单优先用 /pr-files（详情 core 不再带 files 字段）
    var prFiles = (filesState.files.length > 0 ? filesState.files : ((pr && pr.files) || []));
    var prStateUpper = String((pr && pr.state) || "").toUpperCase();
    var mergeState = String((pr && pr.mergeStateStatus) || "").toUpperCase();
    var autoOn = Boolean(pr && pr.autoMergeRequest);
    var reviewUpper = String((pr && pr.reviewDecision) || "").toUpperCase();
    // 按钮只在「这件事还能做」时出现：已合并 / 已关闭的 PR，审批与合并都没有意义，直接不渲染。
    var actionsVisible = !pr || prStateUpper === "OPEN";
    /* 失败检查数：完全不同来源都要认（checkRun 的 conclusion、status context 的 state） */
    var failingChecks = checks.filter(function (c) {
        var conclusion = String((c && c.conclusion) || "").toUpperCase();
        var ctxState = String((c && c.state) || "").toUpperCase();
        if (ctxState)
            return ctxState === "FAILURE" || ctxState === "ERROR";
        return conclusion === "FAILURE" || conclusion === "TIMED_OUT" || conclusion === "CANCELLED"
            || conclusion === "ACTION_REQUIRED" || conclusion === "STARTUP_FAILURE";
    }).length;
    var changesRequested = reviewUpper === "CHANGES_REQUESTED";
    var approvedAlready = reviewUpper === "APPROVED";
    // 为什么禁用的原因要写清楚，别让用户点一个灰按钮猜；顺序按「先修什么最划算」排。
    var approveBlockedReason = !pr
        ? "正在读取 PR"
        : (pr.isDraft ? "草稿 PR 不能批准"
            : (mergeState === "DIRTY" ? "有冲突，先解决冲突再批准"
                : (approvedAlready ? "你已经批准过这个 PR" : null)));
    var mergeBlockedReason = !pr
        ? "正在读取 PR"
        : (pr.isDraft ? "草稿 PR 不能合并"
            : (mergeState === "DIRTY" ? "有冲突，先解决冲突"
                : (failingChecks > 0 ? failingChecks + " 项检查未通过"
                    : (changesRequested ? "评审要求修改，先处理意见"
                        : (mergeState === "BLOCKED" ? "分支保护未满足（检查未过或还缺批准）" : null)))));
    // 一行讲清「现在为什么合不了」，而不是让用户去猜按钮为什么不亮
    var blockedReasons = [];
    if (pr) {
        if (failingChecks > 0)
            blockedReasons.push(failingChecks + " 项检查未通过");
        if (changesRequested)
            blockedReasons.push("评审要求修改");
        if (mergeState === "DIRTY")
            blockedReasons.push("有合并冲突");
    }
    var blockedHint = (actionsVisible && blockedReasons.length > 0)
        ? React.createElement("span", { className: "ghsp-blocked", title: "这些条件不满足前无法合并" }, "不能合并：" + blockedReasons.join(" · "))
        : null;
    var headActions = React.createElement("div", { className: "ghsp-head-actions" }, actionsVisible ? React.createElement("button", {
        type: "button",
        className: "ghsp-btn ghsp-btn-sm ghsp-btn-approve",
        disabled: busy === "APPROVE" || Boolean(approveBlockedReason),
        title: approveBlockedReason || "批准这个 PR",
        onClick: function () { submitReview("APPROVE"); },
    }, busy === "APPROVE" ? "提交中…" : "批准") : null, actionsVisible ? React.createElement("button", {
        type: "button",
        className: "ghsp-btn ghsp-btn-sm " + (confirmMerge ? "ghsp-btn-danger" : "ghsp-btn-merge"),
        disabled: busy === "merge" || Boolean(mergeBlockedReason),
        title: mergeBlockedReason || "用当前方式合并（点两次确认）",
        onClick: function () {
            if (!confirmMerge) {
                setConfirmMerge(true);
                try {
                    setTimeout(function () { setConfirmMerge(false); }, 5000);
                }
                catch (e) { /* 无定时器忽略 */ }
                return;
            }
            mergePr("merge");
        },
    }, busy === "merge" ? "合并中…" : (confirmMerge ? "确认合并？" : "合并")) : null, 
    // 自动合并恰恰是「现在还不能合、等条件满足再合」用的，所以分支保护挡住时它仍然可用
    actionsVisible ? React.createElement("button", {
        type: "button",
        className: "ghsp-btn ghsp-btn-sm ghsp-btn-auto" + (autoOn ? " on" : ""),
        disabled: busy === "auto" || busy === "disable-auto" || !pr,
        title: autoOn ? "取消自动合并" : "开启自动合并：满足条件后自动合入",
        onClick: function () { mergePr(autoOn ? "disable-auto" : "auto"); },
    }, busy === "auto" ? "开启中…" : busy === "disable-auto" ? "取消中…" : autoOn ? "自动合并 ✓" : "自动合并") : null, actionsVisible ? React.createElement("select", {
        className: "ghsp-select",
        value: mergeMethod,
        title: mergeMethods ? "合并方式（按仓库允许项过滤）" : "合并方式",
        onChange: function (ev) { setMergeMethod(ev.target.value); },
    }, ["squash", "merge", "rebase"].map(function (m) {
        var ok = !mergeMethods || mergeMethods[m] !== false;
        return ok ? React.createElement("option", { key: m, value: m }, m) : null;
    })) : null, blockedHint, React.createElement("button", { type: "button", className: "ghsp-icon-btn", title: "在 GitHub 打开", "aria-label": "在 GitHub 打开", onClick: function () { if (pr && pr.url)
            openUrl(pr.url); } }, React.createElement("svg", { width: 12, height: 12, viewBox: "0 0 12 12", "aria-hidden": "true" }, React.createElement("path", { d: "M5 2H2.5A1.5 1.5 0 0 0 1 3.5v6A1.5 1.5 0 0 0 2.5 11h6A1.5 1.5 0 0 0 10 9.5V7M4.5 7.5 10 2m0 0H6.5M10 2v3.5", fill: "none", stroke: "currentColor", strokeWidth: 1.2, strokeLinecap: "round", strokeLinejoin: "round" }))), React.createElement("button", { type: "button", className: "ghsp-icon-btn", title: "把这个 PR 放进对话框", "aria-label": "把这个 PR 放进对话框", onClick: function () { pushToComposer(composerText("pr")); } }, React.createElement("svg", { width: 12, height: 12, viewBox: "0 0 12 12", "aria-hidden": "true" }, React.createElement("path", { d: "M2 3h8v5H5L3 10V8H2z", fill: "none", stroke: "currentColor", strokeWidth: 1.1, strokeLinejoin: "round" }))), React.createElement("button", {
        type: "button",
        className: "ghsp-icon-btn" + (detail.loading ? " spinning" : ""),
        title: detail.loading ? "刷新中…" : "刷新（元数据 + 变更）",
        "aria-label": "刷新",
        disabled: Boolean(detail.loading),
        onClick: function () {
            setReloadTick(function (n) { return n + 1; });
            setDetailTick(function (n) { return n + 1; });
            setThreadTick(function (n) { return n + 1; });
        },
    }, React.createElement("svg", { width: 12, height: 12, viewBox: "0 0 12 12", "aria-hidden": "true" }, React.createElement("path", { d: "M10 6a4 4 0 1 1-1.2-2.8M10 1.5V4H7.5", fill: "none", stroke: "currentColor", strokeWidth: 1.3, strokeLinecap: "round", strokeLinejoin: "round" }))));
    /* ---- 卡片：描述 ---- */
    var bodyText = String((pr && pr.body) || "");
    // 描述默认整段展示：PR 正文就是「为什么这么改」，藏起来等于让评审去点两次。
    // 只有长到离谱（>6000 字）才折叠，并且按钮放在裁剪区外面，否则会被 max-height 一起切掉。
    var descHuge = bodyText.length > 6000;
    var descBody = !pr
        ? React.createElement("div", { className: "ghsp-skeleton" }, React.createElement("div", { className: "ghsp-bar w80" }), React.createElement("div", { className: "ghsp-bar w60" }))
        : (bodyText
            ? React.createElement("div", null, React.createElement("div", { className: descHuge && !descExpanded ? "ghsp-fade" : "", style: descHuge && !descExpanded ? { maxHeight: "520px" } : undefined }, React.createElement("div", { className: "ghsp-md" }, renderMarkdownLite(React.createElement, descHuge && !descExpanded ? clipMarkdown(bodyText, 6000) : bodyText))), descHuge && !descExpanded ? React.createElement("button", { type: "button", className: "ghsp-btn ghsp-btn-sm ghsp-more-btn", onClick: function () { setDescExpanded(true); } }, "展开全文") : null)
            : React.createElement("div", { className: "ghsp-muted" }, "这条 PR 没有正文。"));
    var descriptionCard = cardBlock("desc", "描述", null, null, descBody, false);
    /* ---- 卡片：变更（懒加载 diff）---- */
    var changesActions = !wantDiff
        ? React.createElement("button", {
            type: "button",
            className: "ghsp-btn ghsp-btn-sm",
            onClick: function () { setWantDiff(true); },
        }, "加载 diff")
        : (diffState.loading
            ? React.createElement("span", { className: "ghsp-inline-loading" }, React.createElement("span", { className: "ghsp-spinner" }), "拉取中…")
            : React.createElement("button", {
                type: "button",
                className: "ghsp-btn ghsp-btn-sm",
                onClick: function () { setReloadTick(function (n) { return n + 1; }); },
            }, "重新加载"));
    var changesBody;
    if (!wantDiff) {
        // 未加载 diff：先给文件清单（pr.files 是详情就带的，零额外请求）
        changesBody = React.createElement("div", null, prFiles.length === 0
            ? (detail.loading ? React.createElement("div", { className: "ghsp-skeleton" }, React.createElement("div", { className: "ghsp-bar w80" }), React.createElement("div", { className: "ghsp-bar w60" })) : React.createElement("div", { className: "ghsp-muted" }, "没有文件改动"))
            : prFiles.slice(0, 40).map(function (f) {
                var open = Boolean(expandedFiles[f.path]);
                var hasPatch = Boolean(String(f.patch || "").trim());
                return React.createElement("div", { key: f.path }, React.createElement("div", { className: "ghsp-file-row" }, hasPatch
                    ? React.createElement("button", {
                        type: "button", className: "ghsp-file-toggle",
                        title: open ? "收起这个文件的改动" : "只看这个文件的改动",
                        onClick: function () {
                            setExpandedFiles(function (prev) {
                                var next = Object.assign({}, prev);
                                if (next[f.path])
                                    delete next[f.path];
                                else
                                    next[f.path] = true;
                                return next;
                            });
                        },
                    }, open ? "▾" : "▸")
                    : React.createElement("span", { className: "ghsp-file-toggle ghost" }, "·"), React.createElement("span", { className: "ghsp-path", title: f.path }, f.path), React.createElement("span", { className: "ghsp-stat" }, React.createElement("span", { className: "ghsp-add" }, "+" + (f.additions || 0)), " ", React.createElement("span", { className: "ghsp-del" }, "−" + (f.deletions || 0))), React.createElement("button", { type: "button", className: "ghsp-icon-btn", title: "把这个文件放进对话框", onClick: function () {
                        pushToComposer("看这个改动：" + (selectedRepo || "") + "#" + selected + " 的 `" + f.path + "`（+" + (f.additions || 0) + " −" + (f.deletions || 0) + "）\n" + ((pr && pr.url) || ""));
                    } }, "＋")), open && hasPatch
                    ? React.createElement(DiffBlock, {
                        text: "diff --git a/" + f.path + " b/" + f.path + "\n--- a/" + f.path + "\n+++ b/" + f.path + "\n" + String(f.patch || ""),
                        cap: 3000,
                    })
                    : null);
            }), prFiles.length > 40 ? React.createElement("div", { className: "ghsp-muted", style: { padding: "6px 0" } }, "还有 " + (prFiles.length - 40) + " 个文件，点上方「加载 diff」看全量") : null);
    }
    else if (diffState.loading) {
        changesBody = React.createElement("div", null, React.createElement("div", { className: "ghsp-skel-row" }), React.createElement("div", { className: "ghsp-skel-row", style: { width: "72%" } }), React.createElement("div", { className: "ghsp-skel-row", style: { width: "86%" } }), React.createElement("div", { className: "ghsp-skel-row", style: { width: "58%" } }));
    }
    else if (diffState.error) {
        changesBody = React.createElement("div", null, React.createElement("div", { className: "ghsp-error" }, React.createElement("span", null, diffState.error), React.createElement("div", { className: "ghsp-actions" }, React.createElement("button", { type: "button", className: "ghsp-btn", onClick: function () { setReloadTick(function (n) { return n + 1; }); } }, "重试"), React.createElement("button", { type: "button", className: "ghsp-btn", onClick: function () { setWantDiff(false); } }, "按文件看"))), React.createElement("div", { className: "ghsp-muted", style: { marginTop: "6px" } }, filesState.loading ? "正在读取文件补丁…" : "整份 diff 拿不到时，回到文件列表逐个展开即可（不受 20000 行上限约束）。"));
    }
    else if (files.length > 0) {
        changesBody = React.createElement("div", null, files.map(function (file) {
            var isOpen = openFiles[file.path] === undefined ? Boolean(diffParts.open[file.path]) : openFiles[file.path];
            var active = lineSel && lineSel.path === file.path;
            return React.createElement("section", { key: file.path, className: "ghsp-file" + (active ? " active" : "") }, React.createElement("div", { className: "ghsp-file-head" }, React.createElement("button", {
                type: "button",
                className: "ghsp-file-toggle",
                "aria-expanded": isOpen,
                onClick: function () {
                    setOpenFiles(function (prev) {
                        var next = Object.assign({}, prev);
                        next[file.path] = !isOpen;
                        return next;
                    });
                },
            }, React.createElement("span", { className: "ghsp-caret" + (isOpen ? " open" : "") }, React.createElement("svg", { width: 8, height: 8, viewBox: "0 0 8 8", "aria-hidden": "true" }, React.createElement("path", { d: "M2 1l4 3-4 3", fill: "none", stroke: "currentColor", strokeWidth: 1.2, strokeLinecap: "round", strokeLinejoin: "round" }))), React.createElement("span", { className: "ghsp-path", title: file.path }, file.path), React.createElement("span", { className: "ghsp-stat" }, React.createElement("span", { className: "ghsp-add" }, "+" + file.additions), " ", React.createElement("span", { className: "ghsp-del" }, "−" + file.deletions))), React.createElement("button", {
                type: "button",
                className: "ghsp-icon-btn ghsp-file-action",
                title: "把这个文件的改动放进对话框",
                onClick: function () {
                    setLineSel({ path: file.path, from: 0, to: 0 });
                    pushToComposer(composerText("file"));
                },
            }, "＋对话")), isOpen ? React.createElement(DiffBlock, {
                text: file.text,
                selectedLine: active ? Math.min(lineSel.from, lineSel.to) : 0,
                selectedLineEnd: active ? Math.max(lineSel.from, lineSel.to) : 0,
                onPickLine: function (line, ev) {
                    if (!line) {
                        setLineSel(null);
                        setComment("");
                        return;
                    }
                    // Shift+点击：在同一文件内把当前锚点扩成区间（GitHub 的多行评论也是这样选）
                    var extend = Boolean(ev && ev.shiftKey) && lineSel && lineSel.path === file.path;
                    setLineSel(extend ? { path: file.path, from: lineSel.from, to: line } : { path: file.path, from: line, to: line });
                    setComment("");
                },
            }) : null);
        }));
    }
    else {
        changesBody = React.createElement("div", null, React.createElement("div", { className: "ghsp-notice" }, diffState.error ? ("拿不到完整 diff：" + diffState.error + "。") : "diff 为空。", " 下面是文件清单，点 ↗ 去 GitHub 看全量。"), prFiles.slice(0, 60).map(function (f) {
            return React.createElement("div", { key: f.path, className: "ghsp-file-row" }, React.createElement("span", { className: "ghsp-path", title: f.path }, f.path), React.createElement("span", { className: "ghsp-stat" }, React.createElement("span", { className: "ghsp-add" }, "+" + (f.additions || 0)), " ", React.createElement("span", { className: "ghsp-del" }, "−" + (f.deletions || 0))));
        }));
    }
    var changesCard = cardBlock("changes", "变更", (files.length || prFiles.length) + " 个文件", changesActions, changesBody, true);
    /* ---- 卡片：讨论 ---- */
    var discussionItems = [];
    reviews.forEach(function (r, i) {
        discussionItems.push({ key: "r" + i, kind: "review", at: r.submittedAt || "", author: (r.author && r.author.login) || "", state: r.state, body: r.body || "" });
    });
    comments.forEach(function (c, i) {
        discussionItems.push({ key: "c" + i, kind: "comment", at: c.createdAt || "", author: (c.author && c.author.login) || "", state: "", body: c.body || "" });
    });
    discussionItems.sort(function (a, b) { return String(a.at) < String(b.at) ? -1 : 1; });
    var shownNotes = notesExpanded ? discussionItems : discussionItems.slice(0, 3);
    var discussionBody = React.createElement("div", null, discussionItems.length === 0
        ? (detail.loading ? React.createElement("div", { className: "ghsp-skeleton" }, React.createElement("div", { className: "ghsp-bar w60" })) : React.createElement("div", { className: "ghsp-muted" }, "还没有评审或评论"))
        : shownNotes.map(function (item) {
            return React.createElement("div", { key: item.key, className: "ghsp-note" }, React.createElement("div", { className: "ghsp-note-head" }, React.createElement("span", { className: "ghsp-note-author" }, "@" + item.author), item.kind === "review" ? React.createElement("span", { className: "ghsp-badge " + (String(item.state).toUpperCase() === "APPROVED" ? "open" : String(item.state).toUpperCase() === "CHANGES_REQUESTED" ? "closed" : "draft") }, reviewStateLabel(item.state)) : null, React.createElement("span", { className: "ghsp-note-time" }, item.at ? formatRelativeTime(item.at) : ""), React.createElement("button", { type: "button", className: "ghsp-icon-btn", title: "引用到对话框", onClick: function () {
                    pushToComposer("引用 @" + item.author + " 在 " + (selectedRepo || "") + "#" + selected + " 的意见：\n\n" + String(item.body).slice(0, 2000) + "\n\n请针对这条意见给出处理方案。");
                } }, "＋")), React.createElement("div", { className: "ghsp-md" }, renderMarkdownLite(React.createElement, item.body)));
        }), discussionItems.length > 3 ? React.createElement("button", {
        type: "button",
        className: "ghsp-btn ghsp-btn-sm",
        onClick: function () { setNotesExpanded(!notesExpanded); },
    }, notesExpanded ? "收起" : "显示全部 " + discussionItems.length + " 条") : null, commits.length > 0
        ? React.createElement("div", { style: { marginTop: "6px" } }, React.createElement("div", { className: "ghsp-sub-title" }, "提交 " + commits.length), commits.slice(0, 6).map(function (c, i) {
            return React.createElement("div", { key: (c.oid || "") + i, className: "ghsp-commit" }, React.createElement("code", null, String(c.oid || "").slice(0, 7)), React.createElement("span", { className: "ghsp-commit-msg", title: commitLabel(c) }, commitLabel(c)), React.createElement("span", { className: "ghsp-note-time" }, c.committedDate ? formatRelativeTime(c.committedDate) : ""));
        }), commits.length > 6 ? React.createElement("div", { className: "ghsp-muted", style: { paddingTop: "4px" } }, "还有 " + (commits.length - 6) + " 个提交") : null)
        : null);
    var discussionCard = cardBlock("discuss", "讨论", String(discussionItems.length), null, discussionBody, false);
    /* ---- 卡片：待修改意见（评审 + 评论，逐条可 fix，可批量）---- */
    var requests = [];
    var prAuthor = (pr && pr.author && pr.author.login) || "";
    reviews.forEach(function (r, i) {
        if (!String(r.body || "").trim())
            return;
        // 已批准的评审不进「待修改」队列：那是结论，不是待办
        if (String(r.state || "").toUpperCase() === "APPROVED")
            return;
        requests.push({ key: "r" + i, author: (r.author && r.author.login) || "", state: r.state || "COMMENTED", at: r.submittedAt || "", body: r.body });
    });
    comments.forEach(function (c, i) {
        if (!String(c.body || "").trim())
            return;
        // PR 作者自己的回复（「收到」「已改」）不是待办，别混进队列
        var who = (c.author && c.author.login) || "";
        if (prAuthor && who === prAuthor)
            return;
        requests.push({ key: "c" + i, author: who, state: "", at: c.createdAt || "", body: c.body });
    });
    // 最新在前：修 PR 的人通常先看最近这条
    requests.sort(function (a, b) { return String(a.at) < String(b.at) ? 1 : -1; });
    var shownRequests = requestsExpanded ? requests : requests.slice(0, 4);
    var requestsActions = requests.length
        ? React.createElement("button", {
            type: "button",
            className: "ghsp-btn ghsp-btn-sm",
            title: "把这些意见一次性推进对话框",
            onClick: function () { pushToComposer(fixNotePrompt(requests)); },
        }, "全部 fix " + requests.length)
        : null;
    var requestsBody = requests.length === 0
        ? (detail.loading
            ? React.createElement("div", { className: "ghsp-skeleton" }, React.createElement("div", { className: "ghsp-bar w60" }))
            : React.createElement("div", { className: "ghsp-muted" }, "还没有需要处理的意见"))
        : React.createElement("div", null, shownRequests.map(function (item) {
            var tone = String(item.state).toUpperCase() === "CHANGES_REQUESTED" ? "closed" : String(item.state).toUpperCase() === "APPROVED" ? "open" : "draft";
            return React.createElement("div", { key: item.key, className: "ghsp-request" }, React.createElement("div", { className: "ghsp-note-head" }, React.createElement("span", { className: "ghsp-note-author" }, "@" + (item.author || "?")), React.createElement("span", { className: "ghsp-badge " + tone }, reviewStateLabel(item.state || "COMMENTED")), React.createElement("span", { className: "ghsp-note-time" }, item.at ? formatRelativeTime(item.at) : ""), React.createElement("button", {
                type: "button",
                className: "ghsp-btn ghsp-btn-sm ghsp-fix-btn",
                title: "把这条意见推给 Agent 修",
                onClick: function () { pushToComposer(fixNotePrompt([item])); },
            }, "fix")), React.createElement("div", { className: "ghsp-md ghsp-clamp" }, renderMarkdownLite(React.createElement, item.body)));
        }), requests.length > 4
            ? React.createElement("button", { type: "button", className: "ghsp-btn ghsp-btn-sm", onClick: function () { setRequestsExpanded(!requestsExpanded); } }, requestsExpanded ? "收起" : "显示全部 " + requests.length + " 条")
            : null);
    var requestsCard = cardBlock("requests", "待修改意见", String(requests.length), requestsActions, requestsBody, false);
    /* ---- 卡片：检查 ---- */
    var failedChecks = checks.filter(function (c) { return checkState(c).tone === "fail"; }).length;
    var shownChecks = checksExpanded ? checks : checks.slice(0, 6);
    var checksBody = checks.length === 0
        ? (detail.loading ? React.createElement("div", { className: "ghsp-skeleton" }, React.createElement("div", { className: "ghsp-bar w60" })) : React.createElement("div", { className: "ghsp-muted" }, "没有上报的检查"))
        : React.createElement("div", null, React.createElement("div", { className: "ghsp-checks-summary" }, React.createElement("span", { className: "ghsp-dot " + (failedChecks ? "fail" : "pass") }), React.createElement("span", null, failedChecks ? failedChecks + " 项失败 / 共 " + checks.length + " 项" : "全部通过（" + checks.length + " 项）")), shownChecks.map(function (c, i) {
            var st = checkState(c);
            return React.createElement("div", { key: (c.name || "") + i, className: "ghsp-check" + (st.tone === "fail" ? " fail" : "") }, React.createElement("span", { className: "ghsp-dot " + st.tone }), React.createElement("span", { className: "ghsp-check-name", title: c.name }, c.name || c.context || "check"), st.tone === "fail"
                ? React.createElement("button", {
                    type: "button",
                    className: "ghsp-btn ghsp-btn-sm ghsp-fix-btn",
                    title: "把这条失败的检查推给 Agent 修",
                    onClick: function () { pushToComposer(fixCheckPrompt([c])); },
                }, "fix")
                : null, (c.detailsUrl || c.targetUrl)
                ? React.createElement("button", { type: "button", className: "ghsp-icon-btn", title: "打开", onClick: function () { openUrl(c.detailsUrl || c.targetUrl); } }, "↗")
                : null);
        }), checks.length > 6 ? React.createElement("button", { type: "button", className: "ghsp-btn ghsp-btn-sm", onClick: function () { setChecksExpanded(!checksExpanded); } }, checksExpanded ? "收起" : "全部 " + checks.length + " 项") : null);
    var failedList = checks.filter(function (c) { return checkState(c).tone === "fail"; });
    var checksActions = failedList.length
        ? React.createElement("button", {
            type: "button",
            className: "ghsp-btn ghsp-btn-sm",
            title: "把所有失败的检查一次性推给 Agent",
            onClick: function () { pushToComposer(fixCheckPrompt(failedList)); },
        }, "修复失败项 " + failedList.length)
        : null;
    var checksCard = cardBlock("checks", "检查", String(checks.length), checksActions, checksBody, false);
    /* ---- 卡片：评审 ---- */
    var reviewers = [];
    reviews.forEach(function (r) {
        var login = (r.author && r.author.login) || "";
        if (!login)
            return;
        var hit = reviewers.filter(function (x) { return x.login === login; })[0];
        if (hit) {
            hit.state = r.state || hit.state;
            return;
        }
        reviewers.push({ login: login, state: r.state || "COMMENTED" });
    });
    var reviewersBody = reviewers.length === 0
        ? (detail.loading ? React.createElement("div", { className: "ghsp-skeleton" }, React.createElement("div", { className: "ghsp-bar w40" })) : React.createElement("div", { className: "ghsp-muted" }, "还没有人评审"))
        : reviewers.map(function (r) {
            return React.createElement("div", { key: r.login, className: "ghsp-check" }, React.createElement("span", { className: "ghsp-dot " + (String(r.state).toUpperCase() === "APPROVED" ? "pass" : String(r.state).toUpperCase() === "CHANGES_REQUESTED" ? "fail" : "none") }), React.createElement("span", { className: "ghsp-check-name" }, "@" + r.login), React.createElement("span", { className: "ghsp-check-state" }, reviewStateLabel(r.state)));
        });
    var reviewersCard = cardBlock("reviewers", "评审", String(reviewers.length), null, reviewersBody, false);
    /* ---- 卡片：操作 ---- */
    var actionsBody = React.createElement("div", null, React.createElement("textarea", {
        className: "ghsp-textarea",
        placeholder: "写点意见：可发到对话、发到 PR，或作为「请求修改」的理由",
        value: sideComment,
        onChange: function (ev) { setSideComment(ev.target.value); },
    }), React.createElement("label", { className: "ghsp-check-row" }, React.createElement("input", {
        type: "checkbox",
        checked: deleteBranch,
        onChange: function (ev) { setDeleteBranch(Boolean(ev.target.checked)); },
    }), React.createElement("span", null, "合并后删除源分支")), React.createElement("div", { className: "ghsp-actions", style: { marginTop: "8px" } }, React.createElement("button", {
        type: "button",
        className: "ghsp-btn",
        disabled: busy === "REQUEST_CHANGES" || !sideComment.trim(),
        onClick: function () { submitReview("REQUEST_CHANGES"); },
    }, busy === "REQUEST_CHANGES" ? "提交中…" : "请求修改"), React.createElement("button", {
        type: "button",
        className: "ghsp-btn",
        disabled: busy === "comment" || !sideComment.trim(),
        onClick: function () { sendPrComment(sideComment, "评论"); },
    }, "发到 PR 评论"), React.createElement("button", {
        type: "button",
        className: "ghsp-btn",
        onClick: function () { pushToComposer(composerText("pr")); },
    }, "推到对话框")));
    var actionsCard = cardBlock("actions", "操作", null, null, actionsBody, false);
    /* ---- 选中某一行后的评论条 ---- */
    var commentBar = lineSel
        ? React.createElement("div", { className: "ghsp-commentbar" }, React.createElement("div", { className: "ghsp-commentbar-head" }, React.createElement("span", null, "评论 " + lineSel.path + " " + rangeLabel(lineSel)), React.createElement("button", { type: "button", className: "ghsp-icon-btn", title: "取消", onClick: function () { setLineSel(null); setComment(""); } }, "✕")), React.createElement("textarea", {
            className: "ghsp-textarea",
            placeholder: "这里要怎么改？（可直接发到 PR，或先放进对话框让 Agent 处理）",
            value: comment,
            onChange: function (ev) { setComment(ev.target.value); },
        }), React.createElement("div", { className: "ghsp-actions" }, React.createElement("button", {
            type: "button",
            className: "ghsp-btn ghsp-btn-primary",
            disabled: busy === "inline" || !comment.trim(),
            onClick: function () {
                if (!comment.trim())
                    return;
                var target = "`" + lineSel.path + "` " + rangeLabel(lineSel);
                if (lineSel.from > 0)
                    sendInlineComment(comment);
                else
                    sendPrComment(target + "：\n\n" + comment, "评论");
            },
        }, busy === "inline" ? "发送中…" : "发到 PR（行内）"), React.createElement("button", {
            type: "button",
            className: "ghsp-btn",
            disabled: !comment.trim(),
            onClick: function () {
                var where = "`" + lineSel.path + "` " + rangeLabel(lineSel);
                pushToComposer("在 " + (selectedRepo || "") + "#" + selected + " 的 " + where + "，我要求这样改：\n\n" + comment.trim() + "\n\n请直接改代码并告诉我改了哪些文件。");
            },
        }, "放进对话框")))
        : null;
    var headerSkeleton = detail.loading && !pr;
    return React.createElement("div", { className: "ghsp-panel" }, React.createElement("header", { className: "ghsp-head" }, React.createElement("div", { className: "ghsp-head-top" }, React.createElement("span", { className: "ghsp-badge " + stateKey }, prStateLabel(stateKey)), React.createElement("span", { className: "ghsp-repo", title: selectedRepo || "" }, selectedRepo || ""), React.createElement("span", { className: "ghsp-num" }, "#" + selected), headActions), React.createElement("h2", { className: "ghsp-title" }, (pr && pr.title) || (headerSkeleton ? "正在读取 PR…" : "PR #" + selected)), React.createElement("div", { className: "ghsp-meta" }, pr && pr.author && pr.author.login ? React.createElement("span", null, "@" + pr.author.login) : null, pr && pr.createdAt ? React.createElement("span", null, formatRelativeTime(pr.createdAt)) : null, pr && pr.headRefName
        ? React.createElement("span", { className: "ghsp-branch" }, React.createElement("span", { title: pr.headRefName }, pr.headRefName), React.createElement(TargetTag, { base: pr.baseRefName }))
        : null, React.createElement("span", { className: "ghsp-add" }, "+" + ((pr && pr.additions) || 0)), React.createElement("span", { className: "ghsp-del" }, "−" + ((pr && pr.deletions) || 0)), pr && pr.changedFiles ? React.createElement("span", null, pr.changedFiles + " 个文件") : null, (function () {
        if (!checks.length)
            return null;
        var rollup = summarizeRollupClient(checks);
        return React.createElement("span", { className: "ghsp-checks", title: "检查状态" }, React.createElement("span", { className: "ghsp-dot " + rollup.tone }), React.createElement("span", { className: "ghsp-check-chip " + rollup.tone }, rollup.label));
    })(), (function () {
        // 评审结论在面板里原本完全不可见（只在「待修改意见」里体现）。补一个小徽标：
        // 批准之后能立刻看到「已批准」，也解释了为什么合并按钮仍可能被禁用。
        var decision = String((pr && pr.reviewDecision) || "").toUpperCase();
        if (!decision)
            return null;
        var map = {
            APPROVED: ["pass", "已批准"],
            CHANGES_REQUESTED: ["fail", "需要修改"],
            REVIEW_REQUIRED: ["pending", "待评审"],
        };
        var hit = map[decision];
        if (!hit)
            return null;
        return React.createElement("span", { className: "ghsp-badge " + hit[0], title: "评审结论：" + decision }, hit[1]);
    })(), detail.at ? React.createElement("span", { className: "ghsp-detail-age", title: "元数据更新时间" }, "更新于 " + ageLabel(detail.at)) : null)), detail.error && !pr
        ? React.createElement("div", { className: "ghsp-error" }, React.createElement("span", null, (selectedRepo || "") + "#" + selected + "：" + detail.error), React.createElement("div", { className: "ghsp-actions" }, React.createElement("button", { type: "button", className: "ghsp-btn", onClick: function () { setReloadTick(function (n) { return n + 1; }); setDetailTick(function (n) { return n + 1; }); } }, "重试"), React.createElement("button", { type: "button", className: "ghsp-btn", onClick: function () { if (selectedRepo)
                openUrl("https://github.com/" + selectedRepo + "/pull/" + selected); } }, "在 GitHub 打开")))
        : React.createElement("div", { className: "ghsp-cols" }, React.createElement("main", { className: "ghsp-col-main" }, descriptionCard, changesCard, discussionCard, requestsCard), React.createElement("aside", { className: "ghsp-col-side" }, headerSkeleton ? null : checksCard, headerSkeleton ? null : reviewersCard, actionsCard)), notice ? React.createElement("div", { className: "ghsp-toast " + notice.tone }, notice.text) : null, commentBar);
}
/** 头部那条检查摘要 */
function summarizeRollupClient(checks) {
    var fail = 0;
    var pending = 0;
    for (var i = 0; i < checks.length; i += 1) {
        var st = checkState(checks[i]);
        if (st.tone === "fail")
            fail += 1;
        else if (st.tone === "pending")
            pending += 1;
    }
    if (fail > 0)
        return { tone: "fail", label: fail + " 项失败" };
    if (pending > 0)
        return { tone: "pending", label: "检查进行中" };
    return { tone: "pass", label: checks.length + " 项通过" };
}
/** 右列 tab 的标题（chip 上也走这里） */
export function SessionPrTabTitle(props) {
    if (typeof (props && props.useTabInfo) !== "function")
        return renderTitle(0);
    return React.createElement(SessionPrTitleWithInfo, props);
}
function SessionPrTitleWithInfo(props) {
    var info = props.useTabInfo();
    var params = readTabParams(props, info);
    return renderTitle(Number(params.number) || 0);
}
function renderTitle(number) {
    return React.createElement("span", { style: { display: "flex", alignItems: "center", gap: "6px" } }, renderOctocat(13, "currentColor"), React.createElement("span", null, number ? "PR #" + number : "PR"));
}
