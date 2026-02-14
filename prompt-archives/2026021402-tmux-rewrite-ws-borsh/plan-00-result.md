# Plan-00 执行结果（阶段性）

## 摘要

已按 `plan-00.md` 的方向把 tmux 控制链路的 WS 协议切换为 `tmex-ws-borsh-v1`（全二进制 Borsh Envelope），并在 Gateway/FE 两侧接入了最小可用的握手、设备连接、状态快照、终端输出，以及 selectToken 切换屏障的核心消息流。

另外，已补齐并跑通 FE Playwright e2e，用例覆盖了 pane-active 跟随、resize、以及切换屏障在“快速连续点击”场景下旧事务 token 的严格丢弃（旧 token 不得收到 `LIVE_RESUME`）。

## 主要改动

- Shared（`@tmex/shared`）
  - 新增 `packages/shared/src/ws-borsh/`：`schema/kind/codec/chunk/convert/errors` + 单测。
  - `packages/shared/src/index.ts` 导出 `wsBorsh` 与 `b`，供 Gateway/FE 复用。
  - `packages/shared/package.json` 增加依赖 `@zorsh/zorsh@0.4.0`，并补充 `test` script。
- Gateway
  - `apps/gateway/src/ws/index.ts` 重写为 borsh 协议处理：HELLO 协商、PING/PONG、DEVICE_CONNECT、STATE_SNAPSHOT、TERM_OUTPUT、TMUX_SELECT（屏障链路）等。
  - 新增/完善 `apps/gateway/src/ws/borsh/*`：seq/分片发送修正、session state、switch barrier（ACK -> HISTORY -> LIVE_RESUME + 输出缓冲/flush）。
  - switch barrier 调整：history/ack 之后延迟发送 `LIVE_RESUME`（固定窗口），保证快速连续 select 时旧 token 的 `LIVE_RESUME` 可被取消并严格丢弃。
  - tmux 控制命令回复绑定：`TmuxControlParser` 在 `%begin` 时回调 meta，`TmuxConnection` 将 commandNo 与 command kind 显式绑定，避免纯 FIFO `shift()` 假设导致的错配风险。
  - bell：统一来源（`%bell` 与输出 `0x07`）并做去重；频控在 Gateway（WS 侧按 client+deviceId+paneId）。
  - `apps/gateway/src/events/index.ts` 修复 bell 直达链接中 windowId/paneId 未编码的问题（与现有测试用例对齐）。
  - `apps/gateway/package.json` 测试脚本默认使用 `DATABASE_URL=:memory:`，保证测试隔离与可重复执行。
- FE
  - `apps/fe/src/stores/tmux.ts` 改为使用 `BorshWebSocketClient` 发送/接收语义消息；接入 `SelectStateMachine` 分发 `SWITCH_ACK/TERM_HISTORY/LIVE_RESUME/TERM_OUTPUT`。
  - `apps/fe/src/components/terminal/Terminal.tsx` 改为通过 `SelectStateMachine` 的回调写入 xterm，避免在组件内再做 ws framing/协议解析。
  - 修复“history 不显示”：移除 `Terminal` 卸载时对 `SelectStateMachine.cleanup(deviceId)` 的调用（开发环境 `StrictMode` 双挂载会触发误清理，导致 deferred history 无法重放）；将 cleanup 下沉到真实断连路径（`disconnectDevice`、`DEVICE_DISCONNECTED`、`DEVICE_EVENT(disconnected)`）。
  - Playwright e2e：补齐 `ws-borsh-*` 用例，并修正“初始自动 select 可能已占用 token”的测试竞态（等待 token 变化而非仅等待非空）。

## 验证结果

- `bun run --filter @tmex/shared test`：通过（34/34）。
- `bun run --filter @tmex/gateway test`：通过（73/73）。
- `bun run --filter tmex-cli test`：通过（13/13）。
- `bun run --filter @tmex/fe test:e2e`：通过（13/13）。
- `bun run --filter @tmex/fe build`：通过。
- `bun run --filter @tmex/gateway build`：通过。

## 已知风险与待补齐

- bell 目前已在 Gateway 做来源去重与 WS 侧频控，但最终产品策略（例如 throttle 粒度、是否需要按 window/pane 维度区分、是否需要额外去重窗口/可配置化）仍需结合真实使用场景确认。
- switch barrier 的 `LIVE_RESUME` 固定延迟窗口会引入小幅切换延迟；后续可视体验与时序稳定性需要结合真实使用场景再做调参或可配置化。
