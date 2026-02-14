// WebSocket Borsh 协议分片重组
// 参考: docs/ws-protocol/2026021402-ws-borsh-v1-spec.md

import { ERROR_FRAME_TOO_LARGE, ERROR_INVALID_FRAME, WsBorshError } from './errors';

// ========== 常量 ==========

export const CHUNK_TIMEOUT_MS = 5000;
export const MAX_CHUNK_STREAMS = 100;
export const MAX_CHUNKS_PER_MESSAGE = 1000;

// ========== 类型定义 ==========

export interface Chunk {
  chunkStreamId: number;
  originalKind: number;
  originalSeq: number;
  totalChunks: number;
  chunkIndex: number;
  data: Uint8Array;
}

export interface ReassembledMessage {
  kind: number;
  seq: number;
  payload: Uint8Array;
}

interface ChunkStream {
  chunks: Map<number, Chunk>;
  totalChunks: number;
  createdAt: number;
  originalKind: number;
  originalSeq: number;
}

// ========== Chunk 重组器 ==========

export class ChunkReassembler {
  private streams = new Map<number, ChunkStream>();
  private lastCleanup = Date.now();

  /**
   * 添加一个 chunk，如果重组完成则返回消息
   */
  addChunk(chunk: Chunk): ReassembledMessage | null {
    this.cleanup();

    if (chunk.totalChunks > MAX_CHUNKS_PER_MESSAGE) {
      throw new WsBorshError(
        ERROR_INVALID_FRAME,
        false,
        `Too many chunks: ${chunk.totalChunks} > ${MAX_CHUNKS_PER_MESSAGE}`
      );
    }

    if (chunk.chunkIndex >= chunk.totalChunks) {
      throw new WsBorshError(
        ERROR_INVALID_FRAME,
        false,
        `Chunk index out of bounds: ${chunk.chunkIndex} >= ${chunk.totalChunks}`
      );
    }

    let stream = this.streams.get(chunk.chunkStreamId);

    if (!stream) {
      // 检查流数量限制
      if (this.streams.size >= MAX_CHUNK_STREAMS) {
        this.cleanup(true);
        if (this.streams.size >= MAX_CHUNK_STREAMS) {
          throw new WsBorshError(ERROR_INVALID_FRAME, false, 'Too many concurrent chunk streams');
        }
      }

      stream = {
        chunks: new Map(),
        totalChunks: chunk.totalChunks,
        createdAt: Date.now(),
        originalKind: chunk.originalKind,
        originalSeq: chunk.originalSeq,
      };
      this.streams.set(chunk.chunkStreamId, stream);
    }

    // 验证一致性
    if (stream.totalChunks !== chunk.totalChunks) {
      this.streams.delete(chunk.chunkStreamId);
      throw new WsBorshError(ERROR_INVALID_FRAME, false, 'Chunk total count mismatch');
    }

    // 存储 chunk
    if (stream.chunks.has(chunk.chunkIndex)) {
      throw new WsBorshError(
        ERROR_INVALID_FRAME,
        false,
        `Duplicate chunk index: ${chunk.chunkIndex}`
      );
    }

    stream.chunks.set(chunk.chunkIndex, chunk);

    // 检查是否完成
    if (stream.chunks.size === stream.totalChunks) {
      return this.reassemble(chunk.chunkStreamId, stream);
    }

    return null;
  }

  /**
   * 重组完成的消息
   */
  private reassemble(streamId: number, stream: ChunkStream): ReassembledMessage {
    // 按顺序拼接
    const chunks: Uint8Array[] = [];
    let totalLength = 0;

    for (let i = 0; i < stream.totalChunks; i++) {
      const chunk = stream.chunks.get(i);
      if (!chunk) {
        this.streams.delete(streamId);
        throw new WsBorshError(ERROR_INVALID_FRAME, false, `Missing chunk index: ${i}`);
      }
      chunks.push(chunk.data);
      totalLength += chunk.data.length;
    }

    // 拼接 payload
    const payload = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      payload.set(chunk, offset);
      offset += chunk.length;
    }

    this.streams.delete(streamId);

    return {
      kind: stream.originalKind,
      seq: stream.originalSeq,
      payload,
    };
  }

  /**
   * 清理过期的流
   */
  cleanup(force = false): void {
    const now = Date.now();

    // 非强制清理每 5 秒执行一次
    if (!force && now - this.lastCleanup < 5000) {
      return;
    }

    this.lastCleanup = now;
    const cutoff = now - CHUNK_TIMEOUT_MS;

    for (const [streamId, stream] of this.streams) {
      if (stream.createdAt < cutoff) {
        this.streams.delete(streamId);
      }
    }
  }

  /**
   * 获取当前活跃流数量
   */
  getActiveStreamCount(): number {
    return this.streams.size;
  }

  /**
   * 清除所有流
   */
  clear(): void {
    this.streams.clear();
  }
}

// ========== Chunk 分割器 ==========

export interface ChunkOptions {
  maxFrameBytes: number;
  chunkStreamId: number;
}

export interface ChunkedResult {
  chunks: Chunk[];
  totalChunks: number;
}

/**
 * 将 payload 分割为 chunks
 */
export function splitPayloadIntoChunks(
  payload: Uint8Array,
  kind: number,
  seq: number,
  options: ChunkOptions
): ChunkedResult {
  const { maxFrameBytes, chunkStreamId } = options;

  // EnvelopeSchema 固定字段 12 bytes + payload 长度前缀 4 bytes
  const envelopeOverhead = 16;
  // ChunkSchema 固定字段 14 bytes + data(bytes) 长度前缀 4 bytes
  const chunkOverhead = 18;

  const maxUnchunkedPayloadBytes = maxFrameBytes - envelopeOverhead;
  if (maxUnchunkedPayloadBytes <= 0) {
    throw new WsBorshError(
      ERROR_FRAME_TOO_LARGE,
      false,
      `maxFrameBytes too small: ${maxFrameBytes}`
    );
  }

  if (payload.length <= maxUnchunkedPayloadBytes) {
    return { chunks: [], totalChunks: 0 };
  }

  const maxChunkDataSize = maxFrameBytes - envelopeOverhead - chunkOverhead;
  if (maxChunkDataSize <= 0) {
    throw new WsBorshError(
      ERROR_FRAME_TOO_LARGE,
      false,
      `maxFrameBytes too small for chunking: ${maxFrameBytes}`
    );
  }

  const totalChunks = Math.ceil(payload.length / maxChunkDataSize);

  if (totalChunks > MAX_CHUNKS_PER_MESSAGE) {
    throw new WsBorshError(ERROR_FRAME_TOO_LARGE, false, `Too many chunks: ${totalChunks}`);
  }

  const chunks: Chunk[] = [];

  for (let i = 0; i < totalChunks; i++) {
    const start = i * maxChunkDataSize;
    const end = Math.min(start + maxChunkDataSize, payload.length);
    chunks.push({
      chunkStreamId,
      originalKind: kind,
      originalSeq: seq,
      totalChunks,
      chunkIndex: i,
      data: payload.slice(start, end),
    });
  }

  return {
    chunks,
    totalChunks,
  };
}

/**
 * 生成 chunk stream ID
 */
let nextChunkStreamId = 1;

export function generateChunkStreamId(): number {
  const id = nextChunkStreamId;
  nextChunkStreamId = (nextChunkStreamId % 0xffffffff) + 1;
  return id;
}

export function resetChunkStreamId(): void {
  nextChunkStreamId = 1;
}
