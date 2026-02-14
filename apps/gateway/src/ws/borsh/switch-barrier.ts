// Gateway 切换屏障实现
// 处理 TMUX_SELECT 事务: ACK -> HISTORY -> LIVE_RESUME
// 参考: docs/terminal/2026021404-terminal-switch-barrier-design.md

import type { ServerWebSocket } from 'bun';
import {
  type BorshClientState,
  encodeLiveResume,
  encodeSwitchAck,
  encodeTermHistory,
  encodeTermOutput,
  sendToClient,
} from './codec-borsh';
import { type SessionState, sessionStateStore } from './session-state';

// ========== 配置 ==========

const SWITCH_ACK_TIMEOUT_MS = 1500;
const HISTORY_TIMEOUT_MS = 1500;
const LIVE_RESUME_DELAY_MS = 450;

// ========== 切换屏障管理器 ==========

export interface SwitchBarrierContext {
  deviceId: string;
  windowId: string;
  paneId: string;
  selectToken: Uint8Array;
  wantHistory: boolean;
  cols: number | null;
  rows: number | null;
}

export interface SwitchBarrierCallbacks {
  onAckSent?: () => void;
  onHistorySent?: () => void;
  onLiveResumed?: () => void;
  onTimeout?: (stage: 'ack' | 'history') => void;
}

export class SwitchBarrier {
  private pendingTransactions = new Map<
    ServerWebSocket<unknown>,
    Map<
      string, // deviceId
      {
        context: SwitchBarrierContext;
        callbacks: SwitchBarrierCallbacks;
        timers: ReturnType<typeof setTimeout>[];
      }
    >
  >();

  private tokensEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  private getOrCreateDeviceMap(ws: ServerWebSocket<unknown>): Map<
    string,
    {
      context: SwitchBarrierContext;
      callbacks: SwitchBarrierCallbacks;
      timers: ReturnType<typeof setTimeout>[];
    }
  > {
    const existing = this.pendingTransactions.get(ws);
    if (existing) return existing;
    const created = new Map();
    this.pendingTransactions.set(ws, created);
    return created;
  }

  private getPending(ws: ServerWebSocket<unknown>, deviceId: string) {
    return this.pendingTransactions.get(ws)?.get(deviceId);
  }

  private setPending(
    ws: ServerWebSocket<unknown>,
    deviceId: string,
    value: {
      context: SwitchBarrierContext;
      callbacks: SwitchBarrierCallbacks;
      timers: ReturnType<typeof setTimeout>[];
    }
  ): void {
    this.getOrCreateDeviceMap(ws).set(deviceId, value);
  }

  private deletePending(ws: ServerWebSocket<unknown>, deviceId: string): void {
    const map = this.pendingTransactions.get(ws);
    if (!map) return;
    map.delete(deviceId);
    if (map.size === 0) {
      this.pendingTransactions.delete(ws);
    }
  }

  /**
   * 启动一个新的选择事务
   */
  startTransaction(
    ws: ServerWebSocket<unknown & { borshState?: BorshClientState }>,
    context: SwitchBarrierContext,
    callbacks: SwitchBarrierCallbacks = {}
  ): boolean {
    // 取消任何进行中的事务
    this.cancelTransaction(ws, context.deviceId);

    // 初始化状态机
    const started = sessionStateStore.startSelectTransaction(
      ws,
      context.deviceId,
      context.windowId,
      context.paneId,
      context.selectToken
    );

    if (!started) {
      console.error(`[switch-barrier] Failed to start transaction for ${context.deviceId}`);
      return false;
    }

    const timers: ReturnType<typeof setTimeout>[] = [];

    // 设置超时定时器
    timers.push(
      setTimeout(() => {
        this.handleTimeout(ws, context.deviceId, 'ack', context.selectToken);
      }, SWITCH_ACK_TIMEOUT_MS)
    );

    this.setPending(ws, context.deviceId, {
      context,
      callbacks,
      timers,
    });

    return true;
  }

