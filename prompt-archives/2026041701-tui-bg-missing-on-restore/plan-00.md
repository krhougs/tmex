# Plan: 修复 TUI 恢复时背景色块缺失

## 背景

用户在 tmex 浏览器终端中运行使用 alternate screen 的 TUI（opencode/vim/btop 等），刷新页面或切换 pane 后，历史回放出的界面里"纯背景色"区域整块消失，仅含字符的单元格能正常渲染。

在 `2026041700-terminal-three-bugs-fix` 后，前端已经用 DECSET 1049 + CUP + ED 的前导序列包住 alt-screen 历史文本（见 `apps/fe/src/components/terminal/normalization.ts:10`）。这一侧的逻辑正确——问题在网关侧捕获的历史本身就是残缺的。

## 根因

`apps/gateway/src/tmux-client/local-external-connection.ts` 与 `ssh-external-connection.ts` 的 `capturePaneHistory` 使用：

```
capture-pane -t <pane> -S - -E - -e -p [-a -q]
```

`tmux capture-pane` 默认会去掉每行尾部非字符位置（即使这些位置带有 SGR 背景色）。`-e` 只决定是否输出 escape 序列，并不改变 trim 行为。

复现命令：

```shell
tmux new-session -d -s test -x 80 -y 24
tmux send-keys -t test:0 "printf '\e[44m'; for i in $(seq 1 24); do printf '%-80s\n' \"line $i\"; done" C-m
# 默认捕获：尾部被 trim
tmux capture-pane -t test:0 -e -p | od -c | head
# 加上 -N：完整保留 80 列含 SGR 的尾部
tmux capture-pane -t test:0 -e -N -p | od -c | head
```

实测（见会话日志）确认：不加 `-N` 时，`\e[44m` 后只有文本字符，尾部 68 个蓝底空格完全丢失；加 `-N` 后每行补齐为 80 列。

## 方案

为两个 connection 的 `capturePaneHistory` 的两条 `capture-pane` 命令都追加 `-N`：

- 正常捕获：`-S - -E - -e -N -p`
- 备用 alt 捕获：`-a -S - -E - -e -N -p -q`

`-N` 保留每行尾部空格（连同其 SGR 样式），但不像 `-J` 那样拼接换行——正是我们需要的：alt screen 里每行等于 cols 宽，互不合并。

### 为什么不用 `-J`

`-J` 会去掉行间 `\n`（并 imply `-T`，后者主动 trim），对 alt screen 回放会破坏行结构。

### 客户端侧影响

`normalizeHistoryForTerminal` 会把 `\n` → `\r\n`。历史每行变成 `<cols 字符>\r\n`，在 ghostty 中：

1. 写满 cols 列后光标处于 pending-wrap；
2. `\r` 清 pending-wrap 并回到列 0；
3. `\n` 下移一行。

行为正确。

### `hasRenderableTerminalContent` 的副作用

`capturePaneHistory` 用 `hasRenderableTerminalContent = value.trim().length > 0` 判断是否 fall back 到 alternate buffer。启用 `-N` 后即使 alt screen"视觉上空"也会带 SGR 字节，`trim()` 不会剔除这些字节，因此永远走 `normal` 分支。这与语义一致：alt 模式下优先显示 alt screen 本身（哪怕它是纯背景），不要意外显示背后的 shell 历史。

## 任务清单

- [x] `apps/gateway/src/tmux-client/local-external-connection.ts`：两个 `capture-pane` argv 各加 `-N`
- [x] `apps/gateway/src/tmux-client/ssh-external-connection.ts`：同上
- [x] `apps/gateway/src/tmux-client/local-external-connection.test.ts`：更新 mock 命令字符串匹配

## 验收标准

- `bun test apps/gateway/src/tmux-client/` 全绿
- 手动：在浏览器打开 tmex → 启动 opencode → 刷新页面 → alt screen 中的背景色区域完整恢复

## 风险

- 捕获输出体积会上升（alt screen 全屏填充情况下约为原来的 cols 倍，但 alt screen 本身大小就是 cols×rows，所以实际上是把"视觉尺寸"如实回放）。对长历史影响可忽略。
- 如果将来想区分"真空 alt buffer"和"纯背景 alt buffer"，需要比 `.trim().length` 更强的启发式。当前行为对 alt screen 场景是合理的。
