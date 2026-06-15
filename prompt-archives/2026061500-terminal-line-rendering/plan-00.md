# 终端渲染两个独立问题：根因与修复方案

分支：`fix/terminal-line-rendering`（worktree，从 `main` bba586b 起）。

## 背景

终端为自研 canvas 渲染器（`packages/ghostty-terminal`，ghostty WASM 解析 VT + canvas 自绘）。
用户报告两个**互相独立**的渲染问题，要求找独立根因、勿强改渲染参数糊弄：

1. 行高未被 enforce，不同平台文字行高不一致。
2. 字符垂直方向被截断（`f y g` 等升/降部超出 cell 背景块的部分被掐头去尾）。

注意：`prompt-archives/2026061408-terminal-text-vcenter` 是上一轮 issue #17 的「文字垂直居中」改动，
本轮问题 2 正是那轮引入的居中算法仍不正确所致（它用 em-box=fontSize 当字形盒，忽略字体真实
ascent/descent）。

## 证据（无头浏览器实测，evidence.mjs，Chromium + WebKit，dpr=2，13px monospace）

```
                 Chromium    WebKit
#1 inline span     15.594      15.000   ← updateCellDimensions 现行测量值（round 后 16 vs 15）
   computed 1.2*13 15.600      15.600   ← 真正想 enforce 的高度
#2 font bbox sum   30.00       30.00    （ascent 24 + descent 6, device px）
   现行居中 ink     6..28       9..31    ← WebKit 降部抵到 cell 末行（clip）
```

## 根因

### 问题 1 —— 行高来自 DOM 测量，跨引擎不一致（`terminal.ts: updateCellDimensions`）

cell 高度取自 `probe.getBoundingClientRect().height`。inline 元素的 bounding rect 高度在不同
排版引擎语义不同：Chromium 约等于 line box（≈line-height×em=15.6→16），WebKit 返回字体
content-area（15.0→15）。**同一字体、同一 line-height，跨引擎差 1px**，跨 Windows/Linux 更甚。
即「行高没被 enforce」——它本应由 `line-height × fontSize` 由规范唯一确定，却退化成依赖引擎实现的
测量值。

**修复**：cell 高度改为确定式计算 `round(fontSize × LINE_HEIGHT × dpr)/dpr`，不再 DOM 测量。
宽度（字符 advance，确属字体相关）仍保留测量。

### 问题 2 —— canvas 文字居中用 em-box 当字形盒，忽略真实字体度量（`canvas-renderer.ts`）

`textOffsetY = round((deviceCellHeight − deviceFontSize)/2)`，配合 `textBaseline='top'`。
其中 `deviceFontSize = fontSize × dpr` 是 em 大小，**不是**字形真实包围盒。实测字体 bbox
（ascent+descent=30 设备像素）大于 deviceFontSize（26），降部被推到 cell 底沿之外；逐行
`clearRect` 的下一行清除会擦掉溢出的降部 → `f y g` 掐尾。WebKit 上直接抵到末行像素。

**修复**：用 `measureText().fontBoundingBoxAscent/Descent` 取真实字形盒，按真实盒在 cell 内垂直
居中，`textBaseline='alphabetic'`，baseline = `topGap + ascent`，`topGap = round((cellH − (ascent+descent))/2)`。
数学上保证 `[topGap, topGap+ascent+descent] ⊆ [0, cellH]`，升降部都不溢出，且用各引擎自报度量，
跨平台自洽。装饰线（下/上划线、删除线）随真实字形盒走。

## 两问题独立性

- 问题 1 在布局层（cell 高度测量，`terminal.ts`），决定网格/行高。
- 问题 2 在渲染层（cell 内文字垂直定位，`canvas-renderer.ts`），决定字形是否被裁。
- 只修 1 不解决降部裁切；只修 2 不解决跨平台行高差异。互不覆盖。

## 任务清单

- [ ] `terminal.ts`：抽 `LINE_HEIGHT=1.2` 常量；`updateCellDimensions` 高度改确定式计算。
- [ ] `canvas-renderer.ts`：`resize()` 测真实字体度量，算 `textTopGap`/`baselineY`；`drawRow`
      改 `textBaseline='alphabetic'` + baseline 绘制；装饰线随真实字形盒。
- [ ] 更新/新增单测（vcenter 测试需为 FakeCtx 补 `measureText`）。
- [ ] evidence.mjs 复测两引擎确认两问题均消除。
- [ ] 包内 `bun test` 全绿。

## 验收标准（用户手动验收）

1. 跨平台（至少 Chrome/Safari）同一字号行高一致。
2. `f y g j p q` 等升/降部完整不被裁。
3. 块元素无缝、装饰线位置正确（不回归 #17）。
