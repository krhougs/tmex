# Split Screen 功能 — 原始 Prompt 存档

## 初始需求（2026-07-02）

> 开新的worktree实现新功能：
> 实现Split Screen
> 1. 基于tmux的window/pane来在逻辑上识别分屏的终端
> 2. 终端resize逻辑需要按照分屏需求完全检查、迭代
> 3. 终端分屏在PC上应该允许自由调整大小（像其他终端那样按照第一次split的方向要么保持统一高度或统一宽度）
> 4. Agent对应的应该是具体的pane（即分出来的小屏）
> 5. 手机/平板上只能同时展示一个pane，在当前window有多个pane的时候，终端区域标题栏样式不变，但是新增一个切换pane的按钮，点击会弹出当前窗口的pane列表便于切换。resize到PC尺寸后则正常按照分屏显示。手机尺寸上启动/切换/resize时，所有pane的宽度调整成适合当前屏幕的大小，传给tmux的window宽高是所有pane拼在一起的尺寸。
> 6. 想一个不太突兀的样式设计在非手机尺寸上区分active pane

## 规划期间确认的决策

- **Split 入口**：前端提供 split 操作入口（pane 上下文菜单 + PC 终端区操作），同时识别 tmux 内已有分屏。
- **分屏断点**：768px（与现有 `useIsMobile` 一致，≥768px 即分屏）。
- **Active pane 样式**：角标指示（pane 角落小圆点/编号徽标，边框不变）。

## 后续对话 Prompt

（实现过程中如有新的用户指示，追加到此处）
