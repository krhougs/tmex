// WebSocket Borsh 协议编解码器
// 参考: docs/ws-protocol/2026021402-ws-borsh-v1-spec.md

import type { Schema } from '@zorsh/zorsh';
import type { b } from '@zorsh/zorsh';
import { ERROR_INVALID_FRAME, ERROR_PAYLOAD_DECODE_FAILED, WsBorshError } from './errors';
import { ChunkSchema, EnvelopeSchema } from './schema';

// ========== 常量 ==========

export const MAGIC = new Uint8Array([0x54, 0x58]); // "TX"
export const CURRENT_VERSION = 1;
export const DEFAULT_MAX_FRAME_BYTES = 1_048_576; // 1MiB

// ========== Flags ==========

export const FLAG_ACK_REQUIRED = 1 << 0;
export const FLAG_IS_ACK = 1 << 1;
export const FLAG_IS_ERROR = 1 << 2;
export const FLAG_IS_CHUNK = 1 << 3;
export const FLAG_IS_COMPRESSED = 1 << 4;

// ========== 类型定义 ==========

export type Envelope = b.infer<typeof EnvelopeSchema>;

export interface DecodedEnvelope<T = unknown> {
  version: number;
  kind: number;
  flags: number;
  seq: number;
  payload: T;
}

// ========== 编码函数 ==========

export function encodeEnvelope(
  kind: number,
  payload: Uint8Array,
  seq: number,
  flags = 0,
  version = CURRENT_VERSION
): Uint8Array {
  const envelope: Envelope = {
    magic: MAGIC,
    version,
    kind,
    flags,
    seq,
    payload,
  };
  return EnvelopeSchema.serialize(envelope);
}

export function encodePayload<T>(schema: Schema<T>, data: T): Uint8Array {
  return schema.serialize(data);
}

// ========== 解码函数 ==========

export function decodeEnvelope(data: Uint8Array): Envelope {
  if (data.length < 12) {
    throw new WsBorshError(ERROR_INVALID_FRAME, false, 'Envelope too small');
  }

  // 检查 magic
  if (data[0] !== MAGIC[0] || data[1] !== MAGIC[1]) {
    throw new WsBorshError(ERROR_INVALID_FRAME, false, 'Invalid magic bytes');
  }

  try {
    return EnvelopeSchema.deserialize(data);
  } catch (err) {
    throw new WsBorshError(
      ERROR_INVALID_FRAME,
      false,
      err instanceof Error ? err.message : 'Failed to decode envelope'
    );
  }
}

export function decodePayload<T>(schema: Schema<T>, data: Uint8Array): T {
  try {
    return schema.deserialize(data);
  } catch (err) {
    throw new WsBorshError(
      ERROR_PAYLOAD_DECODE_FAILED,
      false,
      err instanceof Error ? err.message : 'Failed to decode payload'
    );
  }
}

export function decodeEnvelopeAndPayload<T>(
  envelopeData: Uint8Array,
  payloadSchema: Schema<T>
): DecodedEnvelope<T> {
  const envelope = decodeEnvelope(envelopeData);
  const payload = decodePayload(payloadSchema, envelope.payload);
  return {
    version: envelope.version,
    kind: envelope.kind,
    flags: envelope.flags,
    seq: envelope.seq,
    payload,
  };
}

// ========== Chunk 编码/解码 ==========

export type ChunkData = b.infer<typeof ChunkSchema>;

export function encodeChunk(chunk: ChunkData, seq: number): Uint8Array {
  const payloadBytes = ChunkSchema.serialize(chunk);
  return encodeEnvelope(/* KIND_CHUNK */ 0x0501, payloadBytes, seq);
}

export function decodeChunk(data: Uint8Array): ChunkData {
  return ChunkSchema.deserialize(data);
}

// ========== 辅助函数 ==========

export function hasFlag(flags: number, flag: number): boolean {
  return (flags & flag) !== 0;
}

export function setFlag(flags: number, flag: number, value: boolean): number {
  return value ? flags | flag : flags & ~flag;
}

export function checkMagic(data: Uint8Array): boolean {
  return data.length >= 2 && data[0] === MAGIC[0] && data[1] === MAGIC[1];
}

export function createSeqGenerator(): () => number {
  let seq = 1;
  return () => seq++;
}
