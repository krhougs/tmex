# Plan 00 执行结果：pane/window 切换后历史换行错乱修复

时间：2026-02-11

## 执行摘要

初版仅后端移除 `capture-pane -J` 后，用户反馈仍未完全修复。继续排查后确认前端历史回放路径也存在换行语义问题：`term/history` 的字符串以裸 `\n` 写入 xterm（默认 `convertEol=false`），会出现“换行不回到行首”的错位感。

本次最终修复为“后端 + 前端”双点最小改动：

1. 后端历史抓取移除 `-J`，避免合并折行。
2. 前端历史回放将 `\n` 归一化为 `\r\n` 后写入 xterm。

## 关键改动

### 1）后端：取消历史抓取折行合并

- 文件：`apps/gateway/src/tmux/connection.ts`
- 改动：
  - `capture-pane -t ${paneId} -S -1000 -e -J -p` → `capture-pane -t ${paneId} -S -1000 -e -p`
  - `capture-pane -t ${paneId} -a -S -1000 -e -J -p -q` → `capture-pane -t ${paneId} -a -S -1000 -e -p -q`

### 2）后端：增加命令参数回归测试

- 文件：`apps/gateway/src/tmux/connection.test.ts`
- 新增测试：`capturePaneHistory should keep -e and not use -J`
- 断言：两条 `capture-pane` 命令均不含 `-J`。

### 3）前端：历史回放换行归一化

- 文件：`apps/fe/src/pages/DevicePage.tsx`
- 新增函数：`normalizeHistoryForXterm(data)`
- 行为：仅用于 `term/history` 回放，将 `\r?\n` 统一为 `\r\n`，然后 `term.write(...)`。
- 说明：不改实时二进制输出路径，避免影响 TUI 实时流。

## 验证结果

### 后端单测

- 命令：`bun test apps/gateway/src/tmux/connection.test.ts`
- 结果：`4 pass, 0 fail`

### gateway 构建

- 命令：`bun run --cwd apps/gateway build`
- 结果：通过

### fe 构建

- 命令：`bun run --cwd apps/fe build`
- 结果：通过（保留既有 CSS 警告，非本次引入）

## 结论

本次问题不是单点故障。仅修后端 `-J` 不足以覆盖全部表现，前端历史字符串在 xterm 的换行语义也需同步修复。当前双点修复后，切换 pane/window 的历史换行显示应与终端预期一致。
