// WebSocket Borsh 协议 Schema 定义
// 参考: docs/ws-protocol/2026021402-ws-borsh-v1-spec.md

import { b } from '@zorsh/zorsh';

// ========== 基础类型 ==========

export const EnvelopeSchema = b.struct({
  magic: b.bytes(2),
  version: b.u16(),
  kind: b.u16(),
  flags: b.u16(),
  seq: b.u32(),
  payload: b.bytes(),
});

export const OptionU32Schema = b.option(b.u32());
export const OptionU16Schema = b.option(b.u16());
export const OptionStringSchema = b.option(b.string());

// ========== 会话/协商 ==========

export const HelloC2SSchema = b.struct({
  clientImpl: b.string(),
  clientVersion: b.string(),
  maxFrameBytes: b.u32(),
  supportsCompression: b.bool(),
  supportsDiffSnapshot: b.bool(),
});

export const HelloS2CSchema = b.struct({
  serverImpl: b.string(),
  serverVersion: b.string(),
  selectedVersion: b.u16(),
  maxFrameBytes: b.u32(),
  heartbeatIntervalMs: b.u32(),
  capabilities: b.vec(b.string()),
});

export const PingPongSchema = b.struct({
  nonce: b.u32(),
  timeMs: b.u64(),
});

export const ErrorSchema = b.struct({
  refSeq: OptionU32Schema,
  code: b.u16(),
  message: b.string(),
  retryable: b.bool(),
});

// ========== 设备连接 ==========

export const DeviceConnectSchema = b.struct({
  deviceId: b.string(),
});

export const DeviceConnectedSchema = b.struct({
  deviceId: b.string(),
});

export const DeviceDisconnectSchema = b.struct({
  deviceId: b.string(),
});

export const DeviceDisconnectedSchema = b.struct({
  deviceId: b.string(),
});

export const DeviceEventSchema = b.struct({
  deviceId: b.string(),
  eventType: b.u8(),
  errorType: OptionStringSchema,
  message: OptionStringSchema,
  rawMessage: OptionStringSchema,
});

// ========== tmux 控制 ==========

export const TmuxSelectSchema = b.struct({
  deviceId: b.string(),
  windowId: OptionStringSchema,
  paneId: OptionStringSchema,
  selectToken: b.bytes(16),
  wantHistory: b.bool(),
  cols: OptionU16Schema,
  rows: OptionU16Schema,
});

export const TmuxSelectWindowSchema = b.struct({
  deviceId: b.string(),
  windowId: b.string(),
});

export const TmuxCreateWindowSchema = b.struct({
  deviceId: b.string(),
  name: OptionStringSchema,
});

export const TmuxCloseWindowSchema = b.struct({
  deviceId: b.string(),
  windowId: b.string(),
});

export const TmuxClosePaneSchema = b.struct({
  deviceId: b.string(),
  paneId: b.string(),
});

export const TmuxRenameWindowSchema = b.struct({
  deviceId: b.string(),
  windowId: b.string(),
  name: b.string(),
});

export const TmuxEventSchema = b.struct({
  deviceId: b.string(),
  eventType: b.u8(),
  eventData: b.bytes(),
});

// ========== 终端数据 ==========

export const TermInputSchema = b.struct({
  deviceId: b.string(),
  paneId: b.string(),
  encoding: b.u8(),
  data: b.bytes(),
  isComposing: b.bool(),
});

export const TermPasteSchema = b.struct({
  deviceId: b.string(),
  paneId: b.string(),
  encoding: b.u8(),
  data: b.bytes(),
  isComposing: b.bool(),
});

export const TermResizeSchema = b.struct({
  deviceId: b.string(),
  paneId: b.string(),
  cols: b.u16(),
  rows: b.u16(),
});

export const TermSyncSizeSchema = TermResizeSchema;

export const TermOutputSchema = b.struct({
  deviceId: b.string(),
  paneId: b.string(),
  encoding: b.u8(),
  data: b.bytes(),
});

export const TermHistorySchema = b.struct({
  deviceId: b.string(),
  paneId: b.string(),
  selectToken: b.bytes(16),
  encoding: b.u8(),
  data: b.bytes(),
});

// ========== 切换屏障 ==========

export const SwitchAckSchema = b.struct({
  deviceId: b.string(),
  windowId: b.string(),
  paneId: b.string(),
  selectToken: b.bytes(16),
});

export const LiveResumeSchema = b.struct({
  deviceId: b.string(),
  paneId: b.string(),
  selectToken: b.bytes(16),
});

// ========== 分片 ==========

export const ChunkSchema = b.struct({
  chunkStreamId: b.u32(),
  originalKind: b.u16(),
  originalSeq: b.u32(),
  totalChunks: b.u16(),
  chunkIndex: b.u16(),
  data: b.bytes(),
});

// ========== State Snapshot ==========

export const PaneWireSchema = b.struct({
  id: b.string(),
  windowId: b.string(),
  index: b.u16(),
  title: OptionStringSchema,
  active: b.bool(),
  width: b.u16(),
  height: b.u16(),
});

export const WindowWireSchema = b.struct({
  id: b.string(),
  name: b.string(),
  index: b.u16(),
  active: b.bool(),
  panes: b.vec(PaneWireSchema),
});

export const SessionWireSchema = b.struct({
  id: b.string(),
  name: b.string(),
  windows: b.vec(WindowWireSchema),
});

export const StateSnapshotSchema = b.struct({
  deviceId: b.string(),
  session: b.option(SessionWireSchema),
});

export const StateSnapshotDiffSchema = b.struct({
  deviceId: b.string(),
  baseRevision: b.u32(),
  revision: b.u32(),
  diffFormat: b.u8(),
  diffBytes: b.bytes(),
});

// ========== TMUX_EVENT 子 Schema ==========

export const WindowAddEventSchema = b.struct({
  windowId: b.string(),
});

export const WindowCloseEventSchema = b.struct({
  windowId: b.string(),
});

export const WindowRenamedEventSchema = b.struct({
  windowId: b.string(),
  name: b.string(),
});

export const WindowActiveEventSchema = b.struct({
  windowId: b.string(),
});

export const PaneAddEventSchema = b.struct({
  paneId: b.string(),
  windowId: b.string(),
});

export const PaneCloseEventSchema = b.struct({
  paneId: b.string(),
});

export const PaneActiveEventSchema = b.struct({
  windowId: b.string(),
  paneId: b.string(),
});

export const LayoutChangeEventSchema = b.struct({
  windowId: b.string(),
  layout: b.string(),
});

export const BellEventSchema = b.struct({
  windowId: OptionStringSchema,
  paneId: OptionStringSchema,
  windowIndex: OptionU16Schema,
  paneIndex: OptionU16Schema,
  paneUrl: OptionStringSchema,
});
