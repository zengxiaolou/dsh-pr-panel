declare global {
  interface Window {
    __ModuleLoader__: {
      load(options: { id: string; factory: (require: any) => any }): void;
    };
  }
}

/**
 * dsh-pr-panel —— 只做一件事：把「本会话提交的 PR」接进 DSH。
 *
 * 前身是 dsh-pr-panel 的一个本地分叉；这一版把所有与 PR 通道无关的界面
 * （仓库面板、Issue 工作台、提交详情、同步设置、使用指南、升级提示…）都删掉了，
 * 只保留：
 *   1. 右下角浮窗（本会话提了 PR 才出现，可拖动）；
 *   2. 右列 PR 面板（详情 / 变更 / 讨论 / 待修改意见 / 检查 / 评审 / 操作）；
 *   3. 一条把 github.com/<o>/<r>/pull/<n> 链接接进面板的全局点击接管。
 *
 * Agent 侧的工具集（github_pr / issue / run / …）仍然由 Host 半注册，属于这个插件
 * 的核心能力，不在这里删。
 */
import { renderOctocat } from './ui/icons.js';
import {
  SessionPrOverlay,
  SessionPrPanel,
  SessionPrTabTitle,
  injectSessionPrStyles,
  stopSessionPrPollingExport,
  watchSessionPrVisibility,
  resetSessionPrModuleState,
} from './ui/session-pr-panel.js';
import { renderMarkdownLite, splitDiffByFile } from './ui/markdown-lite.js';

// 面板内部用裸标识符引用这两个渲染工具（由构建期注入全局），必须在模块作用域里存在
export { renderMarkdownLite, splitDiffByFile };

