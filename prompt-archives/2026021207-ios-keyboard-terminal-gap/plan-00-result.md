# Plan 00 执行结果

时间：2026-02-12

## 完成项

### 1. 修复 iOS 键盘触发后的终端底部空白（editor/direct）

- 文件：`apps/fe/src/layouts/RootLayout.tsx`
- 变更：
  - 根容器高度从
    - `height: var(--tmex-viewport-height)`
    - 调整为 `height: calc(var(--tmex-viewport-height) + var(--tmex-viewport-offset-top))`
  - 使视觉视口发生 `offsetTop > 0` 时，容器可覆盖可视区域，避免底部出现等高空白。

### 2. 视口变量同步增强（不引入高度抖动回归）

- 文件：`apps/fe/src/layouts/RootLayout.tsx`
- 变更：
  - 继续保留高度同步阈值（2px）与 RAF 合并。
  - 新增 `visualViewport.scroll` 监听，但只走“offset 同步路径”，不在 scroll 路径写高度变量。
  - `resize` 路径仍同步高度 + offset，兼顾键盘弹出、旋转、窗口变化。

## 验证结果

- `bunx tsc -p apps/fe/tsconfig.json --noEmit`：通过
- `bun run --cwd apps/fe test:e2e -- tests/tmux-mobile.e2e.spec.ts -g "折叠 Sidebar 底部按钮在 visualViewport scroll 风暴下应保持稳定"`：通过
- `bun run --cwd apps/fe test:e2e -- tests/tmux-mobile.e2e.spec.ts -g "iPhone 尺寸下顶栏不应挤在一起"`：通过

说明：
- `test:e2e` 过程中出现 `dev exited with code 143` 为测试脚本收尾关闭 dev 进程的既有行为，目标用例均为 `passed`。
- 本次未包含 iOS 真机/模拟器自动化键盘场景，仍建议手工验收 Safari/Chrome。

## 结论

本次修复聚焦于视觉视口偏移导致的容器覆盖不足问题，属于最小侵入改动；在不恢复 `--tmex-viewport-height` scroll 写入的前提下，补齐了 `offsetTop` 实时同步，预期可消除键盘触发后的底部空白。

