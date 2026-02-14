# ws-borsh-v1 状态机设计（Gateway + FE）

> 状态：设计稿（未实现 / 迁移中）。
>
> 目标：用明确状态机替代分散的隐式逻辑，保证 pane 切换、history/live 合并、resize、bell 的确定性。

## 设计原则

- **显式状态**：所有跨消息的流程（切换/缓冲/历史）必须有状态与 token。
- **不变量优先**：先定义必须成立的规则，再写实现。
- **超时与降级**：任何流程都必须有超时兜底，避免卡死。
- **幂等与去重**：重复消息不产生副作用；过期 token 一律丢弃。

## 全局不变量（必须满足）

1. 每个 `deviceId` 在每个客户端上同时最多只有一个“当前活跃选择事务”。
2. `LIVE_RESUME(selectToken)` 之前不允许把 live output 直接写入终端。
3. `TERM_HISTORY(selectToken)` 只能应用到匹配 token 的事务。
4. 任何消息若 token 不匹配或事务已被新事务替代，必须丢弃。
5. resize 以浏览器视口为源（FE），Gateway 仅做同步与 tmux client/pty 对齐。
6. bell 去重与频控必须在 Gateway 统一，FE 仅展示。

---

## 1) WS 连接状态机（FE）

### 状态

- `IDLE`
- `WS_CONNECTING`
- `HELLO_NEGOTIATING`
- `READY`
- `RECONNECT_BACKOFF`
- `CLOSED`

### 事件

- `connect()`
- `ws_open`
- `hello_s2c`
- `ws_error/ws_close`
- `backoff_timeout`
- `disconnect()`

### 转移

- `IDLE -> WS_CONNECTING`：调用 `connect()`。
- `WS_CONNECTING -> HELLO_NEGOTIATING`：WS open 发送 `HELLO_C2S`。
- `HELLO_NEGOTIATING -> READY`：收到 `HELLO_S2C`。
- `READY -> RECONNECT_BACKOFF`：ws close/error。
- `RECONNECT_BACKOFF -> WS_CONNECTING`：backoff 到期。
- 任意状态 `-> CLOSED`：手动断开。

### 超时

- HELLO 超时：3s。超时则 close 并进入 backoff。

### 关键实现点

- `seq` 在单条 ws 连接内单调递增；重连后从 1 重置。
- READY 前的业务消息进入队列缓存，READY 后 flush。

---

## 2) 设备连接状态机（FE，按 deviceId）

### 状态

- `DETACHED`
- `CONNECTING`
- `CONNECTED`
- `FAILED`
- `DISCONNECTING`

### 转移

- `DETACHED -> CONNECTING`：发 `DEVICE_CONNECT`。
- `CONNECTING -> CONNECTED`：收 `DEVICE_CONNECTED`。
- `CONNECTING/CONNECTED -> FAILED`：收 `DEVICE_EVENT(error)`。
- `CONNECTED -> DISCONNECTING`：发 `DEVICE_DISCONNECT`。
- `DISCONNECTING -> DETACHED`：收 `DEVICE_DISCONNECTED`。

### 关键实现点

- FAILED 状态下允许用户重试 connect（回到 CONNECTING）。

---

## 3) 选择事务状态机（FE，按 deviceId）

> 这是最关键的状态机，决定 history/live 合并与输出门控。

### 状态

- `STABLE`：当前 pane 已处于 LIVE。
- `SELECTING`：已发送 `TMUX_SELECT(token)`，等待 `SWITCH_ACK`。
- `ACKED`：收到 `SWITCH_ACK(token)`。
- `HISTORY_APPLIED`：已应用 `TERM_HISTORY(token)`。
- `LIVE`：收到 `LIVE_RESUME(token)` 并已 flush 缓冲。
- `SELECT_FAILED`：超时/错误。

### 事件

- `selectRequested(token, paneId, windowId)`：由路由变化或 `pane-active` 事件触发。
- `switchAck(token)`
- `history(token, bytes)`
- `liveResume(token)`
- `error(token?/refSeq?)`
- `timeout`

