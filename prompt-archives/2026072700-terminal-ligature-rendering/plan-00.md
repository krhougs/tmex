# 终端连字渲染 + 符号宽度约束 + ghostty 升级实施计划

日期：2026-07-27。工作 worktree：`.claude/worktrees/ghostty-font-ligature-research`（vendor 已 init）。
跨仓库任务：主要实施面在 vendor/tmex（ghostty-terminal / terminal-ui / stores / panels / shared-i18n），vibex 侧仅 host-ui-store 跟进。规划存本仓，tmex 侧实施时按其规则另建档（`vendor/tmex/prompt-archives/`）。

## 0. 背景与研究结论（自包含，供无上下文重启）

### 0.1 渲染架构事实

- tmex 终端 = ghostty wasm（`-Demit-lib-vt`，纯 VT 状态机，**不含 font 子系统**，见 ghostty `src/lib_vt.zig`）+ 自研 `CanvasRenderer`（`vendor/tmex/packages/ghostty-terminal/src/canvas-renderer.ts`）。
- 字形绘制是**逐 cell 单字符 `fillText`**（canvas-renderer.ts:455 全文件唯一一处）。浏览器 shaping 每次只见一个字符 → `calt` 连字**从未生效**。HarfBuzz 实测证实：Zed Mono 的 `=>` 整串 shape 时替换为两个各 500 advance 的"半边"字形（cluster 保留），单字符 shape 原样输出。
- tmex fe / vibex webapp / vibex native app 三个消费面**完全同源**：都经 `@tmex/panels` DeviceConsole → `@tmex/terminal-ui` Terminal.tsx → ghostty-terminal。vibex 无 fork，设置 UI 也共享 tmex 组件。

### 0.2 「Zed Mono 多余空格/文字重合」根因（实测数据）

- Zed Mono NerdFontMono（Iosevka 系 Term 排印，Nerd Fonts v3.4.0 打包，`bun run build:fonts` 无损转码不子集）：35090 个 glyph advance **全部 =500**（1 格），但 **1271 个直接映射字符的墨迹显著超出 advance**：
  - `→ ⇒ ↔ ↩ ⇥` 等箭头墨迹 ~958/500 ≈ 2 格 → 压到右邻字符（"文字重合"）；
  - `— ―` 墨迹整 1000；
  - `˄ ˅ ˯ ˰` 墨迹整体在 xMin=500..1000 —— 本格全空（"多余空格"）+ 墨迹全画进右邻格（两个症状同时出现）；
  - `※ ⑽…⒇` 等同理。
- 对照：Geist Mono 仅 90 个溢出 glyph（几乎全是 unmapped 连字组件），Fira Code 318。Zed Mono 量级独一份。
- Iosevka Term 的设计意图是"宽符号右邻留空格则溢出显示"，右邻有字就撞车。
- **用户看到的不是连字问题**：连字在现渲染架构下根本没生效。

### 0.3 ghostty 原生（zig 侧）的对照机制（我们要在 canvas 侧等价复刻的部分）

- 按 run shaping（run 不跨行；样式变化/选区断，`fi/fl/st` 白名单强制断；光标处断由 `font-shaping-break` 控制，默认开）——`src/font/shaper/run.zig:47-304`。
- ligature 只在起始列提交一个 glyph，墨迹自然溢出右邻 cell，无裁剪（`src/renderer/generic.zig:3021-3040`）。
- **glyph constraint**（`src/font/face.zig:143-493`）：
  - Unicode General_Category=S* 的符号（`→` 命中）→ `.fit`（等比只缩小到 cell 内）；
  - `constraintWidth`：右邻是空格 → 允许占 2 格（`src/renderer/cell.zig:253-293`）；
  - Nerd Font 图标专表（`nerd_font_attributes.zig`，font-patcher 生成）；box drawing/block 内建 sprite 自绘（tmex canvas 已等价实现 block element 自绘）。
- 连字开关：`font-feature = -calt, -liga, -dlig`；默认 feature 列表仅 `liga`，`calt` 靠 shaper 默认开。

### 0.4 浏览器可行性实验（Chromium + Playwright，已完成）