window.__ModuleLoader__.load({
  id: "dsh-pr-panel",
  factory: (require: any) => {
    var module = { exports: {} as any };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var React = require("react");
    var currentPluginCtx: any = null;

    function openUrlSmart(url: string): boolean {
      try {
        if (!url || typeof url !== "string") return false;
        if (!/^https?:\/\//i.test(url)) return false;
        var ctx: any = currentPluginCtx;
        var sidebarRight = ctx && typeof ctx.get === "function" ? ctx.get("sidebarRight") : null;
        if (sidebarRight && typeof sidebarRight.openTab === "function") {
          sidebarRight.openTab("browser", { params: { url: url } });
          return true;
        }
      } catch (e) {
        // 版本不匹配/服务未就绪：静默回退，不让一次跳转打断整个面板
      }
      return false;
    }

    /** 系统浏览器兜底（内部浏览器不可用时） */
    function openUrlFallback(url: string) {
      try {
        // 兜底路径也要校验 scheme：window.open 对 javascript:/file: 并不安全
        if (!/^https?:\/\//i.test(String(url || ""))) return;
        window.open(url, "_blank", "noopener,noreferrer");
      } catch (e) {
        /* 弹窗被拦截：无能为力，交给用户手点 */
      }
    }

    /** 内部浏览器优先 + 系统浏览器兜底：PR 面板的「在 GitHub 打开」 */
    function openUrlSmartOrFallback(url: string) {
      if (!url) return;
      if (!openUrlSmart(url)) openUrlFallback(url);
    }

    /**
     * 打开某条 PR 的右列面板。
     *
     * 两步都要做：openTab 只把 tab 放进右栏的 tab 列表，右栏本身如果是收起状态，
     * 用户点完浮窗会「什么都没发生」——所以补一次 openRightbar(true, false)，
     * 让右栏以普通（非全屏）形态展开。
     */
    function openSessionPrTab(params: any) {
      var number = Number(params && params.number);
      if (!Number.isInteger(number) || number <= 0) return;
      var repo = params && typeof params.repo === "string" ? params.repo : undefined;
      var ctx: any = currentPluginCtx;
      var opened = false;
      try {
        var sidebarRight = ctx && typeof ctx.get === "function" ? ctx.get("sidebarRight") : null;
        if (sidebarRight && typeof sidebarRight.openTab === "function") {
          // 用「仓库面板」那个类型（kind: github）承载 PR 面板：
          // 单独注册的 github-pr 类型在某些页面状态下会变成 inactive，标签还在、内容却是空白。
          // github 这个类型是工作区页面正在用的，天然激活；靠 params.number 分派到 PR 面板。
          sidebarRight.openTab("github", { params: repo ? { repo: repo, number: number } : { number: number } });
          opened = true;
        }
        var layout = ctx && typeof ctx.get === "function" ? ctx.get("layout") : null;
        if (layout && typeof layout.openRightbar === "function") {
          layout.openRightbar(true, false);
        }
      } catch (e) {
        opened = false;
      }
      // 老版本 DSH 没有 sidebarRight / 没注册这个 tab 类型时，点浮窗不能变成"什么都没发生"：
      // 退到 PR 页面，至少用户拿到一个能用的结果。
      if (!opened && repo) {
        openUrlSmartOrFallback("https://github.com/" + repo + "/pull/" + number);
      }
      return opened;
    }

    /**
     * 全局捕获阶段的链接接管：只处理本插件面板里的 http(s) 链接。
     *
     * 为什么用 document 级捕获而不是逐个 <a> 加 onClick：面板里有十几处仓库/PR/
     * Issue/Actions 链接分散在多个渲染函数里，逐个改既容易漏、又会在下次改版时
     * 重新长出「跳系统浏览器」的链接。这里用 [class*="dsh-github"] 限定作用域。
     * 带修饰键（⌘/Ctrl/Shift/Alt）或非左键时不接管——那是用户明确要新标签/新窗口。
     */
    function installSmartLinkHandler() {
      if (typeof document === "undefined") return;
      document.addEventListener(
        "click",
        function (ev: any) {
          try {
            if (!ev || ev.defaultPrevented) return;
            if (ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
            var target = ev.target as HTMLElement;
            var anchor = target && target.closest ? target.closest('a[href^="http"]') : null;
            if (!anchor) return;
            var href = anchor.getAttribute("href");
            if (!href) return;

            // PR 链接优先落到「我们的 PR 面板」：聊天里点 #630 时，跳 GitHub 网页要等、
            // 还可能因为内嵌浏览器登录态缺失而一直转圈——而面板读的是本地 gh，秒开。
            // 想去看网页版就按住 Shift/⌘ 点击，那个分支不会走到这里。
            var pr = href.match(/github\.com\/([A-Za-z0-9_][A-Za-z0-9_.-]*)\/([A-Za-z0-9_][A-Za-z0-9_.-]*)\/pull\/(\d+)/i);
            if (pr && openSessionPrTab({ repo: pr[1] + "/" + pr[2], number: Number(pr[3]) })) {
              ev.preventDefault();
              return;
            }

            // 其余链接：只有本插件面板里的才走「内置浏览器优先」
            if (!target.closest('[class*="dsh-github"]')) return;
            if (openUrlSmart(href)) ev.preventDefault();
          } catch (e) {
            // 拦截失败就走浏览器默认行为，绝不让它变成「点了没反应」
          }
        },
        true
      );
    }

    /**
     * 按容器记录的 Tab 键应用互斥显示状态（hidden 页 + active 按钮）。
     * 模块级纯 DOM 操作：渲染函数（switchTab 点击路径）与宿主组件的 effect
     * （SWR 重渲染校正路径）共用——后者是必须的：React 重渲染会按 VDOM 初值
     * 重设 hidden/active，用户手动切的 Tab 会被一次后台数据同步拽回默认页。
     */

    /**
     * 右列标签：一个有 params.number 就画 PR 面板，否则给一条「怎么打开」的说明。
     *
     * 为什么不再保留仓库面板：那个页面是前身项目的工作台，和「看本会话 PR」是两件事，
     * 留着只会让右列多出一整个用不到的数据面（概览/同步/提交详情…）。需要看仓库信息时，
     * 用对话里的 github_* 工具或者直接开 GitHub 网页即可。
     */
    function PrTabBody(props: any) {
      var number = 0;
      try {
        var info = typeof (props && props.useTabInfo) === "function" ? props.useTabInfo() : null;
        var params = info && info.tab && info.tab.navigation && info.tab.navigation.params;
        number = (params && Number(params.number)) || 0;
      } catch (e) {
        number = 0;
      }
      if (number) {
        return React.createElement(SessionPrPanel, Object.assign({}, props, { onOpenUrl: openUrlSmartOrFallback }));
      }
      return React.createElement(
        "div",
        { style: { padding: "18px", fontSize: "12px", lineHeight: "1.7", color: "var(--dsw-alias-label-secondary)" } },
        React.createElement("div", { style: { color: "var(--dsw-alias-label-primary)", fontWeight: 600, marginBottom: "6px" } }, "没有选中 PR"),
        React.createElement("div", null, "从右下角浮窗点一条 PR 打开；或者在对话里点任意 github.com/…/pull/123 链接。"),
        React.createElement("div", { style: { marginTop: "6px" } }, "需要仓库概览时，用对话里的 github_* 工具，或直接开 GitHub 网页。")
      );
    }

    function PrTabTitle(props: any) {
      var number = 0;
      try {
        var info = typeof (props && props.useTabInfo) === "function" ? props.useTabInfo() : null;
        var params = info && info.tab && info.tab.navigation && info.tab.navigation.params;
        number = (params && Number(params.number)) || 0;
      } catch (e) {
        number = 0;
      }
      if (number) return React.createElement(SessionPrTabTitle, props);
      return React.createElement("span", { style: { display: "flex", alignItems: "center", gap: "6px" } },
        renderOctocat(13, "currentColor"),
        React.createElement("span", null, "PR"));
    }

    function apply(ctx: any) {
      currentPluginCtx = ctx;

      if (ctx.effect) {
        ctx.effect(() => injectSessionPrStyles(), "dsh-pr-panel: styles");
        ctx.effect(() => watchSessionPrVisibility(), "dsh-pr-panel: visibility");
        ctx.effect(() => () => stopSessionPrPollingExport(), "dsh-pr-panel: polling");
        ctx.effect(() => () => resetSessionPrModuleState(), "dsh-pr-panel: teardown");
      }
      installSmartLinkHandler();

      if (ctx.sidebarRightTabs && typeof ctx.sidebarRightTabs.register === "function") {
        ctx.effect(() => ctx.sidebarRightTabs.register({
          id: "dsh-pr-panel",
          kind: "github",
          priority: "plugin",
          title: () => "PR",
          guide: [],
        }), "dsh-pr-panel: tab definition");
      }

      if (ctx.slots) {
        ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
          name: "sidebar.right.pane.tab",
          key: "dsh-pr-panel",
        }, PrTabBody));

        ctx.slots.inject("sidebar.right.pane.tab.title", () => ctx.slots.register({
          name: "sidebar.right.pane.tab.title",
          key: "dsh-pr-panel",
        }, PrTabTitle));

        ctx.slots.inject("shell.overlay", () => ctx.slots.register({
          name: "shell.overlay",
          id: "dsh-pr-panel-overlay",
          order: 70,
          label: "本会话 PR",
        }, (props: any) => React.createElement(SessionPrOverlay, Object.assign({}, props, {
          onOpenPr: openSessionPrTab,
          onOpenUrl: openUrlSmartOrFallback,
        }))));
      }
    }

    exports.apply = apply;
    exports.inject = ["slots", "sidebarRightTabs", "sessions", "layout", "theme", "sidebarRight"];
    exports.name = "dsh-pr-panel";

    return module.exports;
  }
});