### 转移规则

1. `STABLE -> SELECTING`：触发新选择事务。
2. `SELECTING -> ACKED`：收到 `SWITCH_ACK(token)`。
3. `ACKED -> HISTORY_APPLIED`：收到 `TERM_HISTORY(token)`（若 wantHistory=true）。
4. `ACKED/HISTORY_APPLIED -> LIVE`：收到 `LIVE_RESUME(token)`。
5. `LIVE -> STABLE`：标记该 token 成为当前稳定 pane。

并发/替换：

- 任意状态收到 `selectRequested(newToken)`：
  - 立刻废弃旧 token（清空缓冲、停止等待）。
  - 进入 `SELECTING(newToken)`。

失败：

- `SELECTING/ACKED/HISTORY_APPLIED` 超时 -> `SELECT_FAILED`。
- `SELECT_FAILED` 可回退到上一个 `STABLE` 的 pane（若存在），或保持空白并提示。

### 超时策略（建议值）

- ACK 超时：1.5s。
- HISTORY 超时：1.5s（到期允许无历史继续）。
- LIVE_RESUME 超时：2.0s（到期允许继续，但记录错误并触发重新 select）。

---

## 4) 输出门控状态机（FE，按 deviceId）

### 状态

- `FLOWING`：直接写入终端。
- `BUFFERING`：缓冲 output bytes。

### 规则

- 进入新 `SELECTING` 时强制切到 `BUFFERING`。
- 收到 `LIVE_RESUME(token)` 时：
  1. 把缓冲 output 依次写入终端。
  2. 切回 `FLOWING`。
- 若收到 output 时处于 BUFFERING：追加到缓冲。

不变量：

- BUFFERING 期间绝不直接 write 到 xterm。

---

## 5) Resize 状态机（FE，按 deviceId+paneId）

### 状态

- `IDLE`
- `PENDING_DEBOUNCE`
- `SENT`

### 规则

- Resize 触发源：ResizeObserver + FitAddon。
- 去重：cols/rows 未变化不发送。
- debounce：80ms。
- `TMUX_SELECT` 可以携带 cols/rows 作为首包同步。
- `TERM_RESIZE` 与 `TERM_SYNC_SIZE` 语义一致；建议：
  - `TERM_SYNC_SIZE` 用于 “select 后强制同步”
  - `TERM_RESIZE` 用于 “正常容器变化”

---

## 6) Bell 状态机（Gateway，按 deviceId+paneId）

### 状态

- `ALLOW`
- `THROTTLED(untilMs)`

### 规则

- bell 事件来源统一：
  - 优先 tmux 控制事件 `%bell`
  - 兼容输出 0x07 作为兜底
  - 两者进入统一去重/频控逻辑
- 频控参数来自 site settings：`bellThrottleSeconds`。
- THROTTLED 期间相同 pane 的 bell 不再推送。

---

## 7) Gateway 侧设备连接状态机（DeviceConnectionEntry）

> 对应 `apps/gateway/src/ws/index.ts` 的 device entry 管理与重连。

### 状态

- `NONE`：无 entry
- `CONNECTING`
- `ACTIVE`：tmux ready，能处理命令与输出
- `RECONNECTING`：自动重连中
- `CLOSING`

### 规则

- clients 集合为空时进入 CLOSING 并断开 tmux。
- clients 不为空且断链时进入 RECONNECTING（按 settings 重试次数与间隔）。
- RECONNECTING 成功后发送 `DEVICE_EVENT(reconnected)` 并主动推 snapshot。

---

## 8) Tmux 输出与命令回复匹配（Gateway 内部）

要求：

- 不能依赖纯 FIFO `shift()` 来把 tmux 输出块与命令类型绑定。
- 必须将“发送队列”与“收到 %begin 时绑定 commandNo”做关联；输出块以 `%begin/%end` 的 commandNo/flags/time 作为真实边界。

这样才能在 output 与 reply 交错时仍保持确定性。