- **canvas `fillText` 整串绘制会触发 calt**：Zed Mono / Geist Mono / Fira Code 的 `=> -> != === <!-- <=> |>` 全部正确连字。
- **符号段整体 fillText、起点按段首 cell 网格定位**：连字完整出现；网格漂移 = |cellW − advance| × 段内位置。Zed(13.0 vs 13)、Fira(16 vs 16) 零漂移；Geist(15.6 vs 15.5) 每字符 0.1 css px，短段不可见。per-cell clip 分片绘制不伤连字墨迹（备选，见 §3.3）。
- Zed Mono 的 GSUB 有 Iosevka `NWID` feature：`→ ⇒ — ※ ↔` 均有窄版字形（备选的打包侧修复，本计划不采用，记档）。

### 0.5 ghostty 升级现状

- tmex 内 submodule `vendor/tmex/vendor/ghostty` pin `43a05dc`（2026-04-15，含 v1.3.1）；上游 origin/main `32e76d8`（2026-07-26）领先 789 commits，版本 1.3.2-dev，**要求 Zig 0.16.0**（build-wasm.sh 现 pin 0.15.2）。
- lib-vt 增量：unicode 宽度 API、颜色工具 API、render state 更新优化（锁持有 ↓2.7~11x）、selection gesture、compression；`include/ghostty/vt/terminal.h` +~477 行；wasm 构建上游持续维护。

## 1. 任务拆分（三件事，一个 tmex 分支串行完成）

1. **P1 ghostty 升级**：submodule → 上游 main 最新，Zig 0.16.0，重建 wasm，核对 bindings，全量回归。
2. **P2 符号宽度约束（方案 A）**：CanvasRenderer 恒开的 ghostty 式 `.fit` 约束，修「重合/多余空格」bug 本体。
3. **P3 真连字 + 设置开关**：符号段整体绘制实现真连字；新增 `terminalLigatures` 布尔设置（默认开），关闭 = 现状逐 cell；DOM 面（IME 预编辑、`--font-mono` 区域）同步 `font-variant-ligatures`。

依赖：P1 先行（避免 bindings 面改两次）；P2/P3 都在 canvas-renderer 前景遍，P2 先落（独立可验证），P3 叠加。

## 2. P1 ghostty 升级设计

- `vendor/tmex/vendor/ghostty` 指针 bump 到 origin/main tip（实施时取当日最新，研究时为 `32e76d8`）。ghostty 是 tmex 的 submodule、上游 ghostty-org/ghostty，**只改指针不 push 任何东西**。
- `packages/ghostty-terminal/scripts/build-wasm.sh`：`ZIG_VERSION` 0.15.2 → 0.16.0（确认 `zig build -Demit-lib-vt -Dtarget=wasm32-freestanding -Doptimize=ReleaseSmall` 命令面在新版仍成立）。
- **硬核对项**（升级最大风险）：`src/render-state.ts` / `src/ghostty-wasm.ts` 硬编码的枚举常量（`GHOSTTY_RENDER_STATE_DATA_*`、`GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_*`、`GHOSTTY_CELL_DATA_*` 等）与结构体字段名。上游若在枚举中间插值会**静默错位**。逐一 diff `include/ghostty/vt/*.h`（旧 pin ↔ 新 pin）核对数值；`scripts/ghostty-wasm.ts verify` + write-metadata 重跑。
- 上游 render state 优化（`446f80f4`）可能影响 dirty 语义 → 重点回归 dirty/局部重绘相关测试与 issue #45 系列测试。
- Gate：`packages/ghostty-terminal` 全部 bun test 绿 + fe dev 实例手工烟测（滚动、IME、选区、resize）。

## 3. P2 符号宽度约束设计（恒开，无设置项）

位置：`canvas-renderer.ts` `drawRowForeground` 的单字符绘制路径（块元素自绘分支之后）。

- **判定**：`cell.text` 非空、非 ASCII（首 codepoint > 0x7F）、非块元素（已有 sprite 自绘）。用 `measureText(cell.text)` 的 `actualBoundingBoxLeft/Right` 检测墨迹相对 [0, cellWidth]（wide cell 为 2 格）的溢出，结果按 `font|text` 缓存（Map，随 fontCache 一起清理）。
- **策略**（对齐 ghostty）：
  - 无显著溢出（阈值 ~5% cell 宽）→ 原样绘制；
  - 有溢出且**右邻 cell 为空**（无文字，且非 spacer-head）→ 放行溢出，最多 2 格（承接 Iosevka「宽符号+空格」设计意图；ghostty constraintWidth=2 同款）；左溢（如 `˄` xMin≥500 的病理字形）不适用放行，直接进缩放；
  - 否则 → `ctx.save()` + translate/scale 等比缩小到 cell 内水平居中（ghostty `.fit`：只缩小不放大）+ `fillText` + `restore()`。
