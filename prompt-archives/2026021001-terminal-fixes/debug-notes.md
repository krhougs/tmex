# 调试笔记

## 已添加的调试日志

### 后端日志 (gateway)

1. **`selectPane` 方法** - 日志: `[tmux] selecting pane ...`
2. **`capturePaneHistory` 方法** - 日志: `[tmux] capturing history for pane ...`
3. **`handleOutputBlock` 方法** - 日志: `[tmux] handleOutputBlock kind: ...`
4. **`handleCapturePaneOutput` 方法** - 日志: `[tmux] capture-pane output: ...`
5. **`handleTmuxSelect` 方法** - 日志: `[ws] handleTmuxSelect ...`
6. **`broadcastTerminalHistory` 方法** - 日志: `[ws] broadcastTerminalHistory ...`

### 前端日志 (fe)

1. **`subscribeHistory` 调用** - 日志: `[fe] subscribing to history for ...`
2. **`term/history` 消息接收** - 日志: `[ws] received term/history for ...`
3. **历史数据处理** - 日志: `[fe] received history, length: ...`

## 测试步骤

1. 启动 gateway 和前端
2. 打开浏览器开发者工具，查看 Console 日志
3. 连接设备并选择 pane
4. 检查日志输出：
   - 应该看到 `[ws] handleTmuxSelect` 日志
   - 应该看到 `[tmux] selecting pane` 日志
   - 应该看到 `[tmux] capturing history for pane` 日志
   - 应该看到 `[tmux] handleOutputBlock kind: capture-pane` 日志
   - 应该看到 `[ws] broadcastTerminalHistory` 日志
   - 应该看到 `[ws] received term/history` 日志
   - 应该看到 `[fe] received history` 日志

## 可能的问题

### 问题1: 历史内容不显示

如果看不到历史内容，检查以下日志：
- 是否有 `[tmux] capturing history for pane` 日志？
- 是否有 `[tmux] handleOutputBlock kind: capture-pane` 日志？
- 是否有 `[ws] broadcastTerminalHistory` 日志？

如果没有 `handleOutputBlock kind: capture-pane` 日志，说明 `capture-pane` 命令的响应没有被正确处理。这可能是因为：
1. `capture-pane` 的输出格式与预期不同
2. 命令响应队列不匹配

### 问题2: 组合按键不工作

检查 `onKey` 事件是否被触发。如果 `onData` 和 `onKey` 同时触发，可能会导致重复输入。

### 问题3: Pane/Window 切换不工作

检查 `handleTmuxSelect` 日志，确认消息是否发送到后端。

## 修复的代码变更

### 1. 历史内容捕获

**文件**: `apps/gateway/src/tmux/connection.ts`
- 添加 `capturePaneHistory` 方法
- 添加 `handleCapturePaneOutput` 方法
- 在 `selectPane` 中调用 `capturePaneHistory`

**文件**: `apps/gateway/src/ws/index.ts`
- 添加 `onTerminalHistory` 回调
- 添加 `broadcastTerminalHistory` 方法

**文件**: `apps/fe/src/stores/tmux.ts`
- 添加 `subscribeHistory` 方法
- 处理 `term/history` 消息

**文件**: `apps/fe/src/pages/DevicePage.tsx`
- 订阅历史内容并写入终端

### 2. 滚轮支持

**文件**: `apps/fe/src/pages/DevicePage.tsx`
- Terminal 配置添加 `scrollback: 10000`

### 3. Sidebar 图标

**文件**: `apps/fe/src/components/Sidebar.tsx`
- 修改 collapsed 状态的样式为 `justify-start px-3`
- 修改图标颜色为 `text-[var(--color-text)]`

### 4. 组合按键

**文件**: `apps/fe/src/pages/DevicePage.tsx`
- 添加 `onKey` 事件处理器
- 处理 Shift+Enter, Ctrl+C 等组合键

### 5. Pane/Window 切换

**文件**: `apps/fe/src/stores/tmux.ts`
- 添加消息队列机制
- 在 WebSocket 连接成功后发送队列中的消息

### 6. 移动端顶栏

**文件**: `apps/fe/src/pages/DevicePage.tsx`
- 添加响应式样式
- 小屏幕隐藏非关键信息

### 7. 尺寸同步

**文件**: `apps/fe/src/pages/DevicePage.tsx`
- 添加同步尺寸按钮
- 修改容器样式支持溢出滚动

**文件**: `apps/fe/src/stores/tmux.ts`
- 添加 `syncPaneSize` action

**文件**: `apps/gateway/src/ws/index.ts`
- 处理 `term/sync-size` 消息

### 8. 环境变量与端口

**文件**: `apps/fe/vite.config.ts`
- 默认端口改为 9883
- 支持 `TMEX_GATEWAY_URL` 环境变量

**文件**: `apps/gateway/src/config.ts`
- 默认端口改为 9663

**文件**: `apps/fe/playwright.config.ts`
- 更新端口配置

### 9. Parser 修复

**文件**: `apps/gateway/src/tmux/parser.ts`
- 修复 `%client-detached` 和 `%client-session-changed` 处理
