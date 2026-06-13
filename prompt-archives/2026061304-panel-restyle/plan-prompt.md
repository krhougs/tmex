# Prompt 存档

## 初始 prompt

> 参考终端区域的样式，重新设计 Sidebar Tab、Agent Chat 和 Pane List 的整体样式

## 澄清后的方向（brainstorming 收敛）

- **视觉方向**：统一"浮动圆角面板"——三个区域都向终端壳的 `rounded-xl 圆角面板 + 自有背景 + 面板间留白` 语言靠拢。
- **改动范围**：可微调结构（容器层级/间距/分组包裹），但不改交互逻辑和数据流。
- **主题适配**：只保证明暗两套，全用语义 token（bg-card/bg-muted/border/primary 等）自动适配。

## 后续追加 prompt

> Tab 整体还是需要有一个非常轻的描边，和现有 device tree 最外层差不多

- → Sidebar Tab 的 `TabsList` 保留一道很轻的描边（`rounded-xl border border-border/60`），和 device 段最外层 `rounded-lg border` 的描边风格统一。
