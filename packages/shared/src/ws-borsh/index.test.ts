// WebSocket Borsh 协议单元测试
// 测试范围: codec, chunk, convert

import { beforeEach, describe, expect, it } from 'bun:test';
import {
  CURRENT_VERSION,
  ChunkReassembler,
  ERROR_FRAME_TOO_LARGE,
  ERROR_INVALID_FRAME,
  KIND_CHUNK,
  KIND_PING,
  MAGIC,
  WsBorshError,
  checkMagic,
  createSeqGenerator,
  decodeEnvelope,
  decodePayload,
  encodeChunk,
  encodeEnvelope,
  encodePayload,
  generateChunkStreamId,
  getErrorMessage,
  isValidKind,
  kindToString,
  resetChunkStreamId,
  splitPayloadIntoChunks,
} from './index';
import { PingPongSchema } from './schema';

describe('codec', () => {
  describe('encodeEnvelope / decodeEnvelope', () => {
    it('应该正确编码和解码 envelope', () => {
      const kind = 0x0003; // PING
      const payload = new Uint8Array([1, 2, 3, 4]);
      const seq = 42;
      const flags = 0;

      const encoded = encodeEnvelope(kind, payload, seq, flags);
      expect(encoded).toBeInstanceOf(Uint8Array);
      expect(encoded.length).toBeGreaterThan(12);

      const decoded = decodeEnvelope(encoded);
      expect(decoded.magic).toEqual(MAGIC);
      expect(decoded.version).toBe(CURRENT_VERSION);
      expect(decoded.kind).toBe(kind);
      expect(decoded.flags).toBe(flags);
      expect(decoded.seq).toBe(seq);
      expect(decoded.payload).toEqual(payload);
    });

    it('应该支持自定义版本', () => {
      const payload = new Uint8Array([1, 2, 3]);
      const encoded = encodeEnvelope(1, payload, 1, 0, 2);
      const decoded = decodeEnvelope(encoded);
      expect(decoded.version).toBe(2);
    });

    it('应该支持自定义 flags', () => {
      const payload = new Uint8Array([1, 2, 3]);
      const flags = 0b1010;
      const encoded = encodeEnvelope(1, payload, 1, flags);
      const decoded = decodeEnvelope(encoded);
      expect(decoded.flags).toBe(flags);
    });

    it('应该对无效数据抛出错误', () => {
      expect(() => decodeEnvelope(new Uint8Array([1, 2, 3]))).toThrow(WsBorshError);
    });

    it('应该检查 magic 字节', () => {
      const invalidData = new Uint8Array([
        0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      ]);
      expect(() => decodeEnvelope(invalidData)).toThrow(WsBorshError);
    });
  });

  describe('checkMagic', () => {
    it('应该正确识别 magic', () => {
      expect(checkMagic(MAGIC)).toBe(true);
      expect(checkMagic(new Uint8Array([0x54, 0x58]))).toBe(true);
      expect(checkMagic(new Uint8Array([0x00, 0x00]))).toBe(false);
      expect(checkMagic(new Uint8Array([0x54]))).toBe(false);
    });
  });

  describe('seq generator', () => {
    it('应该生成递增的 seq', () => {
      const gen = createSeqGenerator();
      expect(gen()).toBe(1);
      expect(gen()).toBe(2);
      expect(gen()).toBe(3);
    });
  });

  describe('payload 编解码', () => {
    it('应该正确编解码 PingPong payload', () => {
      const data = { nonce: 12345, timeMs: 67890n };
      const encoded = encodePayload(PingPongSchema, data);
      const decoded = decodePayload(PingPongSchema, encoded);
      expect(decoded.nonce).toBe(data.nonce);
      expect(decoded.timeMs).toBe(data.timeMs);
    });
  });
});

