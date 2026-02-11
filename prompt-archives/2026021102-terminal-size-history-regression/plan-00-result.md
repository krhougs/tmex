# Plan 00 执行结果：Terminal 尺寸时序、历史保真与闪烁回归修复

时间：2026-02-11

## 执行总结

本次已按计划完成以下修复：

1. 调整 pane 激活链路时序为“先同步尺寸，再 select pane（触发历史抓取）”。
2. `capture-pane` 改为保留 ANSI 和合并换行折叠，修复历史颜色丢失与换行错乱根因。
3. 历史回放改为“实时优先”且不在回放阶段 `reset`，降低 TUI 闪烁。
4. xterm 容器改为稳定铺满模型，修复高度未撑满、宽度溢出与 resize 不稳定。
5. resize 链路增加防抖 + RAF + 尺寸去重，减少高频重复同步。

## 关键改动

### 1）前端时序：先尺寸同步，再载入历史

- 文件：`apps/fe/src/pages/DevicePage.tsx`
- 变更：
  - 新增 `reportPaneSize`，统一 `fit + cols/rows` 计算与上报。
  - 在 pane 激活 effect 中，先 `reportPaneSize('sync', true)`，再 `selectPane(...)`。
  - `scheduleResize` 改为 `setTimeout(80ms) + requestAnimationFrame`，并支持 `immediate/force`。
  - 增加 `lastReportedSize` 去重，避免重复发送相同尺寸。

### 2）后端历史抓取：保留颜色并改进换行语义

- 文件：`apps/gateway/src/tmux/connection.ts`
- 变更：
  - `capture-pane` 命令从：
    - `capture-pane -t ${paneId} -S -1000 -p`
  - 调整为：
    - `capture-pane -t ${paneId} -S -1000 -e -J -p`
- 说明：
  - `-e`：保留文本/背景属性（ANSI）。
  - `-J`：保留 trailing spaces 并合并 wrapped lines。

### 3）历史回放与闪烁修复

- 文件：`apps/fe/src/pages/DevicePage.tsx`
- 变更：
  - 移除历史应用阶段的 `term.reset()` 与额外 `\r\n`。
  - 当 `hasLiveOutput || historyApplied` 时，直接丢弃迟到历史并清空 `pendingHistory`。
  - 在 pane session 切换时执行一次 `term.reset()`，并清空 `historyBuffer`，避免旧 pane 残留。

### 4）xterm 布局与撑满修复

- 文件：
  - `apps/fe/src/pages/DevicePage.tsx`
  - `apps/fe/src/index.css`
- 变更：
  - terminal 容器从 `overflow-auto + fit-content` 改为 `overflow-hidden + w/h-full + min-w/min-h-0`。
  - `.xterm`、`.xterm-screen` 增加 `width:100%; height:100%`。
  - `.xterm` padding 改为 `0`，减少 fit 计算偏差与溢出风险。

## 验证结果

### 单测

- 命令：`source ~/.zshrc && bun test apps/gateway/src/tmux/parser.test.ts`
- 结果：`8 pass, 0 fail`

### 构建

- 命令：`source ~/.zshrc && bun run --cwd apps/gateway build`
- 结果：通过。

- 命令：`source ~/.zshrc && bun run --cwd apps/fe build`
- 结果：通过（存在既有 CSS 警告，不影响本次功能）。

### E2E（定向）

- 命令：
  - `source ~/.zshrc && bun run --cwd apps/fe test:e2e -- tests/tmux-terminal.e2e.spec.ts -g "连接后应显示 pane 现有内容"`
  - `source ~/.zshrc && bun run --cwd apps/fe test:e2e -- tests/tmux-terminal.e2e.spec.ts -g "调整窗口大小后应能同步"`
  - `source ~/.zshrc && bun run --cwd apps/fe test:e2e -- tests/tmux-terminal.e2e.spec.ts -g "同步尺寸按钮应工作正常|调整窗口大小后应能同步|连接后应显示 pane 现有内容"`
- 结果：均通过。

## 风险与后续建议

1. 当前自动化用例未直接断言“ANSI 颜色确实恢复”和“TUI 闪烁视觉完全消失”，建议补充：
   - 颜色回放断言（可通过固定彩色输出 + screenshot 基线）。
   - TUI 稳定性断言（如运行 `htop` 后持续输入和窗口 resize 的截图/帧差对比）。
2. gateway 日志中 `handleOutputBlock kind: noop` 仍较多，建议后续单独降噪，不在本次回归修复范围内。
