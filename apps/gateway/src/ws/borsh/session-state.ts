// Gateway 会话/设备/选择 状态机存储
// 参考: docs/ws-protocol/2026021403-ws-state-machines.md

import type { ServerWebSocket } from 'bun';

// ========== WS 连接状态机 ==========

export type WsConnectionState =
  | 'IDLE'
  | 'WS_CONNECTING'
  | 'HELLO_NEGOTIATING'
  | 'READY'
  | 'RECONNECT_BACKOFF'
  | 'CLOSED';

export interface WsConnectionContext {
  state: WsConnectionState;
  connectedAt: number | null;
  lastActivityAt: number;
  seq: number;
}

// ========== 设备连接状态机 ==========

export type DeviceConnectionState =
  | 'DETACHED'
  | 'CONNECTING'
  | 'CONNECTED'
  | 'FAILED'
  | 'DISCONNECTING'
  | 'RECONNECTING';

export interface DeviceConnectionContext {
  state: DeviceConnectionState;
  deviceId: string;
  connectedAt: number | null;
  lastError: string | null;
  reconnectAttempts: number;
}

// ========== 选择事务状态机 ==========

export type SelectTransactionState =
  | 'STABLE'
  | 'SELECTING'
  | 'ACKED'
  | 'HISTORY_APPLIED'
  | 'LIVE'
  | 'SELECT_FAILED';

export interface SelectTransactionContext {
  state: SelectTransactionState;
  deviceId: string;
  windowId: string | null;
  paneId: string | null;
  selectToken: Uint8Array | null;
  startedAt: number;
  ackedAt: number | null;
  historyAppliedAt: number | null;
  liveResumedAt: number | null;
}

// ========== 输出门控状态机 ==========

export type OutputGateState = 'FLOWING' | 'BUFFERING';

export interface OutputGateContext {
  state: OutputGateState;
  buffer: Uint8Array[];
  maxBufferSize: number;
}

// ========== Bell 状态机 ==========

export interface BellThrottleContext {
  lastBellAt: number;
  throttleSeconds: number;
}

// ========== Session State 存储 ==========

export interface SessionState {
  // WS 连接状态
  wsConnection: WsConnectionContext;

  // 设备状态 (按 deviceId)
  deviceConnections: Map<string, DeviceConnectionContext>;

  // 选择事务 (按 deviceId)
  selectTransactions: Map<string, SelectTransactionContext>;

  // 输出门控 (按 deviceId)
  outputGates: Map<string, OutputGateContext>;

  // Bell 频控 (按 deviceId+paneId)
  bellThrottles: Map<string, BellThrottleContext>;
}

export class SessionStateStore {
  private states = new Map<ServerWebSocket<unknown>, SessionState>();

  create(ws: ServerWebSocket<unknown>): SessionState {
    const now = Date.now();
    const state: SessionState = {
      wsConnection: {
        state: 'IDLE',
        connectedAt: null,
        lastActivityAt: now,
        seq: 0,
      },
      deviceConnections: new Map(),
      selectTransactions: new Map(),
      outputGates: new Map(),
      bellThrottles: new Map(),
    };
    this.states.set(ws, state);
    return state;
  }

  get(ws: ServerWebSocket<unknown>): SessionState | undefined {
    return this.states.get(ws);
  }

  delete(ws: ServerWebSocket<unknown>): void {
    this.states.delete(ws);
  }

  // ========== WS 连接状态操作 ==========

  transitionWsState(ws: ServerWebSocket<unknown>, newState: WsConnectionState): boolean {
    const state = this.states.get(ws);
    if (!state) return false;

    const oldState = state.wsConnection.state;

    // 验证状态转移合法性
    const validTransitions: Record<WsConnectionState, WsConnectionState[]> = {
      IDLE: ['WS_CONNECTING', 'CLOSED'],
      WS_CONNECTING: ['HELLO_NEGOTIATING', 'RECONNECT_BACKOFF', 'CLOSED'],
      HELLO_NEGOTIATING: ['READY', 'RECONNECT_BACKOFF', 'CLOSED'],
      READY: ['RECONNECT_BACKOFF', 'CLOSED'],
      RECONNECT_BACKOFF: ['WS_CONNECTING', 'CLOSED'],
      CLOSED: [],
    };

    if (!validTransitions[oldState].includes(newState)) {
      console.warn(`[session-state] Invalid WS state transition: ${oldState} -> ${newState}`);
      return false;
    }

    state.wsConnection.state = newState;

    if (newState === 'READY') {
      state.wsConnection.connectedAt = Date.now();
    }

    return true;
  }

