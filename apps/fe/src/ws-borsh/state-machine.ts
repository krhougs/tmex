// FE 选择事务状态机
// 管理 pane 切换、history/live 合并
// 参考: docs/ws-protocol/2026021403-ws-state-machines.md

// ========== 状态定义 ==========

export type SelectTransactionState =
  | 'STABLE'
  | 'SELECTING'
  | 'ACKED'
  | 'HISTORY_APPLIED'
  | 'LIVE'
  | 'SELECT_FAILED';

export interface SelectTransaction {
  state: SelectTransactionState;
  deviceId: string;
  windowId: string;
  paneId: string;
  selectToken: Uint8Array;
  wantHistory: boolean;
  startedAt: number;
}

export type OutputGateState = 'FLOWING' | 'BUFFERING';

export interface OutputGate {
  state: OutputGateState;
  buffer: Uint8Array[];
}

// ========== 事件定义 ==========

export interface SelectStartEvent {
  type: 'SELECT_START';
  deviceId: string;
  windowId: string;
  paneId: string;
  selectToken: Uint8Array;
  wantHistory: boolean;
}

export interface SwitchAckEvent {
  type: 'SWITCH_ACK';
  deviceId: string;
  selectToken: Uint8Array;
}

export interface HistoryEvent {
  type: 'HISTORY';
  deviceId: string;
  selectToken: Uint8Array;
  data: string;
}

export interface LiveResumeEvent {
  type: 'LIVE_RESUME';
  deviceId: string;
  selectToken: Uint8Array;
}

export interface OutputEvent {
  type: 'OUTPUT';
  deviceId: string;
  paneId: string;
  data: Uint8Array;
}

export interface SelectFailedEvent {
  type: 'SELECT_FAILED';
  deviceId: string;
}

export type SelectEvent =
  | SelectStartEvent
  | SwitchAckEvent
  | HistoryEvent
  | LiveResumeEvent
  | OutputEvent
  | SelectFailedEvent;

// ========== 回调定义 ==========

export interface SelectCallbacks {
  onResetTerminal?: (deviceId: string) => void;
  onApplyHistory?: (deviceId: string, data: string) => void;
  onFlushBuffer?: (deviceId: string, buffer: Uint8Array[]) => void;
  onOutput?: (deviceId: string, paneId: string, data: Uint8Array) => void;
  onSelectFailed?: (deviceId: string) => void;
}

// ========== 状态机 ==========

export class SelectStateMachine {
  private transactions = new Map<string, SelectTransaction>();
  private outputGates = new Map<string, OutputGate>();
  private deferredHistories = new Map<string, string>();
  private deferredFlushes = new Map<string, Uint8Array[]>();
  private deferredOutputs = new Map<string, Array<{ paneId: string; data: Uint8Array }>>();
  private callbacks: SelectCallbacks;

  // 超时配置
  private ackTimeoutMs = 1500;
  private liveResumeTimeoutMs = 2000;

  // 超时定时器
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(callbacks: SelectCallbacks = {}) {
    this.callbacks = callbacks;
  }

  setCallbacks(callbacks: SelectCallbacks): void {
    this.callbacks = callbacks;
    for (const deviceId of this.transactions.keys()) {
      this.replayDeferred(deviceId);
    }
    for (const deviceId of this.deferredHistories.keys()) {
      this.replayDeferred(deviceId);
    }
    for (const deviceId of this.deferredFlushes.keys()) {
      this.replayDeferred(deviceId);
    }
    for (const deviceId of this.deferredOutputs.keys()) {
      this.replayDeferred(deviceId);
    }
  }

  // ========== 状态查询 ==========

  getTransaction(deviceId: string): SelectTransaction | undefined {
    return this.transactions.get(deviceId);
  }

  getState(deviceId: string): SelectTransactionState {
    return this.transactions.get(deviceId)?.state ?? 'STABLE';
  }

  isStable(deviceId: string): boolean {
    return this.getState(deviceId) === 'STABLE';
  }

  isBuffering(deviceId: string): boolean {
    return this.outputGates.get(deviceId)?.state === 'BUFFERING';
  }

  // ========== 事件处理 ==========

  dispatch(event: SelectEvent): void {
    switch (event.type) {
      case 'SELECT_START':
        this.handleSelectStart(event);
        break;
      case 'SWITCH_ACK':
        this.handleSwitchAck(event);
        break;
      case 'HISTORY':
        this.handleHistory(event);
        break;
      case 'LIVE_RESUME':
        this.handleLiveResume(event);
        break;
      case 'OUTPUT':
        this.handleOutput(event);
        break;
      case 'SELECT_FAILED':
        this.handleSelectFailed(event);
        break;
    }
  }

