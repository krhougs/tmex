# Terminal 修复计划

## 背景

tmex 是一个通过 Web 浏览器管理本地或 SSH 远程设备 tmux 会话的终端控制平台。当前存在多个问题需要修复，以提供完整的用户体验。

## 目标

修复以下8个问题，并扩展 e2e 测试覆盖范围：

1. 连接成功后不会显示tmux当前窗口现有的内容
2. 连接成功后鼠标滚轮应该可以获取到历史内容
3. 左边panel的图标还是看不清，而且不应该居中显示
4. terminal现在没有正确处理按键，Shift+Enter之类的组合按键现在无法正常传递
5. 在左边panel中切换连接成功的设备中的不同的pane/window不工作
6. 顶栏排版在手机上文字和按钮都挤在了一起
7. terminal区域不会根据实际区域更新tmux window/split的宽度和高度，在外部（如iterm2）中调整window/split的宽度高度在terminal中也没有同步。（如果宽度高度溢出应允许区域滚动，同时应提供一个按钮按照当前窗口大小更新tmux window/split的宽高）
8. 前端代码库应支持通过环境变量传入gateway的访问地址和前端bind的地址端口号，前端和gateway的默认端口应改为9663(gateway)和9883(fe)，同时e2e脚本应该检测端口占用来动态指定端口以免影响正在运行的其他服务

## 技术架构

- **Frontend**: React 19 + TypeScript + Vite + xterm.js + Tailwind CSS
- **Gateway**: Bun.js + WebSocket + node-pty + ssh2
- **Protocol**: tmux -CC (Control Mode)

## 问题分析与解决方案

### 问题1: 连接后显示tmux现有内容

**原因**: 当前只接收 %output 和 %extended-output 的新输出，没有捕获历史内容。

**解决方案**:
- tmux control mode 本身不提供历史内容
- 需要在连接成功后，发送 `capture-pane` 命令获取当前 pane 的历史内容
- 修改 `TmuxConnection` 类，在 `selectPane` 或连接成功后自动捕获历史

### 问题2: 鼠标滚轮获取历史内容

**原因**: xterm.js 默认不启用鼠标支持，且没有启用滚轮历史模式。

**解决方案**:
- 启用 xterm.js 的 `scrollback` 选项
- 添加 `xterm-addon-scroll` 或使用内置滚轮处理
- 需要正确配置 terminal 的 `scrollback` 缓冲区大小

### 问题3: Sidebar图标看不清且不应居中

**原因**: 当前 collapsed 状态下的图标使用了 `justify-center`，导致居中显示。

**解决方案**:
- 修改 Sidebar 组件中 collapsed 状态的样式
- 图标颜色需要更清晰

### 问题4: 组合按键传递

**原因**: 当前只使用 `onData` 处理普通字符输入，没有正确处理特殊按键。

**解决方案**:
- 使用 xterm.js 的 `onKey` 事件来处理特殊按键
- 需要将特殊按键（如 Shift+Enter）转换为正确的终端序列

### 问题5: Pane/Window切换不工作

**原因**: 点击 sidebar 中的 pane 时，可能没有正确触发 selectPane 或 URL 跳转有问题。

**解决方案**:
- 检查 `handlePaneClick` 函数
- 确保 `selectPane` 正确发送命令到 tmux
- 修复 URL 编码问题

### 问题6: 移动端顶栏排版

**原因**: 顶栏使用了 `justify-between`，在小屏幕上元素挤在一起。

**解决方案**:
- 使用响应式设计，移动端使用 flex-wrap 或调整布局
- 缩小字体或隐藏非关键信息

### 问题7: 终端尺寸同步

**原因**: 当前只在前端 resize 时同步到 tmux，没有处理外部调整的情况。

**解决方案**:
- 添加一个按钮手动同步尺寸
- 定期检测 tmux pane 尺寸变化
- 如果内容溢出，允许区域滚动

### 问题8: 环境变量与端口配置

**解决方案**:
- 修改 vite.config.ts 使用环境变量
- 修改 gateway config 使用新的默认端口 9663
- e2e 测试动态检测可用端口

## 任务清单

- [ ] 问题1: 实现 capture-pane 获取历史内容
- [ ] 问题2: 启用 xterm.js 滚轮支持
- [ ] 问题3: 修复 Sidebar 图标样式
- [ ] 问题4: 修复组合按键处理
- [ ] 问题5: 修复 Pane/Window 切换
- [ ] 问题6: 修复移动端顶栏
- [ ] 问题7: 实现尺寸同步与滚动
- [ ] 问题8: 环境变量与动态端口
- [ ] 扩展 e2e 测试

## 注意事项

1. 保持代码风格与现有代码一致
2. 不要引入不必要的注释
3. 所有修改需要通过 e2e 测试验证
4. 遵循 AGENTS.md 的执行原则
