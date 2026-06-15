# 终端自定义快捷键列表 — Prompt 存档

## 原始需求（用户）

调研实现以下功能：

1. 终端设置新增功能：自定义快捷键列表。这个功能持久化在服务器中，文案需要和其他持久化在浏览器中的数据做区分。
2. 默认快捷键列表（migration 时直接写入）：粘贴 Enter SHIFT-TAB ESC CTRL-C CTRL-D 上 下 左 右 SHIFT-Enter Backspace
3. 快捷键列管理表支持修改排序，支持用户自己录入快捷键
4. 保存后实时生效
5. 允许添加特殊快捷键：粘贴 切换文本框键盘 新建Agent Session 终端回到最下方（选几个 icon，文字太长，但是在设置页面要文字写清楚）
6. 快捷按钮应该用等宽字体
7. 开关选项：使用图标展示快捷键（即对于回车 ctrl shift 等等按键，使用苹果风格快捷键图标替代太长的文字）
8. 设置页面提供保存前的实时预览

## 调研期澄清（AskUserQuestion 结论）

- 「使用图标展示快捷键」开关 → 跟列表一起存服务器（多端一致、需点保存生效）。
- 用户自定义快捷键录入方式 → 按键捕获 + 高级手填，两者都要。

## 执行约束（goal / worktree 指令）

- effort 切到 ultracode；goal = 完成上述 plan。
- 必须先创建并进入独立 git worktree（`../tmex-terminal-custom-shortcuts-worktree`，分支 `terminal-custom-shortcuts`），确认 pwd 与 git status 均在 worktree 内。
- 后续所有存档、修改、测试、临时实例、自验收、结果存档都只在 worktree 内完成，严禁在主工作区动手。
- 严禁触碰本机生产 tmex（9883 常驻服务及安装目录）；验证只用仓库内临时实例 + 显式覆盖的临时端口/临时数据库。
- 结果存档 `plan-00-result.md` 需写明使用了 worktree。
