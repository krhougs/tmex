# Terminal 修复计划（第三轮）

## 背景

在 `prompt-archives/2026021001-terminal-fixes` 对应的修复合入后，仍存在严重问题：
1. 从直接URL进入设备页白屏，终端内容完全不可见
2. Sidebar 高亮状态下可读性仍有问题
3. 前端未正确读取环境变量 `FE_PORT`

本计划用于系统性修复上述问题，确保功能真正可用。

## 问题根因分析

### 问题1：白屏/无内容

经过代码审查，发现以下问题：

1. **历史内容订阅时机问题**：`subscribeHistory` 依赖 `resolvedPaneId`，但在 `selectPane` 消息发送之前订阅，导致后端无法正确关联历史数据
2. **历史数据处理问题**：`capture-pane` 命令的输出可能包含大量ANSI转义序列，需要正确处理
3. **终端初始化时机**：从URL直接进入时，terminal ref可能还未准备好，历史数据就已经到达
4. **WebSocket消息顺序**：`selectPane` 和 `subscribeHistory` 的顺序问题，历史订阅必须在pane选择之后才能生效

### 问题2：Sidebar 可读性

1. **active状态下的图标颜色**：当前使用 `var(--color-text)`，但在active状态下背景是accent蓝色，文字是白色，图标颜色不统一
2. **对比度问题**：window-item和pane-item的active状态使用半透明背景，与文字对比度可能不足
3. **布局问题**：collapsed状态下的图标对齐需要优化

### 问题3：FE_PORT环境变量

1. `vite.config.ts` 中硬编码了 `port: 9883`
2. 需要从环境变量读取 `FE_PORT`，默认为9883

## 目标

1. 从任意有效URL进入设备页后3秒内能看到终端内容（历史或当前输出），不再白屏
2. Sidebar完全重写，确保active/hover状态下文字、图标对比度满足WCAG AA标准（≥4.5:1）
3. 前端正确读取并使用环境变量 `FE_PORT`（含本地开发、e2e启动链路）
4. 扩展e2e测试覆盖白屏检测、Sidebar可读性、端口配置

## 任务清单

### 阶段1：白屏问题修复
- [ ] 修复历史订阅机制，确保在pane选择后正确获取历史
- [ ] 添加历史数据缓存和重放机制，处理terminal未就绪的情况
- [ ] 优化终端初始化和数据写入的时序
- [ ] 添加错误处理和加载状态显示

### 阶段2：Sidebar 重写
- [ ] 重新设计Sidebar组件结构，更清晰的信息架构
- [ ] 修复active状态下的颜色对比度问题
- [ ] 优化图标和文字的视觉层级
- [ ] 改进折叠/展开动画和交互

### 阶段3：FE_PORT 环境变量
- [ ] 修改 `vite.config.ts` 读取 `FE_PORT`
- [ ] 更新 `playwright.config.ts` 端口检测逻辑
- [ ] 验证环境变量传递链路

### 阶段4：e2e测试扩展
- [ ] 添加"从URL直接进入"的白屏检测测试
- [ ] 添加Sidebar active状态对比度验证测试
- [ ] 添加FE_PORT环境变量测试
- [ ] 确保测试在端口占用时自动选择可用端口

## 验收标准

1. 从 `/devices/:deviceId/windows/:windowId/panes/:paneId` URL直接进入，3秒内终端显示内容
2. Sidebar active状态文字与图标对比度 ≥ 4.5:1
3. 设置 `FE_PORT=9999` 后，前端实际监听端口9999，e2e访问端口9999
4. 所有e2e测试在端口被占用时自动选择可用端口并通过