describe('chunk', () => {
  beforeEach(() => {
    resetChunkStreamId();
  });

  describe('ChunkReassembler', () => {
    it('应该重组分片消息', () => {
      const reassembler = new ChunkReassembler();
      const streamId = 1;
      const originalPayload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

      // 分割成 2 个 chunks
      const chunk1 = {
        chunkStreamId: streamId,
        originalKind: KIND_PING,
        originalSeq: 100,
        totalChunks: 2,
        chunkIndex: 0,
        data: originalPayload.slice(0, 4),
      };

      const chunk2 = {
        chunkStreamId: streamId,
        originalKind: KIND_PING,
        originalSeq: 100,
        totalChunks: 2,
        chunkIndex: 1,
        data: originalPayload.slice(4, 8),
      };

      const result1 = reassembler.addChunk(chunk1);
      expect(result1).toBeNull();

      const result2 = reassembler.addChunk(chunk2);
      expect(result2).not.toBeNull();
      if (result2) {
        expect(result2.kind).toBe(KIND_PING);
        expect(result2.seq).toBe(100);
        expect(result2.payload).toEqual(originalPayload);
      }
    });

    it('应该检测重复 chunk', () => {
      const reassembler = new ChunkReassembler();
      const chunk = {
        chunkStreamId: 1,
        originalKind: KIND_PING,
        originalSeq: 100,
        totalChunks: 2,
        chunkIndex: 0,
        data: new Uint8Array([1, 2, 3]),
      };

      reassembler.addChunk(chunk);
      expect(() => reassembler.addChunk(chunk)).toThrow(WsBorshError);
    });

    it('应该检测越界 index', () => {
      const reassembler = new ChunkReassembler();
      const chunk = {
        chunkStreamId: 1,
        originalKind: KIND_PING,
        originalSeq: 100,
        totalChunks: 2,
        chunkIndex: 5, // 越界
        data: new Uint8Array([1, 2, 3]),
      };

      expect(() => reassembler.addChunk(chunk)).toThrow(WsBorshError);
    });

    it('应该限制最大 chunk 数量', () => {
      const reassembler = new ChunkReassembler();
      const chunk = {
        chunkStreamId: 1,
        originalKind: KIND_PING,
        originalSeq: 100,
        totalChunks: 2000, // 超过限制
        chunkIndex: 0,
        data: new Uint8Array([1]),
      };

      expect(() => reassembler.addChunk(chunk)).toThrow(WsBorshError);
    });

    it('应该清理过期流', () => {
      const reassembler = new ChunkReassembler();

      // 添加一个正常 chunk，但模拟其已过期
      const chunk = {
        chunkStreamId: 1,
        originalKind: KIND_PING,
        originalSeq: 100,
        totalChunks: 2,
        chunkIndex: 0,
        data: new Uint8Array([1, 2, 3]),
      };
      reassembler.addChunk(chunk);

      // 手动将流的创建时间设为过期
      const streams = (reassembler as unknown as { streams: Map<number, { createdAt: number }> })
        .streams;
      const stream = streams.get(1);
      if (stream) {
        stream.createdAt = Date.now() - 10000;
      }

      // 强制清理（跳过冷却时间）
      reassembler.cleanup(true);
      expect(reassembler.getActiveStreamCount()).toBe(0);
    });
  });

  describe('splitPayloadIntoChunks', () => {
    it('应该正确分割 payload', () => {
      const payload = new Uint8Array(5000);
      for (let i = 0; i < 5000; i++) {
        payload[i] = i % 256;
      }

      const result = splitPayloadIntoChunks(payload, KIND_PING, 1, {
        maxFrameBytes: 2048,
        chunkStreamId: 1,
      });

      expect(result.totalChunks).toBeGreaterThan(1);
      expect(result.chunks.length).toBe(result.totalChunks);

      // 验证所有 chunks 的数据总和
      let totalLength = 0;
      for (const chunk of result.chunks) {
        totalLength += chunk.data.length;
        expect(chunk.chunkStreamId).toBe(1);
        expect(chunk.originalKind).toBe(KIND_PING);
        expect(chunk.originalSeq).toBe(1);
      }
      expect(totalLength).toBe(payload.length);
    });

    it('小 payload 不需要分片', () => {
      const payload = new Uint8Array([1, 2, 3, 4]);
      const result = splitPayloadIntoChunks(payload, KIND_PING, 1, {
        maxFrameBytes: 2048,
        chunkStreamId: 1,
      });

      expect(result.totalChunks).toBe(0);
      expect(result.chunks.length).toBe(0);
    });

    it('应该保证 chunk envelope 不超过 maxFrameBytes', () => {
      const maxFrameBytes = 256;
      const payload = new Uint8Array(2048).fill(0xab);

      const result = splitPayloadIntoChunks(payload, KIND_PING, 123, {
        maxFrameBytes,
        chunkStreamId: 1,
      });

      expect(result.totalChunks).toBeGreaterThan(0);

      for (const chunk of result.chunks) {
        const encoded = encodeChunk(chunk, 1);
        expect(encoded.length).toBeLessThanOrEqual(maxFrameBytes);
      }
    });

    it('maxFrameBytes 过小应抛出错误', () => {
      const payload = new Uint8Array([1, 2, 3]);
      expect(() =>
        splitPayloadIntoChunks(payload, KIND_PING, 1, {
          maxFrameBytes: 8,
          chunkStreamId: 1,
        })
      ).toThrow(WsBorshError);

      try {
        splitPayloadIntoChunks(payload, KIND_PING, 1, { maxFrameBytes: 8, chunkStreamId: 1 });
      } catch (e) {
        expect((e as WsBorshError).code).toBe(ERROR_FRAME_TOO_LARGE);
      }
    });
  });

  describe('generateChunkStreamId', () => {
    it('应该生成递增的 stream id', () => {
      resetChunkStreamId();
      expect(generateChunkStreamId()).toBe(1);
      expect(generateChunkStreamId()).toBe(2);
      expect(generateChunkStreamId()).toBe(3);
    });
  });
});

describe('kind', () => {
  it('应该验证有效的 kind', () => {
    expect(isValidKind(0x0001)).toBe(true); // HELLO_C2S
    expect(isValidKind(0x0501)).toBe(true); // CHUNK
    expect(isValidKind(0x9999)).toBe(false);
    expect(isValidKind(0)).toBe(false);
  });

  it('应该返回 kind 字符串表示', () => {
    expect(kindToString(0x0001)).toBe('HELLO_C2S');
    expect(kindToString(0x0501)).toBe('CHUNK');
    expect(kindToString(0x9999)).toBe('UNKNOWN(0x9999)');
  });
});

describe('errors', () => {
  it('应该创建 WsBorshError', () => {
    const error = new WsBorshError(ERROR_INVALID_FRAME, true);
    expect(error.code).toBe(ERROR_INVALID_FRAME);
    expect(error.retryable).toBe(true);
    expect(error.message).toBe(getErrorMessage(ERROR_INVALID_FRAME));
  });

  it('应该支持自定义消息', () => {
    const error = new WsBorshError(ERROR_INVALID_FRAME, false, 'custom message');
    expect(error.message).toBe('custom message');
  });
});
