# tmex-ws-borsh-v1：WebSocket 二进制协议规范（设计稿）

> 状态：设计稿（未实现 / 迁移中）。
>
> 适用范围：`apps/gateway` <-> `apps/fe`。
>
> 编解码实现：统一放在 `packages/shared/src/ws-borsh/`，两端复用。

## 背景

当前链路存在这些结构性问题：

- 协议混合（JSON + 自定义二进制 output），难以做一致的顺序保证与版本演进。
- pane 切换与 history/live 合并缺少事务屏障，容易出现乱序、丢失、重复。
- resize、bell、事件语义分散，难以系统性测试与回归。

因此定义 `tmex-ws-borsh-v1`：基于 Borsh 的全二进制 WS 协议，配合 `selectToken` 屏障与状态机，提供确定性行为。

## 依赖与约束

- 依赖：`@zorsh/zorsh`。
- 编码规则遵循 Borsh：
  - 整数小端序。
  - `string` 为 `u32` 长度前缀 + UTF-8 bytes。
  - `bytes()` 为 `Vec<u8>`（`u32` 长度前缀 + raw bytes）。
  - `bytes(N)` 为 `[u8; N]` 固定长度，无长度前缀。
  - `vec(T)` 为 `u32` 长度前缀 + 连续元素。
  - `option(T)` 为 `u8` discriminator（0/1）+ value。

实现约束：

- wire 层禁止直接使用 `hashMap/hashSet`（顺序不确定）。映射/集合统一用 `vec(entry)` 表示。
- 协议版本使用 `Envelope.version` 显式演进。
- 消息类型使用显式 `kind(u16)`，不使用 `b.enum(...)` 变体序号（避免对象 key 顺序风险）。

## 术语

- **Envelope**：每条 WS binary message 的最外层结构。
- **kind**：消息类型编号（`u16`）。
- **seq**：发送方单调递增序号（连接内），用于日志与关联错误。
- **selectToken**：pane 切换事务 token（16 bytes），用于屏障与乱序丢弃。
- **CHUNK**：超大 payload 的分片承载消息。

## 帧大小与分片

- 默认最大帧：`MAX_FRAME_BYTES = 1_048_576`（1MiB）。
- HELLO 协商：实际生效的最大帧大小为：
  - `effectiveMaxFrameBytes = min(client.maxFrameBytes, server.maxFrameBytes)`。
- 任意消息若编码后超过 `effectiveMaxFrameBytes`，必须使用 `CHUNK` 分片发送。

## Envelope（固定外层）

zorsh schema（参考实现，最终以 `packages/shared/src/ws-borsh/schema.ts` 为准）：

```ts
import { b } from "@zorsh/zorsh";

export const EnvelopeSchema = b.struct({
  magic: b.bytes(2),
  version: b.u16(),
  kind: b.u16(),
  flags: b.u16(),
  seq: b.u32(),
  payload: b.bytes(),
});
```

字段语义：

- `magic`：固定为 `0x54 0x58`（ASCII "TX"）。用于新旧协议分流。
- `version`：当前为 `1`。
- `kind`：消息类型编号（见后文表）。
- `flags`：通用标记位（见后文）。
- `seq`：发送方连接内自增（从 1 开始），重连后重置。
- `payload`：kind 对应的 payload bytes（Borsh 编码）。

## flags（通用标记位）

- bit0 `ACK_REQUIRED`：请求端希望对端用 `ERROR` 或业务级 ACK 响应。
- bit1 `IS_ACK`：该 Envelope 是通用 ACK（v1 预留，当前不使用，pane 切换走 `SWITCH_ACK`）。
- bit2 `IS_ERROR`：该 Envelope 是错误（v1 预留，当前统一用 kind=ERROR）。
- bit3 `IS_CHUNK`：该 Envelope 为分片（v1 预留，当前统一用 kind=CHUNK）。
- bit4 `IS_COMPRESSED`：payload 压缩（v1 保留，默认 0）。
- bit5..15：保留。

## kind 编号表（完整）

