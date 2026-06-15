# Plan 00 执行结果 — Terminal 字体设置（issue #14）

## 状态：完成（待用户 review / commit）

issue #14 实现完毕并通过自验。issue #23（复杂 Unicode）按用户决定不做，已贴技术原因评论并改标 `待讨论`（详见 `plan-prompt.md` 背景）。

## 交付清单

### 字体工具链（新）
- `scripts/fonts/fonts.config.ts`：10 个精选字体真相源。
- `scripts/fonts/build-fonts.ts`：下载 Nerd Fonts v3.4.0 → 定位 Mono Regular/Bold → `wawoff2` 无损转码 → 写产物 → 生成 manifest → 打印跳过清单。
- `scripts/fonts/wawoff2.d.ts`：wawoff2 类型声明。
- 根 `package.json` 加 `build:fonts`；`wawoff2@^2.0.1` devDependency。
- `docs/fonts/2026061501-font-pipeline.md`：工具文档。

### 产物（入库）
- `apps/fe/public/fonts/generated/<id>/<id>-{regular,bold}.woff2`：6 字体 × 2 字重 = 12 文件，14MB。
- `apps/fe/src/lib/fonts/manifest.generated.ts`：生成的字体清单（7 项）。

### 运行时接线（新）
- `apps/fe/src/lib/fonts/types.ts`：manifest 类型契约（手写）。
- `apps/fe/src/lib/fonts/index.ts`：`resolveFontStack` / `loadTerminalFonts`（懒加载 + @font-face 注入）/ `getFontEntry`。
- `apps/fe/src/lib/fonts/useAppMonoFont.ts`：挂应用根，派生 `--font-mono` 全应用传播。
- `apps/fe/src/components/terminal/TerminalPreview.tsx`：只读 headless 终端预览（写死 ~10 行带色含中文代码块）。
- `apps/fe/src/components/settings/terminal-tab.tsx`：设置「终端」Tab UI。

### 改动
- `packages/ghostty-terminal/src/types.ts` + `terminal.ts`：`GhosttyTerminalInitOptions` 加 `lineHeight?`，贯穿 cell 高计算（`:323` / `:1492`）。
- `apps/fe/src/stores/ui.ts`：`useUIStore` 加 `terminalFontSize/LineHeight/FontId` + setters + persist（key `tmex-ui`）。
- `apps/fe/src/components/terminal/Terminal.tsx`：读 store，`resolveFontStack`/`loadTerminalFonts`，字体设置进 useEffect 依赖（变更重建控制器）。
- `apps/fe/src/pages/SettingsPage.tsx`：加 `terminal` tab（类型/图标/tabItems/分支）。
- `apps/fe/src/main.tsx`：`RootLayout` 挂 `useAppMonoFont()`。
- i18n 三语（en/zh/ja）加 `settings.tabGroup.terminal` + `settings.terminal.*`，跑 `build:i18n` 重生成。

## 字体审计结果（Nerd Fonts v3.4.0）

- **已处理（7）**：Geist Mono（默认，沿用既有 woff2）、JetBrains Mono、Fira Code、Blex Mono（IBM Plex Mono）、Noto Sans Mono、Zed Mono、Victor Mono。
- **跳过（3，上游缺 Bold）**：3270、BigBlue Terminal、Departure Mono。

## 关键偏离（透明记录）

工具从计划的 `subset-font` 改为 **`wawoff2`**：Bun 1.3.12 实测 `subset-font` 即便喂全 codepoint 仍丢 14 个不可达字形（retain-reachable），`wawoff2.compress` 无损保留全部（12138/12138）。更契合「不子集」本意且更轻（去掉 harfbuzz/fontkit）。

## 自验（全绿）

- `build:fonts`：7 处理 / 3 跳过，符合审计。
- `bun run build:i18n`：通过。
- `bun run build:fe`（tsc + vite）：通过；生成 woff2 已进 `dist/fonts/generated/`（→ bundle-resources → npm 包）。
- `bun test`（ghostty-terminal）：63 pass / 0 fail。
- biome：手写文件全部 clean（`main.tsx:71` 的 exhaustive-deps 为 HEAD 既有、非本次引入，未动）。
- **无头浏览器（Playwright，端口 9890 临时实例）截图验收**：
  - 设置「终端」Tab 渲染，预览区显示彩色代码块 + 中文（`"你好，世界 🌏"`、`新增/删除/修改`、`通过测试 ✓`）+ Nerd 图标 + 反显状态栏。
  - 字号 13→22、行高 1.2→1.8 实时反映。
  - 字体下拉 = 7 个保留字体，**3 个跳过字体不在列表**；选 JetBrains 后预览换字 + 触发器显示 `JetBrains Mono`。
  - 懒加载：首屏只拉 Geist + 符号；选 JetBrains **仅**拉其 2 个 woff2，无其它字体请求。
  - `--font-mono` 全应用传播：`GeistMonoTmex,…` → 选字后 `JetBrainsMonoTmex,…`。

## 注意事项

- `scripts/fonts/.cache`（下载的 zip + 解压，约 3.4GB）已 gitignore；可 `rm -rf scripts/fonts/.cache` 回收磁盘，重跑会重新下载。
- `manifest.generated.ts` 与 i18n `resources.ts/types.ts` 为生成文件，**不可 lint/format/手改**。
- 字号/行高仅作用于终端；字体族经 `--font-mono` 全应用统一（markdown 代码块、code-viewer 等零改动跟随）。
- 未 commit（按惯例等用户 review）。
