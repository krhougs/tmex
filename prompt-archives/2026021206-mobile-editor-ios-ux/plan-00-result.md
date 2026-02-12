# Plan 00 执行结果

时间：2026-02-12

## 完成项

### 1. 顶部快捷键栏可滑动判定区域扩大

- 文件：`apps/fe/src/index.css`
- 变更：
  - `.terminal-shortcuts-strip` 上移为横向滚动容器（`overflow-x: auto`），并增加 `min-height: 44px` 与 `touch-action: pan-x`。
  - `.shortcut-row` 改为 `inline-flex + min-width: max-content`，让整条 strip 可作为拖动区域。

### 2. 输入模式切换后自动滚动到最新

- 文件：`apps/fe/src/pages/DevicePage.tsx`
- 变更：
  - 新增 `inputMode` 监听 effect，在切换后通过 `requestAnimationFrame + setTimeout` 双触发 `terminal.scrollToBottom()`，保证切换 direct/editor 后仍定位到最新输出。

### 3. iOS textarea 聚焦时 editor 贴键盘、消除异常空白

- 文件：`apps/fe/src/pages/DevicePage.tsx`
- 文件：`apps/fe/src/index.css`
- 文件：`apps/fe/src/layouts/RootLayout.tsx`
- 变更：
  - 新增 iOS 检测与 editor 聚焦状态管理。
  - editor 聚焦且在 iOS 移动端时启用 `editor-mode-input-docked`（fixed 贴底）。
  - 根据 `visualViewport` 计算 `keyboardInsetBottom`，动态设置 editor bottom。
  - 通过 `ResizeObserver` 测量 docked editor 高度，并给终端区域增加对应 `padding-bottom`，避免被覆盖与底部空白。
  - `RootLayout` 额外同步 `--tmex-viewport-offset-top`，为移动端视口偏移提供变量基础。

### 4. iOS 地址栏策略：浏览器内 best-effort + PWA 全屏

- 文件：`apps/fe/src/pages/DevicePage.tsx`
- 文件：`apps/fe/index.html`
- 变更：
  - 终端页首次进入 iOS 移动端时执行一次性 `scrollTo(0, 1)` 序列（best-effort 收起地址栏）。
  - 增加 iOS PWA meta：
    - `viewport-fit=cover`
    - `apple-mobile-web-app-capable=yes`
    - `apple-mobile-web-app-status-bar-style=black-translucent`

### 5. 测试补充（TDD）

- 文件：`apps/fe/tests/tmux-ux.e2e.spec.ts`
- 新增/调整：
  - 将快捷键滚动容器断言从 `shortcut-row` 调整为 `terminal-shortcuts-strip`。
  - 新增“切换输入模式后终端应自动滚动到最新”用例。
  - 新增“应包含 PWA 全屏与 viewport-fit meta”用例。

## 验证结果

### Red（变更前）

以下用例在实现前失败（符合 TDD Red 阶段）：
- `编辑器应提供快捷键并可直接发送`（`terminal-shortcuts-strip` 非横向滚动容器）
- `切换输入模式后终端应自动滚动到最新`
- `应包含 PWA 全屏与 viewport-fit meta`

### Green（变更后）

通过命令：
- `bun run --cwd apps/fe test:e2e -- tests/tmux-ux.e2e.spec.ts -g "编辑器应提供快捷键并可直接发送|切换输入模式后终端应自动滚动到最新|应包含 PWA 全屏与 viewport-fit meta"`
- `bun run --cwd apps/fe test:e2e -- tests/tmux-mobile.e2e.spec.ts -g "iPhone 尺寸下顶栏不应挤在一起|折叠 Sidebar 底部按钮在 visualViewport scroll 风暴下应保持稳定"`
- `bunx tsc -p apps/fe/tsconfig.json --noEmit`
- `bun run --cwd apps/fe build`

说明：`build` 阶段仍有既有 CSS pseudo-class warning（历史问题），本次未引入新增 warning。

## 未完成项

- iOS 真机/模拟器手测清单（Safari/Chrome 键盘贴底与地址栏表现）尚未在本次自动化执行中覆盖，需要后续人工验收。