  // ========== 事件处理器 ==========

  private handleSelectStart(event: SelectStartEvent): void {
    const { deviceId, windowId, paneId, selectToken, wantHistory } = event;

    // 取消之前的事务
    this.cancelTransaction(deviceId);
    this.clearDeferred(deviceId);

    // 创建新事务
    const transaction: SelectTransaction = {
      state: 'SELECTING',
      deviceId,
      windowId,
      paneId,
      selectToken: new Uint8Array(selectToken),
      wantHistory,
      startedAt: Date.now(),
    };

    this.transactions.set(deviceId, transaction);

    // 启动输出门控
    this.startOutputBuffering(deviceId);

    // 设置 ACK 超时
    this.setTimer(
      deviceId,
      () => {
        this.handleTimeout(deviceId, 'ack');
      },
      this.ackTimeoutMs
    );
  }

  private handleSwitchAck(event: SwitchAckEvent): void {
    const { deviceId, selectToken } = event;
    const transaction = this.transactions.get(deviceId);

    if (!transaction || !this.validateToken(transaction.selectToken, selectToken)) {
      return;
    }

    if (transaction.state !== 'SELECTING') {
      return;
    }

    // 清除 ACK 超时
    this.clearTimer(deviceId);

    // 更新状态
    transaction.state = 'ACKED';

    // 重置终端
    this.callbacks.onResetTerminal?.(deviceId);

    // ACK 后进入等待 LIVE_RESUME。history 可选且不会阻塞 live。
    this.setTimer(
      deviceId,
      () => {
        this.handleTimeout(deviceId, 'live');
      },
      this.liveResumeTimeoutMs
    );
  }

  private handleHistory(event: HistoryEvent): void {
    const { deviceId, selectToken, data } = event;
    const transaction = this.transactions.get(deviceId);

    if (!transaction || !this.validateToken(transaction.selectToken, selectToken)) {
      return;
    }

    if (transaction.state !== 'ACKED') {
      return;
    }

    // 更新状态
    transaction.state = 'HISTORY_APPLIED';

    if (this.callbacks.onApplyHistory) {
      this.callbacks.onApplyHistory(deviceId, data);
    } else {
      this.deferredHistories.set(deviceId, data);
    }

    // 继续等待 LIVE_RESUME（重置超时窗口，避免长 history 导致误判）
    this.setTimer(
      deviceId,
      () => {
        this.handleTimeout(deviceId, 'live');
      },
      this.liveResumeTimeoutMs
    );
  }

  private handleLiveResume(event: LiveResumeEvent): void {
    const { deviceId, selectToken } = event;
    const transaction = this.transactions.get(deviceId);

    if (!transaction || !this.validateToken(transaction.selectToken, selectToken)) {
      return;
    }

    if (transaction.state !== 'ACKED' && transaction.state !== 'HISTORY_APPLIED') {
      return;
    }

    // 清除超时
    this.clearTimer(deviceId);

    // 更新状态
    transaction.state = 'LIVE';

    // 停止输出门控并 flush
    const buffered = this.stopOutputBuffering(deviceId);

    // 完成事务
    this.completeTransaction(deviceId);

    if (this.callbacks.onFlushBuffer) {
      this.callbacks.onFlushBuffer(deviceId, buffered);
    } else if (buffered.length > 0) {
      this.deferredFlushes.set(deviceId, buffered);
    }

    this.replayDeferred(deviceId);
  }

  private handleOutput(event: OutputEvent): void {
    const { deviceId, paneId, data } = event;
    const transaction = this.transactions.get(deviceId);

    // 检查 pane 是否匹配
    if (transaction && transaction.paneId !== paneId) {
      return;
    }

    // 如果在缓冲状态，缓冲输出
    if (this.isBuffering(deviceId)) {
      this.bufferOutput(deviceId, data);
      return;
    }

    if (this.callbacks.onOutput) {
      this.callbacks.onOutput(deviceId, paneId, data);
      return;
    }

    const pending = this.deferredOutputs.get(deviceId) ?? [];
    pending.push({ paneId, data: new Uint8Array(data) });
    this.deferredOutputs.set(deviceId, pending);
  }

  private handleSelectFailed(event: SelectFailedEvent): void {
    const { deviceId } = event;
    this.failTransaction(deviceId);
  }

  private handleTimeout(deviceId: string, stage: 'ack' | 'history' | 'live'): void {
    console.warn(`[select-sm] Timeout at ${stage} for ${deviceId}`);
    this.failTransaction(deviceId);
  }

