# 0.16.0

_2026-07-02_

## English

### New

- Split screen: windows with multiple tmux panes now render side by side on desktop, matching your tmux layout. Panes created inside tmux show up automatically, and you can split from the app too — via the toolbar buttons or a pane's context menu.
- Freely resize panes by dragging the divider between them, just like a native terminal.
- Every pane has its own title bar showing its name and running command. Drag a title bar to rearrange panes — drop it on the left/right/top/bottom half of another pane (with a live drop preview), turning a side-by-side layout into a stacked one and vice versa.
- Drag a pane onto the sidebar to move it into another window, or drop it on empty sidebar space to break it out into its own window. A close button on each title bar closes that pane.
- Rename individual panes: custom names show up in the sidebar, the top bar and pane lists.
- On phones and tablets, a window with multiple panes shows one pane at a time with a pane switcher in the top bar; each pane is sized to fit your screen. Widen the browser window and it switches back to split view automatically.
- AI agent sessions and notifications now link to the exact pane they belong to.

### Improvements

- The sidebar now puts panes first: multi-pane windows show each pane with its full title and running command, and panes get the same context menu as windows (rename, new agent session, open in directory, split, watch, close).
- Cleaner terminal header and lists: internal window/pane numbers are no longer displayed.
- UI polish and refinements across the split view.

### Fixes

- Dragging a divider no longer accidentally selects text in the terminal.

---

## 中文

### 新增

- 分屏：包含多个 tmux pane 的窗口现在会在桌面端按 tmux 布局并排显示。在 tmux 里分出的 pane 会自动呈现，也可以直接在应用里分屏——工具栏按钮或 pane 右键菜单里都有「向右/向下分屏」。
- 拖动 pane 之间的分隔条即可自由调整大小，体验与本地终端一致。
- 每个 pane 都有自己的标题栏，显示名称与正在运行的命令。拖动标题栏可以重排布局——放到另一个 pane 的上/下/左/右半区（带实时落点预览），左右布局可以拖成上下布局。
- 把 pane 拖到侧栏的其他窗口上可将其移入该窗口；拖到侧栏空白处则拆分为独立窗口。标题栏上的关闭按钮可直接关掉该 pane。
- 支持给单个 pane 重命名：自定义名称会显示在侧栏、顶栏和 pane 列表中。
- 手机/平板上，多 pane 窗口一次只显示一个 pane，顶栏提供切换菜单，每个 pane 自动适配屏幕大小；把浏览器拉宽后自动恢复分屏显示。
- AI Agent 会话与通知现在会精确关联并跳转到所属的 pane。

### 改进

- 侧栏以 pane 为中心：多 pane 窗口逐个展示每个 pane 的完整标题和运行命令，pane 拥有与窗口一致的右键菜单（重命名、新建 Agent 会话、在此目录新建窗口、分屏、监控、关闭）。
- 顶栏与列表不再显示内部的窗口/pane 编号，界面更简洁。
- 分屏相关的界面细节优化。

### 修复

- 拖动分隔条时不会再误触发终端里的文本选择。
