# Issue #17 终端渲染 bug：文字未垂直居中

## Context（背景）

GitHub issue #17（标签 `confirmed`）：终端里每个字符被画在 cell（方格）的**最顶端**，而不是 cell 垂直方向的中央。报告者怀疑是行高没配好，或之前「修复空隙问题」带来的像素不对齐。

**根因（已读码确认）**：渲染器是自研 Canvas 2D 渲染器 `packages/ghostty-terminal/src/canvas-renderer.ts`（非 xterm.js）。
- `resize()` 里 `context.textBaseline = 'top'`（line 234）。
- `drawRow()` 里 `this.mainContext.fillText(cell.text, x, y)`（line 301），`y = row.y * deviceCellHeight` 是 cell 的**顶边**。
- cell 高 = `fontSize × 1.2`（line-height 1.2，来自 `terminal.ts:1434` 的测量探针）≈ 15.6px，而字形 em-box 仅 `fontSize`（13px）。`textBaseline='top'` 下，多出的 ~0.2em leading 全落在字形**下方** → 文字贴顶。

**关于报告者的「空隙修复」假设**：核对过 gap-fix commit `a1da752`，它只改了像素吸附（`setTransform(dpr…)` → `setTransform(1…)`、cell 吸附到整数设备像素），**没动文字 Y 定位**——`fillText(text, x, y)` + `textBaseline='top'` 早于该 commit 就存在。所以这是**一直存在**的缺失垂直居中，吸附只是让它更明显。块元素自绘、光标、选区都是整 cell 锚定，不受影响。

**决策（已与用户确认）**：
- 范围：文字垂直居中（核心）+ 顺带校准装饰线（下划线/删除线/上划线）与光标。
- 验收：**我自己跑无头浏览器截图验收**（用户已要求「这个东西你可以自己测」），用 `apps/fe` 现成 Playwright e2e 设施。
- 在**新 worktree** 中进行；遵循「先存档，再干活」。

## 实施步骤

### 1. 起新 worktree + 存档（先存档，再干活）
- 用 `EnterWorktree`（或 `git worktree add`）从 `main` 新建 worktree，分支名 `fix/issue-17-terminal-text-vcenter`。
- 在该 worktree 内创建 `prompt-archives/2026061408-terminal-text-vcenter/`（编号续上现有 `…07`），写入：
  - `plan-prompt.md`：本次用户 prompt（含「在新 worktree 处理 issue #17、先确认需求」及两个澄清答复）。
  - `plan-00.md`：本计划内容。
  - （完成后）`plan-00-result.md`：执行结果总结。

### 2. 核心修复：文字垂直居中
文件：`packages/ghostty-terminal/src/canvas-renderer.ts`

- 在 `resize()` 中新增并缓存两个字段（避免每 cell 重算）：
  - `deviceFontSize = this.fontSize * this.dpr`（同时让 `resolveFont()` 复用此字段）。
  - `textOffsetY = Math.max(0, Math.round((this.deviceCellHeight - deviceFontSize) / 2))` —— 把多出的 leading 上下均分。
- `drawRow()` 第 301 行改为 `this.mainContext.fillText(cell.text, x, y + this.textOffsetY)`。
- 结果：字形 em-box 落在 `[y+textOffsetY, y+textOffsetY+deviceFontSize]`，垂直中心 = `y + deviceCellHeight/2`。

### 3. 校准装饰线（drawRow 内，line 304–329）
以居中后字形盒为基准（`lineThickness = Math.max(1, Math.round(dpr))`，结果都 clamp 在 cell 内）：
- **下划线**（line 304-311）：从 cell 底 `y + deviceCellHeight - 2·lineThickness` 改到紧贴字形底 `y + textOffsetY + deviceFontSize - lineThickness`（clamp ≤ `y + deviceCellHeight - lineThickness`）。
- **上划线**（line 322-329）：从 cell 顶 `y + lineThickness` 改到紧贴字形顶 `y + textOffsetY`。
- **删除线**（line 313-320）：从 `0.55·deviceCellHeight` 改到字形几何中线 `Math.round(y + textOffsetY + deviceFontSize/2)`（居中后即 cell 垂直中点）。

### 4. 光标审查（drawCursor，line 397-443）
渲染器固定画底部下划线光标。下划线光标按惯例**整 cell 底部锚定**（xterm/iTerm 等同此），是 cell 指示物而非字形装饰，**保持现状不动**，仅在 result 文档记录「已审查、有意保留 cell 底锚定」。若用户目测后希望与正文下划线对齐，再单独调整（一行改动）。

## 关键文件
- `packages/ghostty-terminal/src/canvas-renderer.ts` —— 唯一代码改动点（`resize` / `drawRow` / `resolveFont`）。
- 只读参考：`packages/ghostty-terminal/src/terminal.ts:1425-1449`（cell 测量、line-height 1.2）、`apps/fe/src/components/terminal/Terminal.tsx:38-42`（fontSize=13）。

## 验收（我自己完成）
1. **编译/静态**：`cd` 到 worktree，跑 `packages/ghostty-terminal` 的 typecheck/构建确保编译通过；按 AGENTS.md 跑 lint（**跳过生成文件**）确认无新增告警。
2. **无头浏览器视觉验收**：复用 `apps/fe` 的 Playwright e2e 设施（`bun run test:e2e` → `scripts/run-e2e.ts` 自动选空闲端口、`globalSetup` 断言连的是 `NODE_ENV=test` 实例，**硬隔离 9883 生产**；参考端口 9885/9665）。
   - 新增一条聚焦 spec（参考现有 `tests/terminal-viewport-render.spec.ts`、`tests/terminal-selection-canvas.spec.ts` 的开终端/取 canvas 套路）：写入已知字符 → 用 `getImageData` 读某一 cell 列的前景像素 → 断言字形上边距 ≈ 下边距（垂直居中），并对比修复前的「贴顶」失败基线。
   - 同时 `page.screenshot` 截图，我自己 Read 该 PNG 目视确认：文字居 cell 垂直中央、下划线贴字底、上划线贴字顶、删除线穿字中、块元素/色块图无新增缝隙、光标正常。
3. 把截图与 spec 结果记入 `plan-00-result.md`；提示用户该改动需正式发版 + `npx tmex-cli@<version> upgrade` 才进生产（由用户执行）。

## 风险
- em-box ≈ fontSize 是近似，个别字体 ascent/descent 偏移可能使光学居中略有偏差；如目测明显偏移，可改用 `measureText` 的 `fontBoundingBoxAscent/Descent` 做精确光学居中（备选，非首选）。
- 装饰线很少触发，回归面小；改动集中在单文件单函数。
