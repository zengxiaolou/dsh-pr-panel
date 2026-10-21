# PROJECT

## 定位

`dsh-pr-panel` 是 DeepSeek Harness 的**单用途**插件，只做「本会话 PR 通道」：

1. 右下角浮窗（`shell.overlay`）——本会话建过 PR 才出现，可拖动、可右键；
2. 右列 `PR` 面板——描述 / 变更 / 讨论 / 待修改意见 / 检查 / 评审 / 操作；
3. Agent 侧的 `github_*` 工具集（Host 半注册，与 UI 独立）。

不再提供仓库面板、Issue 工作台、提交详情、同步设置、使用指南与升级提示。

## 与上游的关系

- 上游：[`ItQianChen/dsh-github-flow`](https://github.com/ItQianChen/dsh-github-flow)（本仓库基于 v0.5.0 的本地分叉）。
- **2026-10-21 起独立演进**，不再跟随上游合并。
- 上游的仓库面板 / Issue 工作台 / 驾驶舱 / 同步设置，本分支**不再跟进**（已整体删除）。
- 包名、仓库地址改为 `zengxiaolou/dsh-pr-panel`，与上游 npm 包无发布关系。

## 目录结构

```
src/
  main.ts          Host 侧入口：插件声明、工具注册、路由挂载
  client.ts        客户端入口（web bundle，仅剩浮窗 / 右列标签 / PR 链接接管）
  session-pr-*.ts  进程内登记簿 + 会话转写回填
  api/             Host HTTP 路由（session-created-prs / pr-detail / pr-diff / pr-files / 动作路由）
  ui/              icons / utils / markdown-lite / session-pr-panel / tw.*
  tools/           github_* Agent 工具（pr / issue / run / release / …）
test/              phase1–phase43，入口 node test/run-all.mjs
docs/              session-pr-channel.md（唯一实现说明）+ images
```

`lib/` 是 `pnpm build` 产物，`node_modules` 在当前机器上是指向旧项目的软链（不要动）。

## 为什么不再 rebase 上游

1. **方向相反**：上游在做功能广度（工作台、Issue、Actions、同步、升级），本分支在做单条 PR 通道的深度（门禁、fix 提示词、按文件补丁、core/thread 拆分）。
2. **改动是删除**：本分支删掉的正是上游持续维护的 UI 主体，每次 rebase 都会把它们带回来，等于重做一遍减法。
3. **冲突面覆盖整片 `src/ui`**：仓库面板与 PR 面板同文件、同槽位、同标签体系，冲突无法局部解决。
4. **提交图已分叉**：包名、仓库、目录与历史都改过，与上游没有可对齐的 base；真需要的上游修复按 commit cherry-pick，而不是整支 rebase。
