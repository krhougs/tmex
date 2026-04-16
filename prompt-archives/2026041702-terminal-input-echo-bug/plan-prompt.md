# Terminal 输入回显 bug 修复

## 用户反馈

> 修一个bug：在终端中输入任何命令，然后回车。输入的命令会在终端中回显
>
> 例子：
> ```
> $ echo "test"
> echotest
> ```

期望：第二行只应该是 `test`（即 `echo` 命令的输出）。
实际：第二行被显示为 `echotest`，看起来是把 `echo` 又回显了一遍并和 `test` 拼在一起。

## 背景

- 最近 commit `20aba36` 把 ghostty-terminal 中辅助 textarea 替换成了 `contenteditable` div，目的是改善 IME 输入体验。
- 替换前 textarea 的 `color: transparent`，本地不可见；替换后 contenteditable 的样式中 `color: this.options.theme.foreground`，本地可能可见。
- 输入流向：
  1. 浏览器 contenteditable -> `beforeinput` / `input` 事件 -> `emitData(data)`
  2. WebSocket borsh -> gateway
  3. gateway 通过 `tmux send-keys -H -t <paneId> <hex>` 注入到 tmux pane
- pane 的输出再通过 capture-pane -p -e 流式回到前端。

## 注意事项

- 本项目使用 Bun.js，请优先使用本地 dev server（gateway 19663 / FE 19883）调试。
- AGENTS.md 要求：先存档再干活；每次需要用户交互前输出 `\a`(0x07) bell。
- 之前的相关修复参见 `prompt-archives/2026041700-terminal-three-bugs-fix` 与 `2026041701-tui-bg-missing-on-restore`。

## 怀疑方向

1. contenteditable 文字本地可见（`color: foreground` 替代了原 textarea 的 `color: transparent`），导致用户看到「输入字符」。
2. `beforeinput` / `input` / `keydown` / `keyup` 重复触发 `emitData`，导致字符在 PTY 端被发送两次。
3. `keyup` 路径无差别调用 `encodeKeyboardEvent('release')`，对纯文字字符可能产生副作用。
4. `clearTextarea` 的时机不对，textContent 累积后又被作为 fallback emit。
