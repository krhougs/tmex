import {
  PANE_MODE_ALT_SCREEN,
  PANE_MODE_FLAGS_PRESENT,
  type StateSnapshotPayload,
  encodePaneModes,
  wsBorsh,
} from '@tmex/shared';

import { getDeviceById } from '../db';
import type { PaneInfo } from './capture-history';
import type { LifecycleEventEmitter, TmuxConnectionOptions } from './connection-types';
import type { AtomicPaneCapture } from './control-mode-capture';
import type { TmuxEvent } from './events';
import type { TmuxSourceMetadataEvent } from './events';
import { LocalExternalTmuxConnection } from './local-external-connection';
import {
  MetadataProjection,
  type MetadataProjectionPatch,
  type MetadataProjectionSnapshot,
} from './metadata-projection';
import {
  type PaneHistoryCaptureInfo,
  type PaneHistoryCursor,
  type PaneHistoryPage,
  PaneHistoryReader,
} from './pane-history-reader';
import {
  type PaneIdentity,
  type PaneReplayPlan,
  PaneRetention,
  type PaneRetentionConsumerCallbacks,
  type PaneRetentionConsumerLease,
  type PaneRetentionLimits,
  type PaneRetentionStats,
  type PaneScreenCheckpoint,
  type PaneTerminalCursor,
} from './pane-retention';
import type { PromptMarker } from './pane-stream-parser';
import { SshExternalTmuxConnection } from './ssh-external-connection';

export interface DeviceSessionRuntimeConnection {
  connect(): Promise<void>;
  disconnect(): void;
  isSessionClosedEmitted?(): boolean;
  requestSnapshot(): void;
  sendInput(paneId: string, data: string): void;
  sendInputBytes?(paneId: string, data: Uint8Array): void;
  resizePane(paneId: string, cols: number, rows: number): void;
  selectPane(windowId: string, paneId: string): void;
  selectPaneWithSize(windowId: string, paneId: string, cols: number, rows: number): void;
  selectWindow(windowId: string): void;
  updateDefaultWorkingDir(dir: string | undefined): void;
  createWindow(name?: string, cwd?: string): Promise<string | null>;
  closeWindow(windowId: string): void;
  closePane(paneId: string): void;
  splitPane(paneId: string, direction: 'h' | 'v', cwd?: string): void;
  resizePaneById(paneId: string, size: { cols?: number; rows?: number }): void;
  resizeWindow(windowId: string, cols: number, rows: number): void;
  selectLayout(windowId: string, preset: 'even-horizontal'): void;
  applyStackedLayout(windowId: string, cols: number, rows: number): void;
  focusPane(windowId: string, paneId: string): void;
  movePane(
    srcPaneId: string,
    dstPaneId: string,
    position: 'left' | 'right' | 'top' | 'bottom'
  ): void;
  breakPane(paneId: string): void;
  requestPaneHistory(paneId: string): Promise<void>;
  fetchPaneHistory(
    paneId: string
  ): Promise<{ data: string; alternateScreen: boolean; modes: number } | null>;
  renameWindow(windowId: string, name: string): void;
  setWindowStyle(style: string): Promise<void>;
  signalThemeChange(paneId: string, theme: 'dark' | 'light'): void;
  capturePaneText(paneId: string, opts?: { historyLines?: number }): Promise<string>;
  getPaneInfo(paneId: string): Promise<PaneInfo>;
  capturePaneFrameAtBarrier?(
    paneId: string,
    historyLines: number,
    onBarrier: () => void
  ): Promise<AtomicPaneCapture>;
  getPaneHistoryCaptureInfo(paneId: string): Promise<PaneHistoryCaptureInfo>;
  capturePaneHistoryRange(
    paneId: string,
    startLine: number,
    endLine: number,
    maxOutputBytes: number
  ): Promise<string>;
}

