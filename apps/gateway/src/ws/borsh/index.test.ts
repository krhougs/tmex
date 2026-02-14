// Gateway Borsh 集成测试

import { beforeEach, describe, expect, it } from 'bun:test';
import { wsBorsh } from '@tmex/shared';
import {
  createBorshClientState,
  decodeDeviceConnect,
  decodeHelloC2S,
  decodePing,
  encodeDeviceConnected,
  encodeHelloS2C,
  encodePong,
} from './codec-borsh';
import { sessionStateStore } from './session-state';
import { switchBarrier } from './switch-barrier';

describe('borsh codec', () => {
  it('应该创建 BorshClientState', () => {
    const state = createBorshClientState();
    expect(state.negotiated).toBe(false);
    expect(state.maxFrameBytes).toBe(wsBorsh.DEFAULT_MAX_FRAME_BYTES);
    expect(state.seqGen()).toBe(1);
    expect(state.seqGen()).toBe(2);
  });

  it('应该编码和解码 HELLO', () => {
    const state = createBorshClientState();
    const seq = state.seqGen();

    const helloS2C = {
      serverImpl: 'tmex-gateway',
      serverVersion: '0.1.0',
      selectedVersion: 1,
      maxFrameBytes: 65536,
      heartbeatIntervalMs: 15000,
      capabilities: ['borsh-v1'],
    };

    const encoded = encodeHelloS2C(helloS2C, seq);
    expect(encoded).toBeInstanceOf(Uint8Array);
    expect(encoded.length).toBeGreaterThan(0);

    const envelope = wsBorsh.decodeEnvelope(encoded);
    expect(envelope.kind).toBe(wsBorsh.KIND_HELLO_S2C);
    expect(envelope.seq).toBe(seq);
  });

  it('应该编码和解码 PING/PONG', () => {
    const state = createBorshClientState();
    const seq = state.seqGen();

    const ping = {
      nonce: 12345,
      timeMs: BigInt(Date.now()),
    };

    // 模拟客户端发送 PING
    const pingPayload = wsBorsh.encodePayload(wsBorsh.schema.PingPongSchema, ping);
    const pingEnvelope = wsBorsh.encodeEnvelope(wsBorsh.KIND_PING, pingPayload, 1);

    // 服务器解码
    const decodedPing = decodePing(wsBorsh.decodeEnvelope(pingEnvelope).payload);
    expect(decodedPing.nonce).toBe(ping.nonce);

    // 服务器发送 PONG
    const pong = encodePong(
      {
        nonce: decodedPing.nonce,
        timeMs: BigInt(Date.now()),
      },
      seq
    );

    const pongEnvelope = wsBorsh.decodeEnvelope(pong);
    expect(pongEnvelope.kind).toBe(wsBorsh.KIND_PONG);
  });

  it('应该编码 DEVICE_CONNECTED', () => {
    const state = createBorshClientState();
    const seq = state.seqGen();

    const connected = encodeDeviceConnected({ deviceId: 'device-1' }, seq);
    const envelope = wsBorsh.decodeEnvelope(connected);

    expect(envelope.kind).toBe(wsBorsh.KIND_DEVICE_CONNECTED);
  });
});

