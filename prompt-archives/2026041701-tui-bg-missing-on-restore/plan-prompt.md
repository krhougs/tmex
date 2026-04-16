# Prompt

## 初始对话

> 修bug：终端中运行使用alternate terminal的TUI程序，刷新页面或切换pane之后，恢复的TUI界面显示残缺
>
> 复现过程：
>
> 1. 在终端中启动opencode
> 2. 刷新页面
> 3. 你会发现恢复的TUI界面中的用来表示黑色背景的区域直接丢失，而有文字的部分却正常渲染在屏幕上

## 背景

承接 `2026041700-terminal-three-bugs-fix` 中 `wrapAlternateScreenHistory` 的逻辑：刷新/切换后会用 `\x1b[?1049h\x1b[H\x1b[2J` + 捕获的历史文本在客户端 ghostty 中重放。

问题锁定在 gateway 侧 `capture-pane` 的参数：缺少 `-N` 时 tmux 会把每行尾部没有字符的位置丢弃，即便这些位置带有背景色。结果：TUI 绘制的纯色背景面板（例如 opencode 的暗色侧栏/聊天区）在重放时整块消失，但含字符的位置正常。
