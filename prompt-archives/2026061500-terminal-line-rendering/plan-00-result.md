# 执行结果 —— 终端两个独立渲染问题

分支：`fix/terminal-line-rendering`（worktree，从 `main` bba586b 起）。

## 两个独立根因（已实测确认，非参数糊弄）

### 问题 1：行高未 enforce，跨平台不一致
根因在布局层 `terminal.ts: updateCellDimensions`：cell 高度取自 `probe.getBoundingClientRect().height`。
inline 元素的 bounding rect 高度在不同排版引擎语义不同——实测 13px monospace / line-height 1.2：
**Chromium 15.594 → round 16，WebKit 15.000 → round 15**，同字体同行高跨引擎差 1px。
行高本应由 `line-height × fontSize` 规范唯一确定，却退化成依赖引擎实现的测量值。

### 问题 2：字形垂直被截（f y g 掐尾）
根因在渲染层 `canvas-renderer.ts`：上一轮 #17 的居中算法用 `textOffsetY = (deviceCellHeight −
deviceFontSize)/2` 配 `textBaseline='top'`，其中 `deviceFontSize = fontSize×dpr` 是 em 大小，**不是**
字形真实包围盒。实测字体 bbox（ascent+descent=30 设备像素）> deviceFontSize（26），降部被推到 cell
底沿之外，逐行 `clearRect` 的下一行清除把溢出降部擦掉。WebKit 上降部直接抵到 cell 末像素行。

两问题分处布局层 / 渲染层，互不覆盖：只修 1 不解降部裁切；只修 2 不解跨平台行高差。

## 补充需求：允许字形溢出相邻 cell（兼容奇怪 Unicode）
即便居中正确，渲染器「逐行 clearRect + 不透明背景铺底」会擦掉任何溢入相邻 cell 的字形墨迹
（组合记号 / Zalgo / 深降部非拉丁文字）。需让这类墨迹可越界而不被裁。

## 改动

### `terminal.ts`
- 新增常量 `LINE_HEIGHT = 1.2`，CSS root / cell 计算共用，消除散落的 `'1.2'`。
- `updateCellDimensions`：高度改确定式 `fontSize × LINE_HEIGHT`，不再 DOM 测量（宽度仍测量，
  advance 确属字体相关）。→ 修问题 1，跨引擎行高一致。

### `canvas-renderer.ts`
- `resize()`：用 `measureText('Mg|qyÅ').fontBoundingBoxAscent/Descent` 取真实字形盒，算
  `textTopGap`、`textBaselineY`、`glyphBoxHeight`；无 fontBoundingBox 的极端环境按 0.8/0.2 em 兜底。
- `drawRow*`：`textBaseline` 改 `alphabetic`，按 `textBaselineY` 绘制，字形盒在 cell 内整体居中
  （数学保证 `[topGap, topGap+ascent+descent] ⊆ [0, cellH]`）。→ 修问题 2。
- 装饰线随真实字形盒走（下划线贴字底、上划线贴字顶、删除线穿字形中线）。
- `drawRow` 拆为 `drawRowBackground` / `drawRowForeground`，`render()` 改两遍渲染（先铺所有目标行
  背景、再画所有前景），并把部分重绘的重绘集扩到脏行上下邻行（±1）。→ 允许字形溢出相邻 cell
  而不被邻 cell 背景擦掉；`lastDrawnRows` 仍只记真正脏行。

## 验证（自测完成）

1. **包内单测**：`bun test`（packages/ghostty-terminal）—— **63 pass / 0 fail**（原 61 + 新 2 溢出回归）。
   - vcenter 测试改为按真实度量断言「字形盒完整含于 cell（不裁）」「baseline 居中」「装饰线随盒」。
   - FakeCtx / FakeCanvasContext2D 补 `measureText`；wheel 测试随确定式 cell 高（16）调整阈值。
   - 新增「两遍渲染：所有背景先于任一 fillText」「部分重绘连带重绘上下邻行」回归。
2. **跨引擎实测**（`verify.mjs`，真实 CanvasRenderer 打进 Chromium + WebKit，dpr=2）：
   - 问题 1：cell 高跨引擎一致（均 32 设备像素）—— PASS。
   - 问题 2：`gyjpqf / MWAÅ / gjpqy / flkb` 墨迹均不触 cell 首/末像素行（touchTop/Bottom 全 false）
     —— 无升/降部裁切，PASS。
3. **可视化截图**（`terminal-line-rendering.png`，Chromium dpr=2 + 红色 cell 网格线）：
   升/降部居中完整；下划线贴字底；CJK 渲染正常；**Zalgo 组合记号（n̈̃）向上溢出相邻 cell 而未被裁**。
4. **类型**：`tsc --noEmit` 改动文件 0 错（仅 worktree 缺 node_modules 导致的 `bun:test`/`Bun`
   解析报错，与改动无关）。
5. **Biome**：改动文件 biome 错误数与 `main` baseline 完全一致（canvas-renderer 1 / terminal 2 /
   terminal.canvas.test 4 —— 均为 lineWidth 100 的既有文件级格式偏差，#17 即已存在、项目容忍）；
   新增的 vcenter 测试块 biome 全绿。**未对生成文件跑 lint，未 reformat 无关代码。**

## 注意事项 / 待用户手动验收
- 实测用浏览器默认 monospace；生产实际字体为 `GeistMonoTmex`，最终行高/裁切/溢出请在 app 内核对。
- 改动属前端渲染器，进生产常驻实例需正式发版 + `npx tmex-cli@<version> upgrade`（用户自行执行）。
  本次全程未触碰 9883 生产服务与安装目录。
- 部分重绘的溢出恢复以 ±1 cell 为界；超过 1 cell 的极端 Zalgo 在增量更新时可能短暂残缺，下次
  全屏重绘（滚动 / resize / 历史加载）自愈。如需无界溢出可改全屏两遍重绘，但会放弃脏行优化。
- 未 commit、未开 PR（按规则等用户指示）。
