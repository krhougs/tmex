import type {
  GatewayHistoryCursor,
  GatewayPaneHistoryPage,
  GatewayPaneScreenSnapshot,
  GatewayRebaseReason,
  GatewayTerminalData,
} from '@tmex/ws-client';

const MAX_SURFACE_HISTORY_BYTES = 8 * 1024 * 1024;
const MAX_SURFACE_HISTORY_PAGES = 64;

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
  activate(target: Target): void;
  onRecoveryRequired(reason: GatewayRebaseReason): void;
  onSnapshotApplied?(target: Target, snapshot: GatewayPaneScreenSnapshot | null): void;
  maxHistoryBytes?: number;
  maxHistoryPages?: number;
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
 * 单终端渲染面：字节直通，不做 seq/epoch 判定，也不缓存 live 用于重建。
 *
 * 缺口只认链路上报的 rebase —— 服务端（gateway/relay/companion）已经在做这件事，
 * 渲染层再判定一遍的唯一效果是：快照尚未落地时 visibleCursor 为空，
 * 于是所有 live 被静默丢弃，终端一片空白。
 *
 * 重取首屏时直接在当前终端上重写，用户可见一次闪屏（已拍板接受），
 * 换掉原先的离屏双缓冲与客户端 replay ring。
 */
export class TerminalSurface<Target extends TerminalSurfaceTarget> {
  private readonly maxHistoryBytes: number;
  private readonly maxHistoryPages: number;
  private target: Target | null = null;
  private latestSnapshot: GatewayPaneScreenSnapshot | null = null;
  private historyPages: GatewayPaneHistoryPage[] = [];
  private historyBytes = 0;
  private nextHistoryCursor: GatewayHistoryCursor | null = null;
  private recoveryRequested = false;
  private recoveryReason: GatewayRebaseReason | null = null;
  private disposed = false;

  constructor(private readonly options: TerminalSurfaceOptions<Target>) {
    this.maxHistoryBytes = options.maxHistoryBytes ?? MAX_SURFACE_HISTORY_BYTES;
    this.maxHistoryPages = options.maxHistoryPages ?? MAX_SURFACE_HISTORY_PAGES;
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
    this.options.activate(target);
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
  }

  replace(snapshot: GatewayPaneScreenSnapshot): void {
    if (this.disposed || !this.target) return;
    const owned = copySnapshot(snapshot);
    this.latestSnapshot = owned;
    this.historyPages = [];
    this.historyBytes = 0;
    this.nextHistoryCursor = copyHistoryCursor(owned.historyCursor);
    this.recoveryRequested = false;
    this.recoveryReason = null;
    this.options.writeSnapshot(this.target, owned, []);
    this.options.onSnapshotApplied?.(this.target, owned);
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
    this.requestRecovery(reason);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.target?.dispose();
    this.target = null;
    this.latestSnapshot = null;
    this.historyPages = [];
    this.historyBytes = 0;
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
