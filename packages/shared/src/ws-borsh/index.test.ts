// WebSocket Borsh 协议单元测试
// 测试范围: codec, chunk, convert

import { beforeEach, describe, expect, it } from 'bun:test';
import {
  AGENT_EVENT_SYNC,
  CURRENT_VERSION,
  ChunkReassembler,
  ERROR_FRAME_TOO_LARGE,
  ERROR_INVALID_FRAME,
  KIND_AGENT_EVENT,
  KIND_AGENT_SUBSCRIBE,
  KIND_AGENT_UNSUBSCRIBE,
  KIND_CHUNK,
  KIND_PING,
  KIND_TMUX_REORDER_PANES,
  KIND_TMUX_REORDER_WINDOWS,
  KIND_WATCH_EVENT,
  MAGIC,
  WATCH_EVENT_TRIGGERED,
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
import {
  AgentEventSchema,
  AgentSubscribeSchema,
  AgentUnsubscribeSchema,
  PingPongSchema,
  TmuxReorderPanesSchema,
  TmuxReorderWindowsSchema,
  WatchEventSchema,
} from './schema';

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
    expect(isValidKind(KIND_AGENT_SUBSCRIBE)).toBe(true);
    expect(isValidKind(KIND_AGENT_UNSUBSCRIBE)).toBe(true);
    expect(isValidKind(KIND_AGENT_EVENT)).toBe(true);
    expect(isValidKind(KIND_WATCH_EVENT)).toBe(true);
    expect(isValidKind(0x9999)).toBe(false);
    expect(isValidKind(0)).toBe(false);
  });

  it('应该返回 kind 字符串表示', () => {
    expect(kindToString(0x0001)).toBe('HELLO_C2S');
    expect(kindToString(0x0501)).toBe('CHUNK');
    expect(kindToString(KIND_AGENT_SUBSCRIBE)).toBe('AGENT_SUBSCRIBE');
    expect(kindToString(KIND_AGENT_UNSUBSCRIBE)).toBe('AGENT_UNSUBSCRIBE');
    expect(kindToString(KIND_AGENT_EVENT)).toBe('AGENT_EVENT');
    expect(kindToString(KIND_WATCH_EVENT)).toBe('WATCH_EVENT');
    expect(kindToString(0x9999)).toBe('UNKNOWN(0x9999)');
  });
});

describe('tmux reorder 协议消息', () => {
  it('REORDER_WINDOWS/REORDER_PANES kind 有效且可读名', () => {
    expect(isValidKind(KIND_TMUX_REORDER_WINDOWS)).toBe(true);
    expect(isValidKind(KIND_TMUX_REORDER_PANES)).toBe(true);
    expect(kindToString(KIND_TMUX_REORDER_WINDOWS)).toBe('TMUX_REORDER_WINDOWS');
    expect(kindToString(KIND_TMUX_REORDER_PANES)).toBe('TMUX_REORDER_PANES');
  });

  it('TmuxReorderWindows payload roundtrip（含字符串数组）', () => {
    const data = { deviceId: 'dev-1', windowIds: ['@2', '@0', '@1'] };
    const decoded = decodePayload(TmuxReorderWindowsSchema, encodePayload(TmuxReorderWindowsSchema, data));
    expect(decoded.deviceId).toBe('dev-1');
    expect(decoded.windowIds).toEqual(['@2', '@0', '@1']);
  });

  it('TmuxReorderPanes payload roundtrip', () => {
    const data = { deviceId: 'dev-1', windowId: '@0', paneIds: ['%3', '%1', '%2'] };
    const decoded = decodePayload(TmuxReorderPanesSchema, encodePayload(TmuxReorderPanesSchema, data));
    expect(decoded.deviceId).toBe('dev-1');
    expect(decoded.windowId).toBe('@0');
    expect(decoded.paneIds).toEqual(['%3', '%1', '%2']);
  });

  it('空数组 roundtrip', () => {
    const decoded = decodePayload(
      TmuxReorderWindowsSchema,
      encodePayload(TmuxReorderWindowsSchema, { deviceId: 'd', windowIds: [] })
    );
    expect(decoded.windowIds).toEqual([]);
  });
});

describe('agent/watch 协议消息', () => {
  it('AGENT_SUBSCRIBE/AGENT_UNSUBSCRIBE payload roundtrip', () => {
    for (const schema of [AgentSubscribeSchema, AgentUnsubscribeSchema]) {
      const encoded = encodePayload(schema, { sessionId: 'session-1' });
      const decoded = decodePayload(schema, encoded);
      expect(decoded.sessionId).toBe('session-1');
    }
  });

  it('AGENT_EVENT envelope + payload roundtrip（payload 为 JSON bytes）', () => {
    const jsonPayload = {
      status: 'running',
      lastError: null,
      inProgressText: 'hello',
      inProgressReasoning: '',
      pendingConfirmations: [],
      lastMessageSeq: 3,
    };
    const payloadBytes = encodePayload(AgentEventSchema, {
      sessionId: 'session-1',
      seq: 42,
      eventType: AGENT_EVENT_SYNC,
      payload: new TextEncoder().encode(JSON.stringify(jsonPayload)),
    });

    const envelope = encodeEnvelope(KIND_AGENT_EVENT, payloadBytes, 7);
    const decodedEnvelope = decodeEnvelope(envelope);
    expect(decodedEnvelope.kind).toBe(KIND_AGENT_EVENT);

    const decoded = decodePayload(AgentEventSchema, decodedEnvelope.payload);
    expect(decoded.sessionId).toBe('session-1');
    expect(decoded.seq).toBe(42);
    expect(decoded.eventType).toBe(AGENT_EVENT_SYNC);
    expect(JSON.parse(new TextDecoder().decode(decoded.payload))).toEqual(jsonPayload);
  });

  it('WATCH_EVENT envelope + payload roundtrip', () => {
    const jsonPayload = { summary: 'rule matched', matchedText: 'ERROR' };
    const payloadBytes = encodePayload(WatchEventSchema, {
      ruleId: 'rule-1',
      deviceId: 'device-1',
      paneId: '%1',
      eventType: WATCH_EVENT_TRIGGERED,
      payload: new TextEncoder().encode(JSON.stringify(jsonPayload)),
    });

    const envelope = encodeEnvelope(KIND_WATCH_EVENT, payloadBytes, 9);
    const decodedEnvelope = decodeEnvelope(envelope);
    expect(decodedEnvelope.kind).toBe(KIND_WATCH_EVENT);

    const decoded = decodePayload(WatchEventSchema, decodedEnvelope.payload);
    expect(decoded.ruleId).toBe('rule-1');
    expect(decoded.deviceId).toBe('device-1');
    expect(decoded.paneId).toBe('%1');
    expect(decoded.eventType).toBe(WATCH_EVENT_TRIGGERED);
    expect(JSON.parse(new TextDecoder().decode(decoded.payload))).toEqual(jsonPayload);
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
