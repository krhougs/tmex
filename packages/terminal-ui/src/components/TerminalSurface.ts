import type {
  GatewayHistoryCursor,
  GatewayPaneHistoryPage,
  GatewayPaneScreenSnapshot,
  GatewayRebaseReason,
  GatewayTerminalData,
} from '@tmex/ws-client';

const MAX_SURFACE_HISTORY_BYTES = 8 * 1024 * 1024;
const MAX_SURFACE_HISTORY_PAGES = 64;
export const MAX_SURFACE_PENDING_LIVE_BYTES = 2 * 1024 * 1024;

export interface TerminalSurfaceTarget {
  dispose(): void;
}

export type TerminalSurfaceRecoveryState = 'initializing' | 'live' | 'recovering' | 'disposed';

export interface TerminalSurfaceDiagnosticState {
  paneEpoch: Uint8Array | null;
  historyEpoch: Uint8Array | null;
  historyBeforeLine: number | null;
  recoveryState: TerminalSurfaceRecoveryState;
  recoveryReason: GatewayRebaseReason | null;
  historyBytes: number;
  historyBytesLimit: number;
  historyPages: number;
  historyPagesLimit: number;
}

export interface TerminalSurfaceOptions<Target extends TerminalSurfaceTarget> {
  createTarget(): Promise<Target>;
  writeSnapshot(
    target: Target,
    snapshot: GatewayPaneScreenSnapshot,
    historyPages: readonly GatewayPaneHistoryPage[]
  ): void;
  /** 历史页前插：离屏解析后拼接展示，不重建终端（replace 是终端重建的唯一入口）。 */
  prependHistory(target: Target, page: GatewayPaneHistoryPage): void;
  writeLive(target: Target, data: Uint8Array): void;
  waitForFirstRender?(target: Target): Promise<void>;
  activate(target: Target, previous: Target | null): void;
  onRecoveryRequired(reason: GatewayRebaseReason): void;
  onSnapshotApplied?(target: Target, snapshot: GatewayPaneScreenSnapshot | null): void;
  maxHistoryBytes?: number;
  maxHistoryPages?: number;
  maxPendingLiveBytes?: number;
}

interface PendingReplacement<Target> {
  id: number;
  target: Target | null;
  bufferedLive: Uint8Array[];
  bufferedLiveBytes: number;
  acceptsDirectLive: boolean;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function copyHistoryCursor(cursor: GatewayHistoryCursor | null): GatewayHistoryCursor | null {
  return cursor
    ? {
        paneEpoch: Uint8Array.from(cursor.paneEpoch),
        historyEpoch: Uint8Array.from(cursor.historyEpoch),
        beforeLine: cursor.beforeLine,
      }
    : null;
}

function copySnapshot(snapshot: GatewayPaneScreenSnapshot): GatewayPaneScreenSnapshot {
  return {
    ...snapshot,
    requestId: snapshot.requestId ? Uint8Array.from(snapshot.requestId) : undefined,
    paneEpoch: Uint8Array.from(snapshot.paneEpoch),
    data: Uint8Array.from(snapshot.data),
    historyCursor: copyHistoryCursor(snapshot.historyCursor),
  };
}

function copyHistoryPage(page: GatewayPaneHistoryPage): GatewayPaneHistoryPage {
  return {
    ...page,
    requestId: page.requestId ? Uint8Array.from(page.requestId) : undefined,
    paneEpoch: Uint8Array.from(page.paneEpoch),
    historyEpoch: Uint8Array.from(page.historyEpoch),
    data: Uint8Array.from(page.data),
    nextCursor: copyHistoryCursor(page.nextCursor),
  };
}

/**
 * 终端渲染面：字节直通，不做 seq/epoch 判定，也不持有长期 replay ring。
 *
 * 缺口只认链路上报的 rebase —— 服务端（gateway/relay/companion）已经在做这件事，
 * 渲染层再判定一遍的唯一效果是：快照尚未落地时 visibleCursor 为空，
 * 于是所有 live 被静默丢弃，终端一片空白。
 *
 * snapshot 在隐藏候选终端完成解析和首次绘制后原子切换；候选创建期间只暂存有界的
 * 后续 live 字节，避免在可见终端上完整重放。
 */
export class TerminalSurface<Target extends TerminalSurfaceTarget> {
  private readonly maxHistoryBytes: number;
  private readonly maxHistoryPages: number;
  private readonly maxPendingLiveBytes: number;
  private target: Target | null = null;
  private pending: PendingReplacement<Target> | null = null;
  private latestSnapshot: GatewayPaneScreenSnapshot | null = null;
  private historyPages: GatewayPaneHistoryPage[] = [];
  private historyBytes = 0;
  private nextHistoryCursor: GatewayHistoryCursor | null = null;
  private recoveryRequested = false;
  private recoveryReason: GatewayRebaseReason | null = null;
  private replacementId = 0;
  private disposed = false;

