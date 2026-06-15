# Plan 00 — Terminal 字体设置（issue #14）

> 背景与 prompt 见同目录 `plan-prompt.md`。本 plan 基于一轮并行验证（`font-settings-verify` workflow，4 验证器，均 high confidence）落地，下文「已验证」标注的事实均有据（Nerd Fonts v3.4.0 git tree 核对 / Bun 1.3.12 实测 / 源码行号核对）。

## 目标

设置页新增「终端」Tab，支持：终端字号（现写死 13）、行高（现写死 1.2）、字体族（选后全应用等宽处统一）。打包精选 Nerd Fonts（Normal+Bold woff2），动态生成 manifest，选择器不做字样预览但下方有终端实时渲染的预览区。字体处理写成标准化工具 + 文档。

## 已验证事实

### 精选字体审计（Nerd Fonts v3.4.0）

| 字体 | release 资产 | CSS family | Regular | Bold | 结论 |
|---|---|---|---|---|---|
| 3270 | 3270.zip | 3270 Nerd Font | ✓ | ✗ | **跳过**（无 Bold，仅宽度变体） |
| BigBlueTerm | BigBlueTerminal.zip | BigBlueTerm Nerd Font | ✓ | ✗ | **跳过**（仅 Regular） |
| DepartureMono | DepartureMono.zip | DepartureMono Nerd Font | ✓ | ✗ | **跳过**（单字重像素字体） |
| BlexMono | **IBMPlexMono.zip** | BlexMono Nerd Font | ✓ | ✓ | 处理 |
| FiraCode | FiraCode.zip | FiraCode Nerd Font | ✓ | ✓ | 处理 |
| Noto Sans Mono | **Noto.zip** | NotoSansM Nerd Font | ✓ | ✓ | 处理 |
| Geist Mono | GeistMono.zip | GeistMono Nerd Font | ✓ | ✓ | 现用（默认，沿用已有 woff2） |
| JetBrainsMono | JetBrainsMono.zip | JetBrainsMono Nerd Font | ✓ | ✓ | 处理（取 Ligatures 子集的 Regular/Bold） |
| ZedMono | ZedMono.zip | ZedMono Nerd Font | ✓ | ✓ | 处理 |
| VictorMono | VictorMono.zip | VictorMono Nerd Font | ✓ | ✓ | 处理 |

**跳过清单**：3270、BigBlueTerm、DepartureMono（均缺 Bold）。
**需新下载处理（6 个）**：BlexMono、FiraCode、Noto Sans Mono、JetBrainsMono、ZedMono、VictorMono。
**默认**：Geist Mono——沿用仓库现有 `apps/fe/public/fonts/GeistMonoNerdFontMono-{Regular,Bold}.woff2`（已子集、已静态 @font-face、终端首屏即用），不重新生成，避免回归。

### 工具链（Bun 1.3.12 实测）

- 需求是「不子集、保留全字形（含 Nerd PUA 图标）」。实测 `subset-font` 即便喂全 codepoint 仍丢 14 个不可达字形（retain-**reachable**）；`wawoff2.compress()` 无损保留 12138/12138。
- **决策（偏离 brainstorming 时选的 subset-font）**：用 **`wawoff2`** 直接 TTF→woff2 纯转码。理由：① 真正满足「不子集」；② 无字形选择逻辑、不会误丢；③ `subset-font` 内部本就经 `fontverter` 调 wawoff2 编码，直接依赖 wawoff2 反而更轻（去掉 harfbuzzjs/fontkit）。代价：输出约大 7%（因不裁剪未引用字形）——正是「不子集」想要的。
- 依赖：`wawoff2@^2.0.1`（唯一运行依赖 argparse，wasm 以 base64 内嵌）。Bun 下 instantiate 干净无警告。**纯构建/CLI 侧**，绝不进前端 bundle（fs 访问正常，不触发 `node:fs externalized`）。
- compress() 是共享 emscripten 单例，**串行**调用每个文件。

### 渲染层 / 预览（源码核对）

