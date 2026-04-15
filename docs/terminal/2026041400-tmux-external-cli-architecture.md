# tmux external CLI 架构说明

## 背景

旧实现依赖 `tmux -CC` control mode。控制消息、pane 输出和错误文本混在同一条流里，导致输出转义、块匹配和状态同步复杂度偏高，历史上多次修复都集中在这一层。

本次重构将 Gateway 与 tmux 的交互切换为外部 CLI 模式，前端协议保持不变，仍由 `apps/fe` 通过 WebSocket 接收 snapshot、history、output 和 tmux event。

## 目标

- 统一本地设备与 SSH 设备的 tmux 交互模型。
- 由 `TmuxRuntimeRegistry` 管理 `device/session` 级共享 runtime，避免 ws 与 push 各自创建后端连接。
- 用 `pipe-pane` 承载实时输出，用 session 级 hook 承载 bell 与 pane 生命周期事件。
- 放弃同步外部 tmux client 操作回 Web UI，只保证 Web UI 自身操作和关键实时事件的一致性。

## 设计

### 共享运行时

- `TmuxRuntimeRegistry` 按 `deviceId` 管理 runtime 引用计数。
- `DeviceSessionRuntime` 负责向 ws、push 广播统一的 tmux event、history、snapshot 和 output。
- ws 关闭或 push 取消订阅后，引用计数归零时触发 runtime shutdown。

### 本地设备

- 通过 Bun 直接执行 `tmux` 外部命令。
- 使用 `/tmp/tmex/<device>-<pid>/` 保存 pane FIFO 和 hook FIFO。
- `pipe-pane -O` 将选中 pane 的实时输出导入 FIFO，再由 Gateway reader 转成终端输出事件。

### SSH 设备

- 基于 `ssh2` 建立连接。
- 主命令通道使用 `conn.exec('/bin/sh -s', { pty: false })`，先 bootstrap 远端 PATH 和 `tmux` 绝对路径，再串行执行后续命令。
- pane 输出 reader 与 hook reader 使用独立 exec channel，避免和主命令通道互相阻塞。

### 事件与快照

- session 级 hook 只安装 `alert-bell`、`pane-died`、`pane-exited` 三类事件。
- Web UI 触发的 select、resize、create-window、close-pane 等写操作完成后都会主动 refresh snapshot。
- 历史输出通过 `capture-pane` 获取，实时输出与历史输出继续沿用现有前端切换屏障协议。

## 范围外

- 不同步外部 tmux client 的主动切 pane、切 window、重命名等操作到 Web UI。
- 不自动管理 tmux server 生命周期，也不在最后一个 window 关闭后 `kill-server`。