export interface DeviceSessionRuntimeListener {
  onEvent?: (event: TmuxEvent) => void;
  onTerminalOutput?: (paneId: string, data: Uint8Array) => void;
  onTerminalHistory?: (
    paneId: string,
    data: string,
    alternateScreen: boolean,
    modes: number
  ) => void;
  onPromptMarker?: (paneId: string, marker: PromptMarker) => void;
  onClipboardWrite?: (paneId: string, text: string) => void;
  onSnapshot?: (payload: StateSnapshotPayload) => void;
  onMetadataPatch?: (patch: MetadataProjectionPatch) => void;
  onMetadataRebaseRequired?: (snapshot: MetadataProjectionSnapshot) => void;
  onError?: (error: Error) => void;
  onClose?: () => void;
}

export interface DeviceSessionRuntimeOptions {
  deviceId: string;
  deviceName?: string;
  notifyEvent?: LifecycleEventEmitter;
  createConnection?: (options: TmuxConnectionOptions) => DeviceSessionRuntimeConnection;
}

function createDefaultConnection(options: TmuxConnectionOptions): DeviceSessionRuntimeConnection {
  const device = getDeviceById(options.deviceId);
  if (device?.type === 'local') {
    return new LocalExternalTmuxConnection(options);
  }
  return new SshExternalTmuxConnection(options);
}

export class DeviceSessionRuntime {
  readonly deviceId: string;

  private readonly connection: DeviceSessionRuntimeConnection;
  private readonly metadataProjection: MetadataProjection;
  private readonly paneRetention = new PaneRetention();
  private readonly paneHistoryReader: PaneHistoryReader;
  private readonly listeners = new Set<DeviceSessionRuntimeListener>();
  private readonly screenCaptures = new Map<string, Promise<PaneScreenCheckpoint | null>>();
  private lastSnapshot: StateSnapshotPayload | null = null;
  private connectPromise: Promise<void> | null = null;
  private terminated = false;
  private closeEmitted = false;
  private manualDisconnect = false;

  constructor(options: DeviceSessionRuntimeOptions) {
    this.deviceId = options.deviceId;
    const createConnection = options.createConnection ?? createDefaultConnection;

    this.metadataProjection = new MetadataProjection(this.deviceId, {
      deviceName: options.deviceName,
      onPatch: (patch) => {
        if (this.lastSnapshot) {
          const diff = wsBorsh.sourceMetadataPatchToLegacyDiff(patch);
          this.lastSnapshot = wsBorsh.applyLegacyStateSnapshotDiff(this.lastSnapshot, diff);
        }
        this.broadcast((listener) => listener.onMetadataPatch?.(patch));
      },
      onRebaseRequired: (snapshot) => {
        this.broadcast((listener) => listener.onMetadataRebaseRequired?.(snapshot));
      },
    });

    this.connection = createConnection({
      deviceId: this.deviceId,
      notifyEvent: options.notifyEvent,
      onEvent: (event) => {
        this.broadcast((listener) => listener.onEvent?.(event));
      },
      onTerminalOutput: (paneId, data) => {
        const paneEpoch = this.metadataProjection.ensurePaneEpoch(paneId);
        if (paneEpoch) this.paneRetention.ingest(paneId, paneEpoch, data);
        this.broadcast((listener) => listener.onTerminalOutput?.(paneId, data));
      },
      onTerminalHistory: (paneId, data, alternateScreen, modes) => {
        this.broadcast((listener) =>
          listener.onTerminalHistory?.(paneId, data, alternateScreen, modes)
        );
      },
      onPromptMarker: (paneId, marker) => {
        this.broadcast((listener) => listener.onPromptMarker?.(paneId, marker));
      },
      onClipboardWrite: (paneId, text) => {
        this.broadcast((listener) => listener.onClipboardWrite?.(paneId, text));
      },
      onSourceReady: (serverEpoch) => {
        this.metadataProjection.setServerEpoch(serverEpoch);
      },
      onSourceMetadata: (event: TmuxSourceMetadataEvent) => {
        this.metadataProjection.applySourceEvent(event);
      },
      beginMetadataReconcile: () => this.metadataProjection.revision,
      onSnapshot: (payload, baseRevision) => {
        const previousSnapshot = this.lastSnapshot;
        const changed = !stateSnapshotsEqual(previousSnapshot, payload);
        this.lastSnapshot = payload;
        this.metadataProjection.reconcile(payload, baseRevision);
        const panes: PaneIdentity[] = [];
        for (const window of payload.session?.windows ?? []) {
          for (const pane of window.panes) {
            const paneEpoch = this.metadataProjection.getPaneEpoch(pane.id);
            if (paneEpoch) panes.push({ paneId: pane.id, paneEpoch });
          }
        }
        this.paneRetention.reconcilePanes(panes);
        const currentPaneIds = new Set(panes.map((pane) => pane.paneId));
        for (const pane of panes)
          this.paneHistoryReader.invalidatePane(pane.paneId, pane.paneEpoch);
        for (const window of previousSnapshot?.session?.windows ?? []) {
          for (const pane of window.panes) {
            if (!currentPaneIds.has(pane.id)) this.paneHistoryReader.invalidatePane(pane.id);
          }
        }
        if (changed) this.broadcast((listener) => listener.onSnapshot?.(payload));
      },
      onError: (error) => {
        this.broadcast((listener) => listener.onError?.(error));
      },
      onClose: () => {
        if (this.manualDisconnect || this.closeEmitted) {
          return;
        }
        this.closeEmitted = true;
        this.terminated = true;
        this.connectPromise = null;
        this.broadcast((listener) => listener.onClose?.());
      },
    });
    this.paneHistoryReader = new PaneHistoryReader(this.connection);
  }

