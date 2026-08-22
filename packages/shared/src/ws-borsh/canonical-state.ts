import { b } from '@zorsh/zorsh';
import {
  ERROR_FRAME_TOO_LARGE,
  ERROR_INVALID_FRAME,
  ERROR_PAYLOAD_DECODE_FAILED,
  ERROR_UNSUPPORTED_PROTOCOL,
  WsBorshError,
} from './errors';

export const CANONICAL_STATE_PROTOCOL_VERSION = 1;
export const CANONICAL_STATE_MAX_FRAME_BYTES = 32 * 1024;
export const WS_ENVELOPE_WIRE_OVERHEAD_BYTES = 16;
export const CANONICAL_STATE_MAX_PAYLOAD_BYTES =
  CANONICAL_STATE_MAX_FRAME_BYTES - WS_ENVELOPE_WIRE_OVERHEAD_BYTES;

export const TERMINAL_KEY_MOD_SHIFT = 1 << 0;
export const TERMINAL_KEY_MOD_ALT = 1 << 1;
export const TERMINAL_KEY_MOD_CTRL = 1 << 2;
export const TERMINAL_KEY_MOD_SUPER = 1 << 3;
export const TERMINAL_KEY_MOD_HYPER = 1 << 4;
export const TERMINAL_KEY_MOD_META = 1 << 5;
export const TERMINAL_KEY_MOD_CAPS_LOCK = 1 << 6;
export const TERMINAL_KEY_MOD_NUM_LOCK = 1 << 7;
export const TERMINAL_KEY_MOD_MASK = 0xff;

export const SOURCE_ENTITY_DEVICE = 0;
export const SOURCE_ENTITY_SERVER = 1;
export const SOURCE_ENTITY_SESSION = 2;
export const SOURCE_ENTITY_WINDOW = 3;
export const SOURCE_ENTITY_PANE = 4;

export const SOURCE_FIELD_NAME = 1;
export const SOURCE_FIELD_TITLE = 2;
export const SOURCE_FIELD_INDEX = 3;
export const SOURCE_FIELD_ACTIVE = 4;
export const SOURCE_FIELD_LAYOUT = 5;
export const SOURCE_FIELD_WIDTH = 6;
export const SOURCE_FIELD_HEIGHT = 7;
export const SOURCE_FIELD_LEFT = 8;
export const SOURCE_FIELD_TOP = 9;
export const SOURCE_FIELD_CURRENT_PATH = 10;
export const SOURCE_FIELD_CURRENT_COMMAND = 11;
export const SOURCE_FIELD_CONNECTED = 12;
export const SOURCE_FIELD_PANE_EPOCH = 13;
export const SOURCE_FIELD_CUSTOM_NAME = 14;

export const SUBSCRIPTION_REJECTED_NOT_FOUND = 1;
export const SUBSCRIPTION_REJECTED_RESOURCE_EXHAUSTED = 2;
export const SUBSCRIPTION_REJECTED_EPOCH_CHANGED = 3;

export const SOURCE_GAP_SCOPE_STREAM = 0;
export const SOURCE_GAP_SCOPE_METADATA = 1;
export const SOURCE_GAP_SCOPE_PANE = 2;

export const SOURCE_GAP_REASON_METADATA_GAP = 1;
export const SOURCE_GAP_REASON_PANE_GAP = 2;
export const SOURCE_GAP_REASON_EPOCH_CHANGED = 3;
export const SOURCE_GAP_REASON_CACHE_EVICTED = 4;
export const SOURCE_GAP_REASON_RESOURCE_EXHAUSTED = 5;

export const SourceEntityKeySchema = b.struct({
  deviceId: b.string(),
  serverEpoch: b.bytes(16),
  entityKind: b.u8(),
  nativeId: b.string(),
});

export const SourceMetadataValueSchema = b.enum({
  Unset: b.unit(),
  String: b.string(),
  Bool: b.bool(),
  U16: b.u16(),
  U32: b.u32(),
  Bytes16: b.bytes(16),
});

export const SourceMetadataFieldSchema = b.struct({
  field: b.u8(),
  value: SourceMetadataValueSchema,
});

export const SourceMetadataRecordSchema = b.struct({
  key: SourceEntityKeySchema,
  parent: b.option(SourceEntityKeySchema),
  fields: b.vec(SourceMetadataFieldSchema),
});

export const CanonicalPaneTargetSchema = b.struct({
  deviceId: b.string(),
  serverEpoch: b.bytes(16),
  paneId: b.string(),
});

