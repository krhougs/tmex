# 计划：修复 tmux 控制模式卡住并补齐窗口/Pane 选择链路

## 背景

当前 gateway 在连接 tmux control mode（`tmux -CC`）后，会出现：

- 日志打印：`[tmux] non-control output:`（常为空行或块内输出），随后看起来“卡住”。
- WebSocket 收到 `event/device disconnected`，但没有清晰错误原因。

经本地 `man tmux` 的 **CONTROL MODE** 章节核对，现有解析实现与协议不一致：

- 命令输出以 `%begin ...` 开始、以 `%end/%error ...` 结束，块内可能出现普通输出行；当前 parser 未处理该输出块。
- `%output pane-id value` 的 `value` 不是 base64，而是带有八进制转义（`\xxx`）的文本；当前 parser 错误地按 base64 解码。

## 目标（验收）

1. 连接设备后，终端输出稳定可见，且输入可交互。
2. 连接成功后前端能收到 `state/snapshot`，包含窗口与 pane 列表。
3. 侧边栏在展开设备时拉取并展示窗口/Pane 树；点击 pane 可切换。
4. 访问 `/devices/:deviceId`（无 window/pane）时自动跳转到 active pane。
5. tmux 退出时能透传 reason（至少在断线前发 `event/device error`）。

## 实施步骤

### 1) Gateway：实现 control mode 输出块与正确 output 解码

- 修改 `apps/gateway/src/tmux/parser.ts`
  - 增加输出块状态机：`%begin/%end/%error`。
  - 实现 `%output/%extended-output` 的八进制转义解码（`\xxx`）。
  - 处理 `%exit [reason]`，通过回调上报。

### 2) Gateway：生成并广播 `state/snapshot`

- 修改 `apps/gateway/src/tmux/connection.ts`
  - `requestSnapshot()` 使用 `\t` 分隔的 format（避免 name 含空格歧义）。
  - 通过“命令队列 + 输出块回调”将 session/windows/panes 组装成 `StateSnapshotPayload`。
  - 新增 `onSnapshot` 回调。
  - 在 tmux/ssh 关闭时，如果存在 `%exit reason`，先 `onError()` 再 `onClose()`。

- 修改 `apps/gateway/src/ws/index.ts`
  - 接入 `onSnapshot`，广播 `state/snapshot` 给该 device 的所有 ws 客户端。

### 3) FE：引入单例 WebSocket store，侧边栏按展开加载

- 新增 `apps/fe/src/stores/tmux.ts`
  - 单例 WebSocket 连接、消息分发、snapshot 缓存、connect/disconnect/select/input/resize/paste API。

- 修改 `apps/fe/src/layouts/RootLayout.tsx`
  - 挂载时确保 ws 连接已建立。

- 修改 `apps/fe/src/components/Sidebar.tsx`
  - 展开设备时 `connectDevice(deviceId)` 拉 snapshot。
  - 渲染 `session.windows[].panes[]` 树。

- 修改 `apps/fe/src/pages/DevicePage.tsx`
  - 使用 tmux store 的 ws（不再自行 new WebSocket）。
  - URL 仅有 deviceId 时，收到 snapshot 后自动 navigate 到 active pane。

### 4) 测试与验证

- 新增 `apps/gateway/src/tmux/parser.test.ts`
  - 覆盖 `%begin/%end`、`%output` 解码、`%extended-output`、`%exit`。

- 端到端手工验证：启动 gateway+fe，连接设备，检查输出、树结构、切换、退出 reason。

## 风险与注意事项

- 输出块与命令队列依赖 FIFO 顺序；snapshot 请求需串行、不可并发乱序。
- `%extended-output` 需要稳健解析 `:` 分隔符。
- 前端改为单例 ws store 后，需注意组件卸载不要误关闭 socket（只在显式断开时关闭）。

