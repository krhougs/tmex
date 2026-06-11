# 终端选区列空间统一修复 — 执行结果

## 背景

ghostty-terminal 引擎的两个选择/复制问题：

1. 选择高亮区域长度/位置与实际文字不符（含宽字符的行尤其明显，越往右偏越多）；
2. 复制出来的内容包含大量无意义的行尾空格。

## 根因

`render-state.ts` 的 `buildRowText` 生成行文本时：

- 跳过宽字符的 spacer-tail 列 → `row.text` 的字符串索引 ≠ 屏幕列；
- 未写过的空 cell 一律补空格 → 每行文本被填满到整屏宽。

而 selection 链路三处坐标系混用：`hitTest` 产出**屏幕列**（像素/cellWidth），`selection-model` 把它当**字符串索引**做 clamp/slice/expand，`drawSelection` 又把选区 rect 的 x/width 当**屏幕列**乘 cellWidth 绘制。结果：

- 含 CJK/emoji 的行每个宽字符让选区错 1 列（症状 1）；
- 行选/跨行复制带上整屏宽的 padding 空格，叠加历史回放 `capture-pane -N` 写入的真实行尾空格（症状 2）。

注意 `-N` 不能去掉：2026-04-17 的 `6aa642c` 为保留带 SGR 背景的行尾色块（vim 状态栏、opencode 面板）有意引入，tmux trim 时不区分有无样式。

## 修复

选区全程统一到**屏幕列空间**，序列化时再转文本（`packages/ghostty-terminal/src/selection-model.ts` 重写）：

- 新增 `SelectionLineModel { colChars, contentCols }`：每屏幕列一个条目，宽字符主列存完整字符（grapheme 可含多个 UTF-16 unit），spacer-tail 列为空串；`contentCols` 为行尾空白（空 cell、空格、spacer）裁剪后的内容列数；
- `buildLineModel(cells)` 从渲染 cells 构建；`lineModelFromText(text)` 供测试/简单场景；
- 锚点/焦点列向左吸附宽字符主列（`snapColumn`），高亮 rect 末列向右扩展覆盖 spacer（`expandColAcrossSpacers`），选中半个宽字符等于选中整个；
- 双击选词按"列字符"判定（spacer 列归属主列），三击行选止于 `contentCols`；
- 序列化时每行段裁剪到 `contentCols`（同时消掉 padding 空格与 `-N` 真实空格，与 iTerm2/Ghostty 本体的 trim trailing whitespace 惯例一致），行内空格保留；
- `terminal.ts`：`lineCache` 改存 `SelectionLineModel`，`getLineText` → `getLineModel`，五处调用点替换；`buildRowText`/`row.text`（buffer 探针、E2E 依赖）保持不动。

## 改动文件

- `packages/ghostty-terminal/src/selection-model.ts`（重写为列空间模型）
- `packages/ghostty-terminal/src/selection-model.test.ts`（新增，覆盖宽字符、spacer 吸附、行尾 trim、跨行）
- `packages/ghostty-terminal/src/terminal.ts`（lineCache/调用点）
- `packages/ghostty-terminal/src/terminal.canvas.test.ts`（SelectionModel 用例适配 `lineModelFromText`）

## 验证

- `bun test` ghostty-terminal 包：34 全过；fe 单测 23 全过；
- e2e（9885/9665，`env -u NODE_ENV`）：`terminal-selection-canvas` + `terminal-clipboard` 7/7 全过（含 memory 标记的既有 flaky :220 与 autoscroll 用例）；`mobile-terminal-interactions` 6/6 全过（长按选词 + toolbar 复制）；
- biome 新文件无问题。

## 行为变化说明

- 选区完全落在空白区域时序列化为空串，SelectionToolbar 不再弹出（此前会复制到一串空格），属合理改善；
- 高亮仍跟随拖拽位置（可亮到行尾空白区），仅复制时裁剪行尾空白。

## 追加：软换行（wrap）复制不插换行（同日第二轮）

用户反馈：被软换行的长行复制时不应插入换行符。两层修复：

1. **前端**（selection-model）：`SelectionLineModel` 增加 `wrappedToNext`（来自 ghostty row 的 `wrap` 标志，语义见 vendor/ghostty `page.zig` Row 注释：true 表示下一行首 cell 是本行延续）。序列化时 wrapped 行与下一行直接拼接、不插 `\n`，且不裁剪行尾空格（wrap 点的空格属于逻辑行内容）。同时把 spacer-tail 改用 `null` 表示、spacer-head 用空串（wrap 行尾的宽字符占位不再产生多余空格）。
2. **后端**（capture）：历史回放的行原本不带 wrap 标志（capture-pane 按屏幕行输出硬换行）。给两端四处 capture 加 `-J`（join wrapped lines）：逻辑行整行输出，前端按相同列宽重新自然 wrap，软换行标志在回放终端中重建。实测确认 `-J -e -N` 组合下带 SGR 背景的行尾色块仍完整保留（不回归 `6aa642c` 修的 TUI 色块问题），且 `-J` 会裁剪无样式行尾空白（进一步减少 `-N` 空格进入 buffer）、回放内容在 resize 时可正确 reflow。

验证：tmux pane 回放实测（长行 wrap 场景光标/屏幕一致、回放 pane 中 `-J` 可重新 join 证明 wrap 标志重建）；ghostty-terminal 38 个单测全过（新增 wrap 连接、wrap 行尾空格保留、spacer-head 不产生多余字符等 4 个用例）；gateway 107 个单测全过；e2e `ws-borsh-history`/`ws-borsh-switch-barrier`/`terminal-selection-canvas`/`terminal-clipboard`/`mobile-terminal-interactions` 全过。

## 已知限制

- 三击行选仍选中单个屏幕行而非整个逻辑行（复制时不带换行，但不会自动扩展到 wrap 的其余部分）；
- `lineCache` 改存数组后每行内存开销增大（与原字符串相比约 4 倍），10k 行 scrollback 满载时约数十 MB，量级可接受；如成问题可改紧凑结构。