export const CanonicalTerminalCursorSchema = b.struct({
  paneEpoch: b.bytes(16),
  terminalSeq: b.u64(),
});

export const CanonicalHistoryCursorSchema = b.struct({
  paneEpoch: b.bytes(16),
  historyEpoch: b.bytes(16),
  beforeLine: b.u32(),
});

export const CanonicalPaneSubscriptionSchema = b.struct({
  pane: CanonicalPaneTargetSchema,
  cursor: b.option(CanonicalTerminalCursorSchema),
});

export const SetPaneSubscriptionsSchema = b.struct({
  generation: b.u64(),
  activePanes: b.vec(CanonicalPaneSubscriptionSchema),
  hotPanes: b.vec(CanonicalPaneSubscriptionSchema),
});

export const CanonicalTerminalInputSchema = b.struct({
  requestId: b.bytes(16),
  pane: CanonicalPaneTargetSchema,
  paneEpoch: b.bytes(16),
  inputId: b.bytes(16),
  data: b.bytes(),
});

export const TerminalKeySchema = b.enum({
  Unicode: b.u32(),
  Enter: b.unit(),
  Tab: b.unit(),
  BackTab: b.unit(),
  Escape: b.unit(),
  Backspace: b.unit(),
  Insert: b.unit(),
  Delete: b.unit(),
  Home: b.unit(),
  End: b.unit(),
  PageUp: b.unit(),
  PageDown: b.unit(),
  ArrowUp: b.unit(),
  ArrowDown: b.unit(),
  ArrowLeft: b.unit(),
  ArrowRight: b.unit(),
  Function: b.u8(),
  NumpadEnter: b.unit(),
  NumpadDigit: b.u8(),
  NumpadDecimal: b.unit(),
  NumpadAdd: b.unit(),
  NumpadSubtract: b.unit(),
  NumpadMultiply: b.unit(),
  NumpadDivide: b.unit(),
  NumpadEqual: b.unit(),
  ShiftLeft: b.unit(),
  ShiftRight: b.unit(),
  ControlLeft: b.unit(),
  ControlRight: b.unit(),
  AltLeft: b.unit(),
  AltRight: b.unit(),
  SuperLeft: b.unit(),
  SuperRight: b.unit(),
});

export const TerminalKeyActionSchema = b.enum({
  Press: b.unit(),
  Repeat: b.u16(),
  Release: b.unit(),
});

export const CanonicalTerminalKeyInputSchema = b.struct({
  requestId: b.bytes(16),
  pane: CanonicalPaneTargetSchema,
  paneEpoch: b.bytes(16),
  inputId: b.bytes(16),
  key: TerminalKeySchema,
  modifiers: b.u16(),
  action: TerminalKeyActionSchema,
});

export const CanonicalResizePaneSchema = b.struct({
  requestId: b.bytes(16),
  pane: CanonicalPaneTargetSchema,
  rows: b.u16(),
  cols: b.u16(),
});

export const CanonicalRequestScreenSchema = b.struct({
  requestId: b.bytes(16),
  pane: CanonicalPaneTargetSchema,
  byteLimit: b.u32(),
});

export const CanonicalRequestHistorySchema = b.struct({
  requestId: b.bytes(16),
  pane: CanonicalPaneTargetSchema,
  beforeCursor: b.option(CanonicalHistoryCursorSchema),
  byteLimit: b.u32(),
});

export const CanonicalCommandSchema = b.enum({
  SetPaneSubscriptions: SetPaneSubscriptionsSchema,
  TerminalInput: CanonicalTerminalInputSchema,
  ResizePane: CanonicalResizePaneSchema,
  RequestScreen: CanonicalRequestScreenSchema,
  RequestHistory: CanonicalRequestHistorySchema,
  TerminalKeyInput: CanonicalTerminalKeyInputSchema,
});

export const CanonicalCommandEnvelopeSchema = b.struct({
  protocolVersion: b.u16(),
  command: CanonicalCommandSchema,
});

export const CanonicalFeedReadySchema = b.struct({
  gatewayEpoch: b.bytes(16),
  maxFrameBytes: b.u32(),
  maxActivePanes: b.u16(),
  maxHotPanes: b.u16(),
  maxScreenBytes: b.u32(),
  maxHistoryPageBytes: b.u32(),
});

export const SourceMetadataSnapshotSchema = b.struct({
  metadataEpoch: b.bytes(16),
  revision: b.u64(),
  snapshotId: b.bytes(16),
  chunkIndex: b.u16(),
  totalChunks: b.u16(),
  records: b.vec(SourceMetadataRecordSchema),
});