- 现状写死：`Terminal.tsx:40` fontSize=13；`theme.ts:77` XTERM_FONT_FAMILY；`theme.ts:93-94` ensureTerminalFontLoaded 写死 13px；`terminal.ts:58` LINE_HEIGHT=1.2（用于 `:323` root.style.lineHeight 与 `:1492` rawHeight）。
- `GhosttyTerminalInitOptions` 现无 `lineHeight`；控制器无 post-init 改字体 API；`updateCellDimensions` 私有。
- 预览可行：`createTerminalController({fontFamily,fontSize,lineHeight,theme,scrollback,disableStdin:true})` → `open(container)` → `write(ANSI字节)`。字体设置变更时**重建控制器**（预览与正式终端都走这条路：把 fontSize/family/lineHeight 放进 `open` 的 useEffect 依赖）。

## 架构决策

1. **store**：扩展现有 `useUIStore`（`apps/fe/src/stores/ui.ts`，persist key `tmex-ui`），新增 `terminalFontSize:number=13`、`terminalLineHeight:number=1.2`、`terminalFontId:string='geist-mono'` 及三个 setter，三者都进 `partialize`。
   - 存 **font id**（manifest 主键）而非 CSS 字符串；CSS stack 在 apply 时由 id 派生：`${cssFamily}, NotoSansSymbols2Tmex, monospace`（符号兜底恒定）。
2. **字体产物与 manifest**
   - 源工具：`scripts/fonts/`（`fonts.config.ts` 真相源 + `build-fonts.ts` + 文档）。下载缓存 `scripts/fonts/.cache/`（gitignore）。
   - 产物：`apps/fe/public/fonts/generated/<id>/<id>-regular.woff2` `-bold.woff2`（入库）。默认 Geist 用既有扁平文件、不进 generated。
   - 生成物：`packages/shared/src/fonts/manifest.generated.ts` + `types.ts`（纯数据，浏览器安全，可进 bundle；**生成文件不可 lint**）。由 `build-fonts.ts` 扫描成功产物生成。
   - manifest 形状：
     ```ts
     interface FontManifestEntry {
       id: string;          // 'jetbrains-mono'
       displayName: string; // 'JetBrains Mono'
       cssFamily: string;   // 'JetBrainsMonoTmex'（@font-face 用的 family）
       bundled: boolean;    // true=有 generated woff2；Geist 默认走静态
       files?: { regular: string; bold: string }; // public 下的 URL 路径，bundled 时有
       isDefault?: boolean;
     }
     export const FONT_MANIFEST: FontManifestEntry[];
     export const DEFAULT_FONT_ID = 'geist-mono';
     ```
   - `fonts.config.ts` 列全 10 个 curated（含 Nerd Fonts 资产名、子目录/文件匹配、cssFamily、`useExisting` 标记给 Geist）；工具对每个尝试定位 Regular+Bold，缺 Bold → 跳过 + 计入跳过报告；不硬编码跳过清单（未来加字体自动复查）。
3. **懒加载 + 全应用传播**：新建 `apps/fe/src/lib/terminal-fonts.ts`：
   - `resolveFontStack(id): string` —— 由 manifest 派生 CSS stack。
   - `loadFontById(id, fontSize): Promise<void>` —— 非默认且未注入过则注入 `@font-face`（Regular 400 / Bold 700 指向 manifest.files），再 `document.fonts.load` 两字重；默认 Geist 已静态，直接 resolve。
   - 应用根挂一个 `useAppMonoFont()`：订阅 `terminalFontId`，变更（含初始持久化值）时 `loadFontById` 后 `document.documentElement.style.setProperty('--font-mono', resolveFontStack(id))`。所有现有 `font-mono` 用户零改动跟随。
4. **作用范围**：字体族→全局 `--font-mono`；字号/行高→仅终端。其它等宽处字号保持现状。
5. **预览**：新建 `TerminalPreview` 组件，内部 headless 控制器喂写死 ANSI（~10 行带色含中文代码块），读「当前未保存」的 fontSize/fontId/lineHeight，变更即重建控制器重渲。

## 任务清单

### A. 字体工具链（独立可先做）
- A1 `scripts/fonts/fonts.config.ts`：10 curated 配置（资产名/子目录/cssFamily/id/displayName/useExisting）。
- A2 `scripts/fonts/build-fonts.ts`：下载（pinned `NERD_FONTS_VERSION='v3.4.0'`，缓存）→ 解压定位 Mono Regular+Bold TTF/OTF → 缺 Bold 跳过+记录 → `wawoff2.compress` 串行转码 → 写 `apps/fe/public/fonts/generated/<id>/` → 扫描成功项生成 `packages/shared/src/fonts/manifest.generated.ts` + `types.ts` → 打印跳过清单。
- A3 `wawoff2` 加 devDependency；`.gitignore` 加 `scripts/fonts/.cache/`。
- A4 根 `package.json` 加 `build:fonts`（手动跑；woff2 入库，日常 build 不强制重跑）。
- A5 文档 `docs/fonts/2026061501-font-pipeline.md`：流程、如何加字体、跳过规则、为何 wawoff2。
- A6 跑一次 `build:fonts`，产出 6 字体 woff2 + manifest，记录跳过清单。

