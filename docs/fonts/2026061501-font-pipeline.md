# 终端字体打包流程（issue #14）

## 背景

终端与全应用等宽文本支持用户切换字体。字体从 [Nerd Fonts](https://www.nerdfonts.com/font-downloads) 精选，转成 woff2 随包分发，运行时按选中字体懒加载。本文档说明字体处理工具 `scripts/fonts/` 的用法与维护方式。

## 设计要点

- **真相源**：`scripts/fonts/fonts.config.ts` 维护精选清单（id / 展示名 / CSS family / Nerd Fonts 资产名 / 文件匹配前缀）。新增字体只在此追加一项。
- **动态 manifest**：构建工具扫描实际产物生成 `apps/fe/src/lib/fonts/manifest.generated.ts`，前端选择器与懒加载据此消费，**不手写字体列表**。
- **不子集、无损转码**：用 `wawoff2`（Google woff2 编码器的 WASM 封装）把整段 TTF/OTF 原样封装成 woff2，保留全部字形（含 Nerd 图标 PUA 区）。不用 `subset-font`——实测它即便喂入全 codepoint 仍会裁掉不可达字形（retain-reachable 而非真正保留全部）。
- **缺字重自动跳过**：每个字体尝试定位 `Mono` 的 Regular + Bold；缺 Bold 即跳过并计入跳过报告，不进 manifest（故选择器只列真正可用的字体）。

## 用法

```bash
bun run build:fonts
```

流程：
1. 读 `fonts.config.ts`。
2. 逐字体从 Nerd Fonts pinned release（`NERD_FONTS_VERSION`，当前 `v3.4.0`）下载资产 zip，缓存到 `scripts/fonts/.cache/`（已 gitignore，重跑命中缓存）。
3. 解压，递归匹配 `<matchPrefix>NerdFontMono-{Regular,Bold}.{ttf,otf}`（支持 `preferPathTokens` / `excludePathTokens` 消歧，如 JetBrains 取 Ligatures、Zed 取 Normal）。
4. `wawoff2.compress` 串行转码 → `apps/fe/public/fonts/generated/<id>/<id>-{regular,bold}.woff2`。
5. 扫描成功产物生成 manifest。
6. 打印「已处理 / 跳过」清单。

产物（woff2）与 manifest **均入库**；日常 `bun run build` 不重跑此步，仅在更新字体清单或 Nerd Fonts 版本时手动执行。

> 默认字体 Geist Mono 沿用仓库已有的扁平 woff2（`apps/fe/public/fonts/GeistMonoNerdFontMono-*.woff2`，已在 `index.css` 静态 `@font-face`、终端首屏即用），工具不重新下载，仅在 manifest 中以默认项引用既有文件。

## 运行时接线

- `apps/fe/src/lib/fonts/index.ts`：`resolveFontStack(id)` 由 manifest 派生 `主字体, NotoSansSymbols2Tmex, monospace`；`loadTerminalFonts(id, size)` 为非默认字体运行时注入 `@font-face` 并 `FontFaceSet.load` Regular/Bold（首屏只静态加载默认 Geist，避免一次拉全部）。
- `apps/fe/src/lib/fonts/useAppMonoFont.ts`：挂应用根，把选中字体写到 `:root` 的 `--font-mono`，全应用所有 `font-mono` 文本统一跟随。
- 字号 / 行高仅作用于终端（`useUIStore.terminalFontSize / terminalLineHeight`，经 `ghostty-terminal` 的 `fontSize` / `lineHeight` init option）。

## 当前结果（Nerd Fonts v3.4.0）

**已处理（7）**：Geist Mono（默认）、JetBrains Mono、Fira Code、Blex Mono（IBM Plex Mono）、Noto Sans Mono、Zed Mono、Victor Mono。

**跳过（3，上游缺 Bold）**：3270、BigBlue Terminal、Departure Mono。

> 跳过项保留在 `fonts.config.ts` 中：将来上游补齐 Bold 时重跑即自动纳入。

## 加新字体

1. 在 `fonts.config.ts` 的 `FONTS` 追加一项（`asset` 用 Nerd Fonts release 资产名，`matchPrefix` 用压缩包内字体文件名前缀——二者可能不同，如 BlexMono 在 `IBMPlexMono.zip` 内）。
2. `bun run build:fonts`。
3. 检查输出的「跳过清单」确认是否落地；提交 `apps/fe/public/fonts/generated/<id>/` 与 `manifest.generated.ts`。

> `manifest.generated.ts` 是生成文件，**不要手改 / lint / format**。