- 组合字符（cell.codepoints>1 的 grapheme，墨迹天然跨格的 combining marks）**不约束**——ghostty 对 grapheme 同样不 constraint；判定条件加 `cell.codepoints.length === 1`。
- 约束不影响装饰线（underline 等按 cell 画不变）。
- 测试：约束判定纯函数抽出（输入 metrics+右邻状态 → 输出 {mode, scale, dx}）做单测；渲染整体靠 repro 页视觉验证 + 既有 canvas 测试回归。

## 4. P3 真连字设计

### 4.1 段（segment）判定 —— 在 drawRowForeground 内对 row.cells 扫描

- 候选字符集（静态，覆盖主流编程连字全部组成字符）：`! # $ % & * + - . / : ; < = > ? @ \ ^ _ | ~`（ASCII 符号；不含引号/括号/逗号/字母 —— 字母连字如 `www`、排版连字 `fi/fl/st` 明确不做，与 ghostty 的坏连字白名单断点方向一致）。
- 合段条件：同一行内连续 cell，每个 cell 单 codepoint ∈ 候选集、`widthKind==='narrow'`、非 invisible，且**可比样式一致**（bold/italic/faint/underline/strikethrough/overline/inverse 及解析后的前景色全部相同；bgColor 不参与——背景独立遍，对齐 ghostty `comparableStyle`）。
- 段长下限 2（单符号走 P2 路径）；**段长上限 8**：覆盖 `<!---`、`<==>` 等全部实际连字长度，`========` 类分隔线在 8 边界断开（连字字体对长重复串的 calt 形态在窗口边界断开无视觉损失），同时限制最坏漂移（§4.2）。
- **光标处不断段**（有意偏离 ghostty `font-shaping-break=cursor` 默认值）：tmex 光标是独立 canvas 层的底部细条、不反色不遮字，断段收益低；且断段会要求光标每次移动强制重绘新旧光标行（现架构光标移动不触发行重绘）。若实测可用性有问题，二期再补（届时需把新旧光标行并入重绘集）。
- 选区不断段：tmex 选区是独立半透明 overlay，不改前景色，无 ghostty 的反色断 run 需求。

### 4.2 段绘制

- 开关开启时：段整体一次 `fillText(segText, segStartX, baselineY)`，起点按段首 cell 网格坐标。段内字符落点由字体 advance 决定，漂移 = |deviceCellWidth − advance×dpr| × 位置；实验数据：Zed/Fira 0，Geist 0.1 css px/字符，cap 8 时最坏 <1px，可接受。
- 段内不做 P2 约束（候选集全为窄墨迹 ASCII 符号）。
- 备选（记档不实施）：per-cell clip 分片绘制（零漂移、O(k²)）或 offscreen canvas + drawImage；实验已证明与直接 fillText 视觉一致，仅当某字体衔接出现可见台阶时再启用。
- 关闭开关时：跳过段扫描，完全走现状逐 cell 路径（行为回到今天）。

### 4.3 设置项与链路（`terminalLigatures: boolean`，默认 `true`）

默认开的理由：用户选择连字字体（Zed/Fira/JetBrains/Geist 全部带 calt）即预期连字；关闭选项满足本任务原始诉求。

tmex 侧（9 处，两个前期 agent 已核对行号，实施时以当时代码为准）：
1. `packages/stores/src/ui.ts` — UIState 字段 + setter + 默认值 + **partialize 白名单**（漏加不持久化）+ merge；
2. `packages/panels/src/settings/terminal-settings-panel.tsx` — Switch 控件（带 data-testid）；
3. `packages/shared/src/i18n/locales/{zh_CN,en_US,ja_JP}.json` — `settings.terminal.*` 文案 + `bun run build:i18n`（生成文件勿手改勿 lint）；
4. `packages/terminal-ui/src/components/Terminal.tsx` — 读 store、传 `createTerminalController`、**effect 依赖数组**（变更需重建终端）；
5. `packages/terminal-ui/src/components/TerminalPreview.tsx` — 同上三处（预览与真实终端同渲染路径，天然所见即所得）;
6. `packages/ghostty-terminal/src/types.ts` — `GhosttyTerminalInitOptions` 新增可选布尔；
7. `packages/ghostty-terminal/src/terminal.ts` — 透传 CanvasRenderer；IME helper textarea（唯一 DOM 文本层）设 `font-variant-ligatures`；
8. `packages/ghostty-terminal/src/canvas-renderer.ts` — Options + 段扫描/绘制 + P2 约束；
9. `apps/fe/src/lib/fonts/useAppMonoFont.ts` + `apps/fe/src/index.css` — `--font-mono` 区域（markdown 代码块/code viewer）跟随开关写 `font-variant-ligatures`（这些 DOM 面连字本来就生效，开关要能关掉它们才自洽）。