> 方向：C2S=客户端到服务端，S2C=服务端到客户端，BIDI=双向。

### 会话/协商（0x0001-0x00FF）

| kind | 名称 | 方向 | 说明 |
|---:|---|---|---|
| 0x0001 | HELLO_C2S | C2S | 客户端能力协商与参数声明 |
| 0x0002 | HELLO_S2C | S2C | 服务端确认参数与能力 |
| 0x0003 | PING | BIDI | 心跳 |
| 0x0004 | PONG | BIDI | 心跳 |
| 0x0005 | ERROR | BIDI | 错误回包（含 refSeq） |

### 设备连接（0x0100-0x01FF）

| kind | 名称 | 方向 | 说明 |
|---:|---|---|---|
| 0x0101 | DEVICE_CONNECT | C2S | 连接设备 |
| 0x0102 | DEVICE_CONNECTED | S2C | 设备已连接 |
| 0x0103 | DEVICE_DISCONNECT | C2S | 断开设备 |
| 0x0104 | DEVICE_DISCONNECTED | S2C | 设备已断开 |
| 0x0105 | DEVICE_EVENT | S2C | 设备事件（错误/重连等） |

### tmux 控制（0x0200-0x02FF）

| kind | 名称 | 方向 | 说明 |
|---:|---|---|---|
| 0x0201 | TMUX_SELECT | C2S | 选择 window/pane（带 selectToken） |
| 0x0202 | TMUX_SELECT_WINDOW | C2S | 仅选择 window |
| 0x0203 | TMUX_CREATE_WINDOW | C2S | 新建 window |
| 0x0204 | TMUX_CLOSE_WINDOW | C2S | 关闭 window |
| 0x0205 | TMUX_CLOSE_PANE | C2S | 关闭 pane |
| 0x0206 | TMUX_RENAME_WINDOW | C2S | 重命名 window |
| 0x0207 | TMUX_EVENT | S2C | tmux 事件（pane-active/bell 等） |
| 0x0208 | STATE_SNAPSHOT | S2C | tmux 状态快照 |
| 0x0209 | STATE_SNAPSHOT_DIFF | S2C | 快照 diff（v1 保留，可忽略） |

### 终端数据（0x0300-0x03FF）

| kind | 名称 | 方向 | 说明 |
|---:|---|---|---|
| 0x0301 | TERM_INPUT | C2S | 终端输入（bytes） |
| 0x0302 | TERM_PASTE | C2S | 粘贴（分块发送） |
| 0x0303 | TERM_RESIZE | C2S | resize（本地视口为源） |
| 0x0304 | TERM_SYNC_SIZE | C2S | 同步尺寸（语义同 TERM_RESIZE，便于区分来源） |
| 0x0305 | TERM_OUTPUT | S2C | 终端输出（raw bytes） |
| 0x0306 | TERM_HISTORY | S2C | 历史输出（与 selectToken 绑定） |

### 切换屏障（0x0400-0x04FF）

| kind | 名称 | 方向 | 说明 |
|---:|---|---|---|
| 0x0401 | SWITCH_ACK | S2C | 选择事务 ACK（开始屏障） |
| 0x0402 | LIVE_RESUME | S2C | 解除屏障（从此刻起 live 可直写） |

### 分片（0x0500-0x05FF）

| kind | 名称 | 方向 | 说明 |
|---:|---|---|---|
| 0x0501 | CHUNK | BIDI | 超大 payload 分片承载 |

## payload schemas（完整）

> 本节描述“字段语义 + wire 类型”。最终 schema 以 shared 代码为准。

### HELLO_C2S（0x0001）

字段：

- `clientImpl: string`（例：`tmex-fe`）
- `clientVersion: string`（例：`0.1.0`）
- `maxFrameBytes: u32`（客户端可接收最大帧）
- `supportsCompression: bool`（v1 固定 false）
- `supportsDiffSnapshot: bool`（v1 固定 false，保留）

约束：

- 客户端必须在 WS open 后第一条发送 HELLO_C2S。

