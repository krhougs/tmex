# 执行结果：终端手机端键盘行为优化（issue #27）

分支：`worktree-feat+issue-27-mobile-keyboard-behavior`（未提交）。

## 已完成

三种键盘避让模式 + 右上角设置入口 + 底部 Sheet + localStorage 持久化，默认 `follow`（光标对齐），全部按计划落地。

### 改动文件

新增：
- `apps/fe/src/hooks/use-keyboard-avoidance.ts`：按 mode 分发避让策略（transform/height），follow 模式键盘打开期间 RAF 跟随光标，读 DOM 实际 transform 回算自然坐标保证收敛不抖。
- `apps/fe/src/utils/keyboard-cursor-bridge.ts`：聚焦终端的光标矩形 getter 单例桥。
- `apps/fe/src/components/settings/keyboard-behavior-sheet.tsx`：底部 Sheet（大屏居中限宽），三卡片即点即生效。
- `apps/fe/tests/keyboard-behavior-settings.spec.ts`：入口可见 + Sheet 选择 + 持久化 + 大屏居中（含截图）。
- `docs/terminal/2026061501-mobile-keyboard-behavior.md`：设计文档。

修改：
- `apps/fe/src/utils/virtualKeyboard.ts`(+`.test.ts`)：`computeCursorFollowOffset` 纯函数 + 6 个边界单测。
- `apps/fe/src/stores/ui.ts`：`keyboardBehaviorMode` 字段 + setter + partialize，默认 `follow`。
- `apps/fe/src/main.tsx`：`MainInset` 消费新 hook，按 strategy 应用 transform/height。
- `apps/fe/src/pages/DevicePage.tsx`：`PageActions` 加 `Settings2` 入口 + 渲染 Sheet。
- `apps/fe/src/components/terminal/Terminal.tsx`：instance 就绪时注册光标 getter。
- `packages/ghostty-terminal/src/terminal.ts`：render() 缓存 `lastCursor` + 新增 `getCursorViewportRect()`（聚焦判定，复用持久 renderState）。
- `packages/ghostty-terminal/src/types.ts` + `index.ts`：`GhosttyCursorViewportRect` 类型 + 接口方法。
- `packages/shared/src/i18n/locales/{en_US,zh_CN,ja_JP}.json` + 生成的 `resources.ts`/`types.ts`（`bun run build:i18n`）。

删除：
- `apps/fe/src/hooks/use-virtual-keyboard-offset.ts`：逻辑已并入新 hook，移除死代码。

## 验证

- `bun test`：virtualKeyboard 13（含 6 新）、ghostty-terminal 59、fe src 42 全过。
- `tsc`：fe、ghostty-terminal 类型检查通过。
- `biome`：新增/改动代码 0 新增错误（terminal.ts 的 10 处、main.tsx/DevicePage.tsx 的 2 处 useExhaustiveDependencies 均为 base 既有，未触碰）。
- e2e（`bun run --filter @tmex/fe test:e2e`）：
  - `mobile-keyboard-avoidance.spec.ts` 3 模式全过：lift 满抬 -320 无 resize；follow 空 shell 抬升 <120（修复看不见输入）无 resize；resize 主高度收缩 >200 且触发 resize 帧。
  - `keyboard-behavior-settings.spec.ts`：大屏入口可见、Sheet 选择即时生效 + 持久化、居中限宽。
  - 回归：23 个 terminal-* / mobile-terminal-* e2e 全过。
- 视觉自验：大屏截图确认底部 Sheet 居中限宽、默认 follow 选中、文案清晰、入口图标可见。

## 后续迭代：follow 模式快捷键栏浮动

用户反馈 follow 模式下那排快捷键栏被键盘盖住，要求浮到键盘正上方（不改光标抬升量）。

- `use-keyboard-avoidance.ts`：follow + 终端聚焦时写 CSS 变量 `--tmex-kb-shortcut-lift = inset - offset`；光标目标线 margin 计入快捷键栏高度（量 `.terminal-shortcuts-strip` offsetHeight），避免光标被浮条遮挡；其余分支/cleanup 复位。
- `DevicePage.tsx`：direct 快捷键栏包 `.kb-floating-shortcuts` 容器（终端背景色）。
- `index.css`：`.kb-floating-shortcuts` 用变量 `translateY` 浮动 + `z-index`；transform 不脱流，终端 canvas 高度不变、不触发 resize。
- 验证：follow e2e 加断言（快捷键栏底沿贴键盘顶、收起后复位），连跑 3 次稳定；截图确认空 shell 下快捷键栏浮键盘上方、与顶部光标不重叠；27 个 keyboard/terminal e2e 全过无回归。

## 后续修复：resize 模式终端高度坍缩

用户反馈「inner height 缩到 20px」。系统化调试（量三模式各 inset 下终端 canvas 高度）确认：lift/follow 终端高度恒定不变；**仅 resize 模式** `<main>` 高度 = `innerHeight - inset`，键盘越高终端越小，固定 UI 开销（header≈64 + 快捷键栏 52 ≈ 116px）吃掉后，键盘很高时终端 canvas 被压到 13px→0（kb=650 实测 termContainer=13px）。

- 修复 `use-keyboard-avoidance.ts` resize 分支：可用高度 `innerHeight - inset < MIN_RESIZE_AVAILABLE_PX(200)` 时退化为整页上移（transform），保住终端可用高度，不再被压没。
- 验证：resize e2e 加退化断言（键盘 640 → transform 非 none + canvas >200px）；3 模式 e2e 全过。

## 后续修复：浮动快捷键栏遮挡光标

用户反馈「浮上来的按钮会挡住输入光标」。诊断（e2e 量 strip rect + 埋点 getCursorViewportRect）确认两层根因：
1. `shortcutLift = inset - offset` 公式漏算终端底部 padding（≈12px），快捷键栏底沿停在键盘顶上方 12px、没精确贴键盘顶；而光标 margin 按「贴键盘顶」算，于是光标落进快捷键栏。
2. 光标在终端最底行时，整页 `offset` 被 `clamp` 封顶到 `inset`，抬不到快捷键栏之上。

修复：
- `computeCursorFollowOffset` 加 `maxOffset`（默认 `inset`，follow 放宽到 `inset + barHeight`）：多抬一个快捷键栏高度让光标即便最底行也停到浮条之上，多抬露出的空白正好被浮动快捷键栏盖住、不露白。
- 快捷键栏定位改测量驱动 `alignShortcutToKeyboardTop`（量当前底沿、补差到键盘顶，自动含 padding），替代易偏的公式。
- 验证：e2e 量到 stripBottom=407=keyboardTop（精确贴）、光标底 347 < 快捷键栏顶 355（上方 8px）；新增正式 e2e + 2 个单测；4 个键盘 e2e 全过。
- 诊断中发现：终端输出超过 viewport 滚动后 `cursor.y` 为 null，follow 退化为整页上移（合理 fallback）。

## 未决 / 交接

- 未提交、未发 PR（等用户指示）。
- `resize` 模式会触发远端 tmux resize-pane，属 issue 明确取舍，非默认。
- 旧版 iOS（`offsetTop>0`）真机验证手段受限（模拟器历史无法复现键盘类 bug），逻辑已兼容但未真机实测。
