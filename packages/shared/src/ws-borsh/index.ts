// WebSocket Borsh 协议模块
// 参考: docs/ws-protocol/2026021402-ws-borsh-v1-spec.md

// 重新导出 zorsh b 命名空间供类型使用
export { b } from '@zorsh/zorsh';

// ========== Kind 常量 ==========
export {
  KIND_HELLO_C2S,
  KIND_HELLO_S2C,
  KIND_PING,
  KIND_PONG,
  KIND_ERROR,
  KIND_DEVICE_CONNECT,
  KIND_DEVICE_CONNECTED,
  KIND_DEVICE_DISCONNECT,
  KIND_DEVICE_DISCONNECTED,
  KIND_DEVICE_EVENT,
  KIND_TMUX_SELECT,
  KIND_TMUX_SELECT_WINDOW,
  KIND_TMUX_CREATE_WINDOW,
  KIND_TMUX_CLOSE_WINDOW,
  KIND_TMUX_CLOSE_PANE,
  KIND_TMUX_RENAME_WINDOW,
  KIND_TMUX_EVENT,
  KIND_STATE_SNAPSHOT,
  KIND_STATE_SNAPSHOT_DIFF,
  KIND_TMUX_SET_WINDOW_STYLE,
  KIND_TERM_INPUT,
  KIND_TERM_PASTE,
  KIND_TERM_RESIZE,
  KIND_TERM_SYNC_SIZE,
  KIND_TERM_OUTPUT,
  KIND_TERM_HISTORY,
  KIND_SWITCH_ACK,
  KIND_LIVE_RESUME,
  KIND_CHUNK,
  KIND_AGENT_SUBSCRIBE,
  KIND_AGENT_UNSUBSCRIBE,
  KIND_AGENT_EVENT,
  KIND_WATCH_EVENT,
  isValidKind,
  kindToString,
} from './kind';

// ========== Agent/Watch 事件常量与 payload 类型 ==========
export {
  AGENT_EVENT_SYNC,
  AGENT_EVENT_STATUS,
  AGENT_EVENT_TEXT_DELTA,
  AGENT_EVENT_REASONING_DELTA,
  AGENT_EVENT_TOOL_CALL,
  AGENT_EVENT_TOOL_RESULT,
  AGENT_EVENT_CONFIRMATION_REQUEST,
  AGENT_EVENT_CONFIRMATION_RESOLVED,
  AGENT_EVENT_MESSAGE_PERSISTED,
  AGENT_EVENT_ERROR,
  AGENT_EVENT_TURN_FINISHED,
  AGENT_EVENT_CREDENTIAL_WARNING,
  AGENT_EVENT_QUEUE_UPDATED,
  WATCH_EVENT_TRIGGERED,
  WATCH_EVENT_MODEL_UNAVAILABLE,
  WATCH_EVENT_RULE_ERROR,
  type AgentSessionWireStatus,
  type AgentConfirmationWireStatus,
  type AgentPendingConfirmation,
  type AgentQueuedMessageWire,
  type AgentQueueUpdatedPayload,
  type AgentSyncEventPayload,
  type AgentStatusEventPayload,
  type AgentTextDeltaPayload,
  type AgentReasoningDeltaPayload,
  type AgentToolCallPayload,
  type AgentToolResultPayload,
  type AgentConfirmationRequestPayload,
  type AgentConfirmationResolvedPayload,
  type AgentMessagePersistedPayload,
  type AgentErrorEventPayload,
  type AgentTurnFinishedPayload,
  type AgentCredentialWarningPayload,
  type WatchTriggeredPayload,
  type WatchModelUnavailablePayload,
  type WatchRuleErrorPayload,
  type AgentEventPayloadMap,
  type WatchEventPayloadMap,
  type AgentEventType,
  type WatchEventType,
} from './agent';

// ========== 错误码 ==========
export {
  ERROR_UNSUPPORTED_PROTOCOL,
  ERROR_INVALID_FRAME,
  ERROR_UNKNOWN_KIND,
  ERROR_PAYLOAD_DECODE_FAILED,
  ERROR_FRAME_TOO_LARGE,
  ERROR_DEVICE_NOT_FOUND,
  ERROR_DEVICE_CONNECT_FAILED,
  ERROR_TMUX_TARGET_NOT_FOUND,
  ERROR_TMUX_NOT_READY,
  ERROR_SELECT_CONFLICT,
  ERROR_SELECT_TOKEN_MISMATCH,
  ERROR_INTERNAL_ERROR,
  ERROR_MESSAGES,
  getErrorMessage,
  WsBorshError,
} from './errors';

// ========== Schema ==========
export * as schema from './schema';

// ========== 编解码器 ==========
export {
  MAGIC,
  CURRENT_VERSION,
  DEFAULT_MAX_FRAME_BYTES,
  FLAG_ACK_REQUIRED,
  FLAG_IS_ACK,
  FLAG_IS_ERROR,
  FLAG_IS_CHUNK,
  FLAG_IS_COMPRESSED,
  type Envelope,
  type DecodedEnvelope,
  encodeEnvelope,
  encodePayload,
  decodeEnvelope,
  decodePayload,
  decodeEnvelopeAndPayload,
  type ChunkData,
  encodeChunk,
  decodeChunk,
  hasFlag,
  setFlag,
  checkMagic,
  createSeqGenerator,
} from './codec';

// ========== 分片 ==========
export {
  CHUNK_TIMEOUT_MS,
  MAX_CHUNK_STREAMS,
  MAX_CHUNKS_PER_MESSAGE,
  type Chunk,
  type ReassembledMessage,
  ChunkReassembler,
  type ChunkOptions,
  type ChunkedResult,
  splitPayloadIntoChunks,
  generateChunkStreamId,
  resetChunkStreamId,
} from './chunk';

// ========== 转换层 ==========
export {
  encodeDeviceEventPayload,
  encodeTmuxEventPayload,
  encodeStateSnapshot,
  decodeDeviceEventPayload,
  decodeTmuxEventPayload,
  decodeStateSnapshot,
} from './convert';