### HELLO_S2C（0x0002）

字段：

- `serverImpl: string`（`tmex-gateway`）
- `serverVersion: string`
- `selectedVersion: u16`（当前 1）
- `maxFrameBytes: u32`（服务端可接收最大帧）
- `heartbeatIntervalMs: u32`（默认 15000）
- `capabilities: vec(string)`

### PING/PONG（0x0003/0x0004）

字段：

- `nonce: u32`
- `timeMs: u64`（可选：用于测 RTT/时钟偏差；如果不需要可固定为 0）

### ERROR（0x0005）

字段：

- `refSeq: option(u32)`（关联的请求 seq；无则 null）
- `code: u16`
- `message: string`
- `retryable: bool`

错误码定义（v1 最小集合）：

- `1001 UNSUPPORTED_PROTOCOL`
- `1002 INVALID_FRAME`
- `1003 UNKNOWN_KIND`
- `1004 PAYLOAD_DECODE_FAILED`
- `1005 FRAME_TOO_LARGE`
- `1101 DEVICE_NOT_FOUND`
- `1102 DEVICE_CONNECT_FAILED`
- `1201 TMUX_TARGET_NOT_FOUND`
- `1202 TMUX_NOT_READY`
- `1301 SELECT_CONFLICT`
- `1302 SELECT_TOKEN_MISMATCH`
- `1401 INTERNAL_ERROR`

### DEVICE_CONNECT / DEVICE_DISCONNECT（0x0101/0x0103）

字段：

- `deviceId: string`

### DEVICE_CONNECTED / DEVICE_DISCONNECTED（0x0102/0x0104）

字段：

- `deviceId: string`

### DEVICE_EVENT（0x0105）

字段：

- `deviceId: string`
- `eventType: u8`
  - 1 `tmux-missing`
  - 2 `disconnected`
  - 3 `error`
  - 4 `reconnected`
- `errorType: option(string)`（用于 FE 展示：如 reconnecting/reconnect_failed 等）
- `message: option(string)`
- `rawMessage: option(string)`

### TMUX_SELECT（0x0201）

字段：

- `deviceId: string`
- `windowId: option(string)`
- `paneId: option(string)`
- `selectToken: bytes(16)`（随机 16 bytes，视作 opaque token）
- `wantHistory: bool`
- `cols: option(u16)`
- `rows: option(u16)`

语义：

- `selectToken` 标识一次选择事务。
- Gateway 必须返回：`SWITCH_ACK(selectToken)`，并按需发送 `TERM_HISTORY(selectToken)`，最后 `LIVE_RESUME(selectToken)`。

### TMUX_SELECT_WINDOW（0x0202）

字段：

- `deviceId: string`
- `windowId: string`

### TMUX_CREATE_WINDOW（0x0203）

字段：

- `deviceId: string`
- `name: option(string)`

### TMUX_CLOSE_WINDOW（0x0204）

字段：

- `deviceId: string`
- `windowId: string`

### TMUX_CLOSE_PANE（0x0205）

字段：

- `deviceId: string`
- `paneId: string`

### TMUX_RENAME_WINDOW（0x0206）

字段：

- `deviceId: string`
- `windowId: string`
- `name: string`

### TMUX_EVENT（0x0207）

字段：

- `deviceId: string`
- `eventType: u8`
  - 1 window-add
  - 2 window-close
  - 3 window-renamed
  - 4 window-active
  - 5 pane-add
  - 6 pane-close
  - 7 pane-active
  - 8 layout-change
  - 9 bell
- `eventData: bytes()`（按 eventType 使用子 schema 解码）

子 schema（v1）：

- window-add：`{ windowId: string }`
- window-close：`{ windowId: string }`
- window-renamed：`{ windowId: string; name: string }`
- window-active：`{ windowId: string }`
- pane-add：`{ paneId: string; windowId: string }`
- pane-close：`{ paneId: string }`
- pane-active：`{ windowId: string; paneId: string }`
- layout-change：`{ windowId: string; layout: string }`
- bell：
  - `windowId: option(string)`
  - `paneId: option(string)`
  - `windowIndex: option(u16)`
  - `paneIndex: option(u16)`
  - `paneUrl: option(string)`

