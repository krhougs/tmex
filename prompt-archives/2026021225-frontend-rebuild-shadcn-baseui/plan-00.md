# Plan-00：前端全量重构（shadcn/ui + Base UI, Nova, 手动 Dark Mode, iOS PWA 安全区）

## 背景与目标
- 目标：彻底重写 `apps/fe/` 前端 UI 与布局，统一采用 shadcn/ui 的默认主题基线（Nova 风格），底层 primitives 使用 Base UI；同时支持全局 Dark Mode（仅手动切换）。
- 约束：
  - 路由 URL 不变（`/devices`、`/devices/:deviceId`、`/devices/:deviceId/windows/:windowId/panes/:paneId`、`/settings`）。
  - 后端 API 契约不变（`/api/*`、`/ws`）。
  - 重点保证移动端/触控与 iOS PWA 安全区、键盘与滚动边界。
- 测试策略（用户最新优先级）：本阶段不写任何自动化测试；删除现有 FE e2e 用例，但保证 `bun run test` 不因此失败。

## 参考（执行时需再次核对，禁止猜测）
- shadcn CLI / create：官方文档与交互配置器
  - https://ui.shadcn.com/docs/installation/vite
  - https://ui.shadcn.com/create
- Base UI：
  - 包名迁移到 `@base-ui/react`（按官方 release notes）
  - https://github.com/mui/base-ui/releases
  - 文档：https://base-ui.com

## 里程碑
1. 建立隔离 worktree（已做）。
2. 归档 prompt 与 plan（本文件 + plan-prompt.md，已做）。
3. 在 `apps/fe/` 内完成 shadcn/ui 初始化与依赖切换到 `@base-ui/react`。
4. 替换全局样式与主题 token（含 `.dark`），保留 tmex 的 viewport/safe-area 变量与逻辑。
5. 重写 App Shell（RootLayout + Sidebar + 页头/移动端 drawer）。
6. 重写三页：Devices / Device(terminal) / Settings（功能保持不变）。
7. 删除旧 e2e 并调整 test 脚本为“无测试也不失败”。
8. 手工回归清单验证，修复移动端/iOS PWA 边界。
9. 记录执行结果到 `plan-00-result.md`。

## 具体实施（文件级）

### A. Worktree 与依赖
- 目录：`.worktrees/frontend-rebuild-shadcn-baseui`
- 命令：
  - `bun install`
  - `bun run --filter @tmex/fe build`

### B. shadcn/ui 初始化（Vite + React）
- 在 `apps/fe/` 运行 shadcn CLI：
  - 选择 Style：Nova
  - 选择 Component library：Base UI
  - 生成/更新：`components.json`、`src/components/ui/*`、`src/lib/utils.ts`、全局样式与 Tailwind 配置
- 需要手工对齐：
  - monorepo 的路径别名（保持 `@` 指向 `apps/fe/src`）
  - Tailwind v4 的接入方式（当前用 `@tailwindcss/vite` + `@import "tailwindcss"`）

### C. Base UI 依赖切换
- 目标：移除 `@base-ui-components/react`，统一使用 `@base-ui/react`。
- 替换范围：
  - `apps/fe/src/components/ui/*`
  - 任何 `@base-ui-components/react/*` 子路径 import

### D. Dark Mode（仅手动）
- 修改：`apps/fe/src/stores/ui.ts`
  - 增加 `theme: 'light' | 'dark'`（persist）
  - 增加 `setTheme(theme)`
- 修改：`apps/fe/src/layouts/RootLayout.tsx`
  - 读取 theme，写入 `document.documentElement.classList` 的 `dark`
- 修改：`apps/fe/src/pages/SettingsPage.tsx`
  - 增加 Theme 切换控件（shadcn 组件）

### E. iOS PWA 安全区与 viewport
- 保留并迁移现有三类机制：
  - `html[data-tmex-standalone="1"]` 时注入 safe-area inset 变量
  - visualViewport 高度/offset 同步为 CSS 变量（用于键盘与 fixed 元素计算）
  - terminal route 下手势/滚动保护（避免 iOS 下拉回弹与误触）
- 相关文件：
  - `apps/fe/index.html`
  - `apps/fe/src/layouts/RootLayout.tsx`
  - `apps/fe/src/index.css`（将旧 `--color-*` 迁移为 shadcn token，同时保留 `--tmex-*`）

### F. 页面与功能保持
- `apps/fe/src/pages/DevicesPage.tsx`
  - CRUD、表单校验、SSH authMode 分支
- `apps/fe/src/pages/DevicePage.tsx`
  - xterm、history/live output、输入模式 direct/editor、IME composing、快捷条
- `apps/fe/src/pages/SettingsPage.tsx`
  - site settings、restart、telegram bots/chats 管理
- `apps/fe/src/components/Sidebar.tsx`
  - 设备树、window/pane 切换、创建/关闭 window、关闭 pane、collapsed 模式、移动端 drawer

### G. 删除 e2e 与 test 脚本调整
- 删除：`apps/fe/tests/*.e2e.spec.ts`
- 调整：`apps/fe/package.json`
  - `test` 不再强依赖 Playwright（保证 `bun run test` 通过）
  - `test:e2e` 可保留为手动入口（但默认不在 CI 里跑）

## 手工回归清单（最低要求）
- Devices：新增/编辑/删除 local 与 ssh 设备；authMode 切换。
- Sidebar：展开/折叠；切换 window/pane；新建 window；关闭 pane/window。
- Terminal：直连 URL 打开；滚动；移动端 direct/editor 切换；IME 输入不拆分；Jump to latest。
- iOS PWA：standalone 安全区顶栏/底栏不遮挡；键盘弹出不抖动、不遮挡输入。
- Settings：保存站点设置；language 变更提示；restart gateway；Telegram bot/chats approve/test/remove。

