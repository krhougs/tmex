# Result: 修复 TUI 恢复时背景色块缺失

## 变更

- `apps/gateway/src/tmux-client/local-external-connection.ts`
  - `capturePaneHistory` 两条 `capture-pane` 命令加入 `-N`
- `apps/gateway/src/tmux-client/ssh-external-connection.ts`
  - 同上
- `apps/gateway/src/tmux-client/local-external-connection.test.ts`
  - 更新 2 个 mock 测试用例中匹配的命令字符串

## 验证

- `bun test apps/gateway/src/tmux-client/` → 40 pass / 0 fail
- 现场用 tmux 3.4 直接 reproduce 了 trim 行为：

```
# 不加 -N：
\033[44m line 2 hello\n line 3 hello\n ...   # 尾部蓝底空格全部丢失

# 加 -N：
\033[44m line 2 hello + 68×空格 \n ...       # 80 列完整保留
```

## 行为变化

- alt screen 恢复后，带背景色的纯色区域（opencode 侧栏/chat area、vim 状态栏底色等）完整显示。
- `hasRenderableTerminalContent` fall-back 启发式在 `-N` 开启后趋向于永远采用 `normal` 分支（alt screen 即便视觉为空也会带 SGR）。与 alt-mode 的期望语义一致。

## 未涉及

- `apps/fe/tests/ssh-terminal-restore.spec.ts` 中也有 `capture-pane` 调用，但那是测试辅助函数用于断言可见文本，不影响恢复流程，保持不变。
- 客户端 `wrapAlternateScreenHistory` / `normalizeHistoryForTerminal` 无需改动。