  /**
   * 发送 SWITCH_ACK
   */
  sendSwitchAck(
    ws: ServerWebSocket<unknown & { borshState?: BorshClientState }>,
    deviceId: string
  ): void {
    const pending = this.getPending(ws, deviceId);
    if (!pending) return;

    const { context } = pending;
    const borshState = ws.data?.borshState;
    if (!borshState) return;

    // 清除 ACK 超时定时器
    const ackTimer = pending.timers.shift();
    if (ackTimer) clearTimeout(ackTimer);

    // 更新状态机
    sessionStateStore.transitionSelectState(ws, deviceId, 'ACKED');

    // 发送 ACK
    const seq = borshState.seqGen();
    const ackData = encodeSwitchAck(
      {
        deviceId,
        windowId: context.windowId,
        paneId: context.paneId,
        selectToken: context.selectToken,
      },
      seq
    );

    sendToClient(ws, ackData);

    // 设置 HISTORY 超时
    if (context.wantHistory) {
      pending.timers.push(
        setTimeout(() => {
          this.handleTimeout(ws, deviceId, 'history', context.selectToken);
        }, HISTORY_TIMEOUT_MS)
      );
    } else {
      // 不需要 history，也要延迟解除屏障，给“快速连续切换”留出取消窗口。
      const expectedToken = context.selectToken;
      pending.timers.push(
        setTimeout(() => {
          this.sendLiveResume(ws, deviceId, expectedToken);
        }, LIVE_RESUME_DELAY_MS)
      );
    }

    pending.callbacks.onAckSent?.();
  }

  /**
   * 发送 TERM_HISTORY
   */
  sendTermHistory(
    ws: ServerWebSocket<unknown & { borshState?: BorshClientState }>,
    deviceId: string,
    paneId: string,
    historyData: Uint8Array
  ): void {
    const pending = this.getPending(ws, deviceId);
    if (!pending) return;

    const { context } = pending;
    if (context.paneId !== paneId) {
      return;
    }
    const borshState = ws.data?.borshState;
    if (!borshState) return;

    // 清除 HISTORY 超时定时器
    const historyTimer = pending.timers.shift();
    if (historyTimer) clearTimeout(historyTimer);

    // 更新状态机
    sessionStateStore.transitionSelectState(ws, deviceId, 'HISTORY_APPLIED');

    // 发送 HISTORY
    const historyMessages = encodeTermHistory(
      {
        deviceId,
        paneId: context.paneId,
        selectToken: context.selectToken,
        encoding: 2, // utf8-bytes
        data: historyData,
      },
      borshState.seqGen,
      borshState.maxFrameBytes
    );

    sendToClient(ws, historyMessages);

    pending.callbacks.onHistorySent?.();

    // history 发送完成后延迟解除屏障，给“快速连续切换”留出取消窗口。
    const expectedToken = context.selectToken;
    pending.timers.push(
      setTimeout(() => {
        this.sendLiveResume(ws, deviceId, expectedToken);
      }, LIVE_RESUME_DELAY_MS)
    );
  }

  /**
   * 发送 LIVE_RESUME
   */
  sendLiveResume(
    ws: ServerWebSocket<unknown & { borshState?: BorshClientState }>,
    deviceId: string,
    expectedToken?: Uint8Array
  ): void {
    const pending = this.getPending(ws, deviceId);
    if (!pending) return;

    const { context } = pending;
    if (expectedToken && !this.tokensEqual(context.selectToken, expectedToken)) {
      return;
    }
    const borshState = ws.data?.borshState;
    if (!borshState) return;

    // 清除所有定时器
    for (const timer of pending.timers) {
      clearTimeout(timer);
    }
    pending.timers = [];

    // 更新状态机到 LIVE
    sessionStateStore.transitionSelectState(ws, deviceId, 'LIVE');

    // 获取缓冲的输出
    const bufferedOutput = sessionStateStore.stopOutputBuffering(ws, deviceId);

    // 发送 LIVE_RESUME
    const seq = borshState.seqGen();
    const liveResumeData = encodeLiveResume(
      {
        deviceId,
        paneId: context.paneId,
        selectToken: context.selectToken,
      },
      seq
    );

    sendToClient(ws, liveResumeData);

    // flush 缓冲输出（LIVE_RESUME 之后发送，保证顺序）
    for (const data of bufferedOutput) {
      const outputSeq = borshState.seqGen();
      const outputData = encodeTermOutput(
        {
          deviceId,
          paneId: context.paneId,
          encoding: 1, // raw bytes
          data,
        },
        outputSeq
      );
      sendToClient(ws, outputData);
    }

    // 完成事务
    this.completeTransaction(ws, deviceId);

    pending.callbacks.onLiveResumed?.();
  }

