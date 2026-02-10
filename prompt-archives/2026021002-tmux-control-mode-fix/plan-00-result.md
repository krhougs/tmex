# 执行结果：plan-00

## 已完成

### Gateway：tmux control mode 解析与链路

- `apps/gateway/src/tmux/parser.ts`：补齐 control mode 协议关键点。
  - 支持 `%begin/%end/%error` 输出块，避免把命令输出当作“非控制输出”导致状态机卡住。
  - `%output/%extended-output` 使用八进制转义（`\xxx`）解码，符合 tmux 手册（CONTROL MODE）。
  - 支持 `%exit [reason]`，并将退出原因上报给连接层。

- `apps/gateway/src/tmux/connection.ts`：增强连接稳定性与可观测性。
  - 新增 ready 握手：等待收到 control mode 的输出块/通知后才认为连接就绪，避免 snapshot 请求在 tmux 未进入 control mode 前被误解析。
  - SSH 连接从 `shell()+write()` 改为 `exec(..., { pty })`，减少 shell 回显/提示符对 control mode 解析的干扰。
  - 输入发送改为 `send-keys -H` 十六进制方式，避免 `-l` 在包含空格、控制字符时出现参数分割问题。

### Gateway：WebSocket snapshot 时序修复

- `apps/gateway/src/ws/index.ts`：修复“client connect 后收不到 snapshot”的时序问题。
  - 先把 ws client 加入 `clients` 集合，再触发 `requestSnapshot()`。
  - 新增 `lastSnapshot` 缓存：后续新 client 连接同一 device 时可立即收到最新 snapshot。

### Gateway：DB 字段映射修复

- `apps/gateway/src/db/index.ts`：修复 `rowToDevice` 中 `privateKeyEnc` 字段读取错误（应为 `private_key_enc`）。

### FE：单例 ws store 与窗口/pane 树

- `apps/fe/src/stores/tmux.ts`：引入单例 WebSocket、snapshot 缓存、二进制输出分发。
- `apps/fe/src/components/Sidebar.tsx`：展开设备时自动连接并展示 window/pane 树。
- `apps/fe/src/pages/DevicePage.tsx`：复用 store 的 ws；当 URL 只有 `deviceId` 时，根据 snapshot 自动跳转到 active pane。
- `apps/fe/src/layouts/RootLayout.tsx`：应用启动时确保 ws 连接建立。

### 测试

- `apps/gateway/src/tmux/parser.test.ts`：覆盖 `%begin/%end`、`%output` 解码、`%exit`。

## 已验证

- `apps/gateway`：`bun test` 通过。
- `apps/gateway`：`bun build` 通过。
- `apps/fe`：`bun build` 通过。

## 未验证/受限项

- 由于当前运行环境对 tmux socket/网络能力有限制（出现 `error connecting to /tmp/tmux-1000/default (Operation not permitted)`），无法在本环境完成真实 tmux 交互的端到端验证。

## 建议你本机复验步骤

1. 启动 gateway 与前端（保持前端代理指向 gateway）。
2. 登录后展开设备：应能收到 `state/snapshot` 并渲染窗口/pane。
3. 进入设备页：URL 仅 `deviceId` 时应自动跳转到 active pane。
4. 在终端输入：输出应通过 `%output` 解析并实时显示。

