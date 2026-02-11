# Plan 00 执行结果：Sidebar 与 Terminal 回归修复

时间：2026-02-11

## 执行总结

本次按计划完成了四类回归修复：

1. Sidebar 补齐关闭 pane/window 按钮，并实现“关闭最后一个 pane 时关闭对应 window”的行为。
2. 新建 window 按钮在高亮状态下改为始终可见并提升对比度。
3. 尺寸同步从 `resize-pane -x/-y` 切换为客户端尺寸同步（`refresh-client -C`），并在前端补齐容器级同步触发。
4. 历史回放链路增加 session guard，避免历史包在实时阶段覆盖终端内容导致输入闪烁。

## 关键改动

### 1）Sidebar 交互与可见性

- 文件：`apps/fe/src/components/Sidebar.tsx`
- 变更：
  - 增加 `closeWindow` / `closePane` 动作接入。
  - Window 行、Pane 行新增关闭按钮（始终显示）。
  - 关闭 pane 时，若该 window 仅 1 个 pane，前端改为调用 `closeWindow`。
  - 新建 window 按钮在高亮项下保持可见并提升视觉对比。

### 2）终端失效态与输入保护

- 文件：`apps/fe/src/pages/DevicePage.tsx`
- 变更：
  - 增加 `window/pane` 失效检测，失效时展示遮罩提示。
  - 失效时禁用输入发送与“同步尺寸”按钮。
  - 为移动端编辑器发送入口增加同样的交互禁用保护。

### 3）尺寸同步链路修复

- 文件：`apps/gateway/src/tmux/connection.ts`
- 变更：
  - `resizePane` 改为 `refresh-client -C cols,rows`，不再用 `resize-pane -x/-y` 强行改 pane 几何。
  - `closeWindow` 增加单窗口兜底（会话仅 1 window 时先 `new-window -d` 再 kill 目标窗口），保证关闭动作稳定。

- 文件：`apps/fe/src/pages/DevicePage.tsx`
- 变更：
  - 引入 `scheduleResize`，统一处理 `fit + resize/sync`，并通过 `requestAnimationFrame` 节流。
  - 增加容器级 `ResizeObserver`，在布局变化时自动触发尺寸同步。

### 4）历史覆盖实时输出修复

- 文件：`apps/fe/src/pages/DevicePage.tsx`
- 变更：
  - 引入 `paneSessionId`、`historyApplied`、`hasLiveOutput`。
  - `term/history` 仅在当前 pane session 且尚未进入实时输出时允许应用。
  - 收到二进制实时输出后禁止迟到历史覆盖。

### 5）回归测试补充

- 文件：
  - `apps/fe/tests/tmux-sidebar.e2e.spec.ts`
  - `apps/fe/tests/tmux-terminal.e2e.spec.ts`
- 新增/调整：
  - 新建窗口按钮可见且可点击。
  - 关闭最后 pane 后旧 window 项消失且同步按钮禁用。
  - 当前 pane 关闭后同步按钮禁用。
  - 清理逻辑适配“当前目标不可用”遮罩场景。

## 验证结果

### 构建验证

- 命令：`source ~/.zshrc && cd apps/fe && bun run build`
- 结果：通过。

### E2E 验证（定向）

- 命令：
  - `source ~/.zshrc && cd apps/fe && bun run test:e2e -- tests/tmux-sidebar.e2e.spec.ts -g "关闭最后一个 pane 时应自动关闭对应 window"`
  - `source ~/.zshrc && cd apps/fe && bun run test:e2e -- tests/tmux-sidebar.e2e.spec.ts tests/tmux-terminal.e2e.spec.ts`
- 结果：通过（`13 passed`）。

## 风险与后续建议

1. `closeWindow` 的单窗口兜底会在 tmux 会话中保留一个新窗口，这是 tmux 语义下避免会话直接消失的折中；若后续希望“最后窗口关闭后直接回到设备页/会话重建策略可控”，建议单独设计会话生命周期策略。
2. 目前 gateway 仍有较多 `handleOutputBlock` 调试日志，功能不受影响，但建议后续降噪。
