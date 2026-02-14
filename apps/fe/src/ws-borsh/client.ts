// FE Borsh WebSocket 客户端
// 管理连接、消息编解码、分片重组

import { wsBorsh } from '@tmex/shared';

// ========== 配置 ==========

const WS_URL = `${typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${typeof window !== 'undefined' ? window.location.host : ''}/ws`;

const DEFAULT_OPTIONS: BorshClientOptions = {
  clientImpl: 'tmex-fe',
  clientVersion: '0.1.0',
  maxFrameBytes: 1048576, // 1MB
  reconnectDelayMs: 1000,
  maxReconnectAttempts: 5,
  heartbeatIntervalMs: 15000,
};

// ========== 类型定义 ==========

export interface BorshClientOptions {
  clientImpl: string;
  clientVersion: string;
  maxFrameBytes: number;
  reconnectDelayMs: number;
  maxReconnectAttempts: number;
  heartbeatIntervalMs: number;
}

export type ConnectionState =
  | 'IDLE'
  | 'WS_CONNECTING'
  | 'HELLO_NEGOTIATING'
  | 'READY'
  | 'RECONNECT_BACKOFF'
  | 'CLOSED';

export interface BorshMessage {
  kind: number;
  seq: number;
  payload: Uint8Array;
}

export type MessageHandler = (message: BorshMessage) => void;
export type StateChangeHandler = (state: ConnectionState) => void;
export type ErrorHandler = (error: Error) => void;

// ========== Borsh WebSocket 客户端 ==========

export class BorshWebSocketClient {
  private ws: WebSocket | null = null;
  private options: BorshClientOptions;
  private state: ConnectionState = 'IDLE';

  // 消息处理
  private seq = 0;
  private chunkReassembler = new wsBorsh.ChunkReassembler();

  // 重连
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // 心跳
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  // 回调
  private messageHandlers: Set<MessageHandler> = new Set();
  private stateChangeHandlers: Set<StateChangeHandler> = new Set();
  private errorHandlers: Set<ErrorHandler> = new Set();

  // 待发送队列
  private pendingMessages: Array<{ kind: number; payload: Uint8Array }> = [];
  private maxPendingMessages = 100;

  constructor(options: Partial<BorshClientOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  // ========== 状态管理 ==========

  private setState(newState: ConnectionState): void {
    if (this.state === newState) return;

    console.log(`[borsh-client] State: ${this.state} -> ${newState}`);
    this.state = newState;

    for (const handler of this.stateChangeHandlers) {
      try {
        handler(newState);
      } catch (err) {
        console.error('[borsh-client] State change handler error:', err);
      }
    }

    // 进入 READY 时发送队列
    if (newState === 'READY') {
      this.flushPendingMessages();
    }
  }

  getState(): ConnectionState {
    return this.state;
  }

  isReady(): boolean {
    return this.state === 'READY';
  }

  // ========== 事件订阅 ==========

  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onStateChange(handler: StateChangeHandler): () => void {
    this.stateChangeHandlers.add(handler);
    return () => this.stateChangeHandlers.delete(handler);
  }

  onError(handler: ErrorHandler): () => void {
    this.errorHandlers.add(handler);
    return () => this.errorHandlers.delete(handler);
  }

  // ========== 连接管理 ==========

  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN || this.ws?.readyState === WebSocket.CONNECTING) {
      return;
    }

    this.setState('WS_CONNECTING');

