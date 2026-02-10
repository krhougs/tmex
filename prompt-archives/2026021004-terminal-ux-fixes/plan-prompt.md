# Terminal UX Fixes Plan

## 问题列表

### 1. Terminal白屏问题
- 直接通过URL冷启动进入前端，terminal部分白屏
- 但按键可以发送到tmux（说明连接正常）

### 2. Sidebar功能问题
- 高亮状态样式看不清
- 切换window和split功能不工作
- 缺少新增window功能

### 3. 响应式布局问题
- 调整浏览器宽度会导致页面不可用

## 修复计划

### 阶段1: 修复Terminal白屏
- 分析DevicePage.tsx中的terminal初始化逻辑
- 修复冷启动时terminal容器大小问题
- 确保xterm正确初始化和渲染

### 阶段2: 修复Sidebar
- 改进高亮样式（使用更明显的颜色）
- 修复window/pane切换逻辑
- 添加新增window按钮和功能

### 阶段3: 响应式布局重设计
- 重新设计CSS布局结构
- 使用更稳定的flex/grid布局
- 处理resize事件

### 阶段4: e2e测试扩展
- 添加冷启动URL测试
- 添加sidebar交互测试
- 添加新增window测试
- 添加resize测试

## 执行原则
- 先存档，再干活
- 不做假设性推进
- 保持专业、高效执行
