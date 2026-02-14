# Prompt Archive: 终端重构使用 react-xtermjs

**Date:** 2026-02-14  
**Task:** 重构整个终端，使用 react-xtermjs 而不是直接使用 @xterm/xterm

---

## 原始 Prompt

> 阅读 AGENTS.md 研究重构整个终端，出计划，不实现。使用 react-xtermjs 而不是直接使用 @xterm/xterm

---

## 背景调研结果

### 当前终端实现现状

当前 `DevicePage.tsx`（1535 行）直接集成 xterm.js，存在以下问题：

1. **代码复杂度高**：
   - 手动管理 Terminal 实例生命周期（init、dispose）
   - 大量 useRef 管理状态（terminal、fitAddon、历史缓冲区等）
   - 复杂的 resize 逻辑（防抖、同步、冲突处理）
   - 手动处理 addon 加载（FitAddon、Unicode11Addon、WebglAddon）

2. **状态管理混乱**：
   - 混合使用 useRef 和 useState
   - session ID 管理 pane 生命周期
   - history fallback timer 和 buffer 管理

3. **事件处理繁琐**：
   - 手动绑定/解绑 WebSocket 消息
   - 自定义键盘事件处理
   - composition 事件处理

### react-xtermjs 优势

- 提供 `useXTerm` hook 和 `XTerm` 组件
- 自动管理 Terminal 实例生命周期
- 简化 addon 集成
- 更符合 React 声明式编程模型

### 需要保持的功能

1. 主题切换（dark/light）
2. WebGL 渲染（性能优化）
3. FitAddon 自动适配
4. Unicode11 支持
5. Resize 上报后端
6. History 回显
7. Binary 数据实时输出
8. 输入模式切换（direct/editor）
9. 移动端触摸处理
10. iOS 键盘适配

---

## 计划文件

- `plan-00.md`: 重构终端使用 react-xtermjs 详细计划
