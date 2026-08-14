# Configurable Sidebar Media Query Implementation Plan

> **For Codex:** 在当前 vibex worktree 内的 tmex 任务分支实施并独立验证。

**Goal:** 允许 SidebarProvider 由宿主配置 desktop media query，同时保持默认响应式行为不变。

**Architecture:** `useIsMobile` 接收 query 字符串并把它作为 effect 依赖；`SidebarProvider` 仅负责透传可选配置。产品平台判断留在调用方，tmex UI 不感知原生宿主。

**Tech Stack:** Bun、React 19、TypeScript、matchMedia。

---

### Task 1: 增加 query 参数

**Files:**
- Modify: `packages/ui/src/hooks/use-mobile.ts`
- Modify: `packages/ui/src/components/sidebar.tsx`

1. 导出默认 desktop query 常量。
2. `useIsMobile(desktopMediaQuery = DEFAULT_DESKTOP_MEDIA_QUERY)` 在初始化和 effect 中使用同一 query。
3. effect 依赖 `desktopMediaQuery`，切换参数时注销旧 MediaQueryList 并订阅新实例。
4. `SidebarProvider` 增加可选 `desktopMediaQuery?: string` 并传给 hook。

### Task 2: 验证和提交

1. 运行 `bun run --filter @tmex/ui test`。
2. 运行消费方 Native webview 构建，验证类型契约。
3. Review diff，确认默认调用点没有行为变化。
4. 使用中性 commit message 提交，并推送 `vibex/native-layout-safe-area`。

