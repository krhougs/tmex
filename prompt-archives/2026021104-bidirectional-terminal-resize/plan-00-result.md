# Plan 00 执行结果：双向尺寸同步与新窗口首帧溢出修复

时间：2026-02-11

## 执行总结

本次围绕“浏览器与 iTerm2 双向尺寸同步”与“新窗口首帧溢出”完成了链路修复，并补齐了历史回放初始化时序：

1. tmux 会话在连接就绪后统一设置 `window-size latest` 与 `aggressive-resize on`。
2. 网关增加快照低频轮询兜底（有选中 pane 的客户端时启用），用于 iTerm2 侧尺寸变更反向传导。
3. 前端 DevicePage 增加双向尺寸回环抑制（pendingLocalSize + suppress 窗口）并应用远端 pane 宽高。
4. pane/window 切换后增加多阶段同步（立即 + 延迟 + fonts.ready）缓解新窗口首帧 1-5 列溢出。
5. 历史回放从“实时先到即丢历史”改为“初始化缓冲 + 超时回放 fallback”，并在后端同时抓取 normal/alternate screen 做择优。

## 关键变更

### 1）tmux 尺寸策略

- 文件：`apps/gateway/src/tmux/connection.ts`
- 变更：
  - 新增 `configureWindowSizePolicy`，连接 ready 后执行：
    - `set-option -g -w window-size latest`
    - `set-option -g -w aggressive-resize on`

### 2）双屏历史抓取与合并

- 文件：`apps/gateway/src/tmux/connection.ts`
- 变更：
  - `capturePaneHistory` 同时触发：
    - normal: `capture-pane -S -1000 -e -J -p`
    - alternate: `capture-pane -a -S -1000 -e -J -p -q`
  - 引入请求队列与 220ms 聚合超时，按内容长度择优发送 `term/history`。

### 3）前端尺寸双向状态机

- 文件：`apps/fe/src/pages/DevicePage.tsx`
- 变更：
  - 新增 `pendingLocalSize` + `suppressLocalResizeUntil`，避免本地发送与远端回传互相放大。
  - 当 snapshot 的 `selectedPane.width/height` 变化时，执行 `term.resize` 回推浏览器 cols/rows。
  - 本地 resize/sync 发包时记录最近上报尺寸，回传命中则仅确认不二次发送。

### 4）新窗口首帧溢出修复

- 文件：`apps/fe/src/pages/DevicePage.tsx`
- 变更：
  - 新增 `runPostSelectResize`：
    - 立即 `sync`
    - 60ms 后二次 `sync`
    - `document.fonts.ready` 后再次 `sync`
  - 在 `selectPane` 后与 pane 切换后触发。

### 5）历史初始化回放修复

- 文件：`apps/fe/src/pages/DevicePage.tsx`
- 变更：
  - 二进制实时输出在初始化阶段先写入 `historyBuffer`。
  - `term/history` 到达后合并写入；若 400ms 未到达则 fallback 回放缓冲。

### 6）网关可观测性与轮询兜底

- 文件：`apps/gateway/src/ws/index.ts`
- 变更：
  - `term/resize`、`term/sync-size` 增加日志。
  - `snapshotPollTimer`：当有选中 pane 客户端时，每 1s 请求 snapshot；无客户端/断连时自动停止。

## 验证结果

### 构建

- `source ~/.zshrc && bun run --cwd apps/gateway build`：通过。
- `source ~/.zshrc && bun run --cwd apps/fe build`：通过（存在既有 CSS 警告，不影响本次功能）。

### 定向 e2e

- `source ~/.zshrc && bun run --cwd apps/fe test:e2e -- tests/tmux-terminal.e2e.spec.ts -g "同步尺寸按钮应工作正常|调整窗口大小后应能同步|连接后应显示 pane 现有内容"`
- 结果：`3 passed`。

## 风险与后续建议

1. 当前 e2e 仍以“可用性”为主，建议追加 `stty size` 前后比对断言，确保双向尺寸变化可量化。
2. 颜色验证建议增加截图基线（普通 ANSI 与 TUI 两套）以避免主观误差。
3. 目前 gateway 仍有较多 `noop` 日志，后续可单独降噪。
