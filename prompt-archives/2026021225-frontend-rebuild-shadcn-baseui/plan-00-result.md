# Plan-00 执行结果：前端全量重构（shadcn/ui + Base UI）

## 执行摘要
- 已完成 `apps/fe` 的前端重构主线：组件体系统一为 `shadcn/ui + Base UI`，全局主题走 shadcn token，保留并增强 tmex 在 iOS PWA 场景的 safe-area 与 viewport 适配。
- 已按已确认决策删除旧 FE e2e 用例，并将 FE 测试脚本调整为占位通过（当前阶段不建设自动化测试）。
- 已完成核心页面的深度视觉与交互改造，业务能力保持不变（路由不变、API 契约不变）。

## 关键改动

### 1) 组件与依赖基线
- 新增：`apps/fe/components.json`（`style: base-nova`）
- 新增：`apps/fe/src/lib/utils.ts`
- 新增/替换：`apps/fe/src/components/ui/*.tsx`（Button、Dialog、Sheet、Select、Switch、Tabs、Tooltip 等）
- 新增兼容出口：`apps/fe/src/components/ui/index.tsx`（兼容旧调用习惯）
- 修改：`apps/fe/package.json`
  - 移除 `@base-ui-components/react` 与 Radix 依赖
  - 新增 `@base-ui/react`、`shadcn`、`tw-animate-css`、`@fontsource-variable/inter`
  - `test` / `test:e2e` / `test:ui` 维持占位脚本
- 修改：`bun.lock`

### 2) 主题与布局壳层
- 修改：`apps/fe/src/stores/ui.ts`
  - 新增 `theme: 'light' | 'dark'`（persist）
- 修改：`apps/fe/src/main.tsx`
  - 首屏预应用主题，减少闪烁
- 修改：`apps/fe/src/layouts/RootLayout.tsx`
  - 桌面端固定侧栏 + 移动端 `Sheet` 抽屉
  - 移动端紧凑顶栏（侧栏入口、输入模式切换、跳转到底部）
  - 保留 tmex 通知事件与 pane 跳转逻辑
  - 保留 iOS 手势保护与 `visualViewport` 变量同步逻辑

### 3) 页面级重构（保持业务能力）
- 修改：`apps/fe/src/components/Sidebar.tsx`
  - 设备树/窗口/pane 导航整体重排为紧凑层级结构
  - 保留连接、选择、新建窗口、关闭窗口/Pane 行为
  - 侧栏折叠态与移动端抽屉态分别优化交互
- 修改：`apps/fe/src/pages/DevicesPage.tsx`
  - 列表、空状态、设备卡片、编辑弹窗全部重排
  - 保留设备 CRUD 与 SSH 认证分支逻辑
- 修改：`apps/fe/src/pages/DevicePage.tsx`
  - 终端页头、快捷键条、编辑器面板视觉重构
  - 保留 xterm 初始化/历史回放/实时输出/大小同步/输入模式逻辑
  - iOS 编辑器 dock 与键盘 inset 逻辑保持
- 修改：`apps/fe/src/pages/SettingsPage.tsx`
  - Theme 开关 + 多处 checkbox 改为 `Switch`
  - 视觉风格统一到 shadcn token

### 4) 全局样式与 iOS PWA 边界
- 重写：`apps/fe/src/index.css`
  - 引入 shadcn token（light/dark）
  - 保留并整合 `--tmex-viewport-height` / `--tmex-viewport-offset-top` / safe-area 变量
  - 保留终端移动端手势保护与 editor dock 规则
  - 清理与新组件冲突的旧 textarea/checkbox 样式

### 5) e2e 清理
- 删除：`apps/fe/tests/*.e2e.spec.ts`

## 验证结果

### 已通过
1. `bun run --filter @tmex/fe build`
- 结果：通过
- 说明：前端 TypeScript + Vite 构建成功（本轮多次复验通过）。

2. `bun run --filter @tmex/fe test`
- 结果：通过（占位脚本）
- 说明：符合本阶段“先不写自动化测试”的决策。

3. `bun run build`
- 结果：此前已通过（workspace 全量构建）。

### 已知非本次改动问题
1. `bun run test`
- 结果：此前失败
- 原因：`@tmex/gateway` 既有 SQLite 测试环境问题（`unable to open database file`）
- 结论：非 FE 重构引入。

## 风险与待办
- 当前按决策未建设新 e2e，仍存在前端回归风险，尤其是移动端触控与 iOS PWA 边界。
- 后续如恢复自动化测试，建议优先覆盖：侧栏导航树、终端输入模式切换、iOS PWA 安全区与键盘弹出场景。