vibex 侧（1 处硬性 + 测试）：
- `packages/workspace-runtime/src/host-ui-store.ts` — PersistedUIState 键联合 + 默认值 + setter + partialize（TS 编译强制，tmex 加字段后不改必红）；
- `packages/workspace-ui/src/hooks/use-app-mono-font.ts` — 同 fe 的 `--font-mono` 连字 CSS 跟随；
- 回归：`packages/workspace-runtime/src/runtime.test.ts`、`packages/platform-native/src/index.test.ts`、`packages/platform-browser/src/contract.test.ts` 中 `vibex:tmex-ui` 持久化断言按需补。

存储语义：与 fontId 同级，localStorage（zustand persist），**不进云同步**（`SYNCED_NAMESPACES` 不动），三端各自本地。

### 4.4 测试与验收

- 段切分器纯函数单测（候选集、样式断点、cap、grapheme/宽字符排除）——属长期行为，值得永久测试；
- P2 约束判定纯函数单测；
- 既有 ghostty-terminal 全套 bun test 回归（尤其 canvas/vcenter/issue45 系列）；
- 视觉验收：fe dev 实例（worktree 内临时实例，dev 端口 19663/19883，绝不碰生产 9883/`tmex` tmux session）分别用 Zed Mono / Geist / Fira 验证：① `=> -> != === <!--` 连字出现且网格对齐；② `x→y`、`p˄q`、`a—b` 不再重合；③ `→ `（右邻空格）保持 2 格宽箭头；④ 关闭开关后回到逐 cell、DOM 面连字同步关闭；⑤ IME 组字、选区、光标穿越连字段无异常；
- WebKit 验证：macOS Safari 打开 fe dev（canvas fillText calt 触发性在 WebKit 需实证；Chromium 已证）。native app 端因同源 webapp，webapp 过验即基本覆盖，App 侧抽查 iOS 模拟器。

## 5. 分支与提交编排

- tmex 侧：`scripts/vendor.sh branch <task>` 开 `vibex/terminal-ligature-rendering`（名称实施时定），commit 按 P1 / P2 / P3 分层，**commit message 中性开源语气**（不带 Vibe X 上下文）；push 走 `vendor.sh push --yes`，以 `vendor.sh check` 可达为准。
- vibex 侧：本 worktree 分支上先推 tmex 上游、再 commit gitlink 指针 + host-ui-store 改动。
- tmex 侧实施档：动手时在 `vendor/tmex/prompt-archives/` 按其规则另建（如 `2026072700-terminal-ligature-rendering`）。

## 6. 风险与开放问题

| # | 风险 | 应对 |
|---|---|---|
| R1 | ghostty 789 commits 枚举/ABI 静默错位 | 逐 diff include/ 头文件数值核对；verify:wasm；全测试回归（P1 Gate 不过不进 P2） |
| R2 | Zig 0.16 构建 wasm 产物行为差异 | smoke-compiled.ts + 全测试；产物 metadata 记录 zig 版本 |
| R3 | WebKit canvas fillText 不触发 calt（Chromium 已证，WebKit 未证） | P3 视觉验收含 Safari；若不触发，连字开关在 WebKit 降级为无连字（不影响 P2 修复），再评估 per-cell clip + CSS font-feature 方案 |
| R4 | 段绘制与脏行局部重绘交互（段跨脏行边界） | 段完全在行内、重绘按整行进行（现有 ±1 邻行机制不变），无跨行段；测试覆盖 |
| R5 | 光标不断段的可用性（光标停在连字中间） | 有意取舍，底条光标位置本身可见；实测反馈差再做二期（新旧光标行入重绘集） |
| R6 | measureText 约束判定的性能 | 按 font|char 缓存；溢出字符占比极低；段扫描 O(cols)/行 |
| R7 | 默认开启连字改变全体用户观感 | 产品预期内（连字字体的设计意图）；设置一键可关；发布说明标注 |

备选方案记档（不实施）：打包侧烘焙 NWID 窄字形（零运行时开销但改字体原味、仅 Zed Mono、个别字符无变体）；per-cell clip 分片绘制（零漂移备胎）。
