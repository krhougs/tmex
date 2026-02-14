# 终端切换屏障（selectToken）设计

> 状态：设计稿（未实现 / 迁移中）。
>
> 目标：解决 pane 切换时 history/live 乱序、丢失、重复，以及“切换后短时间输出写到错误 pane”的问题。

## 背景与问题

当前实现大致依赖：

- Gateway：`tmux/select` 后 `capture-pane` 推 `term/history`。
- FE：先写 history，再把 live buffer 追加。

但缺少明确的事务边界，导致：

- live output 可能在 history 之前到达并被写入，随后 history 覆盖，造成乱序。
- 用户快速切换 pane 时，旧 pane 的 history/live 可能写入新 pane。
- 历史订阅与 select 的时机竞态，导致偶发“无历史/白屏”。

## 核心思路

- 每次选择事务由客户端生成 `selectToken(16 bytes)`。
- 服务端必须按序发送三段式屏障消息：
  1. `SWITCH_ACK(selectToken)`：确认切换事务开始。
  2. `TERM_HISTORY(selectToken)`：发送与该 token 绑定的历史（可选）。
  3. `LIVE_RESUME(selectToken)`：解除屏障，从此刻起 live output 才能直写。

并且：

- `LIVE_RESUME` 之前产生的 live output 必须缓冲，不能提前下发到 FE。

## 端到端时序

```text
FE                        Gateway                         tmux
 |  TMUX_SELECT(token)      |                               |
 |------------------------->| select window/pane            |
 |                          |------------------------------>|
 |                          | SWITCH_ACK(token)             |
 |<-------------------------|                               |
 | (reset terminal, gate)   | capture-pane/history          |
 |                          |------------------------------>|
 |                          | TERM_HISTORY(token)           |
 |<-------------------------|                               |
 | (apply history)          | LIVE_RESUME(token)            |
 |<-------------------------| (flush buffered output)       |
 | (flush buffered output)  | TERM_OUTPUT (live)            |
 |<-------------------------|<------------------------------|
```

## Gateway 侧实现要求

### 1) per-client 事务状态

每个 ws client、每个 deviceId 维护：

- `currentSelection: { windowId, paneId } | null`
- `pendingToken: Uint8Array(16) | null`
- `barrierState: 'idle' | 'acked' | 'history_sent' | 'live'`
- `outputBuffer: Uint8Array[]`（屏障期缓冲）

### 2) 收到 TMUX_SELECT(token)

必须按以下顺序执行：

1. 记录 `pendingToken = token`，清空旧 buffer。
2. 立即把该 client 的订阅过滤目标切到新 pane（避免 output 路由错误）。
3. 下发 `SWITCH_ACK(token)`。
4. 若请求带 cols/rows：先同步 resize（transport pty + tmux client）。
5. 执行 tmux select（window/pane）。
6. 若 `wantHistory=true`：执行 `capture-pane`（normal + alternate + mode）并在完成后下发 `TERM_HISTORY(token)`。
7. 下发 `LIVE_RESUME(token)`，并把屏障期缓冲的 output flush 给该 client。

### 3) output 缓冲策略

- 屏障未解除（未发 LIVE_RESUME）时：把输出 append 到 `outputBuffer`。
- LIVE_RESUME 发出后：
  - 先 flush buffer，再把后续 output 直接发送。

### 4) 超时与降级

- capture history 超时：允许发送空 history（或跳过 history），但仍必须发送 LIVE_RESUME 以解除屏障。
- 若 tmux select 失败（target missing）：
  - 发送 `ERROR(refSeq)`
  - 并尝试回退到上一次稳定选择（如果存在）。

## FE 侧实现要求

### 1) 事务触发源

- 路由变化（URL 中 windowId/paneId）。
- 收到 `TMUX_EVENT(pane-active)`（同 deviceId，自动跟随）。

触发后：

1. 生成 `selectToken(16 bytes)`。
2. 发送 `TMUX_SELECT(token, wantHistory=true, cols/rows)`。
3. 对自动跟随的路由跳转使用 `navigate(..., { replace: true })`。

### 2) Terminal gate（写入门控）

- 收到 `SWITCH_ACK(token)`：
  - reset xterm（清空屏幕与状态）
  - 进入 gate 状态：禁止写入 live output，改为本地 buffer。
- 收到 `TERM_HISTORY(token)`：
  - 写入 history
  - 标记 historyApplied
- 收到 `LIVE_RESUME(token)`：
  - flush 本地 buffer
  - 解除 gate：后续 output 直写

### 3) 并发与替换

- 若在旧 token 未完成时用户又触发新 token：
  - 立即丢弃旧 token 的 history/output
  - reset 终端，以新 token 为准

### 4) 失败处理

- 若 ACK/HISTORY/RESUME 超时：
  - 显示提示（toast/状态条）
  - 允许用户重试 select

## 关键边界条件

- 用户快速切换 pane：必须保证旧 token 的输出不会写入新 pane。
- history 很大：必须支持 CHUNK 分片与重组。
- 设备断线/重连：需要将当前 token 状态清空，并重新触发 select。

## 验收用例（必须覆盖）

1. output 先到、history 后到：最终显示顺序为 history -> output。
2. history 先到、output 后到：正常。
3. 切换期间连续多次 select：只有最后一次生效。
4. history capture 失败：仍能进入 live，且不会卡死。

