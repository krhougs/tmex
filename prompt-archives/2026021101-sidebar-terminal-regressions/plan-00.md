# Plan 00：Sidebar 与 Terminal 回归修复

时间：2026-02-11

## 背景

近期修复后仍存在四类回归：

1. Sidebar 缺少关闭 pane/window 的交互入口。
2. 新建 window 按钮在高亮状态可见性不足。
3. 终端尺寸同步链路异常，页面进入后内容排版错乱。
4. TUI 输入出现“一闪而过”，疑似历史回放覆盖实时输出。

## 目标与验收

1. Sidebar 提供关闭 pane/window 按钮；关闭最后一个 pane 后 window 自动关闭。
2. 新建 window 按钮在高亮项下保持清晰可见。
3. 尺寸同步改为客户端尺寸同步，避免破坏 tmux 布局。
4. 历史回放只在初始化阶段生效，不覆盖实时输入输出。
5. e2e 关键场景通过。

## 实施任务

### 任务 1：Sidebar 关闭能力与可见性

- 文件：`apps/fe/src/components/Sidebar.tsx`
- 内容：
  - 注入 `closePane`、`closeWindow` 动作。
  - Window/Pane 行添加“关闭”按钮并始终可见。
  - Pane 关闭时若窗口仅剩一个 pane，改为关闭窗口。
  - 新建窗口按钮改为始终可见，并提升高亮态对比度。

### 任务 2：关闭后的失效态（不自动跳转）

- 文件：`apps/fe/src/pages/DevicePage.tsx`
- 内容：
  - 检测当前 `windowId/paneId` 是否仍存在。
  - 失效时显示遮罩提示“已关闭，请在侧边栏重新选择”。
  - 失效时禁用输入与同步尺寸。

### 任务 3：尺寸同步根修

- 文件：
  - `apps/gateway/src/tmux/connection.ts`
  - `apps/gateway/src/ws/index.ts`
  - `apps/fe/src/pages/DevicePage.tsx`
- 内容：
  - 后端将尺寸同步实现从 `resize-pane -x/-y` 改为 `refresh-client -C cols,rows`。
  - 前端增加基于容器 `ResizeObserver` 的 `fit + sync`，并做节流。

### 任务 4：TUI 输入闪烁修复

- 文件：`apps/fe/src/pages/DevicePage.tsx`
- 内容：
  - 为 pane 切换建立 session guard。
  - 历史回放仅允许在“尚未收到实时输出”时生效。
  - 收到实时输出后忽略迟到历史，避免 reset 覆盖。

### 任务 5：回归测试

- 文件：
  - `apps/fe/tests/tmux-sidebar.e2e.spec.ts`
  - `apps/fe/tests/tmux-terminal.e2e.spec.ts`
- 内容：
  - 补充关闭 pane/window 与最后 pane 关闭窗口场景。
  - 验证新建按钮在高亮态可见。
  - 验证尺寸同步与输入稳定性关键路径。

## 验证命令

- `cd apps/fe && source ~/.zshrc && bun run test:e2e -- tests/tmux-sidebar.e2e.spec.ts tests/tmux-terminal.e2e.spec.ts`

## 注意事项

- 以根因修复为主，避免继续叠加时序补丁。
- 不改动与本次回归无关的模块。
- 最终写入 `plan-00-result.md` 记录执行结果与风险。
