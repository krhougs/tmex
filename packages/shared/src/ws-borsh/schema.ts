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
  cwd: OptionStringSchema,
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

export const TmuxSetWindowStyleSchema = b.struct({
  deviceId: b.string(),
  style: b.string(),
});

export const TmuxReorderWindowsSchema = b.struct({
  deviceId: b.string(),
  windowIds: b.vec(b.string()),
});

export const TmuxReorderPanesSchema = b.struct({
  deviceId: b.string(),
  windowId: b.string(),
  paneIds: b.vec(b.string()),
});

export const TmuxEventSchema = b.struct({
  deviceId: b.string(),
  eventType: b.u8(),
  eventData: b.bytes(),
});

// ========== 分屏（split screen） ==========

// 幂等全量声明：除焦点 pane（selectedPanes）外还要接收输出的 pane 集合
export const TmuxSubscribePanesSchema = b.struct({
  deviceId: b.string(),
  paneIds: b.vec(b.string()),
});

// 拉取非焦点 pane 的首屏历史；回包复用 KIND_TERM_HISTORY，selectToken = requestToken
export const TmuxFetchPaneHistorySchema = b.struct({
  deviceId: b.string(),
  paneId: b.string(),
  requestToken: b.bytes(16),
});

// splitter 拖拽提交：resize-pane 绝对值（cols/rows 至少一个）
export const TmuxResizePaneSchema = b.struct({
  deviceId: b.string(),
  paneId: b.string(),
  cols: OptionU16Schema,
  rows: OptionU16Schema,
});

// 移动端拼接布局：resize-window 到 N*cols+(N-1) x rows + select-layout even-horizontal
export const TmuxApplyStackedLayoutSchema = b.struct({
  deviceId: b.string(),
  windowId: b.string(),
  cols: b.u16(),
  rows: b.u16(),
});

// direction: 1=right(-h) 2=down(-v)
export const TmuxSplitPaneSchema = b.struct({
  deviceId: b.string(),
  paneId: b.string(),
  direction: b.u8(),
  cwd: OptionStringSchema,
});

// 分屏内轻量焦点切换：select-window/select-pane，无 barrier/history/reset
export const TmuxFocusPaneSchema = b.struct({
  deviceId: b.string(),
  windowId: b.string(),
  paneId: b.string(),
});

// pane 自定义名（gateway 内存 overlay，空串 = 恢复自动名）
export const TmuxRenamePaneSchema = b.struct({
  deviceId: b.string(),
  paneId: b.string(),
  name: b.string(),
});

// 拖拽重排：把 srcPane 移到 dstPane 的某一侧（tmux move-pane）
// position: 1=left 2=right 3=top 4=bottom
export const TmuxMovePaneSchema = b.struct({
  deviceId: b.string(),
  srcPaneId: b.string(),
  dstPaneId: b.string(),
  position: b.u8(),
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
  alternateScreen: b.bool(),
  data: b.bytes(),
});

// ========== 剪贴板 ==========

export const ClipboardWriteSchema = b.struct({
  deviceId: b.string(),
  paneId: b.string(),
  text: b.string(),
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
  customName: OptionStringSchema,
  active: b.bool(),
  width: b.u16(),
  height: b.u16(),
  currentPath: OptionStringSchema,
  currentCommand: OptionStringSchema,
  left: OptionU16Schema,
  top: OptionU16Schema,
});

export const WindowWireSchema = b.struct({
  id: b.string(),
  name: b.string(),
  customName: OptionStringSchema,
  index: b.u16(),
  active: b.bool(),
  layout: OptionStringSchema,
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

// ========== Agent ==========

export const AgentSubscribeSchema = b.struct({
  sessionId: b.string(),
});

export const AgentUnsubscribeSchema = b.struct({
  sessionId: b.string(),
});

// payload 为 JSON bytes（形状约定见 ./agent.ts），先例：TmuxEventSchema.eventData
export const AgentEventSchema = b.struct({
  sessionId: b.string(),
  seq: b.u32(),
  eventType: b.u8(),
  payload: b.bytes(),
});

// ========== Watch ==========

export const WatchEventSchema = b.struct({
  ruleId: b.string(),
  deviceId: b.string(),
  paneId: b.string(),
  eventType: b.u8(),
  payload: b.bytes(),
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
  paneTitle: OptionStringSchema,
  paneCurrentCommand: OptionStringSchema,
});

export const NotificationEventSchema = b.struct({
  source: b.u8(),
  title: OptionStringSchema,
  body: b.string(),
  windowId: OptionStringSchema,
  paneId: OptionStringSchema,
  windowIndex: OptionU16Schema,
  paneIndex: OptionU16Schema,
  paneUrl: OptionStringSchema,
  paneTitle: OptionStringSchema,
  paneCurrentCommand: OptionStringSchema,
});