describe('session state store', () => {
  it('应该创建 session state', () => {
    const mockWs = { remoteAddress: '127.0.0.1' } as any;
    const state = sessionStateStore.create(mockWs);

    expect(state).toBeDefined();
    expect(state.wsConnection.state).toBe('IDLE');
    expect(state.deviceConnections.size).toBe(0);
  });

  it('应该管理设备连接状态', () => {
    const mockWs = { remoteAddress: '127.0.0.1' } as any;
    sessionStateStore.create(mockWs);

    const deviceId = 'device-1';

    // 初始状态
    const ctx = sessionStateStore.getOrCreateDeviceConnection(mockWs, deviceId);
    expect(ctx).toBeDefined();
    expect(ctx?.state).toBe('DETACHED');

    // 状态转移
    const transitioned = sessionStateStore.transitionDeviceState(mockWs, deviceId, 'CONNECTING');
    expect(transitioned).toBe(true);

    const updated = sessionStateStore.getOrCreateDeviceConnection(mockWs, deviceId);
    expect(updated?.state).toBe('CONNECTING');
  });

  it('应该管理选择事务', () => {
    const mockWs = { remoteAddress: '127.0.0.1' } as any;
    sessionStateStore.create(mockWs);

    const deviceId = 'device-1';
    const windowId = '@1';
    const paneId = '%2';
    const selectToken = new Uint8Array(16).fill(0xab);

    // 启动事务
    const started = sessionStateStore.startSelectTransaction(
      mockWs,
      deviceId,
      windowId,
      paneId,
      selectToken
    );
    expect(started).toBe(true);

    const ctx = sessionStateStore.getOrCreateSelectTransaction(mockWs, deviceId);
    expect(ctx?.state).toBe('SELECTING');
    expect(ctx?.windowId).toBe(windowId);
    expect(ctx?.paneId).toBe(paneId);

    // 状态转移
    sessionStateStore.transitionSelectState(mockWs, deviceId, 'ACKED');
    expect(ctx?.state).toBe('ACKED');
  });

  it('应该缓冲输出', () => {
    const mockWs = { remoteAddress: '127.0.0.1' } as any;
    sessionStateStore.create(mockWs);

    const deviceId = 'device-1';

    // 开始缓冲
    sessionStateStore.startOutputBuffering(mockWs, deviceId);
    expect(sessionStateStore.isBuffering(mockWs, deviceId)).toBe(true);

    // 缓冲数据
    const data1 = new Uint8Array([1, 2, 3]);
    const data2 = new Uint8Array([4, 5, 6]);
    sessionStateStore.bufferOutput(mockWs, deviceId, data1);
    sessionStateStore.bufferOutput(mockWs, deviceId, data2);

    // 停止缓冲并获取数据
    const buffered = sessionStateStore.stopOutputBuffering(mockWs, deviceId);
    expect(buffered.length).toBe(2);
    expect(buffered[0]).toEqual(data1);
    expect(buffered[1]).toEqual(data2);
    expect(sessionStateStore.isBuffering(mockWs, deviceId)).toBe(false);
  });
});

describe('switch barrier', () => {
  it('应该管理事务生命周期', () => {
    const mockWs = {
      remoteAddress: '127.0.0.1',
      data: { borshState: createBorshClientState() },
      send: () => {},
    } as any;

    sessionStateStore.create(mockWs);

    const deviceId = 'device-1';
    const windowId = '@1';
    const paneId = '%2';
    const selectToken = crypto.getRandomValues(new Uint8Array(16));

    // 启动事务
    const started = switchBarrier.startTransaction(
      mockWs,
      {
        deviceId,
        windowId,
        paneId,
        selectToken,
        wantHistory: false,
        cols: null,
        rows: null,
      },
      {
        onAckSent: () => {},
      }
    );
    expect(started).toBe(true);

    // 验证 token
    const token = switchBarrier.getSelectToken(mockWs, deviceId);
    expect(token).toEqual(selectToken);

    // 验证 token
    const valid = switchBarrier.validateToken(mockWs, deviceId, selectToken);
    expect(valid).toBe(true);

    const invalidToken = crypto.getRandomValues(new Uint8Array(16));
    const invalid = switchBarrier.validateToken(mockWs, deviceId, invalidToken);
    expect(invalid).toBe(false);

    // 清理
    switchBarrier.cleanupClient(mockWs);
  });

  it('不应因相同 remoteAddress 导致不同客户端事务冲突', () => {
    const ws1 = {
      remoteAddress: '127.0.0.1',
      data: { borshState: createBorshClientState() },
      send: () => {},
    } as any;

    const ws2 = {
      remoteAddress: '127.0.0.1',
      data: { borshState: createBorshClientState() },
      send: () => {},
    } as any;

    sessionStateStore.create(ws1);
    sessionStateStore.create(ws2);

    const deviceId = 'device-1';
    const token1 = crypto.getRandomValues(new Uint8Array(16));
    const token2 = crypto.getRandomValues(new Uint8Array(16));

    expect(
      switchBarrier.startTransaction(ws1, {
        deviceId,
        windowId: '@1',
        paneId: '%1',
        selectToken: token1,
        wantHistory: false,
        cols: null,
        rows: null,
      })
    ).toBe(true);

    expect(
      switchBarrier.startTransaction(ws2, {
        deviceId,
        windowId: '@1',
        paneId: '%2',
        selectToken: token2,
        wantHistory: false,
        cols: null,
        rows: null,
      })
    ).toBe(true);

    expect(switchBarrier.validateToken(ws1, deviceId, token1)).toBe(true);
    expect(switchBarrier.validateToken(ws2, deviceId, token2)).toBe(true);
    expect(switchBarrier.validateToken(ws1, deviceId, token2)).toBe(false);

    switchBarrier.cleanupClient(ws1);
    switchBarrier.cleanupClient(ws2);
  });
});