  /**
   * 获取当前事务的 token
   */
  getSelectToken(ws: ServerWebSocket<unknown>, deviceId: string): Uint8Array | null {
    return this.getPending(ws, deviceId)?.context.selectToken ?? null;
  }

  /**
   * 验证 token 是否匹配当前事务
   */
  validateToken(ws: ServerWebSocket<unknown>, deviceId: string, token: Uint8Array): boolean {
    const currentToken = this.getSelectToken(ws, deviceId);
    if (!currentToken) return false;

    if (currentToken.length !== token.length) return false;
    for (let i = 0; i < currentToken.length; i++) {
      if (currentToken[i] !== token[i]) return false;
    }
    return true;
  }

  /**
   * 检查是否应该缓冲输出
   */
  shouldBufferOutput(ws: ServerWebSocket<unknown>, deviceId: string): boolean {
    return sessionStateStore.isBuffering(ws, deviceId);
  }

  /**
   * 缓冲输出数据
   */
  bufferOutput(ws: ServerWebSocket<unknown>, deviceId: string, data: Uint8Array): boolean {
    return sessionStateStore.bufferOutput(ws, deviceId, data);
  }

  /**
   * 处理超时
   */
  private handleTimeout(
    ws: ServerWebSocket<unknown>,
    deviceId: string,
    stage: 'ack' | 'history',
    expectedToken?: Uint8Array
  ): void {
    const pending = this.getPending(ws, deviceId);
    if (!pending) return;
    if (expectedToken && !this.tokensEqual(pending.context.selectToken, expectedToken)) {
      return;
    }

    console.warn(`[switch-barrier] Transaction timeout at stage: ${stage} for ${deviceId}`);

    if (stage === 'history') {
      // history 超时: 允许无 history 进入 live，保证不阻塞
      this.sendLiveResume(ws as any, deviceId, expectedToken);
      pending.callbacks.onTimeout?.(stage);
      return;
    }

    // ACK 超时视为失败
    sessionStateStore.transitionSelectState(ws, deviceId, 'SELECT_FAILED');
    sessionStateStore.stopOutputBuffering(ws, deviceId);

    // 回调
    pending.callbacks.onTimeout?.(stage);

    // 清理事务
    this.cleanupTransaction(ws, deviceId);
  }

  /**
   * 取消进行中的事务
   */
  cancelTransaction(ws: ServerWebSocket<unknown>, deviceId: string): void {
    const pending = this.getPending(ws, deviceId);
    if (!pending) return;

    // 清除定时器
    for (const timer of pending.timers) {
      clearTimeout(timer);
    }

    // 解除输出门控
    sessionStateStore.stopOutputBuffering(ws, deviceId);

    // 清理
    this.cleanupTransaction(ws, deviceId);
  }

  /**
   * 完成事务
   */
  private completeTransaction(ws: ServerWebSocket<unknown>, deviceId: string): void {
    // 更新状态机为 STABLE
    sessionStateStore.transitionSelectState(ws, deviceId, 'STABLE');

    // 清理
    this.cleanupTransaction(ws, deviceId);
  }

  /**
   * 清理事务数据
   */
  private cleanupTransaction(ws: ServerWebSocket<unknown>, deviceId: string): void {
    this.deletePending(ws, deviceId);
  }

  /**
   * 清理客户端的所有事务
   */
  cleanupClient(ws: ServerWebSocket<unknown>): void {
    const deviceMap = this.pendingTransactions.get(ws);
    if (!deviceMap) return;
    for (const deviceId of Array.from(deviceMap.keys())) {
      this.cancelTransaction(ws, deviceId);
    }
  }
}

// 全局单例
export const switchBarrier = new SwitchBarrier();
