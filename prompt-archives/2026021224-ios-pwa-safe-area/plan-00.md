# 计划：iOS PWA Standalone 顶部安全区适配

## 背景

- iOS PWA（`display: standalone`）在 `viewport-fit=cover` 下会把页面扩展到安全区。
- 现有移动端顶栏与内容偏移使用固定高度（44px），未叠加 `safe-area-inset-top`，导致操作区与刘海/状态栏重叠。

## 目标

1. 移动端固定顶栏避让 iOS 顶部安全区。
2. 主内容起始位置与顶栏高度一致，避免内容被压住。
3. 移动端侧边栏头部同步避让顶部安全区。
4. 保持桌面端布局与交互不变。

## 实施步骤

1. 在 `apps/fe/src/index.css` 新增移动端 `safe-area` 工具类：
   - 顶栏容器类：高度 = `44px + env(safe-area-inset-top)`，并补偿左右安全区。
   - 顶栏内容行类：固定 44px 内容高度。
   - 主内容偏移类：`padding-top = 44px + env(safe-area-inset-top)`。
2. 在 `apps/fe/src/layouts/RootLayout.tsx`：
   - 移动顶栏应用上述类。
   - 将主内容区 `pt-11` 替换为安全区偏移类。
3. 在 `apps/fe/src/components/Sidebar.tsx`：
   - 头部容器应用同类安全区顶边避让，避免移动端侧栏头部被覆盖。
4. 更新/补充 E2E：
   - 在移动端布局测试断言顶栏与内容区已挂载安全区类（不依赖浏览器真实 safe-area 值）。
5. 验证：
   - `bunx tsc -p apps/fe/tsconfig.json --noEmit`
   - `bun run --cwd apps/fe test:e2e -- tests/tmux-mobile.e2e.spec.ts -g "iPhone 尺寸下顶栏不应挤在一起"`

## 风险与回滚

- 风险：类名变更可能影响旧用例选择器。
- 规避：保留 `data-testid`，测试只验证 class 存在与核心交互。
- 回滚：仅涉及 FE 样式与布局 class，可按文件粒度回退。