  constructor(private readonly options: TerminalSurfaceOptions<Target>) {
    this.maxHistoryBytes = options.maxHistoryBytes ?? MAX_SURFACE_HISTORY_BYTES;
    this.maxHistoryPages = options.maxHistoryPages ?? MAX_SURFACE_HISTORY_PAGES;
    this.maxPendingLiveBytes = options.maxPendingLiveBytes ?? MAX_SURFACE_PENDING_LIVE_BYTES;
  }

  async initialize(): Promise<Target> {
    if (this.disposed) throw new Error('terminal surface disposed');
    if (this.target) return this.target;
    const target = await this.options.createTarget();
    if (this.disposed) {
      target.dispose();
      throw new Error('terminal surface disposed');
    }
    this.target = target;
    this.options.activate(target, null);
    this.options.onSnapshotApplied?.(target, null);
    return target;
  }

  getVisibleTarget(): Target | null {
    return this.target;
  }

  getNextHistoryCursor(): GatewayHistoryCursor | null {
    return copyHistoryCursor(this.nextHistoryCursor);
  }

  getDiagnosticState(): TerminalSurfaceDiagnosticState {
    return {
      paneEpoch: this.latestSnapshot ? Uint8Array.from(this.latestSnapshot.paneEpoch) : null,
      historyEpoch: this.nextHistoryCursor
        ? Uint8Array.from(this.nextHistoryCursor.historyEpoch)
        : null,
      historyBeforeLine: this.nextHistoryCursor?.beforeLine ?? null,
      recoveryState: this.disposed
        ? 'disposed'
        : this.recoveryRequested
          ? 'recovering'
          : this.pending
            ? 'recovering'
            : this.target
              ? 'live'
              : 'initializing',
      recoveryReason: this.recoveryReason,
      historyBytes: this.historyBytes,
      historyBytesLimit: this.maxHistoryBytes,
      historyPages: this.historyPages.length,
      historyPagesLimit: this.maxHistoryPages,
    };
  }

  write(frame: GatewayTerminalData): void {
    if (this.disposed || !this.target) return;
    this.options.writeLive(this.target, frame.data);
    const pending = this.pending;
    if (!pending) return;
    if (pending.acceptsDirectLive && pending.target) {
      try {
        this.options.writeLive(pending.target, frame.data);
      } catch {
        this.cancelPending();
        this.requestRecovery('resource_exhausted');
      }
      return;
    }
    if (pending.bufferedLiveBytes + frame.data.byteLength > this.maxPendingLiveBytes) {
      this.cancelPending();
      this.requestRecovery('resource_exhausted');
      return;
    }
    const data = Uint8Array.from(frame.data);
    pending.bufferedLive.push(data);
    pending.bufferedLiveBytes += data.byteLength;
  }

  replace(snapshot: GatewayPaneScreenSnapshot): void {
    if (this.disposed || !this.target) return;
    const owned = copySnapshot(snapshot);
    this.recoveryRequested = false;
    this.recoveryReason = null;
    this.startReplacement(owned);
  }

