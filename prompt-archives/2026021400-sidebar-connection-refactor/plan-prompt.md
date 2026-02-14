# Plan Prompt Archive

## 任务来源
用户报告 Sidebar 存在以下 bugs：
1. 连接了多个设备时，切换设备窗口只能触发 tmux select window 事件，但页面没有跳转
2. 连接设备 A 后去连接设备 B，设备 A 会断开
3. Sidebar 中所有跳转行为应该是 replace 而不是 push

## 用户要求
需要重构连接管理代码，不应该由 sidebar 管理状态，而是由整个 App 进行全局管理。

## 当前问题分析

### Bug 1 - 切换设备窗口不跳转
- `handleWindowClick` 只调用 `selectWindow()`，没有主动导航
- DevicePage 的 useEffect 只监听当前 `deviceId`，跨设备切换时不会响应
- 依赖 "pane-active event"，但该事件不会跨设备触发

### Bug 2 - 连接新设备时已有设备断开
- DevicePage 的 cleanup 函数调用 `disconnectDevice(deviceId, 'page')` 
- 引用计数机制复杂，sidebar 和 page 双引用源难以追踪

### Bug 3 - 跳转应该用 replace
- 当前使用 `navigate(to)` 是 push 操作
- 应该改为 `navigate(to, { replace: true })`

## 建议的重构方案

### 架构原则
采用"全局连接管理 + 纯导航 Sidebar"：
- 将"设备应该连接"的状态提升到全局（App 级别）
- Sidebar 只负责修改这个状态和导航
- DevicePage 只负责展示和发送 tmux 命令

### 关键改动
1. **新建 `GlobalDeviceManager` 组件**（App 级别）
   - 监听路由变化，自动连接当前 URL 中的设备
   - 维护 `persistedConnectedDevices` Set，持久化到 localStorage
   - Sidebar 的"连接/断开"按钮修改这个 Set

2. **重构 Sidebar**
   - `handleConnectToggle`：修改全局列表 + `replace` 导航
   - `handleWindowClick`：主动 `replace` 导航到目标窗口
   - 所有导航使用 `navigate(to, { replace: true })`

3. **重构 DevicePage**
   - 移除 `useEffect` 中的连接/断开逻辑
   - 监听 `deviceId` 变化，只发送 `selectPane` 或 `selectWindow` 命令

4. **简化 tmux store**
   - 移除 `ConnectionRef` 概念
   - `connectDevice/disconnectDevice` 变为纯命令发送

## 日期
2026-02-14
