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
  KIND_TERM_INPUT,
  KIND_TERM_PASTE,
  KIND_TERM_RESIZE,
  KIND_TERM_SYNC_SIZE,
  KIND_TERM_OUTPUT,
  KIND_TERM_HISTORY,
  KIND_SWITCH_ACK,
  KIND_LIVE_RESUME,
  KIND_CHUNK,
  isValidKind,
  kindToString,
} from './kind';

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
