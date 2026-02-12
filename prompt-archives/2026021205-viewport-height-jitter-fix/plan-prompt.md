# Prompt 存档：跨浏览器 `--tmex-viewport-height` 抖动

## 用户原始反馈
1. 我观察到一个现象，在一些浏览器中左下角两个按钮会疯狂抽搐，打开调试器可以看到 `--tmex-viewport-height` 的值在不停变化。
2. Implement the plan.

## 上下文补充
- 已在代码中确认 `apps/fe/src/layouts/RootLayout.tsx` 同时监听了 `window.resize`、`visualViewport.resize`、`visualViewport.scroll`，并持续写入 `--tmex-viewport-height`。
- 用户在规划阶段确认：
  - 修复范围：抖动 + 重构策略。
  - 浏览器优先级：全部一起覆盖。