### B. 渲染层参数化（packages/ghostty-terminal）
- B1 `types.ts` `GhosttyTerminalInitOptions` 加 `lineHeight?: number`。
- B2 `terminal.ts`：`:323` 与 `:1492` 用 `this.options.lineHeight ?? LINE_HEIGHT`（LINE_HEIGHT 仍作默认常量）。
- B3 跑包内既有测试确认无回归。

### C. store + 设置 UI + i18n
- C1 `stores/ui.ts`：加 3 字段 + 3 setter + 默认值 + partialize（按验证给出的行号）。
- C2 i18n：`packages/shared/src/i18n/locales/{en_US,zh_CN,ja_JP}.json` 加 `settings.tabGroup.terminal`、`settings.terminalFontSize`、`settings.terminalLineHeight`、`settings.terminalFontFamily` 等 key → 跑 `bun run build:i18n` 重生成（生成文件不手改）。
- C3 `SettingsPage.tsx`：import `Monitor`；类型 union 加 `'terminal'`；6 个 selector；tabItems 加项；内容分支：字号 Input(8–24)、行高 Input(1–2 step0.1)、字体 `Select`（**选项来自 `FONT_MANIFEST` 动态 map**，仅 displayName 纯文本，无字样预览）+ 下方 `TerminalPreview`。

### D. 字体接线 + 懒加载 + 预览
- D1 `apps/fe/src/lib/terminal-fonts.ts`（resolveFontStack / loadFontById）。
- D2 `theme.ts`：`ensureTerminalFontLoaded(fontSize=13)` 参数化；`XTERM_FONT_FAMILY` 改由 resolveFontStack(default) 派生（或保留默认常量）；导出名整理。
- D3 `index.css`：`--font-mono` 可被运行时 `:root` 覆盖（保留默认值兜底）。
- D4 `useAppMonoFont()` 挂应用根，做 D1 的传播。
- D5 `Terminal.tsx`：读 store 的 fontSize/fontId/lineHeight，动态 config，`loadFontById` 后建控制器；font 设置进 `open` useEffect 依赖（变更重建）。
- D6 `TerminalPreview` 组件 + 写死 ANSI 常量（~10 行、含中文、多色）。

### E. 验证（自验，不甩给用户）
- E1 `bun run build:i18n`、`bun run build:fonts`、各包 typecheck/lint（**跳过生成文件**）通过。
- E2 仓库内临时实例（显式覆盖 app.env 变量，端口避 9883）起 dev，无头浏览器：进设置「终端」Tab，改字号/行高/字体，**截图**确认预览区与真实终端实时变化、全应用 `font-mono`（markdown 代码块等）跟随、懒加载生效（非默认字体网络只拉选中项）。
- E3 切换到跳过字体不应出现在列表；默认 Geist 首屏不额外拉网。
- E4 e2e（若有终端/设置相关）回归。

## 风险与注意

- **bundle 体积**：6 字体 × 2 字重 full woff2，每个约 0.5–2MB，合计可能 10–20MB 入 `apps/fe/public` 与 npm 包。已用懒加载把**运行时**成本压到「仅选中字体」；入包体积是一次性磁盘成本，自托管工具可接受。docs 注明。
- **生成文件**：manifest.generated.ts、i18n resources.ts/types.ts、woff2 —— 不可 lint/format，git status 出现属正常。
- **JetBrainsMono/ZedMono/Noto** 有多套（Ligatures/NoLigatures、Normal/Extended、宽度变体）：config 精确指定取哪一套的 Mono Regular/Bold，避免取错。
- **重建控制器开销**：字体设置变更才触发，非热路径，可接受；预览区同理。
- **不写时间估计**（按既定反馈）。

## 偏离与透明记录

- 工具从 `subset-font` 改为 `wawoff2`：实测 subset-font 对「不子集」会丢 14 字形，wawoff2 无损，且更轻。本意（纯 Bun/JS + 不子集）不变，实现更正确。
