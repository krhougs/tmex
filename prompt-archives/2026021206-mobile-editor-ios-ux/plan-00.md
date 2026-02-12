# 计划：移动端快捷键栏触控优化与 iOS 键盘/地址栏适配

## 背景
- 快捷键栏当前横向滚动主要落在 `.shortcut-row`，触控命中区偏小，手机操作困难。
- 输入模式切换不会主动触发终端滚动到底部。
- iOS 键盘弹出时存在 visual viewport 偏移，导致 editor 区跳位与底部空白。
- iOS 浏览器地址栏无法强制隐藏，只能浏览器内 best-effort；PWA 可实现全屏无地址栏。

## 目标
1. 扩大快捷键栏可滑动判定区域，提高手机横滑可用性。
2. 输入模式切换后终端自动滚动到最新。
3. iOS 键盘弹出时 editor 紧贴键盘，消除上飘与底部空白。
4. 增加 iOS PWA meta，浏览器内增加地址栏隐藏 best-effort。

## 实施步骤
1. 归档（先存档后干活）。
2. TDD 补充前端 E2E：
   - 快捷键栏容器可横向滚动。
   - 切换输入模式后仍可看到最新输出（间接验证跳底）。
   - `index.html` 关键 iOS meta 存在（静态断言）。
3. 改造 `DevicePage.tsx`：
   - 输入模式变化时触发 `scrollToBottom()`。
   - editor textarea 聚焦/失焦时维护“键盘活动态”，并在聚焦后触发一次滚动定位。
   - mobile terminal 首次交互时做地址栏收起 best-effort（一次性）。
4. 改造 `RootLayout.tsx`：
   - 继续维护 `--tmex-viewport-height`，新增 `--tmex-viewport-offset-top` 变量同步。
5. 改造 `index.css`：
   - 将快捷键横向滚动能力上移到 `.terminal-shortcuts-strip`，扩大可触区域。
   - editor 模式在移动端键盘活动时 fixed 贴底，并通过 `--tmex-viewport-offset-top` 对齐。
6. 更新 `apps/fe/index.html`：
   - `viewport-fit=cover`。
   - `apple-mobile-web-app-capable=yes`。
   - `apple-mobile-web-app-status-bar-style=black-translucent`。
7. 执行验证：
   - 定向 E2E。
   - `bunx tsc -p apps/fe/tsconfig.json --noEmit`。
   - `bun run --cwd apps/fe build`。

## 注意事项
- 仅改前端，不触碰协议与后端行为。
- iOS 地址栏在浏览器中不承诺 100% 隐藏。
- 保持当前仓库已有脏改动不受影响。
