# 执行结果：iOS PWA Safe-Area 与底部空白修复（持续迭代）

## 本轮新增修复

### 1. 去除全局底部安全区变量，改为按组件启用

- 文件：`apps/fe/src/index.css`
- 变更：
  - 移除 `--tmex-safe-area-bottom` 全局变量与 `html[data-tmex-standalone="1"]` 的全局 bottom 映射。
  - 保留 top/left/right 的受控变量，继续用于顶部与左右安全区。

### 2. 编辑器底部与侧边栏底部统一逻辑

- 文件：`apps/fe/src/index.css`
- 新增规则（仅移动端 + standalone 生效）：
  - `html[data-tmex-standalone="1"] .editor-mode-input { padding-bottom: calc(8px + env(safe-area-inset-bottom)); }`
  - `html[data-tmex-standalone="1"] .tmex-sidebar-bottom-safe-md { padding-bottom: calc(12px + env(safe-area-inset-bottom)); }`
  - `html[data-tmex-standalone="1"] .tmex-sidebar-bottom-safe-sm { padding-bottom: calc(8px + env(safe-area-inset-bottom)); }`

- 文件：`apps/fe/src/components/Sidebar.tsx`
- 变更：
  - 展开态底部容器加 `tmex-sidebar-bottom-safe-md`。
  - 折叠态底部容器加 `tmex-sidebar-bottom-safe-sm`。

### 3. Toaster 底部偏移取消全局 safe-area 绑定

- 文件：`apps/fe/src/main.tsx`
- 变更：
  - `mobileOffset.bottom` 从 `calc(12px + var(--tmex-safe-area-bottom))` 调整为固定 `12px`。

### 4. iOS PWA 底部大块：视口高度在 standalone 下做“非键盘场景补齐”

- 文件：`apps/fe/src/layouts/RootLayout.tsx`
- 变更：
  - 在 `applyViewportVars` 中，针对 `isStandaloneDisplayMode()` 增加高度修正：
    - 当 `layoutHeight - (visualHeight + offsetTop)` 在小阈值内（判定为非键盘差异）时，使用 `layoutHeight - offsetTop` 作为高度同步值。
  - 目标：避免 PWA standalone 下 `visualViewport.height` 基线偏小导致根容器底部长期留白。

## 历史保留项（本目录此前已完成）

- 顶部 safe-area 只在 standalone 启用。
- `html[data-tmex-standalone]` 运行时标记与旧版 Safari 监听兼容。
- Toaster 顶部偏移绑定 `var(--tmex-safe-area-top)`，避免被刘海/状态栏遮挡。

## 验证结果

- `bunx tsc -p apps/fe/tsconfig.json --noEmit`：通过。
- `bun run --cwd apps/fe test:e2e -- tests/tmux-ux.e2e.spec.ts -g "iOS Meta"`：通过。
- `bun run --cwd apps/fe test:e2e -- tests/tmux-mobile.e2e.spec.ts -g "折叠 Sidebar 底部按钮在 visualViewport scroll 风暴下应保持稳定"`：通过。

说明：iOS PWA standalone + 键盘相关表现依赖真机 `visualViewport` 实际行为，本轮自动化仅能做回归兜底，仍需真机确认底部空白是否彻底消除。