### STATE_SNAPSHOT（0x0208）

字段：

- `deviceId: string`
- `session: option(SessionWire)`

SessionWire：

- `id: string`
- `name: string`
- `windows: vec(WindowWire)`

WindowWire：

- `id: string`
- `name: string`
- `index: u16`
- `active: bool`
- `panes: vec(PaneWire)`

PaneWire：

- `id: string`
- `windowId: string`
- `index: u16`
- `title: option(string)`
- `active: bool`
- `width: u16`
- `height: u16`

### STATE_SNAPSHOT_DIFF（0x0209，v1 保留）

字段：

- `deviceId: string`
- `baseRevision: u32`
- `revision: u32`
- `diffFormat: u8`（保留）
- `diffBytes: bytes()`

语义：

- v1 默认不启用；客户端在不支持时可以忽略。

### TERM_INPUT（0x0301）

字段：

- `deviceId: string`
- `paneId: string`
- `encoding: u8`（2=utf8-bytes）
- `data: bytes()`
- `isComposing: bool`

### TERM_PASTE（0x0302）

字段同 TERM_INPUT，但 `isComposing` 固定 false。

### TERM_RESIZE / TERM_SYNC_SIZE（0x0303/0x0304）

字段：

- `deviceId: string`
- `paneId: string`
- `cols: u16`
- `rows: u16`

### TERM_OUTPUT（0x0305）

字段：

- `deviceId: string`
- `paneId: string`
- `encoding: u8`（1=raw-bytes）
- `data: bytes()`

约束：

- 服务端必须按“当前客户端订阅的 pane”过滤 output。
- 在 `LIVE_RESUME(selectToken)` 之前属于屏障期的 output 必须缓冲，不得提前下发。

### TERM_HISTORY（0x0306）

字段：

- `deviceId: string`
- `paneId: string`
- `selectToken: bytes(16)`
- `encoding: u8`（2=utf8-bytes）
- `data: bytes()`

### SWITCH_ACK（0x0401）

字段：

- `deviceId: string`
- `windowId: string`
- `paneId: string`
- `selectToken: bytes(16)`

### LIVE_RESUME（0x0402）

字段：

- `deviceId: string`
- `paneId: string`
- `selectToken: bytes(16)`

### CHUNK（0x0501）

字段：

- `chunkStreamId: u32`
- `originalKind: u16`
- `originalSeq: u32`
- `totalChunks: u16`
- `chunkIndex: u16`
- `data: bytes()`（原消息的 payload bytes 片段）

重组规则：

- 收到 `CHUNK` 后按 `chunkStreamId` 聚合，收齐 `totalChunks` 后按 `chunkIndex` 拼接 `data`。
- 拼接得到 `originalPayloadBytes` 后，用 `originalKind` 解码为对应 payload。
- 超时（默认 5s）或重复/越界 index：丢弃并回 `ERROR(code=1002)`。

## 关键时序（必须遵守）

### 1) 连接协商

1. WS open。
2. Client -> `HELLO_C2S`。
3. Server -> `HELLO_S2C`。
4. 进入 READY，开始允许业务消息。

### 2) 选择屏障（切 pane）

Client -> `TMUX_SELECT(selectToken, wantHistory, cols/rows)`

Server 必须按序发送：

1. `SWITCH_ACK(selectToken)`
2. （可选）`TERM_HISTORY(selectToken)`
3. `LIVE_RESUME(selectToken)`

并且：

- `LIVE_RESUME` 之前产生的 output 必须缓冲；`LIVE_RESUME` 发出后先 flush，再实时下发。

## 兼容与迁移

- Gateway 迁移期同时支持：
  - 新协议：WS binary 且 `magic == TX`。
  - 旧协议：JSON 文本帧 + 旧 output 二进制帧。
- FE 提供 feature flag：优先使用 borsh，失败则回退旧协议。

