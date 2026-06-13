# Plan Prompt: Issue #6 UI 改动

## 原始 Prompt

https://github.com/krhougs/tmex/issues/6
研究这个issue给出执行plan

## 后续对话 Prompt

开新的worktree，按照项目规范执行plan，善用subagent

## Issue 内容

4 项前端 UI 改动需求：

1. **Sheet 全屏边框去除**：手机端 Sidebar/Sheet 已调整为占满全屏，sheet 组件原有的最右边的边框应该去除
2. **手机端左上角图标更换**：手机上左上角的 sidebar 图标应被展示为其他图标，因为手机上这个界面是使用从上往下的动画展示的
3. **Device tree 新建 agent session 按钮**：应该收在对应 pane 的 context menu 中
4. **Bug: Context menu 点击外部关闭**：在 sidebar 中展开任意 context menu，只能通过点击原按钮关闭 menu，用户按照一般习惯点击屏幕其他地方则会触发对应位置的点击事件。在手机上时应该在 menu 展开时实现点击其他位置关闭 menu

## 用户确认的决策

- 图标选择：Menu（汉堡菜单）
- Bug 修复方案：原选 modal=true，经 Metis 审查发现无效（base-ui 1.2.0 中 `FloatingFocusManager.modal` 硬编码为 `isContextMenu`），改用 `MenuBackdrop` 方案
- 测试策略：无自动化测试，使用 Agent 执行的 QA 场景验证

## 执行环境

- Worktree: `../tmex-issue-6` (branch: `fix/issue-6-ui-changes`)
- Plan 文件: `.sisyphus/plans/issue-6-ui-changes.md`
