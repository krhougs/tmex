# 计划：新增动态 PWA Manifest（站点名来自数据库）

## 背景

- 现有 FE 尚未声明 manifest，无法完整走 PWA 安装链路。
- 站点名称由数据库 `site_settings.site_name` 维护，要求 PWA 安装名与其一致。
- 运行路径分两种：
  - `apps/fe` dev：Vite 通过 `/api` 代理到 gateway。
  - `packages/app` 打包：gateway 同进程提供 `/api` 与静态 FE 文件。

## 目标

1. 提供可安装的 manifest。
2. manifest 的 `name/short_name` 动态读取数据库中的 `siteName`。
3. 在 FE dev 与打包 app 下行为一致。

## 实施步骤

1. 在 `apps/gateway/src/api/index.ts` 新增 `GET /api/manifest.webmanifest`。
2. 返回 `application/manifest+json`，并设置 `Cache-Control: no-store`。
3. manifest 字段：
   - `id`、`start_url`、`scope`: `/`
   - `name`、`short_name`: `settings.siteName`
   - `display`: `standalone`
   - `background_color`、`theme_color`: `#0d1117`
   - `icons`: 使用 `/tmex.png`（`768x768`，`purpose: any maskable`）
4. 在 `apps/fe/index.html` 增加 `<link rel="manifest" href="/api/manifest.webmanifest" />`。
5. 在 E2E 补充 manifest 断言：
   - 页面应声明 manifest link。
   - 修改 `siteName` 后 manifest 的 `name/short_name` 应同步变化，并在 finally 恢复。
6. 执行验证：
   - `bunx tsc -p apps/fe/tsconfig.json --noEmit`
   - `bun run --cwd apps/fe test:e2e -- tests/tmux-ux.e2e.spec.ts -g "manifest"`

## 注意事项

- 不新增静态 manifest 文件，统一走 API 以保证动态名称。
- 不改动数据库 schema，仅读取现有 `site_settings`。
- 不触碰与本任务无关的现有脏改动。