    try {
      this.ws = new WebSocket(WS_URL);
      this.ws.binaryType = 'arraybuffer';

      this.ws.onopen = () => {
        this.sendHello();
      };

      this.ws.onmessage = (event) => {
        this.handleMessage(event.data);
      };

      this.ws.onclose = () => {
        this.handleClose();
      };

      this.ws.onerror = () => {
        this.handleError(new Error('WebSocket error'));
      };
    } catch (err) {
      this.handleError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  disconnect(): void {
    this.setState('CLOSED');
    this.clearTimers();

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  // ========== 消息处理 ==========

  private handleMessage(data: ArrayBuffer | string): void {
    if (typeof data === 'string') {
      // 忽略旧协议的文本消息
      return;
    }

    const buffer = new Uint8Array(data);

    // 检查 magic
    if (!wsBorsh.checkMagic(buffer)) {
      console.warn('[borsh-client] Received message without magic, ignoring');
      return;
    }

    try {
      const envelope = wsBorsh.decodeEnvelope(buffer);

      // 处理 CHUNK
      if (envelope.kind === wsBorsh.KIND_CHUNK) {
        const chunk = wsBorsh.decodeChunk(envelope.payload);
        const reassembled = this.chunkReassembler.addChunk(chunk);
        if (reassembled) {
          this.dispatchMessage({
            kind: reassembled.kind,
            seq: reassembled.seq,
            payload: reassembled.payload,
          });
        }
        return;
      }

      // 处理 HELLO_S2C
      if (envelope.kind === wsBorsh.KIND_HELLO_S2C) {
        this.handleHelloS2C(envelope.payload);
        return;
      }

      // 处理 PONG
      if (envelope.kind === wsBorsh.KIND_PONG) {
        return;
      }

      // 分发业务消息
      this.dispatchMessage({
        kind: envelope.kind,
        seq: envelope.seq,
        payload: envelope.payload,
      });
    } catch (err) {
      console.error('[borsh-client] Failed to decode message:', err);
    }
  }

  private dispatchMessage(message: BorshMessage): void {
    for (const handler of this.messageHandlers) {
      try {
        handler(message);
      } catch (err) {
        console.error('[borsh-client] Message handler error:', err);
      }
    }
  }

  private handleHelloS2C(payload: Uint8Array): void {
    try {
      const hello = wsBorsh.decodePayload(wsBorsh.schema.HelloS2CSchema, payload);
      console.log('[borsh-client] HELLO_S2C received:', hello);

      this.setState('READY');
      this.startHeartbeat();
      this.reconnectAttempts = 0;
    } catch (err) {
      console.error('[borsh-client] Failed to decode HELLO_S2C:', err);
      this.handleError(new Error('HELLO negotiation failed'));
    }
  }

  private handleClose(): void {
    this.stopHeartbeat();

    if (this.state === 'CLOSED') {
      return;
    }

    if (this.reconnectAttempts < this.options.maxReconnectAttempts) {
      this.scheduleReconnect();
    } else {
      this.setState('CLOSED');
      this.handleError(new Error('Max reconnection attempts reached'));
    }
  }

  private handleError(error: Error): void {
    console.error('[borsh-client] Error:', error);

    for (const handler of this.errorHandlers) {
      try {
        handler(error);
      } catch (err) {
        console.error('[borsh-client] Error handler error:', err);
      }
    }
  }

  // ========== 发送消息 ==========

  private sendHello(): void {
    const hello = {
      clientImpl: this.options.clientImpl,
      clientVersion: this.options.clientVersion,
      maxFrameBytes: this.options.maxFrameBytes,
      supportsCompression: false,
      supportsDiffSnapshot: false,
    };

    const payload = wsBorsh.encodePayload(wsBorsh.schema.HelloC2SSchema, hello);
    const seq = this.nextSeq();
    const envelope = wsBorsh.encodeEnvelope(wsBorsh.KIND_HELLO_C2S, payload, seq);

    this.sendRaw(envelope);
    this.setState('HELLO_NEGOTIATING');
  }

  send(kind: number, payload: Uint8Array): boolean {
    if (!this.isReady()) {
      // 未就绪，加入队列
      if (this.pendingMessages.length < this.maxPendingMessages) {
        this.pendingMessages.push({ kind, payload });
      }
      return false;
    }

    const seq = this.nextSeq();

    // 检查是否需要分片
    const chunkResult = wsBorsh.splitPayloadIntoChunks(payload, kind, seq, {
      maxFrameBytes: this.options.maxFrameBytes,
      chunkStreamId: wsBorsh.generateChunkStreamId(),
    });

    if (chunkResult.totalChunks === 0) {
      // 不需要分片
      const envelope = wsBorsh.encodeEnvelope(kind, payload, seq);
      this.sendRaw(envelope);
    } else {
      // 发送分片
      for (const chunk of chunkResult.chunks) {
        const chunkEnvelope = wsBorsh.encodeChunk(chunk, this.nextSeq());
        this.sendRaw(chunkEnvelope);
      }
    }

    return true;
  }

  private sendRaw(data: Uint8Array): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    }
  }

  private flushPendingMessages(): void {
    while (this.pendingMessages.length > 0) {
      const msg = this.pendingMessages.shift();
      if (msg) {
        this.send(msg.kind, msg.payload);
      }
    }
  }

  // ========== 心跳 ==========

  private startHeartbeat(): void {
    this.stopHeartbeat();

    this.heartbeatTimer = setInterval(() => {
      this.sendPing();
    }, this.options.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private sendPing(): void {
    if (!this.isReady()) return;

    const ping = {
      nonce: Math.floor(Math.random() * 0xffffffff),
      timeMs: BigInt(Date.now()),
    };

    const payload = wsBorsh.encodePayload(wsBorsh.schema.PingPongSchema, ping);
    const seq = this.nextSeq();
    const envelope = wsBorsh.encodeEnvelope(wsBorsh.KIND_PING, payload, seq);

    this.sendRaw(envelope);
  }

  // ========== 重连 ==========

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;

    this.reconnectAttempts++;
    this.setState('RECONNECT_BACKOFF');

    const delay = Math.min(
      this.options.reconnectDelayMs * 2 ** (this.reconnectAttempts - 1),
      30000 // 最大 30 秒
    );

    console.log(`[borsh-client] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private clearTimers(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHeartbeat();
  }

  // ========== 工具方法 ==========

  private nextSeq(): number {
    this.seq = (this.seq + 1) % 0xffffffff;
    return this.seq;
  }
}

// 全局客户端实例
let globalClient: BorshWebSocketClient | null = null;

export function getBorshClient(): BorshWebSocketClient {
  if (!globalClient) {
    globalClient = new BorshWebSocketClient();
  }
  return globalClient;
}

export function resetBorshClient(): void {
  if (globalClient) {
    globalClient.disconnect();
    globalClient = null;
  }
}
