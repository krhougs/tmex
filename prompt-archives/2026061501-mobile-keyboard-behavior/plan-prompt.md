# Issue #27 终端手机端键盘行为优化 — Prompt 存档

## 元信息

- 日期：2026-06-15
- 分支 / worktree：`worktree-feat+issue-27-mobile-keyboard-behavior`
- 关联 issue：https://github.com/krhougs/tmex/issues/27
- 效力等级：ultracode（多 agent workflow 编排）

## 原始 prompt

> https://github.com/krhougs/tmex/issues/27 调研实现这个需求。记得开新的worktree

## Issue #27 原文（终端手机端键盘行为优化）

当前版本 0.12.0 手机键盘会完整顶起整个终端页面，在大部分情况下体验不错，但是在新打开的空 shell 中则看不见正在输入的内容。

我们需要新增一个手机键盘行为设置，入口在终端页面的右上角，数值持久化在浏览器中。入口点击弹出 modal 实时影响终端键盘行为。设置选项中需要用简单的文案写清楚行为。下面三个模式最好重新取些对用户友好的名字。

- 模式 1：整体抬起页面但不 resize，即现在的行为。
- 模式 2：整体抬起页面并 resize 终端，大体同现在的行为，但是会把页面和终端 resize 到占满除键盘外的可用高度。
- 模式 3：不 resize 页面和终端，动态按照光标位置抬起页面，使光标总是正好在键盘上方。实现时注意边界情况，避免 transform 后空白不可见页面被暴露给用户。

label：confirmed（Ready for agents to work with）

## 后续对话 prompt

（按时间追加）

### 设计决策（AskUserQuestion 回答）

- 模式命名：**页面平移 / 终端缩放 / 光标对齐**（内部值 `lift` / `resize` / `follow`）。
- 默认模式：**光标对齐（`follow`）**——直接修复空 shell 看不见输入的 bug。
- 弹窗形态：**从底部 Sheet**，注意排版，触屏 PC 和 iPad 要支持，**所有屏幕都要有这个设置入口**（即入口不门控、全尺寸显示；大屏 Sheet 居中限宽）。

### 后续迭代：follow 模式快捷键栏浮动

- 用户：「follow cursor模式，快捷键应该浮动在键盘上方」「不是抬起来多多少的问题，是这个模式下键盘抬起应该让那一排快捷键浮起来」。
- 诉求：follow 模式键盘弹起时，direct 模式终端下方那排快捷键栏（`.terminal-shortcuts-strip`）独立浮到键盘正上方（像输入法辅助条），不被键盘盖、不随页面 transform 跑；**不改光标抬升算法本身**。
- 约束：快捷键栏不能脱离文档流（canvas 是 flex-1 被 ResizeObserver 监听，脱流会触发终端 resize，违反 follow 不 resize）。
- 方案：CSS 变量 `--tmex-kb-shortcut-lift = inset - offset`，direct 快捷键栏 `translateY` 浮动（自身位移 + `<main>` offset = inset，贴键盘顶）；光标目标线计入快捷键栏高度，避免光标被浮条盖。

### 运维

- 用户要求「用 main 里的 dev 数据库启动 dev server」：worktree 建 `development.env.local`（gitignore），`DATABASE_URL=/Users/krhougs/LocalCodes/tmex/tmex.db`（绝对路径）；dev 端口 19663/19883，与生产 9883 隔离。已启动验证（/api/devices 返回 main 库的设备）。
