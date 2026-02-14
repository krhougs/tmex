# 终端重构使用 react-xtermjs

**日期：** 2026-02-14  
**作者：** Kimi Code  
**状态：** 计划中

---

## 背景

当前前端终端功能位于 `apps/fe/src/pages/DevicePage.tsx` 中，直接使用 `xterm.js` 库（`import { Terminal } from 'xterm'`）实现。该文件已增长至 1535 行，包含大量终端生命周期管理、事件处理、resize 逻辑等复杂代码。

### 当前实现的问题

1. **代码复杂度高**：手动管理 Terminal 实例生命周期（初始化、销毁）、大量 useRef 管理状态、复杂的 resize 防抖和同步逻辑
2. **状态管理混乱**：混合使用 useRef 和 useState，session ID 管理 pane 生命周期，history fallback timer 和 buffer 管理
3. **事件处理繁琐**：手动绑定/解绑 WebSocket 消息、自定义键盘事件处理、composition 事件处理

### 目标方案

引入 `react-xtermjs` 库作为 xterm.js 的 React 封装，提供：

- `useXTerm` hook 和 `XTerm` 组件
- 自动管理 Terminal 实例生命周期
- 简化 addon 集成
- 更符合 React 声明式编程模型

---

## 目标

1. 使用 `react-xtermjs` 替代直接使用 `xterm.js`
2. 将 DevicePage 中的终端相关逻辑抽离到独立组件
3. 保持所有现有功能不变
4. 代码量减少 50% 以上

---

## 设计思路

### 组件架构

```
DevicePage
├── Terminal (新组件)
│   ├── useXTerm (from react-xtermjs)
│   ├── useTerminalResize (自定义 hook)
│   ├── FitAddon
│   ├── Unicode11Addon
│   └── WebglAddon
├── Editor (原有)
└── Shortcuts (原有)
```

### 关键设计决策

1. **组件封装**：创建独立的 `Terminal` 组件，封装所有 xterm.js 细节
2. **Hooks 分离**：将 resize、data 处理、mobile 触摸等逻辑分离到独立 hooks
3. **Ref 暴露**：通过 `useImperativeHandle` 暴露必要方法供父组件调用
4. **渐进式重构**：保持现有外部接口不变，逐步替换内部实现

---

## 任务清单

### Phase 1: 依赖和基础结构

- [ ] Task 1: 安装 react-xtermjs 和 @xterm/xterm 依赖
- [ ] Task 2: 创建 Terminal 组件基础结构和类型定义
- [ ] Task 3: 迁移 Terminal 主题配置到独立文件

### Phase 2: Hooks 开发

- [ ] Task 4: 创建 useTerminal hook 处理 data/history
- [ ] Task 5: 创建 useTerminalResize hook 处理 resize 逻辑
- [ ] Task 6: 创建 useMobileTouch hook 处理移动端触摸

### Phase 3: 组件完善

- [ ] Task 7: 完善 Terminal 组件集成所有功能
- [ ] Task 8: 添加主题切换、input mode 切换支持

### Phase 4: 页面重构

- [ ] Task 9: 重构 DevicePage 使用 Terminal 组件
- [ ] Task 10: 清理 DevicePage 冗余代码

### Phase 5: 验证

- [ ] Task 11: 运行 E2E 测试验证
- [ ] Task 12: 类型检查和构建验证

---

## 风险评估

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| react-xtermjs API 与现有代码不兼容 | 中 | 高 | 先创建原型验证，保留回滚方案 |
| Addon 加载方式改变导致功能异常 | 中 | 中 | 完整测试所有 addon（WebGL、Fit、Unicode11）|
| Resize 逻辑重构引入 bug | 中 | 高 | 保留现有 resize 算法，仅改变封装方式 |
| Mobile 触摸处理失效 | 低 | 中 | 保留现有触摸处理逻辑，完整 E2E 测试 |
| 性能退化 | 低 | 中 | 对比重构前后性能指标 |

---

## 验收标准

1. DevicePage.tsx 行数减少 50% 以上（当前 1535 行）
2. 所有 E2E 测试通过
3. 类型检查无错误
4. 构建成功
5. 主题切换正常
6. Resize 上报正常
7. History 回显正常
8. Binary 数据实时输出正常
9. 输入模式切换正常
10. 移动端触摸滚动正常
11. iOS 键盘适配正常

---

## 参考文档

- [react-xtermjs GitHub](https://github.com/Qovery/react-xtermjs)
- [xterm.js 官方文档](https://xtermjs.org/)
- [现有计划存档](/prompt-archives/2026021400-terminal-react-xtermjs-refactor/plan-00.md)