  // ========== 事务管理 ==========

  private completeTransaction(deviceId: string): void {
    const transaction = this.transactions.get(deviceId);
    if (!transaction) return;

    transaction.state = 'STABLE';
    this.transactions.delete(deviceId);
  }

  private failTransaction(deviceId: string): void {
    const transaction = this.transactions.get(deviceId);
    if (!transaction) return;

    transaction.state = 'SELECT_FAILED';

    // 停止输出门控
    this.stopOutputBuffering(deviceId);

    // 回调
    this.callbacks.onSelectFailed?.(deviceId);

    // 清理
    this.transactions.delete(deviceId);
    this.clearTimer(deviceId);
    this.clearDeferred(deviceId);
  }

  private cancelTransaction(deviceId: string): void {
    const transaction = this.transactions.get(deviceId);
    if (!transaction) return;

    // 丢弃缓冲的输出
    this.stopOutputBuffering(deviceId);

    // 清理
    this.transactions.delete(deviceId);
    this.clearTimer(deviceId);
    this.clearDeferred(deviceId);
  }

  // ========== 输出门控 ==========

  private startOutputBuffering(deviceId: string): void {
    this.outputGates.set(deviceId, {
      state: 'BUFFERING',
      buffer: [],
    });
  }

  private stopOutputBuffering(deviceId: string): Uint8Array[] {
    const gate = this.outputGates.get(deviceId);
    if (!gate) return [];

    const buffered = [...gate.buffer];
    this.outputGates.delete(deviceId);
    return buffered;
  }

  private bufferOutput(deviceId: string, data: Uint8Array): void {
    const gate = this.outputGates.get(deviceId);
    if (!gate) return;

    // 限制缓冲大小
    if (gate.buffer.length >= 1000) {
      gate.buffer.shift();
    }

    gate.buffer.push(new Uint8Array(data));
  }

  // ========== 工具方法 ==========

  private validateToken(expected: Uint8Array, received: Uint8Array): boolean {
    if (expected.length !== received.length) return false;
    for (let i = 0; i < expected.length; i++) {
      if (expected[i] !== received[i]) return false;
    }
    return true;
  }

  private replayDeferred(deviceId: string): void {
    const history = this.deferredHistories.get(deviceId);
    if (history !== undefined && this.callbacks.onApplyHistory) {
      this.callbacks.onApplyHistory(deviceId, history);
      this.deferredHistories.delete(deviceId);
    }

    const flush = this.deferredFlushes.get(deviceId);
    if (flush && this.callbacks.onFlushBuffer) {
      this.callbacks.onFlushBuffer(deviceId, flush);
      this.deferredFlushes.delete(deviceId);
    }

    const outputs = this.deferredOutputs.get(deviceId);
    if (outputs && this.callbacks.onOutput) {
      for (const output of outputs) {
        this.callbacks.onOutput(deviceId, output.paneId, output.data);
      }
      this.deferredOutputs.delete(deviceId);
    }
  }

  private clearDeferred(deviceId: string): void {
    this.deferredHistories.delete(deviceId);
    this.deferredFlushes.delete(deviceId);
    this.deferredOutputs.delete(deviceId);
  }

  private setTimer(deviceId: string, callback: () => void, delay: number): void {
    this.clearTimer(deviceId);
    const timer = setTimeout(callback, delay);
    this.timers.set(deviceId, timer);
  }

  private clearTimer(deviceId: string): void {
    const timer = this.timers.get(deviceId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(deviceId);
    }
  }

  // ========== 清理 ==========

  cleanup(deviceId: string): void {
    this.cancelTransaction(deviceId);
    this.outputGates.delete(deviceId);
    this.clearDeferred(deviceId);
  }

  cleanupAll(): void {
    for (const deviceId of this.transactions.keys()) {
      this.cleanup(deviceId);
    }
    this.transactions.clear();
    this.outputGates.clear();
    this.deferredHistories.clear();
    this.deferredFlushes.clear();
    this.deferredOutputs.clear();
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }
}

// 全局状态机实例
let globalStateMachine: SelectStateMachine | null = null;

export function getSelectStateMachine(callbacks?: SelectCallbacks): SelectStateMachine {
  if (!globalStateMachine) {
    globalStateMachine = new SelectStateMachine(callbacks);
    return globalStateMachine;
  }
  if (callbacks) {
    globalStateMachine.setCallbacks(callbacks);
  }
  return globalStateMachine;
}

export function resetSelectStateMachine(): void {
  if (globalStateMachine) {
    globalStateMachine.cleanupAll();
    globalStateMachine = null;
  }
}
