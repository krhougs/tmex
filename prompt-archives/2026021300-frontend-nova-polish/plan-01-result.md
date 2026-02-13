# Plan 01 Result: 移动端交互/布局/安全区修复 + PC 终端铺满（问题 1-9）

日期：2026-02-13

## 完成情况
- Phase 1（问题 2/4/6/5）：将移动端终端页“下滑 overscroll 拦截”从全局收敛到 xterm 输出区域，避免吞掉快捷键栏/编辑器/设置页等区域的点击。
  - `apps/fe/src/layouts/RootLayout.tsx`：移除终端路由下的 `touchstart/touchmove` 全局监听（不再在 RootLayout 里 `preventDefault()`）。
  - `apps/fe/src/pages/DevicePage.tsx`：仅在 `.xterm-viewport` 上绑定移动端触摸监听；当 viewport 处于顶部且向下滑动时 `preventDefault()`，用于抑制 iOS/Safari/PWA 的下拉回弹导致的点击不稳定。
- Phase 2（问题 1/9）：补充 ScrollArea 在 flex 容器中的最小尺寸约束，确保 overflow 计算稳定，从而让 coarse pointer 下隐藏 scrollbar 的逻辑可被稳定触发与验证。
  - `apps/fe/src/components/ui/scroll-area.tsx`：为 Root/Viewport 增加 `min-h-0 min-w-0`。
- E2E：补齐移动端关键交互回归用例。
  - `apps/fe/tests/mobile-terminal-interactions.spec.ts`：移动端 editor 聚焦后点击快捷键/发送，验证保持 focus 且发出 `term/input`。
  - `apps/fe/tests/mobile-sidebar-safe-area.spec.ts`：移动端 sidebar overflow 场景下，验证 coarse pointer 隐藏 scrollbar，且 safe-area padding 生效。
  - `apps/fe/tests/mobile-settings.spec.ts`：移动端 settings Tabs/Select/Webhook CRUD 可点可用（Telegram 接口 mock）。

## 验证
- `bun run --filter @tmex/fe build`：通过。
- `bun run --filter @tmex/fe test:e2e`：通过（Chromium 8/8）。

## 关键改动文件
- `apps/fe/src/layouts/RootLayout.tsx`
- `apps/fe/src/pages/DevicePage.tsx`
- `apps/fe/src/components/ui/scroll-area.tsx`
- `apps/fe/tests/mobile-terminal-interactions.spec.ts`
- `apps/fe/tests/mobile-sidebar-safe-area.spec.ts`
- `apps/fe/tests/mobile-settings.spec.ts`

## 备注
- Plan 01 的其余 Phase（Settings Tabs、iOS 安全区填充层、PC 端 fit() 解耦等）已在 `main` 的既有提交中落地；本次提交为 Phase 1 的“方案 A 落地 + 回归用例补齐”。