  updateLastActivity(ws: ServerWebSocket<unknown>): void {
    const state = this.states.get(ws);
    if (state) {
      state.wsConnection.lastActivityAt = Date.now();
    }
  }

  incrementSeq(ws: ServerWebSocket<unknown>): number {
    const state = this.states.get(ws);
    if (!state) return 0;
    state.wsConnection.seq += 1;
    return state.wsConnection.seq;
  }

  // ========== 设备连接状态操作 ==========

  getOrCreateDeviceConnection(
    ws: ServerWebSocket<unknown>,
    deviceId: string
  ): DeviceConnectionContext | undefined {
    const state = this.states.get(ws);
    if (!state) return undefined;

    let ctx = state.deviceConnections.get(deviceId);
    if (!ctx) {
      ctx = {
        state: 'DETACHED',
        deviceId,
        connectedAt: null,
        lastError: null,
        reconnectAttempts: 0,
      };
      state.deviceConnections.set(deviceId, ctx);
    }
    return ctx;
  }

  transitionDeviceState(
    ws: ServerWebSocket<unknown>,
    deviceId: string,
    newState: DeviceConnectionState
  ): boolean {
    const ctx = this.getOrCreateDeviceConnection(ws, deviceId);
    if (!ctx) return false;

    const oldState = ctx.state;

    // 验证状态转移合法性
    const validTransitions: Record<DeviceConnectionState, DeviceConnectionState[]> = {
      DETACHED: ['CONNECTING'],
      CONNECTING: ['CONNECTED', 'FAILED'],
      CONNECTED: ['DISCONNECTING', 'RECONNECTING'],
      FAILED: ['CONNECTING'],
      DISCONNECTING: ['DETACHED'],
      RECONNECTING: ['CONNECTED', 'FAILED'],
    };

    if (!validTransitions[oldState].includes(newState)) {
      console.warn(
        `[session-state] Invalid device state transition: ${oldState} -> ${newState} for ${deviceId}`
      );
      return false;
    }

    ctx.state = newState;

    if (newState === 'CONNECTED') {
      ctx.connectedAt = Date.now();
      ctx.reconnectAttempts = 0;
      ctx.lastError = null;
    } else if (newState === 'FAILED') {
      ctx.reconnectAttempts += 1;
    }

    return true;
  }

  // ========== 选择事务状态操作 ==========

  getOrCreateSelectTransaction(
    ws: ServerWebSocket<unknown>,
    deviceId: string
  ): SelectTransactionContext | undefined {
    const state = this.states.get(ws);
    if (!state) return undefined;

    let ctx = state.selectTransactions.get(deviceId);
    if (!ctx) {
      ctx = {
        state: 'STABLE',
        deviceId,
        windowId: null,
        paneId: null,
        selectToken: null,
        startedAt: 0,
        ackedAt: null,
        historyAppliedAt: null,
        liveResumedAt: null,
      };
      state.selectTransactions.set(deviceId, ctx);
    }
    return ctx;
  }

  startSelectTransaction(
    ws: ServerWebSocket<unknown>,
    deviceId: string,
    windowId: string,
    paneId: string,
    selectToken: Uint8Array
  ): boolean {
    const ctx = this.getOrCreateSelectTransaction(ws, deviceId);
    if (!ctx) return false;

    // 重置之前的状态
    ctx.state = 'SELECTING';
    ctx.windowId = windowId;
    ctx.paneId = paneId;
    ctx.selectToken = selectToken;
    ctx.startedAt = Date.now();
    ctx.ackedAt = null;
    ctx.historyAppliedAt = null;
    ctx.liveResumedAt = null;

    // 同时启动输出门控
    this.startOutputBuffering(ws, deviceId);

    return true;
  }