export const SourceMetadataPatchSchema = b.struct({
  metadataEpoch: b.bytes(16),
  fromRevision: b.u64(),
  throughRevision: b.u64(),
  upserts: b.vec(SourceMetadataRecordSchema),
  removals: b.vec(SourceEntityKeySchema),
});

export const CanonicalPaneDataSchema = b.struct({
  pane: CanonicalPaneTargetSchema,
  paneEpoch: b.bytes(16),
  seqStart: b.u64(),
  seqEnd: b.u64(),
  data: b.bytes(),
});

export const CanonicalSubscriptionRejectionSchema = b.struct({
  pane: CanonicalPaneTargetSchema,
  reason: b.u8(),
});

export const CanonicalSubscriptionAppliedSchema = b.struct({
  generation: b.u64(),
  activePanes: b.vec(CanonicalPaneTargetSchema),
  hotPanes: b.vec(CanonicalPaneTargetSchema),
  rejected: b.vec(CanonicalSubscriptionRejectionSchema),
});

export const CanonicalScreenBeginSchema = b.struct({
  requestId: b.bytes(16),
  pane: CanonicalPaneTargetSchema,
  paneEpoch: b.bytes(16),
  baseSeq: b.u64(),
  rows: b.u16(),
  cols: b.u16(),
  modes: b.u8(),
  totalBytes: b.u32(),
});

export const CanonicalContentChunkSchema = b.struct({
  requestId: b.bytes(16),
  offset: b.u32(),
  data: b.bytes(),
});

export const CanonicalScreenCommitSchema = b.struct({
  requestId: b.bytes(16),
  totalBytes: b.u32(),
  historyCursor: b.option(CanonicalHistoryCursorSchema),
});

export const CanonicalHistoryBeginSchema = b.struct({
  requestId: b.bytes(16),
  pane: CanonicalPaneTargetSchema,
  paneEpoch: b.bytes(16),
  historyEpoch: b.bytes(16),
  lineStart: b.u32(),
  lineEnd: b.u32(),
  truncated: b.bool(),
  totalBytes: b.u32(),
});

export const CanonicalHistoryCommitSchema = b.struct({
  requestId: b.bytes(16),
  totalBytes: b.u32(),
  nextCursor: b.option(CanonicalHistoryCursorSchema),
});

export const CanonicalGapScopeSchema = b.enum({
  Stream: b.unit(),
  Metadata: b.struct({
    expectedEpoch: b.bytes(16),
    availableEpoch: b.bytes(16),
    expectedRevision: b.u64(),
    availableRevision: b.u64(),
  }),
  Pane: b.struct({
    pane: CanonicalPaneTargetSchema,
    expectedPaneEpoch: b.bytes(16),
    availablePaneEpoch: b.bytes(16),
    expectedSeq: b.u64(),
    availableSeq: b.u64(),
  }),
});

export const CanonicalSourceGapSchema = b.struct({
  reason: b.u8(),
  scope: CanonicalGapScopeSchema,
});

export const CanonicalErrorSchema = b.struct({
  requestId: b.option(b.bytes(16)),
  code: b.u16(),
  message: b.string(),
  retryable: b.bool(),
});

export const CanonicalEventSchema = b.enum({
  FeedReady: CanonicalFeedReadySchema,
  SourceMetadataSnapshot: SourceMetadataSnapshotSchema,
  SourceMetadataPatch: SourceMetadataPatchSchema,
  PaneData: CanonicalPaneDataSchema,
  SubscriptionApplied: CanonicalSubscriptionAppliedSchema,
  ScreenBegin: CanonicalScreenBeginSchema,
  ScreenChunk: CanonicalContentChunkSchema,
  ScreenCommit: CanonicalScreenCommitSchema,
  HistoryBegin: CanonicalHistoryBeginSchema,
  HistoryChunk: CanonicalContentChunkSchema,
  HistoryCommit: CanonicalHistoryCommitSchema,
  SourceGap: CanonicalSourceGapSchema,
  Error: CanonicalErrorSchema,
});

export const CanonicalEventEnvelopeSchema = b.struct({
  protocolVersion: b.u16(),
  event: CanonicalEventSchema,
});

