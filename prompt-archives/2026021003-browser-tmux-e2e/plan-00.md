# Plan-00：浏览器端 tmux e2e（Playwright）

## 背景

- 用户反馈浏览器端仍不可用，并出现 xterm 运行时异常（Viewport 刷新时访问到 undefined）。
- 当前前端已集成 xterm 与 WebSocket，但没有覆盖“连接本地 tmux + 窗口/分屏操作”的端到端自动化验证。

## 目标

1. 提供可在 **真实浏览器** 中运行的 e2e 测试：
   - 能登录。
   - 能添加并连接“本地设备”。
   - 能通过终端指令创建窗口、删除窗口。
   - 能通过终端指令 split，并能在侧边栏切换到新 pane。
2. 修复/规避导致浏览器端不可用的关键问题，使 e2e 测试具备可通过的基础。

## 注意事项

- 测试依赖：
  - `tmux` 必须存在于运行环境。
  - `bun` 必须存在于运行环境（gateway 使用 Bun API）。
  - Playwright 浏览器依赖需提前安装（CI 或本地执行时处理）。
- e2e 需要使用独立的 tmux session，并在测试结束后清理，避免污染宿主环境。
- 当前前端不消费 `event/tmux`，因此需要后端在 tmux 事件发生后刷新并广播 `state/snapshot`，以便 UI 侧边栏能感知窗口/分屏变化。

## 任务拆分

1. 存档：记录 prompt、计划（本文件）。
2. 后端：在收到 tmux 相关事件后，节流触发 `requestSnapshot()` 并广播最新快照。
3. 前端：避免 DevicePage 在连接后立即路由跳转导致的 xterm dispose 异常（拆出 Redirect 页面，或延迟 dispose）。
4. 前端：补齐 Playwright 配置（同时启动 gateway + fe），编写 e2e 用例覆盖：连接、创建/删除窗口、split、切换 pane。
5. 存档：输出结果总结与运行方式。

## 验收标准

- `cd apps/fe && playwright test`（或项目约定命令）可在无人工干预下完成：
  - 成功连接本地 tmux。
  - 完成窗口创建/删除、split 与切换。
- 测试过程中无未捕获的前端 `pageerror`（尤其是 xterm 的 `dimensions` 相关异常）。