  applyHistoryPage(page: GatewayPaneHistoryPage): boolean {
    if (this.disposed || !this.target || !this.latestSnapshot || !this.nextHistoryCursor) {
      return false;
    }
    const expected = this.nextHistoryCursor;
    if (
      page.deviceId !== this.latestSnapshot.deviceId ||
      page.paneId !== this.latestSnapshot.paneId ||
      !bytesEqual(page.paneEpoch, this.latestSnapshot.paneEpoch) ||
      !bytesEqual(page.paneEpoch, expected.paneEpoch) ||
      !bytesEqual(page.historyEpoch, expected.historyEpoch) ||
      page.lineEnd !== expected.beforeLine ||
      page.lineStart > page.lineEnd
    ) {
      this.requestRecovery('cache_evicted');
      return false;
    }
    if (
      page.nextCursor &&
      (!bytesEqual(page.nextCursor.paneEpoch, page.paneEpoch) ||
        !bytesEqual(page.nextCursor.historyEpoch, page.historyEpoch) ||
        page.nextCursor.beforeLine !== page.lineStart)
    ) {
      this.requestRecovery('cache_evicted');
      return false;
    }
    if (
      this.historyPages.length >= this.maxHistoryPages ||
      this.historyBytes + page.data.byteLength > this.maxHistoryBytes
    ) {
      this.nextHistoryCursor = null;
      return false;
    }

    const owned = copyHistoryPage(page);
    this.historyPages.push(owned);
    this.historyPages.sort((left, right) => left.lineStart - right.lineStart);
    this.historyBytes += owned.data.byteLength;
    this.nextHistoryCursor = copyHistoryCursor(owned.nextCursor);
    this.options.prependHistory(this.target, owned);
    this.options.onSnapshotApplied?.(this.target, this.latestSnapshot);
    return true;
  }

  rebase(reason: GatewayRebaseReason): void {
    if (this.disposed) return;
    this.cancelPending();
    this.requestRecovery(reason);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.replacementId += 1;
    this.cancelPending(false);
    this.target?.dispose();
    this.target = null;
    this.latestSnapshot = null;
    this.historyPages = [];
    this.historyBytes = 0;
  }

  private startReplacement(snapshot: GatewayPaneScreenSnapshot): void {
    const id = ++this.replacementId;
    this.cancelPending(false);
    const pending: PendingReplacement<Target> = {
      id,
      target: null,
      bufferedLive: [],
      bufferedLiveBytes: 0,
      acceptsDirectLive: false,
    };
    this.pending = pending;
    void this.buildReplacement(pending, snapshot);
  }

  private async buildReplacement(
    pending: PendingReplacement<Target>,
    snapshot: GatewayPaneScreenSnapshot
  ): Promise<void> {
    let target: Target;
    try {
      target = await this.options.createTarget();
    } catch {
      if (!this.disposed && this.pending === pending) {
        this.pending = null;
        this.requestRecovery('resource_exhausted');
      }
      return;
    }
    if (this.disposed || this.pending !== pending || pending.id !== this.replacementId) {
      target.dispose();
      return;
    }
    pending.target = target;
    try {
      this.options.writeSnapshot(target, snapshot, []);
      for (const data of pending.bufferedLive) this.options.writeLive(target, data);
      pending.bufferedLive = [];
      pending.bufferedLiveBytes = 0;
      pending.acceptsDirectLive = true;
      await this.options.waitForFirstRender?.(target);
    } catch {
      if (this.pending === pending) this.pending = null;
      if (pending.target === target) {
        pending.target = null;
        target.dispose();
      }
      if (!this.disposed && pending.id === this.replacementId) {
        this.requestRecovery('resource_exhausted');
      }
      return;
    }
    if (this.disposed || this.pending !== pending || pending.id !== this.replacementId) {
      if (pending.target === target) {
        pending.target = null;
        target.dispose();
      }
      return;
    }

    const previous = this.target;
    this.options.activate(target, previous);
    this.target = target;
    this.pending = null;
    this.latestSnapshot = snapshot;
    this.historyPages = [];
    this.historyBytes = 0;
    this.nextHistoryCursor = copyHistoryCursor(snapshot.historyCursor);
    this.recoveryRequested = false;
    this.recoveryReason = null;
    this.options.onSnapshotApplied?.(target, snapshot);
    if (previous && previous !== target) previous.dispose();
  }

  private cancelPending(incrementId = true): void {
    if (incrementId) this.replacementId += 1;
    const pending = this.pending;
    this.pending = null;
    if (pending?.target) {
      const target = pending.target;
      pending.target = null;
      target.dispose();
    }
  }

  private requestRecovery(reason: GatewayRebaseReason): void {
    const changed = this.recoveryReason !== reason;
    this.recoveryReason = reason;
    // 同一 reason 的恢复请求在途时抑制重复请求，避免请求风暴；但 reason 变化必须继续上报：
    // 首屏一直取不回来时，重试耗尽后的 resource_exhausted 正是靠这条路径把失败态交给渲染层，
    // 被吞掉就只能永远停在 Loading。
    if (this.recoveryRequested && !changed) return;
    this.recoveryRequested = true;
    this.options.onRecoveryRequired(reason);
  }
}
