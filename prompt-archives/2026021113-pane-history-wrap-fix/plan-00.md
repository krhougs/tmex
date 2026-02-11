# Plan 00：pane/window 切换后历史换行错乱最小修复

时间：2026-02-11

## 背景

用户反馈在 Web 端切换 pane/window 后，已有输出显示错乱，表现为“看起来基本没有换行”；同一内容在 iTerm2 显示正常。

代码排查显示，历史回放依赖 gateway 的 `capture-pane` 抓取结果，而当前命令包含 `-J`，会把软换行折叠合并，导致回放文本的视觉换行语义被破坏。

## 目标

1. 修复切换 pane/window 后历史文本换行错乱。
2. 保留已有 ANSI 颜色能力（`-e` 选项不变）。
3. 采用最小改动，不改协议、不改前端交互逻辑。

## 实施范围

### 任务 1：调整历史抓取命令

- 文件：`apps/gateway/src/tmux/connection.ts`
- 修改：移除 normal/alternate 两条 `capture-pane` 命令中的 `-J`。
- 预期：历史文本按 tmux 逐行输出回放，不再被强行合并。

### 任务 2：补充回归单测

- 文件：`apps/gateway/src/tmux/connection.test.ts`
- 新增：验证 `capturePaneHistory` 发出的 `capture-pane` 命令不包含 `-J`，并保持 `-e` 语义。

### 任务 3：验证

- 运行：`bun test apps/gateway/src/tmux/connection.test.ts`
- 运行：`bun run --cwd apps/gateway build`
- 结果写入：`plan-00-result.md`

## 注意事项

1. 本次为最小修复，不引入 feature flag。
2. 保持现有历史选择策略（normal/alternate）。
3. 不处理与本问题无关的终端体验项，避免扩大改动面。

## 执行中新增观察（2026-02-11）

在用户反馈“后端改动后仍未修复”后，追加前端链路排查。发现 `DevicePage` 的历史回放调用为 `term.write(data)`，其中 `data` 来自 `term/history` 的字符串，包含裸 `\n`。根据 xterm 文档，默认 `convertEol` 为关闭，裸 `\n` 仅换行不回到行首，可能导致“看起来没有正常换行”的错位展示。

据此新增最小前端修复：仅在历史回放路径对字符串做 `\n -> \r\n` 归一化，不改实时二进制输出路径。