  get isTerminated(): boolean {
    return this.terminated;
  }

  // 本次连接是否已因 session gone 发出 session_closed（供断开告警抑制双发）。
  get sessionClosedEmitted(): boolean {
    return this.connection.isSessionClosedEmitted?.() ?? false;
  }

  subscribe(listener: DeviceSessionRuntimeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async connect(): Promise<void> {
    if (this.terminated) {
      return Promise.reject(
        new Error(`Device session runtime already terminated: ${this.deviceId}`)
      );
    }

    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = this.connection.connect().catch((error) => {
      this.terminated = true;
      this.connectPromise = null;
      this.metadataProjection.dispose();
      this.paneRetention.dispose();
      this.paneHistoryReader.dispose();
      throw error;
    });

    return this.connectPromise;
  }

  disconnect(): void {
    if (this.terminated) {
      return;
    }

    this.terminated = true;
    this.manualDisconnect = true;
    this.connectPromise = null;
    this.connection.disconnect();
    this.metadataProjection.dispose();
    this.paneRetention.dispose();
    this.paneHistoryReader.dispose();
  }

  async shutdown(): Promise<void> {
    this.disconnect();
  }

  requestSnapshot(): void {
    this.connection.requestSnapshot();
  }

  getCurrentSnapshot(): StateSnapshotPayload | null {
    return this.lastSnapshot;
  }

  getMetadataSnapshot(): MetadataProjectionSnapshot {
    return this.metadataProjection.currentSnapshot();
  }

  getServerEpoch(): Uint8Array | null {
    return this.metadataProjection.serverEpoch;
  }

  getPaneIdentity(paneId: string): PaneIdentity | null {
    if (!this.metadataProjection.hasPane(paneId)) return null;
    const paneEpoch = this.metadataProjection.getPaneEpoch(paneId);
    return paneEpoch ? { paneId, paneEpoch } : null;
  }

  attachPaneConsumer(callbacks: PaneRetentionConsumerCallbacks): PaneRetentionConsumerLease {
    return this.paneRetention.attachConsumer(callbacks);
  }

  getPaneRetentionStats(): PaneRetentionStats {
    return this.paneRetention.snapshotStats();
  }

  getPaneRetentionLimits(): PaneRetentionLimits {
    return this.paneRetention.snapshotLimits();
  }

  isPaneTerminalRetained(paneId: string): boolean {
    return this.paneRetention.isPaneRetained(paneId);
  }

  getPaneScreenCheckpoint(paneId: string): PaneScreenCheckpoint | null {
    return this.paneRetention.getScreenCheckpoint(paneId);
  }

  readPaneReplay(paneId: string, cursor: PaneTerminalCursor): PaneReplayPlan | null {
    return this.paneRetention.readReplay(paneId, cursor);
  }

  readPaneHistory(
    paneId: string,
    beforeCursor: PaneHistoryCursor | null,
    byteLimit: number
  ): Promise<PaneHistoryPage | null> {
    const identity = this.getPaneIdentity(paneId);
    if (!identity) return Promise.resolve(null);
    return this.paneHistoryReader.readPage(paneId, identity.paneEpoch, beforeCursor, byteLimit);
  }

  async captureCanonicalScreen(
    paneId: string,
    byteLimit: number
  ): Promise<PaneScreenCheckpoint | null> {
    const existing = this.screenCaptures.get(paneId);
    if (existing) return existing;
    const capture = this.captureCanonicalScreenInternal(paneId, byteLimit).finally(() => {
      if (this.screenCaptures.get(paneId) === capture) this.screenCaptures.delete(paneId);
    });
    this.screenCaptures.set(paneId, capture);
    return capture;
  }

  setCustomName(kind: 'window' | 'pane', nativeId: string, name: string | null): void {
    this.metadataProjection.setCustomName(kind, nativeId, name);
  }

  sendInput(paneId: string, data: string): void {
    this.connection.sendInput(paneId, data);
  }

  sendInputBytes(paneId: string, data: Uint8Array): void {
    if (this.connection.sendInputBytes) {
      this.connection.sendInputBytes(paneId, data);
      return;
    }
    this.connection.sendInput(paneId, new TextDecoder().decode(data));
  }

  resizePane(paneId: string, cols: number, rows: number): void {
    this.connection.resizePane(paneId, cols, rows);
  }

  selectPane(windowId: string, paneId: string): void {
    this.connection.selectPane(windowId, paneId);
  }

  selectPaneWithSize(windowId: string, paneId: string, cols: number, rows: number): void {
    this.connection.selectPaneWithSize(windowId, paneId, cols, rows);
  }

  selectWindow(windowId: string): void {
    this.connection.selectWindow(windowId);
  }

  updateDefaultWorkingDir(dir: string | undefined): void {
    this.connection.updateDefaultWorkingDir(dir);
  }

  createWindow(name?: string, cwd?: string): Promise<string | null> {
    return this.connection.createWindow(name, cwd);
  }

  closeWindow(windowId: string): void {
    this.connection.closeWindow(windowId);
  }

  closePane(paneId: string): void {
    this.connection.closePane(paneId);
  }

  splitPane(paneId: string, direction: 'h' | 'v', cwd?: string): void {
    this.connection.splitPane(paneId, direction, cwd);
  }

  resizePaneById(paneId: string, size: { cols?: number; rows?: number }): void {
    this.connection.resizePaneById(paneId, size);
  }

  resizeWindow(windowId: string, cols: number, rows: number): void {
    this.connection.resizeWindow(windowId, cols, rows);
  }

  selectLayout(windowId: string, preset: 'even-horizontal'): void {
    this.connection.selectLayout(windowId, preset);
  }

  applyStackedLayout(windowId: string, cols: number, rows: number): void {
    this.connection.applyStackedLayout(windowId, cols, rows);
  }

  focusPane(windowId: string, paneId: string): void {
    this.connection.focusPane(windowId, paneId);
  }

  movePane(
    srcPaneId: string,
    dstPaneId: string,
    position: 'left' | 'right' | 'top' | 'bottom'
  ): void {
    this.connection.movePane(srcPaneId, dstPaneId, position);
  }

  breakPane(paneId: string): void {
    this.connection.breakPane(paneId);
  }

  async requestPaneHistory(paneId: string): Promise<void> {
    return this.connection.requestPaneHistory(paneId);
  }

  async fetchPaneHistory(
    paneId: string
  ): Promise<{ data: string; alternateScreen: boolean; modes: number } | null> {
    return this.connection.fetchPaneHistory(paneId);
  }

  renameWindow(windowId: string, name: string): void {
    this.connection.renameWindow(windowId, name);
  }

  setWindowStyle(style: string): Promise<void> {
    return this.connection.setWindowStyle(style);
  }

  signalThemeChange(paneId: string, theme: 'dark' | 'light'): void {
    this.connection.signalThemeChange(paneId, theme);
  }

  async capturePaneText(paneId: string, opts?: { historyLines?: number }): Promise<string> {
    return this.connection.capturePaneText(paneId, opts);
  }

  async getPaneInfo(paneId: string): Promise<PaneInfo> {
    return this.connection.getPaneInfo(paneId);
  }

  private async captureCanonicalScreenInternal(
    paneId: string,
    byteLimit: number
  ): Promise<PaneScreenCheckpoint | null> {
    const identity = this.getPaneIdentity(paneId);
    if (!identity) return null;
    const maxBytes = Math.min(byteLimit, this.paneRetention.maxCheckpointBytesPerPane);
    if (maxBytes < 64) return null;
    const projectedPane = this.lastSnapshot?.session?.windows
      .flatMap((window) => window.panes)
      .find((pane) => pane.id === paneId);
    const estimatedCols = Math.max(1, projectedPane?.width ?? 80);
    const estimatedRows = Math.max(1, projectedPane?.height ?? 24);
    const estimatedBytesPerLine = Math.max(16, estimatedCols * 4);
    const boundedTotalLines = Math.max(
      estimatedRows,
      Math.min(estimatedRows + 256, Math.floor(maxBytes / estimatedBytesPerLine))
    );
    const historyLines = Math.max(0, boundedTotalLines - estimatedRows);
    let baseCursor: PaneTerminalCursor | null = null;
    let frame: AtomicPaneCapture;
    if (this.connection.capturePaneFrameAtBarrier) {
      frame = await this.connection.capturePaneFrameAtBarrier(paneId, historyLines, () => {
        baseCursor = this.paneRetention.getLatestCursor(paneId);
      });
    } else {
      const info = await this.connection.getPaneInfo(paneId);
      const text = await this.connection.capturePaneText(paneId, {
        historyLines: info.alternateScreen ? 0 : historyLines,
      });
      baseCursor = this.paneRetention.getLatestCursor(paneId);
      frame = {
        text,
        historyText: null,
        cols: info.cols,
        rows: info.rows,
        cursorX: info.cursorX,
        cursorY: info.cursorY,
        alternateScreen: info.alternateScreen,
        historySize: (await this.connection.getPaneHistoryCaptureInfo(paneId)).historySize,
        modes: null,
      };
    }
    const prefix = frame.alternateScreen ? '\x1b[?1049h\x1b[2J\x1b[H' : '\x1b[2J\x1b[H';
    const cursor =
      frame.cursorX === null || frame.cursorY === null
        ? ''
        : `\x1b[${frame.cursorY + 1};${frame.cursorX + 1}H`;
    const encoder = new TextEncoder();
    const prefixBytes = encoder.encode(prefix);
    const cursorBytes = encoder.encode(cursor);
    const textBudget = Math.max(0, maxBytes - prefixBytes.byteLength - cursorBytes.byteLength);
    const visibleBytes = encoder.encode(frame.text);
    // alt 屏的 scrollback 属于 primary grid（TUI 启动前的旧 shell 输出），绝不拼进快照；
    // 预算不足时整段丢弃历史而不是从头部截断——截断会切断 SGR 序列且让行数失配。
    const includeHistory =
      !frame.alternateScreen && frame.historySize > 0 && frame.historyText !== null;
    const historyBytes = includeHistory
      ? encoder.encode(`${frame.historyText}\n`)
      : new Uint8Array(0);
    const historyIncluded =
      includeHistory && historyBytes.byteLength + visibleBytes.byteLength <= textBudget;
    const rawTextBytes = historyIncluded ? concatBytes(historyBytes, visibleBytes) : visibleBytes;
    // 降级路径（无 control 通道）的 text 本身就是 -S 合并采集，历史行内嵌其中
    const fallbackEmbeddedHistory = frame.historyText === null && !frame.alternateScreen;
    const embeddedHistoryLines = historyIncluded || fallbackEmbeddedHistory ? historyLines : 0;
    const textWasTruncated = rawTextBytes.byteLength > textBudget;
    const textBytes = truncateUtf8Tail(rawTextBytes, textBudget);
    const data = concatBytes(prefixBytes, textBytes, cursorBytes);
    const currentIdentity = this.getPaneIdentity(paneId);
    if (
      !baseCursor ||
      !currentIdentity ||
      !bytesEqual(identity.paneEpoch, currentIdentity.paneEpoch) ||
      !bytesEqual(baseCursor.paneEpoch, currentIdentity.paneEpoch)
    ) {
      return null;
    }
    const checkpoint: PaneScreenCheckpoint = {
      paneId,
      paneEpoch: currentIdentity.paneEpoch,
      baseSeq: baseCursor.terminalSeq,
      rows: Math.max(1, Math.min(frame.rows, 0xffff)),
      cols: Math.max(1, Math.min(frame.cols, 0xffff)),
      modes:
        (frame.alternateScreen ? PANE_MODE_ALT_SCREEN : 0) |
        (frame.modes ? encodePaneModes(frame.modes) | PANE_MODE_FLAGS_PRESENT : 0),
      data,
      historyCursor: frame.alternateScreen
        ? null
        : this.paneHistoryReader.createCursor(
            paneId,
            currentIdentity.paneEpoch,
            textWasTruncated
              ? frame.historySize
              : Math.max(0, frame.historySize - embeddedHistoryLines)
          ),
      capturedAt: Date.now(),
    };
    this.paneRetention.storeScreenCheckpoint(checkpoint);
    return checkpoint;
  }

  private broadcast(action: (listener: DeviceSessionRuntimeListener) => void): void {
    for (const listener of this.listeners) {
      try {
        action(listener);
      } catch (error) {
        console.error('[tmux-client] listener callback failed:', error);
      }
    }
  }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function stateSnapshotsEqual(
  left: StateSnapshotPayload | null,
  right: StateSnapshotPayload
): boolean {
  if (!left || left.deviceId !== right.deviceId) return false;
  if (!left.session || !right.session) return left.session === right.session;
  if (
    left.session.id !== right.session.id ||
    left.session.name !== right.session.name ||
    left.session.windows.length !== right.session.windows.length
  ) {
    return false;
  }
  for (let windowIndex = 0; windowIndex < left.session.windows.length; windowIndex += 1) {
    const previousWindow = left.session.windows[windowIndex];
    const nextWindow = right.session.windows[windowIndex];
    if (
      !previousWindow ||
      !nextWindow ||
      previousWindow.id !== nextWindow.id ||
      previousWindow.name !== nextWindow.name ||
      previousWindow.customName !== nextWindow.customName ||
      previousWindow.index !== nextWindow.index ||
      previousWindow.active !== nextWindow.active ||
      previousWindow.layout !== nextWindow.layout ||
      previousWindow.panes.length !== nextWindow.panes.length
    ) {
      return false;
    }
    for (let paneIndex = 0; paneIndex < previousWindow.panes.length; paneIndex += 1) {
      const previousPane = previousWindow.panes[paneIndex];
      const nextPane = nextWindow.panes[paneIndex];
      if (
        !previousPane ||
        !nextPane ||
        previousPane.id !== nextPane.id ||
        previousPane.windowId !== nextPane.windowId ||
        previousPane.index !== nextPane.index ||
        previousPane.title !== nextPane.title ||
        previousPane.customName !== nextPane.customName ||
        previousPane.currentCommand !== nextPane.currentCommand ||
        previousPane.currentPath !== nextPane.currentPath ||
        previousPane.active !== nextPane.active ||
        previousPane.width !== nextPane.width ||
        previousPane.height !== nextPane.height ||
        previousPane.left !== nextPane.left ||
        previousPane.top !== nextPane.top
      ) {
        return false;
      }
    }
  }
  return true;
}

function truncateUtf8Tail(value: Uint8Array, byteLimit: number): Uint8Array {
  let start = Math.max(0, value.byteLength - byteLimit);
  while (start < value.byteLength && (value[start] ?? 0) >= 0x80 && (value[start] ?? 0) < 0xc0) {
    start += 1;
  }
  return value.slice(start);
}

function concatBytes(...values: Uint8Array[]): Uint8Array {
  const total = values.reduce((sum, value) => sum + value.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.byteLength;
  }
  return result;
}

export function createDeviceSessionRuntime(
  options: DeviceSessionRuntimeOptions
): DeviceSessionRuntime {
  return new DeviceSessionRuntime(options);
}
