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

### 修改意见（2026-07-02 第二轮）

> 0. pane list里的window ID对于用户来说意义不大，可以不现实
> 1. 对于有多个pane的窗口，左边栏窗口行不显示标题、进程，不展示窗口层级的context menu，对于其所属每个pane都应该显示完整的窗口名和进程@路径
> 2. 对于有单的pane的窗口，左边栏保持现有的样式行为
> 3. pane的context menu和单pane窗口的context menu应该保持一致，都有 重命名、以当前目录打开、当前pane/窗口分屏、以当前pane/窗口开新的窗口
> 4. 终端区域，PC尺寸且已分屏的情况下，每个pane都应该显示一个标题栏，显示基本信息，并可以拖动标题栏为窗口自由拖动位置，左右的可以拖成上下的那种，也需要有那种现代的终端拖放位置预览

补充澄清（AskUserQuestion）：
- 「window ID」指侧栏左侧数字、顶栏编号、移动端切换菜单 index，全部去掉；
- 「以当前 pane/窗口开新的窗口」= 在新窗口开同目录 shell（即 newInCwd）；
- pane 与单 pane 窗口对最终用户无区别，菜单完全一致（含 Agent 会话，agent 已支持 pane 级绑定）。
