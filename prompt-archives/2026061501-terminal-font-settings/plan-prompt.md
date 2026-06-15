# Terminal 字体设置（issue #14）— Prompt 存档

## 背景

- issue #14「字体相关体验优化」（来自 #12），label：enhancement / confirmed。
- 同批调研的 issue #23（复杂 Unicode 渲染，如阿拉伯文）经分析为终端「固定等宽网格」模型的根本限制：渲染是自研 Canvas2D 逐 cell `fillText`，切断了跨 cell 的连写整形与 BiDi 重排；ghostty 本体亦不支持。已在 #23 贴技术原因评论，并将其标记从「可动工」改为新建的「待讨论」label，暂不做。
- 本项目 Bun-only，前端 vite + @base-ui/react + zustand + tailwind4；终端用自研 `packages/ghostty-terminal`（ghostty-vt WASM 状态机 + 自研 Canvas2D 渲染器），非 ghostty GPU 渲染器。

## 需求（issue #14 原文要点）

- 设置新增「终端」Tab：调字号（现写死 13px）、行高、选字体。
- 字体选择全应用统一（所有等宽处读同一设置）；字号/行高仅终端。
- 打包精选 Nerd Fonts（挑 Normal+Bold 两字重，转 woff2）；动态生成 manifest（非手写）；选择器**不做字样预览**（避免流量爆炸）；选择器下方有**终端组件实时渲染的预览区**（写死 ~10 行带色含中文代码块）。
- 缺字重的字体先跳过，给出跳过清单。字体处理流程写成标准化工具代码 + 文档。
- 精选清单：3270, BigBlueTerm, BlexMono, DepartureMono, FiraCode, Noto Sans Mono, Geist Mono（现用）, JetBrainsMono, ZedMono, VictorMono。

## 已定决策（brainstorming 结论）

1. **不子集，原样转 woff2**（保留全字形含 Nerd 图标，零裁剪风险）。
2. **纯 Bun/JS 工具链**（subset-font / harfbuzz-wasm，免 Python）。
3. **localStorage**（zustand persist），每设备独立。
4. 字体族 → 全局 `--font-mono`；字号/行高 → 仅终端。
5. 懒加载：默认 GeistMono 静态 `@font-face`；选非默认时运行时注入 `@font-face` + `FontFaceSet.load` 两字重再 apply。
6. 预览区 = 只读 headless ghostty 实例喂写死 ANSI 彩色代码块。
7. 产物布局：`scripts/fonts/`（工具 + config + 文档）、`apps/fe/public/fonts/<family>/`（woff2 入库）、`packages/shared/src/fonts/manifest.generated.ts`（生成物，可进前端 bundle）。
8. 构建链：根 `package.json` 加 `build:fonts`（放 `build:i18n` 后、`build:fe` 前；woff2 已入库，日常 build 不必重跑下载，仅更新字体时手动跑）。生成文件不可 lint。

## 对话 prompt 流水

1. `调研字体渲染相关的issue #23 #14`
2. 决策（AskUserQuestion）：只做 #14；#23 回复不做的原因并把 confirmed 标记改为待讨论；先不管 #23。
3. 决策（AskUserQuestion）：不子集原样转 woff2；纯 Bun/JS（subset-font）；localStorage 持久化。
4. `ok`（确认设计四块：工具链与产物布局 / 数据流与持久化 / 设置 UI 与预览 / 渲染层参数化）
5. `/effort ultracode`（本会话切 ultracode：xhigh + workflow 编排）
