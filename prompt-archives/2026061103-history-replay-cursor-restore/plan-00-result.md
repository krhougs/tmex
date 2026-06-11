# 历史回放光标恢复修复 — 执行结果

## 背景

刷新或切换页面后两类症状（手动 resize 均可恢复）：

1. Claude Code（Ink）TUI 错位，实际输入区域与 TUI 预期位置完全不一致；
2. 普通终端中光标停在正确位置之后若干列的空白处。

## 根因

`capture-pane` 历史回放只包含屏幕文本，**不含光标位置**。回放结束后前端终端光标停在最后写入字符之后，与 tmux pane 的真实光标（`#{cursor_x}/#{cursor_y}`）不一致。实测（tmux 3.4）确认三个事实：

- `capture-pane -S - -E -` 输出包含可见区域底部的全部空行 → 回放后光标落在可见区域底行；
- `-N` 保留行尾空白 → 光标行回放后光标停在尾随空白之后（症状 2 的直接来源）；
- capture 输出不含任何光标定位序列。

Ink 类 TUI 用相对光标移动（`ESC[nA` + 擦行）做增量重绘，起点错位导致整个界面错乱（症状 1）。resize 能修复是因为 SIGWINCH 触发应用全量重绘。

## 修复

新增 `apps/gateway/src/tmux-client/capture-history.ts`，local/ssh 两个连接共用；前端与 ws 协议零改动：

- capture 时把原 `#{alternate_on}` 查询扩展为 `#{alternate_on} #{cursor_x} #{cursor_y} #{pane_height}`（合并为一次 display-message，不增加命令往返）；
- 把光标恢复序列拼接到 history 末尾：
  - 主屏：去掉 capture 结尾换行（使回放后光标停在可见区域底行这一已知起点），再 `ESC[nA`（相对上移 `pane_height-1-cursor_y` 行）+ `ESC[mG`（绝对列 `cursor_x+1`）。主屏有滚动缓冲，不能用绝对行号；
  - alt 屏：前端 `wrapAlternateScreenHistory` 回放前会清屏从顶部写起，直接 `ESC[y+1;x+1H` 绝对定位；
- 光标字段解析失败时原样返回 history（含结尾换行），与旧行为完全一致。

前端 `normalizeHistoryForTerminal` 只对以 `\n` 结尾的数据裁剪末尾换行；拼接序列后数据不以 `\n` 结尾，裁剪逻辑自然跳过，时序与既有屏障（ACK→HISTORY→LIVE_RESUME）无任何变化。

## 改动文件

- `apps/gateway/src/tmux-client/capture-history.ts`（新增）
- `apps/gateway/src/tmux-client/capture-history.test.ts`（新增）
- `apps/gateway/src/tmux-client/local-external-connection.ts`
- `apps/gateway/src/tmux-client/ssh-external-connection.ts`
- `apps/gateway/src/tmux-client/local-external-connection.test.ts`（更新 mock 命令串与期望，新增主屏用例）

## 验证

- 单元测试：`bun test apps/gateway/src/tmux-client/` 107 个全过；
- 真实回放验证（临时脚本，已删除）：把 capture+恢复序列 cat 进同尺寸干净 tmux pane，对比 `#{cursor_x}/#{cursor_y}` 与屏幕内容：
  - 主屏场景（模拟 Ink：历史 + 行尾空白输入行 + 底部状态栏，光标在非底行中间列）：光标 (15,4) 与屏幕完全一致；
  - alt 屏场景（man 页）：光标 (1,7)、alt 状态、屏幕完全一致；
- e2e：`ws-borsh-history` / `ws-borsh-switch-barrier` / `ws-borsh-resize` 10 个用例全过（9885/9665 端口，`env -u NODE_ENV`）;
- gateway 全量 `bun test`：4 个失败为既有问题（全量运行时测试顺序污染 i18next 全局语言，干净 main 同样失败，单独跑相关文件 0 失败）；
- tsc / biome：与基线完全一致，无新增问题。

## 注意事项 / 已知限制

- display 查询与 capture 之间若 pane 有新输出，光标与内容存在极小竞态窗口；该窗口内的输出同时会被 select 屏障缓冲并在 LIVE_RESUME 后重放，属既有行为，本次未改动。
- pending-wrap 状态（光标停在写满整行之后）无法用序列精确恢复，列号会被钳制到行宽，影响仅一个字符位，可忽略。
- scroll region（DECSTBM）等终端模式仍不随 capture 恢复，属既有限制（Ink/Claude Code 不使用）。
