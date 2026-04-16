# 执行结果

## 结果概览

- 已将 SSH `test-connection` 从 stub 改为真实 probe，能够返回阶段化结果。
- 已修复 SSH runtime 在真实远端 tmux 上无法进入可用终端的根因，`dns shanghai` 已完成实机 smoke。
- 已补充参数化 Playwright 回归，使用运行参数选择 SSH 目标设备，不硬编码服务器。
- 已保留并验证“一个 device 只有一个 SSH 连接”的约束：同设备复用同一 runtime，不并发建立第二条 SSH transport。

## 根因结论

1. `apps/gateway/src/api/index.ts` 的 `/api/devices/:id/test-connection` 原本是 stub，无法反映真实 SSH/tmux 状态。
2. SSH probe 的 bootstrap 通道没有主动结束 stdin，真实远端会一直等待脚本输入，导致 probe 挂起。
3. SSH runtime 的 snapshot 解析假设 tmux 输出使用制表符分隔，但真实远端 tmux 返回的是 pipe 分隔格式，导致 session/window/pane 解析错误，页面一直停留在“Disconnected”。
4. Playwright 的 gateway 启动命令未经过 `run-with-ssh-agent.sh`，且在 real-device 场景下可能复用错误的现有服务，导致真实 SSH e2e 不稳定。

## 主要变更

### Gateway probe

- 新增 `apps/gateway/src/tmux-client/ssh-probe.ts`
  - 提供真实 SSH probe，复用 SSH 认证解析与远端 tmux bootstrap。
  - 返回 `{ success, tmuxAvailable, phase, rawMessage }` 结构化结果。
  - 最终修正了一处 probe 缺陷：认证/配置解析现在完全落在 `try/catch` 内，不会再因为前置解析抛错而绕过结构化失败结果。
- 新增 `apps/gateway/src/tmux-client/ssh-probe.test.ts`
  - 覆盖 probe ready 路径。
  - 覆盖 bootstrap stdin 必须结束，否则 probe 无法完成的回归场景。

### SSH Config 支持与连接配置收敛

- 新增 `apps/gateway/src/tmux-client/ssh-connect-config.ts`
  - 抽出 SSH 连接配置解析，统一供 probe/runtime 复用。
  - 支持 `sshConfigRef` 作为 `~/.ssh/config` 中的 host alias，通过 `ssh -G <alias>` 解析 `hostname`、`user`、`port`、`identityagent`、`identityfile`。
  - 支持从 alias 解析 agent 路径或第一个可读私钥文件，消除之前“configRef 一律未实现”的硬阻塞。
- 新增 `apps/gateway/src/tmux-client/ssh-connect-config.test.ts`
  - 覆盖 `SSH_AUTH_SOCK` agent 路径解析。
  - 覆盖 `identityfile` 列表里首个可读私钥的解析。

### API 接线

- 新增 `apps/gateway/src/api/test-connection.ts`
  - 将设备存在性检查、probe 调用、错误分类与响应组装从 `api/index.ts` 中抽出，便于验证。
  - 最终将 `test-connection` 对设备统一收敛到 runtime registry 路径，避免本地设备误走 SSH probe，也避免 SSH 设备在已有 runtime 时额外建立第二条 SSH 连接。
- 更新 `apps/gateway/src/api/index.ts`
  - `handleTestConnection` 改为调用真实 handler，而不是返回固定成功响应。
- 更新 `packages/shared/src/index.ts`
  - 扩展 `TestConnectionResult`，增加 `phase`、`errorType`、`message`、`rawMessage`。
- 新增 `apps/gateway/src/api/test-connection.test.ts`
  - 覆盖设备不存在的 404。
  - 覆盖 probe/运行时失败时返回阶段化 payload，而不是 stub。
  - 覆盖配置/认证异常仍返回结构化失败 payload，而不是把错误冒泡成 500。
  - 覆盖并发 `test-connection` 共用同一 runtime，以及“已有 runtime 时不再创建第二个连接”的回归。

### SSH runtime 修复

- 更新 `apps/gateway/src/tmux-client/ssh-external-connection.ts`
  - 将 snapshot 的 tmux format 从 tab 分隔改为 pipe 分隔。
  - 新增更稳健的字段拆分逻辑，允许 window/pane title 中包含分隔符前后的字段保持可解析。
  - 移除无效的 `configRef` 分支类型比较，消除 LSP 错误。
- 更新 `apps/gateway/src/tmux-client/ssh-external-connection.test.ts`
  - 新增基于真实 pipe 分隔输出的快照解析回归测试。
  - 同步现有 SSH snapshot 相关测试数据到 pipe 分隔格式。

### 单 device 单 SSH 连接保证

- 更新 `apps/gateway/src/ws/index.test.ts`
  - 新增“第二个 websocket 客户端连接同一 device 时复用同一 runtime”测试。
  - 验证 acquire/connect 只发生一次，确保同 device 不会建立第二条 SSH 连接。
- 更新 `apps/gateway/src/api/test-connection.test.ts`
  - 新增并发 `test-connection` 共用同一 runtime 的测试。
  - 新增“已有 runtime 时 test-connection 复用现有 runtime，不建立第二条连接”的测试。
- 更新 `apps/gateway/src/tmux-client/device-session-runtime.ts`
  - runtime 被远端关闭或手动断开后会清空 `connectPromise`，后续 `connect()` 不会复用失效 promise 假阳性成功。
- 更新 `apps/gateway/src/tmux-client/device-session-runtime.test.ts`
  - 新增“runtime 已关闭后再次 connect 会被拒绝”的回归测试。