  transitionSelectState(
    ws: ServerWebSocket<unknown>,
    deviceId: string,
    newState: SelectTransactionState
  ): boolean {
    const ctx = this.getOrCreateSelectTransaction(ws, deviceId);
    if (!ctx) return false;

    const oldState = ctx.state;

    // 验证状态转移合法性
    const validTransitions: Record<SelectTransactionState, SelectTransactionState[]> = {
      STABLE: ['SELECTING'],
      SELECTING: ['ACKED', 'SELECT_FAILED'],
      ACKED: ['HISTORY_APPLIED', 'LIVE', 'SELECT_FAILED'],
      HISTORY_APPLIED: ['LIVE', 'SELECT_FAILED'],
      LIVE: ['STABLE', 'SELECTING'],
      SELECT_FAILED: ['STABLE', 'SELECTING'],
    };

    if (!validTransitions[oldState].includes(newState)) {
      console.warn(
        `[session-state] Invalid select state transition: ${oldState} -> ${newState} for ${deviceId}`
      );
      return false;
    }

    ctx.state = newState;

    const now = Date.now();
    switch (newState) {
      case 'ACKED':
        ctx.ackedAt = now;
        break;
      case 'HISTORY_APPLIED':
        ctx.historyAppliedAt = now;
        break;
      case 'LIVE':
        ctx.liveResumedAt = now;
        break;
      case 'STABLE':
        ctx.selectToken = null;
        break;
    }

    return true;
  }

  // ========== 输出门控操作 ==========

  getOrCreateOutputGate(
    ws: ServerWebSocket<unknown>,
    deviceId: string
  ): OutputGateContext | undefined {
    const state = this.states.get(ws);
    if (!state) return undefined;

    let ctx = state.outputGates.get(deviceId);
    if (!ctx) {
      ctx = {
        state: 'FLOWING',
        buffer: [],
        maxBufferSize: 1000, // 最大缓冲 1000 条
      };
      state.outputGates.set(deviceId, ctx);
    }
    return ctx;
  }

  startOutputBuffering(ws: ServerWebSocket<unknown>, deviceId: string): void {
    const ctx = this.getOrCreateOutputGate(ws, deviceId);
    if (!ctx) return;

    ctx.state = 'BUFFERING';
    ctx.buffer = []; // 清空旧缓冲
  }

  stopOutputBuffering(ws: ServerWebSocket<unknown>, deviceId: string): Uint8Array[] {
    const ctx = this.getOrCreateOutputGate(ws, deviceId);
    if (!ctx) return [];

    ctx.state = 'FLOWING';
    const buffered = [...ctx.buffer];
    ctx.buffer = [];
    return buffered;
  }

  bufferOutput(ws: ServerWebSocket<unknown>, deviceId: string, data: Uint8Array): boolean {
    const ctx = this.getOrCreateOutputGate(ws, deviceId);
    if (!ctx || ctx.state !== 'BUFFERING') return false;

    if (ctx.buffer.length >= ctx.maxBufferSize) {
      console.warn(`[session-state] Output buffer overflow for ${deviceId}`);
      ctx.buffer.shift(); // 丢弃最旧的数据
    }

    ctx.buffer.push(data);
    return true;
  }

  isBuffering(ws: ServerWebSocket<unknown>, deviceId: string): boolean {
    const ctx = this.getOrCreateOutputGate(ws, deviceId);
    return ctx?.state === 'BUFFERING';
  }

  // ========== Bell 频控操作 ==========

  shouldAllowBell(
    ws: ServerWebSocket<unknown>,
    deviceId: string,
    paneId: string,
    throttleSeconds: number
  ): boolean {
    const state = this.states.get(ws);
    if (!state) return false;

    const key = `${deviceId}:${paneId}`;
    const now = Date.now();

    let ctx = state.bellThrottles.get(key);
    if (!ctx) {
      ctx = {
        lastBellAt: 0,
        throttleSeconds,
      };
      state.bellThrottles.set(key, ctx);
    }

    const throttleMs = throttleSeconds * 1000;
    if (now - ctx.lastBellAt < throttleMs) {
      return false; // 在频控期内
    }

    ctx.lastBellAt = now;
    ctx.throttleSeconds = throttleSeconds;
    return true;
  }

  // ========== 清理操作 ==========

  cleanupDevice(ws: ServerWebSocket<unknown>, deviceId: string): void {
    const state = this.states.get(ws);
    if (!state) return;

    state.deviceConnections.delete(deviceId);
    state.selectTransactions.delete(deviceId);
    state.outputGates.delete(deviceId);

    // 清理该设备的所有 bell 记录
    for (const key of state.bellThrottles.keys()) {
      if (key.startsWith(`${deviceId}:`)) {
        state.bellThrottles.delete(key);
      }
    }
  }

  cleanup(ws: ServerWebSocket<unknown>): void {
    this.states.delete(ws);
  }
}

// 全局单例
export const sessionStateStore = new SessionStateStore();
