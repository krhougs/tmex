# Prompt Archive

## 用户需求

修复 bug：

1. vim 退出后没有释放鼠标，退出后鼠标滚轮事件应该变回 scroll 普通终端，而不是继续发送鼠标事件。
2. 刚刚的 ssh 实现完成后引入了新 bug，终端中打开 opencode，刷新或切换窗口后恢复的 TUI 是残缺的。

## 当前上下文

- 本轮按系统要求以调试流程推进，先调查根因，再补失败用例，再做最小修复。
- 已启动并行探索任务，分别调查鼠标模式生命周期、SSH 恢复链路、以及现有测试/复现入口。
- 已确认近期 SSH 相关改动集中在 `apps/gateway/src/tmux-client/*` 与较早的 `apps/gateway/src/tmux/*`。
