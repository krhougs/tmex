# Plan 00 执行结果：历史颜色保留与双向尺寸同步收敛

时间：2026-02-11

## 执行总结

本轮已按 iTerm2 处理思路完成网关与前端链路修复，重点解决了“尺寸同步被旧快照覆盖”与“历史回放控制字符丢失”的问题，并补充了刷新后 ANSI 保留的可执行回归验证。

## 关键改动

### 1）网关尺寸策略与刷新节流

- 文件：`apps/gateway/src/tmux/connection.ts`
- 变更：
  1. `configureWindowSizePolicy` 将 `aggressive-resize` 从 `on` 调整为 `off`。
  2. 新增 `resizeSnapshotTimer` 与 `scheduleSnapshotAfterResize`。
  3. `resizePane` 在 `refresh-client -C` 后触发节流快照刷新，减少旧 pane 尺寸回流。
  4. `cleanup` 时清理 `resizeSnapshotTimer`，防止悬挂定时器。

### 2）前端尺寸竞争抑制

- 文件：`apps/fe/src/pages/DevicePage.tsx`
- 变更：
  1. 远端尺寸回传应用前增加 `pendingLocalSize` 时间窗口判断。
  2. 本地刚上报尺寸后的短窗口内，忽略不匹配的远端快照，防止“同步按钮/resize 刚生效就被旧尺寸打回”。
  3. 匹配到本地已上报尺寸时，仅确认并清除 pending，不再触发反向抖动。

### 3）tmux 控制解析器行分隔修复

- 文件：`apps/gateway/src/tmux/parser.ts`
- 变更：
  1. `parseBuffer` 改为仅按 `\n` 拆行。
  2. 仅剥离行尾 CRLF 的 `\r`，保留行内 `\r`，避免破坏 TUI 重绘序列。

### 4）测试补强

- 文件：`apps/gateway/src/tmux/parser.test.ts`
- 新增：
  1. `preserves carriage return inside output block line`。
  2. `handles CRLF terminated control line`。

- 文件：`apps/fe/tests/tmux-terminal.e2e.spec.ts`
- 新增：
  1. `页面刷新后历史应保留 ANSI 颜色转义`。
  2. 通过监听 WebSocket `term/history` 帧断言 payload 中含 `\u001b[`。

## 验证结果

### 网关

1. `source ~/.zshrc >/dev/null 2>&1 || true; bun run --cwd apps/gateway test`：通过。
2. `source ~/.zshrc >/dev/null 2>&1 || true; bun run --cwd apps/gateway build`：通过。

### 前端

1. `source ~/.zshrc >/dev/null 2>&1 || true; bun run --cwd apps/fe build`：通过。
2. `source ~/.zshrc >/dev/null 2>&1 || true; bun run --cwd apps/fe test:e2e -- tests/tmux-terminal.e2e.spec.ts -g "页面刷新后历史应保留 ANSI 颜色转义"`：通过。
3. `source ~/.zshrc >/dev/null 2>&1 || true; bun run --cwd apps/fe test:e2e -- tests/tmux-terminal.e2e.spec.ts -g "连接后应显示 pane 现有内容|页面刷新后历史应保留 ANSI 颜色转义|同步尺寸按钮应工作正常|调整窗口大小后应能同步"`：通过。

## 结果与风险

1. 浏览器侧 resize / 同步尺寸链路在 e2e 与 tmux pane 实际尺寸上均可观测到变化。
2. 刷新后 `term/history` 已验证可携带 ANSI 转义数据，颜色信息不再在传输链路丢失。
3. 仍建议在真实 iTerm2 联调中观察“极端频繁拖拽窗口”的体验抖动；当前逻辑采用时间窗抑制，属于稳定性优先策略。

## 后续修正（针对 `set-window-option -w` 报错）

### 问题

用户现场报错：`parse error: command set-window-option: unknown flag -w`。
该错误导致浏览器发起尺寸同步时命令链路中断，进而表现为“点击同步尺寸/浏览器 resize 不生效”。

### 修复

1. `apps/gateway/src/tmux/connection.ts`
   - 将 `set-window-option -w -t ...` 改为兼容写法 `set-window-option -t ...`。
   - 同步补强浏览器 -> tmux 链路：
     - 记录当前激活窗口 `activeWindowId`；
     - `resizePane` 时执行：
       - `refresh-client -C {cols}x{rows}`；
       - `resize-window -x {cols} -y {rows} -t {activeWindowId}`；
       - `set-window-option -t {activeWindowId} window-size latest`。

2. `apps/fe/tests/tmux-terminal.e2e.spec.ts`
   - 修复外部尺寸测试中的命令兼容性（去掉 `set-window-option -w`）。
   - 新增 `readActiveWindowId`，外部尺寸变更改为针对活动 `window_id` 发送 `resize-window`。
   - 新增稳定断言：浏览器接收到 `state/snapshot` 中目标尺寸，验证“外部 tmux -> 浏览器”链路。

### 补充验证

1. `source ~/.zshrc >/dev/null 2>&1 || true; bun run --cwd apps/gateway test`：通过。
2. `source ~/.zshrc >/dev/null 2>&1 || true; bun run --cwd apps/fe test:e2e -- tests/tmux-terminal.e2e.spec.ts -g "同步尺寸按钮应工作正常|调整窗口大小后应能同步|外部 tmux 调整尺寸后浏览器 rows/cols 应跟随变化"`：`3 passed`。
