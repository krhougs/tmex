# Plan 00 Result: Frontend Nova Polish + 功能补齐 + E2E

日期：2026-02-13

## 完成情况
- 功能补齐
  - Sidebar：补回“删除设备”入口（确认弹窗、删除后刷新设备列表、删除当前选中设备时回退到`/devices`，并断开 sidebar/page 的 tmux 连接引用）。
  - Settings：补回 Webhooks 管理（列表/新增/删除），对齐后端 API：`GET/POST /api/webhooks`、`DELETE /api/webhooks/:id`。
  - Devices：补回“删除设备确认弹窗”，并新增设备卡片“更多操作”菜单（Edit/Test/Delete）；SSH 设备支持“测试连接”（`POST /api/devices/:id/test-connection`）。

- Nova 主题与 UI
  - `apps/fe/src/index.css`：按 shadcn `base-nova` 的 Nova 配色基线调整主色（切到 `theme=blue` 的 token 组合），并继续保留 iOS PWA safe-area/visualViewport 行为相关样式。
  - 字体：已切换为 Geist Variable（`@fontsource-variable/geist`），并作为全局 `--font-sans`。
  - App Shell：`RootLayout` 增加轻量的 `from-primary` 渐变底色，减少“纯白/纯黑”导致的廉价感，保持布局紧凑。
  - Terminal：xterm 主题与容器背景统一（light/dark 皆有配色），并对终端快捷键条与编辑器输入区做专门 surface token（更 Nova 化）。
  - 触摸屏可用性：Sidebar 的关键 icon 按钮在 coarse pointer 下自动放大，并确保危险操作（删除）在触屏上可见/可点。

- 输入与组合态（CJK/IME）
  - DevicePage：基于 xterm `terminal.textarea` 监听 `compositionstart/compositionend`，将组合态标记透传到后端 `term/input.isComposing`，避免拼音/假名候选被拆开发送。
  - DevicePage：Editor 模式下禁用 xterm stdin（`disableStdin`），减少“编辑器输入与终端输入混用”的触摸误操作。

- E2E（Playwright）
  - 删除旧 e2e 并重建 `apps/fe/tests/*`，覆盖设备 CRUD、Sidebar 删除、Settings（含 Telegram mock + Webhooks CRUD）、终端 UI、移动端顶部栏与侧边栏 Sheet。
  - `apps/fe/package.json`：恢复并启用 `test:e2e` 脚本，依赖已补齐 `@playwright/test`。
  - 根据 UI 调整同步更新设备页测试用例（菜单操作 + 删除确认弹窗）。

## 验证
- `bun run --filter @tmex/fe build`：通过。
- `bun run --filter @tmex/fe test:e2e`：通过（Chromium 5/5）。
- `bun run --filter @tmex/gateway build`：通过。

## 关键改动文件
- `apps/fe/src/pages/SettingsPage.tsx`（新增 Webhooks 管理 + UI 调整）
- `packages/shared/src/i18n/resources.ts`（新增 `webhook.*` 文案）
- `apps/fe/src/index.css`（Nova 主色 token 调整）
- `apps/fe/tests/settings.spec.ts`（新增 Webhooks CRUD 覆盖）
- `apps/fe/src/pages/DevicePage.tsx`（xterm 主题、组合态输入保护、触摸优化）
- `apps/fe/src/pages/DevicesPage.tsx`（设备操作菜单、测试连接、删除确认）
- `apps/fe/src/components/Sidebar.tsx`（触摸屏 hit-area/可见性优化）
- `apps/gateway/src/api/index.ts`（PWA manifest 颜色与新终端配色对齐）
