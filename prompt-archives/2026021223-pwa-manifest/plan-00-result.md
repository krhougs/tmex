# Plan 00 执行结果

时间：2026-02-12

## 完成项

### 1) gateway 新增动态 manifest

- 文件：`apps/gateway/src/api/index.ts`
- 新增路由：
  - `GET /api/manifest.webmanifest`
  - `HEAD /api/manifest.webmanifest`
- 行为：
  - 从数据库读取 `site_settings`（`getSiteSettings()`），将 `siteName` 写入 manifest 的 `name/short_name`。
  - 响应头：
    - `Content-Type: application/manifest+json; charset=utf-8`
    - `Cache-Control: no-store`
  - 图标使用 `/tmex.png`（`768x768`，`purpose: any maskable`）。

### 2) FE 声明 manifest link（dev 与打包运行同路由）

- 文件：`apps/fe/index.html`
- 新增：
  - `<link rel="manifest" href="/api/manifest.webmanifest" />`
  - `<link rel="apple-touch-icon" href="/tmex.png" />`
- 说明：
  - dev：`/api/*` 已由 Vite 代理到 gateway。
  - 打包 app：gateway 同源处理 `/api/*`，静态 FE 不需要额外处理。

### 3) iOS 安装引导提示（解释 iOS 不会自动弹出安装弹窗）

- 文件：`apps/fe/src/layouts/RootLayout.tsx`
- 变更：
  - iOS 移动端且非 standalone 模式时，首次进入展示一次性 toast，引导用户通过“分享 -> 添加到主屏幕”安装。
  - 通过 `localStorage` 记录已展示，避免反复提示。
  - `localStorage` 读写增加容错，避免隐私模式/存储受限导致页面异常。

### 3) E2E 回归用例

- 文件：`apps/fe/tests/tmux-ux.e2e.spec.ts`
- 新增断言：
  - 页面应存在 `link[rel="manifest"]` 且 `href` 指向 `/api/manifest.webmanifest`。
  - 页面应存在 `link[rel="apple-touch-icon"]` 且指向 `/tmex.png`。
  - 修改站点名后 manifest 的 `name/short_name` 应同步变化，并在 finally 中恢复原始站点设置，避免污染环境。

## 验证结果

- `bunx tsc -p apps/fe/tsconfig.json --noEmit`：通过
- `bun run --cwd apps/fe test:e2e -- tests/tmux-ux.e2e.spec.ts -g "manifest|PWA|iOS Meta"`：通过

说明：
- `apps/gateway` 侧 `tsc` 当前存在既有类型错误，本次未引入新的 gateway 类型检查口径变更，验证以现有前端 E2E/类型检查为准。