export type SourceEntityKey = b.infer<typeof SourceEntityKeySchema>;
export type SourceMetadataValue = b.infer<typeof SourceMetadataValueSchema>;
export type SourceMetadataField = b.infer<typeof SourceMetadataFieldSchema>;
export type SourceMetadataRecord = b.infer<typeof SourceMetadataRecordSchema>;
export type CanonicalPaneTarget = b.infer<typeof CanonicalPaneTargetSchema>;
export type CanonicalTerminalCursor = b.infer<typeof CanonicalTerminalCursorSchema>;
export type CanonicalHistoryCursor = b.infer<typeof CanonicalHistoryCursorSchema>;
export type CanonicalPaneSubscription = b.infer<typeof CanonicalPaneSubscriptionSchema>;
export type TerminalKey = b.infer<typeof TerminalKeySchema>;
export type TerminalKeyAction = b.infer<typeof TerminalKeyActionSchema>;
export type CanonicalTerminalKeyInput = b.infer<typeof CanonicalTerminalKeyInputSchema>;
export type CanonicalCommand = b.infer<typeof CanonicalCommandSchema>;
export type CanonicalCommandEnvelope = b.infer<typeof CanonicalCommandEnvelopeSchema>;
export type CanonicalEvent = b.infer<typeof CanonicalEventSchema>;
export type CanonicalEventEnvelope = b.infer<typeof CanonicalEventEnvelopeSchema>;

export function assertCanonicalPayloadBounded(payload: Uint8Array): void {
  if (payload.byteLength > CANONICAL_STATE_MAX_PAYLOAD_BYTES) {
    throw new WsBorshError(
      ERROR_FRAME_TOO_LARGE,
      false,
      `canonical payload exceeds ${CANONICAL_STATE_MAX_PAYLOAD_BYTES} bytes`
    );
  }
}

function assertCanonicalEncoding<T>(
  schema: { serialize(value: T): Uint8Array },
  decoded: T,
  payload: Uint8Array
): void {
  const canonical = schema.serialize(decoded);
  if (
    canonical.byteLength !== payload.byteLength ||
    canonical.some((byte, index) => byte !== payload[index])
  ) {
    throw new WsBorshError(ERROR_INVALID_FRAME, false, 'non-canonical payload encoding');
  }
}

export function encodeCanonicalCommandPayload(command: CanonicalCommand): Uint8Array {
  const payload = CanonicalCommandEnvelopeSchema.serialize({
    protocolVersion: CANONICAL_STATE_PROTOCOL_VERSION,
    command,
  });
  assertCanonicalPayloadBounded(payload);
  return payload;
}

export function decodeCanonicalCommandPayload(payload: Uint8Array): CanonicalCommandEnvelope {
  assertCanonicalPayloadBounded(payload);
  let decoded: CanonicalCommandEnvelope;
  try {
    decoded = CanonicalCommandEnvelopeSchema.deserialize(payload);
  } catch (error) {
    throw new WsBorshError(
      ERROR_PAYLOAD_DECODE_FAILED,
      false,
      error instanceof Error ? error.message : 'invalid canonical command'
    );
  }
  if (decoded.protocolVersion !== CANONICAL_STATE_PROTOCOL_VERSION) {
    throw new WsBorshError(ERROR_UNSUPPORTED_PROTOCOL, false);
  }
  assertCanonicalEncoding(CanonicalCommandEnvelopeSchema, decoded, payload);
  return decoded;
}

export function encodeCanonicalEventPayload(event: CanonicalEvent): Uint8Array {
  const paneData = 'PaneData' in event ? event.PaneData : null;
  if (
    paneData &&
    (paneData.seqEnd < paneData.seqStart ||
      paneData.seqEnd - paneData.seqStart !== BigInt(paneData.data.byteLength))
  ) {
    throw new WsBorshError(ERROR_INVALID_FRAME, false, 'PaneData sequence range mismatch');
  }
  const payload = CanonicalEventEnvelopeSchema.serialize({
    protocolVersion: CANONICAL_STATE_PROTOCOL_VERSION,
    event,
  });
  assertCanonicalPayloadBounded(payload);
  return payload;
}

export function decodeCanonicalEventPayload(payload: Uint8Array): CanonicalEventEnvelope {
  assertCanonicalPayloadBounded(payload);
  let decoded: CanonicalEventEnvelope;
  try {
    decoded = CanonicalEventEnvelopeSchema.deserialize(payload);
  } catch (error) {
    throw new WsBorshError(
      ERROR_PAYLOAD_DECODE_FAILED,
      false,
      error instanceof Error ? error.message : 'invalid canonical event'
    );
  }
  if (decoded.protocolVersion !== CANONICAL_STATE_PROTOCOL_VERSION) {
    throw new WsBorshError(ERROR_UNSUPPORTED_PROTOCOL, false);
  }
  assertCanonicalEncoding(CanonicalEventEnvelopeSchema, decoded, payload);
  return decoded;
}