### 参数化 e2e

- 新增 `apps/fe/tests/ssh-device-connect.spec.ts`
  - 通过 `TMEX_E2E_SSH_DEVICE_NAME` 运行时解析目标设备。
  - 通过 `TMEX_E2E_DATABASE_URL` 复用指定数据库中的现有设备。
  - 先验证 `/api/devices/:id/test-connection` 成功，再打开真实 SSH terminal，发送 marker 并验证回显。
- 更新 `apps/fe/playwright.config.ts`
  - gateway 改为通过 `run-with-ssh-agent.sh` 启动，确保 real-device e2e 拿到有效 `SSH_AUTH_SOCK`。
  - real-device 场景下禁止复用现有 server，避免浏览器连到错误环境。

## 验证结果

### 单元测试与构建

- `cd apps/gateway && bun test`
  - 结果：`89 pass, 0 fail`
- `cd apps/gateway && bun run build`
  - 结果：通过
- `cd apps/fe && bun run build`
  - 结果：通过
- `lsp_diagnostics`：
  - `apps/gateway/src`：0 errors
  - `apps/fe`：0 errors
  - `packages/shared/src`：0 errors

### 实机手工验证（`dns shanghai`）

- SSH probe：
  - 命令：通过 `run-with-ssh-agent.sh` 执行 `probeSshDevice('30c791d9-1326-43f6-b60f-967a97ce2d77')`
  - 结果：`{"success":true,"tmuxAvailable":true,"phase":"ready"}`
- SSH runtime smoke：
  - 命令：通过 `createDeviceSessionRuntime` 连接 `dns shanghai`，等待 snapshot，选择 active pane，发送 `printf "__TMEX_SSH_SMOKE__\n"`
  - 结果：
    - `SNAPSHOT {"windowId":"@0","paneId":"%0","session":"main1"}`
    - `OUTPUT_HIT %0 "printf \"__TMEX_SSH_SMOKE__\\n\"\r\n...__TMEX_SSH_SMOKE__..."`
- API 路径：
  - 命令：启动 gateway 后 `POST /api/devices/30c791d9-1326-43f6-b60f-967a97ce2d77/test-connection`
  - 结果：`{"success":true,"tmuxAvailable":true,"phase":"ready","message":"Success"}`
- 单 device 单 SSH 连接约束验证：
  - 命令：先通过 `tmuxRuntimeRegistry.acquire(deviceId)` 建立并保持 `dns shanghai` 的 active runtime，再调用 `handleDeviceTestConnection()`，并在注入的 `acquireRuntime` 中比较 runtime 对象。
  - 结果：
    - `RUNTIME_REUSED true`
    - `API_PAYLOAD {"success":true,"tmuxAvailable":true,"phase":"ready","message":"Success"}`
  - 结论：已连接 device 的 test-connection 会复用现有 runtime，不再额外拉起第二条 SSH 连接。

### 本轮最终回归修复

- 修复了 `test-connection` 的本地设备回归：本地设备不再误走 `probeSshDevice()`。
- 修复了已关闭 runtime 可能复用旧 `connectPromise` 的问题，避免 `test-connection` 或后续调用把失效 runtime 误当成有效连接。

### SSH Config 路径验证

- ConfigRef probe：
  - 命令：通过 `run-with-ssh-agent.sh` 执行 `probeSshDevice()`，注入 `authMode=configRef`、`sshConfigRef=localhost` 的 SSH 设备。
  - 结果：`{"success":true,"tmuxAvailable":true,"phase":"ready"}`
- ConfigRef runtime smoke：
  - 命令：直接构造 `SshExternalTmuxConnection`，注入 `authMode=configRef`、`sshConfigRef=localhost` 的 SSH 设备，等待 snapshot 后向 active pane 发送 `printf "__TMEX_CFGREF_SMOKE__\n"`。
  - 结果：
    - `SNAPSHOT {"windowId":"@384","paneId":"%683","session":"tmex"}`
    - `HISTORY_HIT %683`
- ConfigRef 解析单测：
  - `ssh-connect-config.test.ts` 已验证 alias -> `SSH_AUTH_SOCK` agent 与 alias -> `identityfile` 私钥两条路径。

### 参数化 e2e

- 命令：
  - `cd apps/fe && TMEX_E2E_DATABASE_URL=/tmp/tmex.db TMEX_E2E_SSH_DEVICE_NAME='dns shanghai' TMEX_E2E_GATEWAY_PORT=29663 TMEX_E2E_FE_PORT=29883 bun run test:e2e -- ssh-device-connect.spec.ts`
- 结果：`1 passed`

## 额外说明

- 三个 explore 背景任务因超时失败，但在超时前后已通过直接代码阅读、实机 probe、实机 runtime smoke 和 Playwright 回归补齐所需上下文，因此未重试。
- 早期直接使用当前 shell 环境调 probe 时出现 `Failed to connect to agent`，根因是当前 shell 的 `SSH_AUTH_SOCK` 指向失效路径；真正的 gateway/e2e 启动已统一通过 `run-with-ssh-agent.sh` 解析有效 agent socket。

## 风险与后续

- 当前 API success 文案仍是通用 `Success`；如后续需要更细粒度的 probe 成功提示，可以单独做 i18n 文案优化，但这不影响本轮 SSH 可用性目标。
- pipe 分隔 snapshot 解析已覆盖当前真实远端行为；如果未来遇到包含大量 `|` 的 pane/window title，现有解析仍会优先保留头尾关键字段，但可以继续扩展更强的编码方案。
