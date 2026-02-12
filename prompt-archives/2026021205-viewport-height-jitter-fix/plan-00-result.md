# Plan 00 执行结果

时间：2026-02-12

## 完成内容

### 1) 视口高度同步逻辑重构

- 文件：`apps/fe/src/layouts/RootLayout.tsx`
- 调整点：
  - 移除 `visualViewport.scroll` 监听，避免滚动事件风暴导致的 `--tmex-viewport-height` 高频写入。
  - 引入 `requestAnimationFrame` 合并同帧更新，降低布局抖动与无效重排。
  - 引入 2px 高度差阈值（`HEIGHT_DELTA_THRESHOLD_PX = 2`）抑制 1px 级噪声抖动。
  - 增加非法高度保护：`height` 非有限数值或 `<= 0` 时忽略更新。

### 2) 回归测试（TDD）

- 文件：`apps/fe/tests/tmux-mobile.e2e.spec.ts`
- 新增用例：`折叠 Sidebar 底部按钮在 visualViewport scroll 风暴下应保持稳定`
  - 测试方法：在页面内临时 patch `CSSStyleDeclaration.prototype.setProperty` 统计 `--tmex-viewport-height` 的写入次数；通过 `visualViewport.dispatchEvent(new Event('scroll'))` 模拟 scroll 风暴。
  - 断言：scroll 风暴期间 `--tmex-viewport-height` 写入次数应被抑制（`<= 1`），同时底部按钮位置变化不超过 1px。

## 验证证据

- Red（修复前）
  - `bun run --cwd apps/fe test:e2e -- tests/tmux-mobile.e2e.spec.ts -g "折叠 Sidebar 底部按钮"`：失败
  - 失败原因：scroll 风暴触发 `--tmex-viewport-height` 写入次数为 40（预期 <= 1）。

- Green（修复后）
  - `bun run --cwd apps/fe test:e2e -- tests/tmux-mobile.e2e.spec.ts -g "折叠 Sidebar 底部按钮"`：通过

- 现有关键用例回归
  - `bun run --cwd apps/fe test:e2e -- tests/tmux-mobile.e2e.spec.ts -g "iPhone 尺寸下顶栏不应挤在一起"`：通过
  - `bun run --cwd apps/fe test:e2e -- tests/tmux-ux.e2e.spec.ts -g "调整浏览器宽度不应导致页面不可用"`：通过

- 类型检查与构建
  - `bunx tsc -p apps/fe/tsconfig.json --noEmit`：通过
  - `bun run --cwd apps/fe build`：通过（存在既有 CSS pseudo-class warning）

## 结论

`--tmex-viewport-height` 的高频抖动已被抑制，并通过新增 E2E 回归用例与关键现有用例验证未引入明显回归；移动端输入法适配仍保留 `visualViewport.resize` 驱动。
