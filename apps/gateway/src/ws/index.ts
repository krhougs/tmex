import type {
  EventDevicePayload,
  EventType,
  StateSnapshotPayload,
  TmuxEventType,
  WebhookEvent,
} from '@tmex/shared';
import { type ThemeMode, getTmuxWindowStyle, wsBorsh } from '@tmex/shared';
import { GATEWAY_CAPABILITIES } from '@tmex/shared';
import type { Server, ServerWebSocket } from 'bun';
import { agentWsHub } from '../agent/ws-hub';
import {
  type DeviceTreeOrderRecord,
  getDeviceTreeOrder,
  getSiteSettings,
  setPaneOrder,
  setWindowOrder,
  updateSiteSettings,
} from '../db';
import { t } from '../i18n';
import type { SettingsNamespace } from '../settings/broadcaster';
import { getDisplayVersion } from '../system/version';
import type {
  DeviceSessionRuntime,
  DeviceSessionRuntimeListener,
} from '../tmux-client/device-session-runtime';
import type { TmuxEvent } from '../tmux-client/events';
import { tmuxRuntimeRegistry } from '../tmux-client/registry';
import { isTmuxPaneId, isTmuxWindowId } from '../tmux-client/snapshot-format';
import { resolvePaneContext } from '../tmux/bell-context';
import {
  type BorshClientState,
  createBorshClientState,
  decodeCanonicalCommand,
  encodeCanonicalEvent,
} from './borsh/codec-borsh';
import { sessionStateStore } from './borsh/session-state';
import { switchBarrier } from './borsh/switch-barrier';
import { CanonicalFeedSession } from './canonical-feed-session';
import { classifySshError } from './error-classify';
import { GatewayActivityMetrics, collectCanonicalStateMetrics } from './gateway-activity-metrics';
import { applyDeviceTreeOverlay } from './overlay-utils';
import { TerminalOutputBatcher } from './terminal-output-batcher';
import { TerminalOutputMetrics } from './terminal-output-metrics';
import { gatewayWebSocketSendGuard } from './websocket-send-guard';

interface ClientState {
  borshState: BorshClientState;
}

interface DeviceConnectionEntry {
  runtime: DeviceSessionRuntime;
  detachRuntime: (() => void) | null;
  clients: Set<ServerWebSocket<ClientState>>;
  lastSnapshot: StateSnapshotPayload | null;
  snapshotTimer: ReturnType<typeof setTimeout> | null;
  snapshotPollTimer: ReturnType<typeof setInterval> | null;
  reconnectAttempts: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  canonicalClients?: Set<ServerWebSocket<ClientState>>;
  idleReleaseTimer?: ReturnType<typeof setTimeout> | null;
}

interface WebSocketServerDeps {
  acquireRuntime: (deviceId: string) => Promise<DeviceSessionRuntime>;
  releaseRuntime: (deviceId: string, runtime: DeviceSessionRuntime) => Promise<void> | void;
  /** 只读取常驻活跃 runtime（push supervisor 持有），无 ws 连接时改名 overlay 写穿用。 */
  peekRuntime?: (deviceId: string) => DeviceSessionRuntime | null;
  loadDeviceTreeOrder: (deviceId: string) => DeviceTreeOrderRecord;
  saveWindowOrder: (deviceId: string, windowIds: string[]) => void;
  savePaneOrder: (deviceId: string, windowId: string, paneIds: string[]) => void;
}

const defaultDeps: WebSocketServerDeps = {
  acquireRuntime: async (deviceId) => tmuxRuntimeRegistry.acquire(deviceId),
  releaseRuntime: async (deviceId, runtime) => {
    await tmuxRuntimeRegistry.release(deviceId, runtime);
  },
  peekRuntime: (deviceId) => tmuxRuntimeRegistry.peek(deviceId),
  loadDeviceTreeOrder: getDeviceTreeOrder,
  saveWindowOrder: setWindowOrder,
  savePaneOrder: setPaneOrder,
};

interface WebSocketServerOptions {
  deps?: Partial<WebSocketServerDeps>;
}

export const RUNTIME_IDLE_GRACE_MS = 5_000;
const ENVELOPE_OVERHEAD_BYTES = 16;

export function payloadNeedsChunking(payloadLength: number, maxFrameBytes: number): boolean {
  return payloadLength > maxFrameBytes - ENVELOPE_OVERHEAD_BYTES;
}

// tmux #{window_layout} 前缀携带整窗尺寸（如 "b25d,120x30,0,0[...]"）
export function parseWindowLayoutSize(
  layout: string | undefined
): { cols: number; rows: number } | null {
  if (!layout) return null;
  const match = /^[0-9a-fA-F]{4},(\d+)x(\d+)/.exec(layout);
  if (!match) return null;
  return { cols: Number(match[1]), rows: Number(match[2]) };
}

export class WebSocketServer {
  private readonly gatewayActivityMetrics = new GatewayActivityMetrics();
  private readonly terminalOutputMetrics = new TerminalOutputMetrics();
  private terminalOutputEventsUntilMetricsCheck = 1024;
  private readonly terminalOutputBatcher = new TerminalOutputBatcher((deviceId, paneId, data) => {
    try {
      this.terminalOutputMetrics.recordBatch(data.length);
      this.sendTerminalOutput(deviceId, paneId, data);
      this.reportTerminalOutputMetricsIfDue();
    } catch (error) {
      console.error('[ws] terminal output batch failed:', error);
    }
  });

  connections = new Map<string, DeviceConnectionEntry>();
  pendingConnectionEntries = new Map<string, Promise<DeviceConnectionEntry | null>>();
  connectedClients = new Set<ServerWebSocket<ClientState>>();
  // 窗口自定义名 overlay：deviceId -> windowId -> name，仅存于 gateway 内存（进程生命周期内有效）
  windowCustomNames = new Map<string, Map<string, string>>();
  // pane 自定义名 overlay：deviceId -> paneId -> name（不写 tmux pane title，避免被应用 OSC 覆盖）
  paneCustomNames = new Map<string, Map<string, string>>();
  // 当前站点主题（来自 SiteSettings.theme），用于设置 tmux window-style 让 tmux 原生代答 OSC 11
  currentTheme: ThemeMode | null = null;
  private themeSignalLast = new Map<string, { theme: 'dark' | 'light'; at: number }>();
  private lastThemeTimestamp = 0n;
  private lastSettingsTimestamp = 0n;
  // per-device 去重缓存：同主题不重发 OSC stdin 注入（resize 路径触发的主题同步如主题未变则跳过）
  private pendingTmuxTheme: ThemeMode | null = null;
  private themeApplyInFlight = false;
  private lastBroadcastTheme = new Map<string, 'dark' | 'light'>();
  private readonly deviceTreeOrders = new Map<string, DeviceTreeOrderRecord>();
  private readonly deps: WebSocketServerDeps;
  private readonly canonicalSessions = new Map<
    ServerWebSocket<ClientState>,
    CanonicalFeedSession
  >();

  constructor(options: WebSocketServerOptions = {}) {
    this.deps = {
      ...defaultDeps,
      ...(options.deps ?? {}),
    };
  }

  private clearSnapshotTimer(entry: DeviceConnectionEntry): void {
    if (!entry.snapshotTimer) return;
    clearTimeout(entry.snapshotTimer);
    entry.snapshotTimer = null;
  }

  private clearSnapshotPollTimer(entry: DeviceConnectionEntry): void {
    if (!entry.snapshotPollTimer) return;
    clearInterval(entry.snapshotPollTimer);
    entry.snapshotPollTimer = null;
  }

  private clearReconnectTimer(entry: DeviceConnectionEntry): void {
    if (!entry.reconnectTimer) return;
    clearTimeout(entry.reconnectTimer);
    entry.reconnectTimer = null;
  }

  private clearIdleReleaseTimer(entry: DeviceConnectionEntry): void {
    if (!entry.idleReleaseTimer) return;
    clearTimeout(entry.idleReleaseTimer);
    entry.idleReleaseTimer = null;
  }

  private entryHasClients(entry: DeviceConnectionEntry): boolean {
    return entry.clients.size > 0 || Boolean(entry.canonicalClients?.size);
  }

  private scheduleConnectionEntryRelease(deviceId: string, entry: DeviceConnectionEntry): void {
    if (this.entryHasClients(entry)) {
      this.clearIdleReleaseTimer(entry);
      return;
    }
    if (entry.idleReleaseTimer) return;
    entry.idleReleaseTimer = setTimeout(() => {
      entry.idleReleaseTimer = null;
      if (this.connections.get(deviceId) !== entry || this.entryHasClients(entry)) return;
      this.connections.delete(deviceId);
      this.releaseConnectionEntry(deviceId, entry);
    }, RUNTIME_IDLE_GRACE_MS);
  }

  private releaseConnectionEntry(deviceId: string, entry: DeviceConnectionEntry): void {
    this.terminalOutputBatcher.discardDevice(deviceId);
    this.clearSnapshotTimer(entry);
    this.clearSnapshotPollTimer(entry);
    this.clearReconnectTimer(entry);
    this.clearIdleReleaseTimer(entry);
    entry.detachRuntime?.();
    entry.detachRuntime = null;
    this.themeSignalLast.delete(deviceId);
    this.lastBroadcastTheme.delete(deviceId);
    this.deviceTreeOrders.delete(deviceId);
    void this.deps.releaseRuntime(deviceId, entry.runtime);
  }

  private attachRuntime(deviceId: string, runtime: DeviceSessionRuntime): () => void {
    const listener: DeviceSessionRuntimeListener = {
      onEvent: (event) => {
        void this.broadcastTmuxEvent(deviceId, event);
      },
      onTerminalOutput: (paneId, data) => {
        this.broadcastTerminalOutput(deviceId, paneId, data);
      },
      onTerminalHistory: (paneId, data, alternateScreen, modes) => {
        this.broadcastTerminalHistory(deviceId, paneId, data, alternateScreen, modes);
      },
      onClipboardWrite: (paneId, text) => {
        this.broadcastClipboardWrite(deviceId, paneId, text);
      },
      onSnapshot: (payload) => {
        this.broadcastStateSnapshot(deviceId, payload);
      },
      onMetadataPatch: (patch) => {
        this.broadcastLegacyMetadataPatch(deviceId, patch, runtime.getCurrentSnapshot());
      },
      onMetadataRebaseRequired: () => {
        const snapshot = runtime.getCurrentSnapshot();
        if (snapshot) this.broadcastStateSnapshot(deviceId, snapshot);
      },
      onError: (error) => {
        this.broadcastError(deviceId, error);
      },
      onClose: () => {
        void this.handleConnectionClose(deviceId);
      },
    };

    return runtime.subscribe(listener);
  }

  private refreshSnapshotPolling(deviceId: string): void {
    const entry = this.connections.get(deviceId);
    if (!entry) return;
    this.clearSnapshotPollTimer(entry);
  }

  handleUpgrade(req: Request, server: Server<any>): Response | false | undefined {
    const url = new URL(req.url);
    if (url.pathname !== '/ws') {
      return false;
    }

    const success = (server as any).upgrade(req, {
      data: {
        borshState: createBorshClientState(),
      } satisfies ClientState,
    });

    return success ? undefined : new Response('Upgrade failed', { status: 500 });
  }

  handleOpen(ws: ServerWebSocket<ClientState>): void {
    console.log('[ws] client connected');
    sessionStateStore.create(ws);
    this.connectedClients.add(ws);
  }

  handleMessage(ws: ServerWebSocket<ClientState>, message: string | Buffer): void {
    if (typeof message === 'string') {
      return;
    }

    const data = new Uint8Array(message);

    if (!wsBorsh.checkMagic(data)) {
      this.sendError(ws, null, wsBorsh.ERROR_INVALID_FRAME, 'Missing magic bytes', false);
      return;
    }

    let envelope: wsBorsh.Envelope;
    try {
      envelope = wsBorsh.decodeEnvelope(data);
    } catch (err) {
      const e = err instanceof wsBorsh.WsBorshError ? err : null;
      this.sendError(
        ws,
        null,
        e?.code ?? wsBorsh.ERROR_INVALID_FRAME,
        e?.message ?? 'Invalid envelope',
        e?.retryable ?? false
      );
      return;
    }

    const clientState = ws.data.borshState;

    // CHUNK 重组
    if (envelope.kind === wsBorsh.KIND_CHUNK) {
      try {
        const chunk = wsBorsh.decodeChunk(envelope.payload);
        const reassembled = clientState.chunkReassembler.addChunk(chunk);
        if (!reassembled) {
          return;
        }
        void this.handleBorshMessage(ws, reassembled.kind, reassembled.seq, reassembled.payload);
        return;
      } catch (err) {
        const e = err instanceof wsBorsh.WsBorshError ? err : null;
        this.sendError(
          ws,
          null,
          e?.code ?? wsBorsh.ERROR_INVALID_FRAME,
          e?.message ?? 'Invalid chunk',
          e?.retryable ?? false
        );
        return;
      }
    }

    void this.handleBorshMessage(ws, envelope.kind, envelope.seq, envelope.payload);
  }

  handleDrain(ws: ServerWebSocket<ClientState>): void {
    gatewayWebSocketSendGuard.handleDrain(ws as ServerWebSocket<unknown>);
    this.canonicalSessions.get(ws)?.onDrain();
  }

  private getOrCreateCanonicalSession(ws: ServerWebSocket<ClientState>): CanonicalFeedSession {
    const existing = this.canonicalSessions.get(ws);
    if (existing) return existing;
    const session = new CanonicalFeedSession({
      maxFrameBytes: ws.data.borshState.maxFrameBytes,
      sendEvent: (event) => this.sendCanonicalEvent(ws, event),
      resolveRuntime: async (deviceId) => {
        const entry = await this.getOrCreateConnectionEntry(deviceId, ws);
        if (!entry) return null;
        entry.canonicalClients ??= new Set();
        entry.canonicalClients.add(ws);
        this.clearIdleReleaseTimer(entry);
        return entry.runtime;
      },
      initialDeviceIds: () =>
        Array.from(this.connections, ([deviceId, entry]) =>
          entry.clients.has(ws) ? deviceId : null
        ).filter((deviceId): deviceId is string => deviceId !== null),
      onDeviceAttached: (deviceId, runtime) => {
        const entry = this.connections.get(deviceId);
        if (!entry || entry.runtime !== runtime) return;
        entry.canonicalClients ??= new Set();
        entry.canonicalClients.add(ws);
        this.clearIdleReleaseTimer(entry);
      },
      onDeviceDetached: (deviceId, runtime) => {
        const entry = this.connections.get(deviceId);
        if (!entry || entry.runtime !== runtime) return;
        entry.canonicalClients?.delete(ws);
        this.scheduleConnectionEntryRelease(deviceId, entry);
      },
    });
    this.canonicalSessions.set(ws, session);
    return session;
  }

  private sendCanonicalEvent(
    ws: ServerWebSocket<ClientState>,
    event: wsBorsh.CanonicalEvent
  ): boolean {
    const terminalBytes = 'PaneData' in event ? event.PaneData.data.byteLength : null;
    try {
      const frame = encodeCanonicalEvent(
        event,
        ws.data.borshState.seqGen(),
        ws.data.borshState.maxFrameBytes
      );
      const delivered = gatewayWebSocketSendGuard.sendFrames(ws as ServerWebSocket<unknown>, [
        frame as unknown as BufferSource,
      ]);
      if (terminalBytes !== null) {
        this.terminalOutputMetrics.recordCanonicalRecipient(terminalBytes, delivered);
      }
      return delivered;
    } catch (error) {
      if (terminalBytes !== null) {
        this.terminalOutputMetrics.recordCanonicalRecipient(terminalBytes, false);
      }
      console.error('[ws] failed to encode canonical event:', error);
      return false;
    }
  }

  handleClose(ws: ServerWebSocket<ClientState>): void {
    console.log('[ws] client disconnected');

    this.canonicalSessions.get(ws)?.close();
    this.canonicalSessions.delete(ws);
    gatewayWebSocketSendGuard.forget(ws as ServerWebSocket<unknown>);
    this.connectedClients.delete(ws);
    switchBarrier.cleanupClient(ws);
    sessionStateStore.cleanup(ws);
    agentWsHub.removeClient(ws);

    for (const [deviceId, entry] of this.connections) {
      entry.canonicalClients?.delete(ws);
      if (entry.clients.delete(ws)) {
        delete ws.data.borshState.selectedPanes[deviceId];
        delete ws.data.borshState.subscribedPanes[deviceId];
      }
      this.refreshSnapshotPolling(deviceId);
      this.scheduleConnectionEntryRelease(deviceId, entry);
    }
  }

  updateDefaultWorkingDir(deviceId: string, dir: string | undefined): void {
    const entry = this.connections.get(deviceId);
    entry?.runtime.updateDefaultWorkingDir(dir);
  }

  getLastSnapshot(deviceId: string): StateSnapshotPayload | null {
    return this.connections.get(deviceId)?.lastSnapshot ?? null;
  }

  closeAll(): void {
    for (const session of this.canonicalSessions.values()) session.close();
    this.canonicalSessions.clear();
    for (const [deviceId, entry] of this.connections) {
      this.releaseConnectionEntry(deviceId, entry);
      this.connections.delete(deviceId);
    }
    this.pendingConnectionEntries.clear();
  }

  private async handleBorshMessage(
    ws: ServerWebSocket<ClientState>,
    kind: number,
    refSeq: number,
    payload: Uint8Array
  ): Promise<void> {
    const state = ws.data.borshState;
    this.gatewayActivityMetrics.recordInbound(kind, payload.length);

    if (kind !== wsBorsh.KIND_HELLO_C2S && !state.negotiated) {
      this.sendError(ws, refSeq, wsBorsh.ERROR_INVALID_FRAME, 'HELLO required', false);
      return;
    }

    if (kind === wsBorsh.KIND_HELLO_C2S) {
      this.handleHello(ws, refSeq, payload);
      return;
    }

    if (kind === wsBorsh.KIND_PING) {
      this.handlePing(ws, refSeq, payload);
      return;
    }

    switch (kind) {
      case wsBorsh.KIND_DEVICE_CONNECT: {
        const decoded = wsBorsh.decodePayload(wsBorsh.schema.DeviceConnectSchema, payload);
        await this.handleDeviceConnect(ws, decoded.deviceId);
        return;
      }

      case wsBorsh.KIND_DEVICE_DISCONNECT: {
        const decoded = wsBorsh.decodePayload(wsBorsh.schema.DeviceDisconnectSchema, payload);
        this.handleDeviceDisconnect(ws, decoded.deviceId);
        return;
      }

      case wsBorsh.KIND_TMUX_SELECT: {
        const decoded = wsBorsh.decodePayload(wsBorsh.schema.TmuxSelectSchema, payload);
        this.handleTmuxSelect(ws, decoded);
        return;
      }

      case wsBorsh.KIND_TMUX_SELECT_WINDOW: {
        const decoded = wsBorsh.decodePayload(wsBorsh.schema.TmuxSelectWindowSchema, payload);
        this.handleTmuxSelectWindow(decoded.deviceId, decoded.windowId);
        return;
      }

      case wsBorsh.KIND_TMUX_CREATE_WINDOW: {
        let decoded: wsBorsh.b.infer<typeof wsBorsh.schema.TmuxCreateWindowSchema>;
        try {
          decoded = wsBorsh.decodePayload(wsBorsh.schema.TmuxCreateWindowSchema, payload);
        } catch (error) {
          console.warn('[ws] create-window payload decode failed:', error);
          return;
        }
        this.handleCreateWindow(
          ws,
          decoded.deviceId,
          decoded.name ?? undefined,
          decoded.cwd ?? undefined
        );
        return;
      }

      case wsBorsh.KIND_TMUX_CLOSE_WINDOW: {
        const decoded = wsBorsh.decodePayload(wsBorsh.schema.TmuxCloseWindowSchema, payload);
        this.handleCloseWindow(decoded.deviceId, decoded.windowId);
        return;
      }

      case wsBorsh.KIND_TMUX_CLOSE_PANE: {
        const decoded = wsBorsh.decodePayload(wsBorsh.schema.TmuxClosePaneSchema, payload);
        this.handleClosePane(decoded.deviceId, decoded.paneId);
        return;
      }

      case wsBorsh.KIND_TMUX_RENAME_WINDOW: {
        const decoded = wsBorsh.decodePayload(wsBorsh.schema.TmuxRenameWindowSchema, payload);
        this.renameWindow(decoded.deviceId, decoded.windowId, decoded.name);
        return;
      }

      case wsBorsh.KIND_TMUX_SET_WINDOW_STYLE: {
        const decoded = wsBorsh.decodePayload(wsBorsh.schema.TmuxSetWindowStyleSchema, payload);
        this.handleSetWindowStyle(decoded.deviceId, decoded.style);
        return;
      }

      case wsBorsh.KIND_TMUX_REORDER_WINDOWS: {
        const decoded = wsBorsh.decodePayload(wsBorsh.schema.TmuxReorderWindowsSchema, payload);
        this.reorderWindows(decoded.deviceId, decoded.windowIds);
        return;
      }

      case wsBorsh.KIND_TMUX_REORDER_PANES: {
        const decoded = wsBorsh.decodePayload(wsBorsh.schema.TmuxReorderPanesSchema, payload);
        this.reorderPanes(decoded.deviceId, decoded.windowId, decoded.paneIds);
        return;
      }

      case wsBorsh.KIND_TMUX_SUBSCRIBE_PANES: {
        const decoded = wsBorsh.decodePayload(wsBorsh.schema.TmuxSubscribePanesSchema, payload);
        this.handleSubscribePanes(ws, decoded.deviceId, decoded.paneIds);
        return;
      }

      case wsBorsh.KIND_TMUX_FETCH_PANE_HISTORY: {
        const decoded = wsBorsh.decodePayload(wsBorsh.schema.TmuxFetchPaneHistorySchema, payload);
        this.handleFetchPaneHistory(ws, decoded.deviceId, decoded.paneId, decoded.requestToken);
        return;
      }

      case wsBorsh.KIND_TMUX_RESIZE_PANE: {
        const decoded = wsBorsh.decodePayload(wsBorsh.schema.TmuxResizePaneSchema, payload);
        this.handleResizePaneById(
          decoded.deviceId,
          decoded.paneId,
          decoded.cols ?? undefined,
          decoded.rows ?? undefined
        );
        return;
      }

      case wsBorsh.KIND_TMUX_APPLY_STACKED_LAYOUT: {
        const decoded = wsBorsh.decodePayload(wsBorsh.schema.TmuxApplyStackedLayoutSchema, payload);
        this.handleApplyStackedLayout(
          decoded.deviceId,
          decoded.windowId,
          decoded.cols,
          decoded.rows
        );
        return;
      }

      case wsBorsh.KIND_TMUX_SPLIT_PANE: {
        const decoded = wsBorsh.decodePayload(wsBorsh.schema.TmuxSplitPaneSchema, payload);
        this.handleSplitPane(
          decoded.deviceId,
          decoded.paneId,
          decoded.direction,
          decoded.cwd ?? undefined
        );
        return;
      }

      case wsBorsh.KIND_TMUX_FOCUS_PANE: {
        const decoded = wsBorsh.decodePayload(wsBorsh.schema.TmuxFocusPaneSchema, payload);
        this.handleFocusPane(ws, decoded.deviceId, decoded.windowId, decoded.paneId);
        return;
      }

      case wsBorsh.KIND_TMUX_RENAME_PANE: {
        const decoded = wsBorsh.decodePayload(wsBorsh.schema.TmuxRenamePaneSchema, payload);
        this.renamePane(decoded.deviceId, decoded.paneId, decoded.name);
        return;
      }

      case wsBorsh.KIND_TMUX_MOVE_PANE: {
        const decoded = wsBorsh.decodePayload(wsBorsh.schema.TmuxMovePaneSchema, payload);
        this.handleMovePane(
          decoded.deviceId,
          decoded.srcPaneId,
          decoded.dstPaneId,
          decoded.position
        );
        return;
      }

      case wsBorsh.KIND_TMUX_BREAK_PANE: {
        const decoded = wsBorsh.decodePayload(wsBorsh.schema.TmuxBreakPaneSchema, payload);
        this.handleBreakPane(decoded.deviceId, decoded.paneId);
        return;
      }

      case wsBorsh.KIND_TERM_INPUT: {
        const decoded = wsBorsh.decodePayload(wsBorsh.schema.TermInputSchema, payload);
        if (decoded.isComposing) return;
        const text = new TextDecoder().decode(decoded.data);
        this.handleTermInput(decoded.deviceId, decoded.paneId, text);
        return;
      }

      case wsBorsh.KIND_TERM_PASTE: {
        const decoded = wsBorsh.decodePayload(wsBorsh.schema.TermPasteSchema, payload);
        const text = new TextDecoder().decode(decoded.data);
        this.handleTermPaste(decoded.deviceId, decoded.paneId, text);
        return;
      }

      case wsBorsh.KIND_TERM_RESIZE: {
        const decoded = wsBorsh.decodePayload(wsBorsh.schema.TermResizeSchema, payload);
        this.handleTermResize(decoded.deviceId, decoded.paneId, decoded.cols, decoded.rows);
        return;
      }

      case wsBorsh.KIND_TERM_SYNC_SIZE: {
        const decoded = wsBorsh.decodePayload(wsBorsh.schema.TermSyncSizeSchema, payload);
        this.handleTermResize(decoded.deviceId, decoded.paneId, decoded.cols, decoded.rows);
        return;
      }

      case wsBorsh.KIND_AGENT_SUBSCRIBE: {
        const decoded = wsBorsh.decodePayload(wsBorsh.schema.AgentSubscribeSchema, payload);
        await agentWsHub.subscribe(ws, decoded.sessionId);
        return;
      }

      case wsBorsh.KIND_AGENT_UNSUBSCRIBE: {
        const decoded = wsBorsh.decodePayload(wsBorsh.schema.AgentUnsubscribeSchema, payload);
        agentWsHub.unsubscribe(ws, decoded.sessionId);
        return;
      }

      case wsBorsh.KIND_SITE_THEME_UPDATE: {
        const decoded = wsBorsh.decodePayload(wsBorsh.schema.SiteThemeUpdateC2SSchema, payload);
        this.handleSiteThemeUpdate(ws, decoded);
        return;
      }

      case wsBorsh.KIND_CANONICAL_COMMAND: {
        try {
          const decoded = decodeCanonicalCommand(payload);
          await this.getOrCreateCanonicalSession(ws).handleCommand(decoded.command);
        } catch (error) {
          const protocolError = error instanceof wsBorsh.WsBorshError ? error : null;
          this.sendError(
            ws,
            refSeq,
            protocolError?.code ?? wsBorsh.ERROR_PAYLOAD_DECODE_FAILED,
            protocolError?.message ?? 'Invalid canonical command',
            protocolError?.retryable ?? false
          );
        }
        return;
      }

      default:
        this.sendError(ws, refSeq, wsBorsh.ERROR_UNKNOWN_KIND, `Unknown kind: ${kind}`, false);
    }
  }

  private handleHello(ws: ServerWebSocket<ClientState>, refSeq: number, payload: Uint8Array): void {
    let hello: wsBorsh.b.infer<typeof wsBorsh.schema.HelloC2SSchema>;
    try {
      hello = wsBorsh.decodePayload(wsBorsh.schema.HelloC2SSchema, payload);
    } catch (err) {
      const e = err instanceof wsBorsh.WsBorshError ? err : null;
      this.sendError(
        ws,
        refSeq,
        e?.code ?? wsBorsh.ERROR_PAYLOAD_DECODE_FAILED,
        e?.message ?? 'HELLO payload decode failed',
        e?.retryable ?? false
      );
      return;
    }

    const serverMaxFrameBytes = wsBorsh.DEFAULT_MAX_FRAME_BYTES;
    const effectiveMaxFrameBytes = Math.min(hello.maxFrameBytes, serverMaxFrameBytes);

    ws.data.borshState.negotiated = true;
    ws.data.borshState.clientImpl = hello.clientImpl.slice(0, 64);
    ws.data.borshState.maxFrameBytes = effectiveMaxFrameBytes;
    agentWsHub.registerClient(ws);

    const helloS2C: wsBorsh.b.infer<typeof wsBorsh.schema.HelloS2CSchema> = {
      serverImpl: 'tmex-gateway',
      serverVersion: getDisplayVersion(),
      selectedVersion: wsBorsh.CURRENT_VERSION,
      maxFrameBytes: serverMaxFrameBytes,
      heartbeatIntervalMs: 15000,
      capabilities: [...GATEWAY_CAPABILITIES],
    };

    const payloadBytes = wsBorsh.encodePayload(wsBorsh.schema.HelloS2CSchema, helloS2C);
    this.sendEnvelope(ws, wsBorsh.KIND_HELLO_S2C, payloadBytes);
  }

  private handlePing(ws: ServerWebSocket<ClientState>, refSeq: number, payload: Uint8Array): void {
    try {
      const ping = wsBorsh.decodePayload(wsBorsh.schema.PingPongSchema, payload);
      const pongPayload = wsBorsh.encodePayload(wsBorsh.schema.PingPongSchema, {
        nonce: ping.nonce,
        timeMs: ping.timeMs,
      });
      this.sendEnvelope(ws, wsBorsh.KIND_PONG, pongPayload);
    } catch (err) {
      const e = err instanceof wsBorsh.WsBorshError ? err : null;
      this.sendError(
        ws,
        refSeq,
        e?.code ?? wsBorsh.ERROR_PAYLOAD_DECODE_FAILED,
        e?.message ?? 'PING payload decode failed',
        e?.retryable ?? false
      );
    }
  }

  private sendEnvelope(ws: ServerWebSocket<ClientState>, kind: number, payload: Uint8Array): void {
    this.sendChunked(ws, kind, payload);
  }

  private sendChunked(
    ws: ServerWebSocket<ClientState>,
    kind: number,
    payload: Uint8Array
  ): boolean {
    if (!gatewayWebSocketSendGuard.canSend(ws as ServerWebSocket<unknown>)) {
      return false;
    }
    const state = ws.data.borshState;

    const originalSeq = state.seqGen();
    if (!payloadNeedsChunking(payload.length, state.maxFrameBytes)) {
      return gatewayWebSocketSendGuard.sendFrames(ws as ServerWebSocket<unknown>, [
        wsBorsh.encodeEnvelope(kind, payload, originalSeq),
      ]);
    }
    const chunked = wsBorsh.splitPayloadIntoChunks(payload, kind, originalSeq, {
      maxFrameBytes: state.maxFrameBytes,
      chunkStreamId: wsBorsh.generateChunkStreamId(),
    });

    return gatewayWebSocketSendGuard.sendFrames(
      ws as ServerWebSocket<unknown>,
      chunked.chunks.map((chunk) => wsBorsh.encodeChunk(chunk, state.seqGen()))
    );
  }

  private sendError(
    ws: ServerWebSocket<ClientState>,
    refSeq: number | null,
    code: number,
    message: string,
    retryable: boolean
  ): void {
    const payload = wsBorsh.encodePayload(wsBorsh.schema.ErrorSchema, {
      refSeq,
      code,
      message,
      retryable,
    });
    this.sendEnvelope(ws, wsBorsh.KIND_ERROR, payload);
  }

  private async getOrCreateConnectionEntry(
    deviceId: string,
    ws: ServerWebSocket<ClientState>
  ): Promise<DeviceConnectionEntry | null> {
    const existing = this.connections.get(deviceId);
    if (existing) {
      this.clearIdleReleaseTimer(existing);
      return existing;
    }

    const pending = this.pendingConnectionEntries.get(deviceId);
    if (pending) {
      return pending;
    }

    const creationPromise: Promise<DeviceConnectionEntry | null> = this.createDeviceConnectionEntry(
      deviceId,
      ws
    )
      .then((createdEntry) => {
        if (createdEntry) {
          this.connections.set(deviceId, createdEntry);
        }
        return createdEntry;
      })
      .finally(() => {
        if (this.pendingConnectionEntries.get(deviceId) === creationPromise) {
          this.pendingConnectionEntries.delete(deviceId);
        }
      });

    this.pendingConnectionEntries.set(deviceId, creationPromise);
    return creationPromise;
  }

  private async handleDeviceConnect(
    ws: ServerWebSocket<ClientState>,
    deviceId: string
  ): Promise<void> {
    const entry = await this.getOrCreateConnectionEntry(deviceId, ws);
    if (!entry) return;

    entry.clients.add(ws);
    this.clearIdleReleaseTimer(entry);
    ws.data.borshState.selectedPanes[deviceId] ??= null;

    const canonicalSession = this.canonicalSessions.get(ws);
    if (canonicalSession) await canonicalSession.attachDevice(deviceId, entry.runtime);

    const connectedPayload = wsBorsh.encodePayload(wsBorsh.schema.DeviceConnectedSchema, {
      deviceId,
    });
    this.sendEnvelope(ws, wsBorsh.KIND_DEVICE_CONNECTED, connectedPayload);

    if (entry.lastSnapshot) {
      if (!entry.canonicalClients?.has(ws)) {
        const snapshotBytes = this.encodeSnapshotWithOverlays(entry.lastSnapshot);
        this.sendChunked(ws, wsBorsh.KIND_STATE_SNAPSHOT, snapshotBytes);
      }
    } else {
      entry.runtime.requestSnapshot();
    }
  }

  private handleDeviceDisconnect(ws: ServerWebSocket<ClientState>, deviceId: string): void {
    this.canonicalSessions.get(ws)?.detachDevice(deviceId);
    const entry = this.connections.get(deviceId);
    if (entry) {
      entry.clients.delete(ws);
      this.refreshSnapshotPolling(deviceId);
      this.scheduleConnectionEntryRelease(deviceId, entry);
    }

    delete ws.data.borshState.selectedPanes[deviceId];
    delete ws.data.borshState.subscribedPanes[deviceId];

    const disconnectedPayload = wsBorsh.encodePayload(wsBorsh.schema.DeviceDisconnectedSchema, {
      deviceId,
    });
    this.sendEnvelope(ws, wsBorsh.KIND_DEVICE_DISCONNECTED, disconnectedPayload);
  }

  private handleTmuxSelect(
    ws: ServerWebSocket<ClientState>,
    data: wsBorsh.b.infer<typeof wsBorsh.schema.TmuxSelectSchema>
  ): void {
    const deviceId = data.deviceId;
    const entry = this.connections.get(deviceId);
    if (!entry) return;

    const windowId = data.windowId ?? undefined;
    const paneId = data.paneId ?? undefined;
    if (!windowId || !paneId) return;
    if (!this.canSelectPane(entry, deviceId, windowId, paneId)) return;

    this.terminalOutputBatcher.flushDevice(deviceId);
    const started = switchBarrier.startTransaction(ws as any, {
      deviceId,
      windowId,
      paneId,
      selectToken: data.selectToken,
      wantHistory: data.wantHistory,
      cols: data.cols ?? null,
      rows: data.rows ?? null,
    });

    if (!started) {
      this.sendError(
        ws,
        null,
        wsBorsh.ERROR_SELECT_CONFLICT,
        'Failed to start select transaction',
        false
      );
      return;
    }

    ws.data.borshState.selectedPanes[deviceId] = paneId;
    this.refreshSnapshotPolling(deviceId);
    switchBarrier.sendSwitchAck(ws as any, deviceId);

    const cols = data.cols ?? null;
    const rows = data.rows ?? null;
    if (cols !== null && rows !== null) {
      entry.runtime.selectPaneWithSize(windowId, paneId, cols, rows);
    } else {
      entry.runtime.selectPane(windowId, paneId);
    }
  }

  private handleTmuxSelectWindow(deviceId: string, windowId: string): void {
    const entry = this.connections.get(deviceId);
    if (!entry) return;
    if (!this.canSelectWindow(entry, deviceId, windowId)) return;
    entry.runtime.selectWindow(windowId);
  }

  private canSelectWindow(
    entry: DeviceConnectionEntry,
    deviceId: string,
    windowId: string | undefined
  ): windowId is string {
    if (!isTmuxWindowId(windowId)) {
      console.warn(`[ws] rejecting invalid tmux window id on ${deviceId}: ${windowId ?? ''}`);
      entry.runtime.requestSnapshot();
      return false;
    }

    const windows = entry.lastSnapshot?.session?.windows;
    if (!windows?.some((window) => window.id === windowId)) {
      console.warn(`[ws] rejecting missing tmux window id on ${deviceId}: ${windowId}`);
      entry.runtime.requestSnapshot();
      return false;
    }

    return true;
  }

  private canSelectPane(
    entry: DeviceConnectionEntry,
    deviceId: string,
    windowId: string | undefined,
    paneId: string | undefined
  ): windowId is string {
    if (!this.canSelectWindow(entry, deviceId, windowId)) {
      return false;
    }

    if (!isTmuxPaneId(paneId)) {
      console.warn(`[ws] rejecting invalid tmux pane id on ${deviceId}: ${paneId ?? ''}`);
      entry.runtime.requestSnapshot();
      return false;
    }

    const window = entry.lastSnapshot?.session?.windows.find(
      (candidate) => candidate.id === windowId
    );
    if (!window?.panes.some((pane) => pane.id === paneId)) {
      console.warn(`[ws] rejecting missing tmux pane id on ${deviceId}: ${paneId}`);
      entry.runtime.requestSnapshot();
      return false;
    }

    return true;
  }

  private handleTermInput(deviceId: string, paneId: string, data: string): void {
    const entry = this.connections.get(deviceId);
    if (!entry) return;
    entry.runtime.sendInput(paneId, data);
  }

  // 去重以快照中目标 window 的实际尺寸为准：tmux 尺寸是 per-window 的，
  // 独立的 per-device 缓存会吞掉切换 window 后的合法 resize（单 pane 切窗不重绘回归）
  private handleTermResize(deviceId: string, paneId: string, cols: number, rows: number): void {
    const entry = this.connections.get(deviceId);
    if (!entry) return;

    const window = entry.lastSnapshot?.session?.windows?.find((w) =>
      w.panes?.some((p) => p.id === paneId)
    );

    if (window?.panes && window.panes.length > 1) {
      const currentSize = parseWindowLayoutSize(window.layout);
      if (currentSize && currentSize.cols === cols && currentSize.rows === rows) {
        return;
      }
      entry.runtime.resizeWindow(window.id, cols, rows);
      return;
    }

    const pane = window?.panes.find((p) => p.id === paneId);
    if (pane && pane.width === cols && pane.height === rows) {
      return;
    }

    entry.runtime.resizePane(paneId, cols, rows);
  }

  private handleTermPaste(deviceId: string, paneId: string, data: string): void {
    const entry = this.connections.get(deviceId);
    if (!entry) return;

    const chunkSize = 1024;
    for (let i = 0; i < data.length; i += chunkSize) {
      const chunk = data.slice(i, i + chunkSize);
      entry.runtime.sendInput(paneId, chunk);
    }
  }

  // 创建成功后向发起方回执新 window id（KIND_TMUX_WINDOW_CREATED），
  // 客户端无需通过快照 diff 推断新窗口。
  private handleCreateWindow(
    ws: ServerWebSocket<ClientState>,
    deviceId: string,
    name?: string,
    cwd?: string
  ): void {
    const entry = this.connections.get(deviceId);
    if (!entry) {
      const connected = Array.from(this.connections.keys()).join(',') || '(none)';
      console.warn(
        `[ws] create-window dropped: no connection entry for device ${deviceId} (connected devices: ${connected})`
      );
      return;
    }
    void entry.runtime
      .createWindow(name, cwd)
      .then((windowId) => {
        if (!windowId) {
          console.warn(`[ws] create-window dropped on ${deviceId}: runtime returned no window id`);
          return;
        }
        this.sendEnvelope(
          ws,
          wsBorsh.KIND_TMUX_WINDOW_CREATED,
          wsBorsh.encodePayload(wsBorsh.schema.TmuxWindowCreatedSchema, { deviceId, windowId })
        );
      })
      .catch((error) => {
        console.warn(`[ws] create-window failed on ${deviceId}:`, error);
      });
  }

  private handleCloseWindow(deviceId: string, windowId: string): void {
    const entry = this.connections.get(deviceId);
    if (!entry) return;
    entry.runtime.closeWindow(windowId);
  }

  private handleClosePane(deviceId: string, paneId: string): void {
    const entry = this.connections.get(deviceId);
    if (!entry) return;
    entry.runtime.closePane(paneId);
  }

  // pane 重命名同窗口：写内存 overlay 而非 tmux pane title，避免被应用 OSC 持续覆盖。
  // WS handler 与 REST 桥共用（settings/broadcaster 注册）。
  renamePane(deviceId: string, paneId: string, name: string): void {
    if (!isTmuxPaneId(paneId)) return;
    const trimmed = name.trim().slice(0, 64);
    const names = this.paneCustomNames.get(deviceId);

    if (!trimmed) {
      names?.delete(paneId);
    } else if (names) {
      names.set(paneId, trimmed);
    } else {
      this.paneCustomNames.set(deviceId, new Map([[paneId, trimmed]]));
    }

    const paneRuntime = this.connections.get(deviceId)?.runtime ?? this.deps.peekRuntime?.(deviceId);
    paneRuntime?.setCustomName?.('pane', paneId, trimmed || null);

    this.broadcastSettingsUpdate('tree-order');
    const entry = this.connections.get(deviceId);
    if (!entry?.lastSnapshot) return;
    this.sendSnapshotToClients(entry, entry.lastSnapshot);
  }

  private handleBreakPane(deviceId: string, paneId: string): void {
    const entry = this.connections.get(deviceId);
    if (!entry || !isTmuxPaneId(paneId)) return;
    entry.runtime.breakPane(paneId);
  }

  private handleMovePane(
    deviceId: string,
    srcPaneId: string,
    dstPaneId: string,
    position: number
  ): void {
    const entry = this.connections.get(deviceId);
    if (!entry || !isTmuxPaneId(srcPaneId) || !isTmuxPaneId(dstPaneId)) return;
    if (srcPaneId === dstPaneId) return;
    const positionMap: Record<number, 'left' | 'right' | 'top' | 'bottom'> = {
      1: 'left',
      2: 'right',
      3: 'top',
      4: 'bottom',
    };
    const resolved = positionMap[position];
    if (!resolved) return;
    entry.runtime.movePane(srcPaneId, dstPaneId, resolved);
  }

  // 重命名写入内存 overlay 而非 tmux rename-window，避免关闭 automatic-rename 导致标题不再跟随终端。
  // WS handler 与 REST 桥共用（settings/broadcaster 注册）。
  renameWindow(deviceId: string, windowId: string, name: string): void {
    const trimmed = name.trim().slice(0, 64);
    const names = this.windowCustomNames.get(deviceId);

    if (!trimmed) {
      names?.delete(windowId);
    } else if (names) {
      names.set(windowId, trimmed);
    } else {
      this.windowCustomNames.set(deviceId, new Map([[windowId, trimmed]]));
    }

    const windowRuntime =
      this.connections.get(deviceId)?.runtime ?? this.deps.peekRuntime?.(deviceId);
    windowRuntime?.setCustomName?.('window', windowId, trimmed || null);

    this.broadcastSettingsUpdate('tree-order');
    const entry = this.connections.get(deviceId);
    if (!entry?.lastSnapshot) return;
    this.sendSnapshotToClients(entry, entry.lastSnapshot);
  }

  // 供 REST 读自定义名 overlay（快照未必存在，直接读内存 Map）
  getCustomNames(deviceId: string): {
    windows: Record<string, string>;
    panes: Record<string, string>;
  } {
    return {
      windows: Object.fromEntries(this.windowCustomNames.get(deviceId) ?? []),
      panes: Object.fromEntries(this.paneCustomNames.get(deviceId) ?? []),
    };
  }

  private handleSetWindowStyle(deviceId: string, style: string): void {
    const entry = this.connections.get(deviceId);
    if (!entry) return;
    void (async () => {
      try {
        // 先等 window-style 落地再补发 997：TUI 收到通知会重查 OSC 11，顺序反了拿旧色
        await entry.runtime.setWindowStyle(style);
      } catch (err) {
        console.error('[ws] setWindowStyle failed:', err);
      }
      if (this.currentTheme !== null) {
        const theme = this.currentTheme;
        if (this.lastBroadcastTheme.get(deviceId) !== theme) {
          this.lastBroadcastTheme.set(deviceId, theme);
          this.broadcastThemeChange(theme);
        }
      }
    })();
  }

  private handleSiteThemeUpdate(
    ws: ServerWebSocket<ClientState>,
    decoded: wsBorsh.b.infer<typeof wsBorsh.schema.SiteThemeUpdateC2SSchema>
  ): void {
    if (decoded.theme !== wsBorsh.SITE_THEME_DARK && decoded.theme !== wsBorsh.SITE_THEME_LIGHT) {
      this.sendError(
        ws,
        null,
        wsBorsh.ERROR_PAYLOAD_DECODE_FAILED,
        `invalid theme value: ${decoded.theme}`,
        false
      );
      return;
    }
    const themeName: ThemeMode = decoded.theme === wsBorsh.SITE_THEME_LIGHT ? 'light' : 'dark';

    updateSiteSettings({ theme: themeName });
    this.scheduleTmuxThemeApply(themeName);
    this.broadcastSiteThemeUpdateS2C(themeName);
    this.broadcastSettingsUpdate('theme');
  }

  // tmux 侧主题编排（latest-wins 合并）：先 await 全设备 window-style 落地，再对订阅
  // mode 2031 的 pane 注入 997。编排进行中新值到来只记 pending，当前轮结束后再跑，
  // 快速连切时丢弃中间态只应用末态。
  scheduleTmuxThemeApply(theme: ThemeMode): void {
    this.pendingTmuxTheme = theme;
    if (this.themeApplyInFlight) {
      return;
    }
    this.themeApplyInFlight = true;
    void (async () => {
      try {
        while (this.pendingTmuxTheme !== null) {
          const next = this.pendingTmuxTheme;
          this.pendingTmuxTheme = null;
          await this.handleSiteThemeChange(next);
          this.broadcastThemeChange(next);
        }
      } finally {
        this.themeApplyInFlight = false;
      }
    })();
  }

  // 向所有 connected clients 广播 KIND_SITE_THEME_UPDATE S2C。
  // serverTimestamp 严格递增（同毫秒并发时 +1），保证前端能按序应用。
  // WS C2S handleSiteThemeUpdate 与 HTTP POST /api/settings/theme 共用此路径，
  // 确保两条入口的 S2C 行为一致（T10 已确保前端收到 S2C 不回送 C2S，无循环）。
  broadcastSiteThemeUpdateS2C(theme: ThemeMode): void {
    const now = BigInt(Date.now());
    if (now <= this.lastThemeTimestamp) {
      this.lastThemeTimestamp += 1n;
    } else {
      this.lastThemeTimestamp = now;
    }
    const effectiveTimestamp = this.lastThemeTimestamp;

    const themeCode = theme === 'light' ? wsBorsh.SITE_THEME_LIGHT : wsBorsh.SITE_THEME_DARK;
    const payloadBytes = wsBorsh.encodePayload(wsBorsh.schema.SiteThemeUpdateS2CSchema, {
      theme: themeCode,
      serverTimestamp: effectiveTimestamp,
    });
    for (const client of this.connectedClients) {
      this.sendEnvelope(client, wsBorsh.KIND_SITE_THEME_UPDATE, payloadBytes);
    }
  }

  // 向所有 connected clients 广播 KIND_SETTINGS_UPDATE（设置变更缓存失效信号）。
  // serverTimestamp 与 theme 广播同规则：严格递增（同毫秒并发时 +1）。
  broadcastSettingsUpdate(namespace: SettingsNamespace): void {
    const now = BigInt(Date.now());
    if (now <= this.lastSettingsTimestamp) {
      this.lastSettingsTimestamp += 1n;
    } else {
      this.lastSettingsTimestamp = now;
    }

    const payloadBytes = wsBorsh.encodePayload(wsBorsh.schema.SettingsUpdateS2CSchema, {
      namespace,
      serverTimestamp: this.lastSettingsTimestamp,
    });
    for (const client of this.connectedClients) {
      this.sendEnvelope(client, wsBorsh.KIND_SETTINGS_UPDATE, payloadBytes);
    }
  }

  // 向所有 connected clients 广播 KIND_NOTIFY_EVENT（事件通知，无订阅过滤——
  // 未知 kind 由客户端静默忽略）。timestamp 取事件时间，解析失败回退 Date.now()。
  broadcastEventNotify(eventType: EventType, event: WebhookEvent): void {
    const eventTimeMs = Date.parse(event.timestamp);
    const payloadBytes = wsBorsh.encodePayload(wsBorsh.schema.EventNotifyS2CSchema, {
      eventType,
      eventJson: JSON.stringify(event),
      timestamp: BigInt(Number.isNaN(eventTimeMs) ? Date.now() : eventTimeMs),
    });
    for (const client of this.connectedClients) {
      this.sendEnvelope(client, wsBorsh.KIND_NOTIFY_EVENT, payloadBytes);
    }
  }

  // 站点主题变化时对所有已连接设备的所有 window 设置 tmux window-style，
  // 让 tmux 原生代答 OSC 11 取到与前端主题一致的颜色。
  // 严格 per-device：每个设备的所有 window 都要设置。
  async handleSiteThemeChange(theme: ThemeMode): Promise<void> {
    if (theme !== 'dark' && theme !== 'light') {
      return;
    }
    this.currentTheme = theme;
    const style = getTmuxWindowStyle(theme);
    const results = await Promise.allSettled(
      [...this.connections.values()].map((entry) => entry.runtime.setWindowStyle(style))
    );
    for (const result of results) {
      if (result.status === 'rejected') {
        console.error('[ws] setWindowStyle on theme change failed:', result.reason);
      }
    }
  }

  // 对单个设备应用当前主题的 window-style（用于新设备连接时）。
  // currentTheme 为 null 时跳过（尚未从 SiteSettings 初始化）。
  applyThemeToDevice(deviceId: string): void {
    if (this.currentTheme === null) {
      return;
    }
    const entry = this.connections.get(deviceId);
    if (!entry) {
      return;
    }
    const style = getTmuxWindowStyle(this.currentTheme);
    entry.runtime.setWindowStyle(style).catch((err) => {
      console.error(`[ws] setWindowStyle on device ${deviceId} failed:`, err);
    });
  }

  // 主题变化时对所有已连接设备的所有 pane 注入主题通知序列（stdin 路径）。
  // 节流：同一设备同主题 1s 内去重，避免快速切换时刷屏。
  broadcastThemeChange(theme: 'dark' | 'light'): void {
    const now = Date.now();
    for (const [deviceId, entry] of this.connections) {
      const last = this.themeSignalLast.get(deviceId);
      if (last && last.theme === theme && now - last.at < 1000) {
        continue;
      }
      this.themeSignalLast.set(deviceId, { theme, at: now });
      this.lastBroadcastTheme.set(deviceId, theme);

      const panes = entry.lastSnapshot?.session?.windows?.flatMap((w) => w.panes) ?? [];
      for (const pane of panes) {
        try {
          entry.runtime.signalThemeChange(pane.id, theme);
        } catch (err) {
          console.error(`[ws] signalThemeChange failed for ${deviceId}/${pane.id}:`, err);
        }
      }
    }
  }

  // window / pane 重排：纯显示层 overlay，写库后立即用上一份快照重广播（不触碰 tmux、不打 poll）。
  // WS handler 与 REST 桥共用（settings/broadcaster 注册）。
  reorderWindows(deviceId: string, windowIds: string[]): void {
    const currentOrder = this.getCachedDeviceTreeOrder(deviceId);
    this.deps.saveWindowOrder(deviceId, windowIds);
    this.storeDeviceTreeOrder({
      deviceId,
      windows: windowIds,
      panes: currentOrder.panes,
    });
    this.broadcastSettingsUpdate('tree-order');
    const entry = this.connections.get(deviceId);
    if (!entry?.lastSnapshot) return;
    this.sendSnapshotToClients(entry, entry.lastSnapshot);
  }

  reorderPanes(deviceId: string, windowId: string, paneIds: string[]): void {
    const currentOrder = this.getCachedDeviceTreeOrder(deviceId);
    this.deps.savePaneOrder(deviceId, windowId, paneIds);
    this.storeDeviceTreeOrder({
      deviceId,
      windows: currentOrder.windows,
      panes: {
        ...currentOrder.panes,
        [windowId]: paneIds,
      },
    });
    this.broadcastSettingsUpdate('tree-order');
    const entry = this.connections.get(deviceId);
    if (!entry?.lastSnapshot) return;
    this.sendSnapshotToClients(entry, entry.lastSnapshot);
  }

  // 幂等全量声明附加订阅集：只接受当前快照中存在的 pane，替换旧集合
  private handleSubscribePanes(
    ws: ServerWebSocket<ClientState>,
    deviceId: string,
    paneIds: string[]
  ): void {
    const entry = this.connections.get(deviceId);
    if (!entry) return;

    const knownPaneIds = new Set(
      entry.lastSnapshot?.session?.windows.flatMap((window) =>
        window.panes.map((pane) => pane.id)
      ) ?? []
    );
    const accepted = new Set<string>();
    for (const paneId of paneIds) {
      if (isTmuxPaneId(paneId) && knownPaneIds.has(paneId)) {
        accepted.add(paneId);
      }
    }

    this.terminalOutputBatcher.flushDevice(deviceId);
    if (accepted.size > 0) {
      ws.data.borshState.subscribedPanes[deviceId] = accepted;
    } else {
      delete ws.data.borshState.subscribedPanes[deviceId];
    }
    this.refreshSnapshotPolling(deviceId);
  }

  // 点对点请求-响应：直接 capture 并只回发起 client（带其 requestToken），
  // 不经 broadcastTerminalHistory——广播路由按 barrier/selectedPanes 投递，
  // 无法与进行中的 select 事务区分同一 pane 的两份 history
  private handleFetchPaneHistory(
    ws: ServerWebSocket<ClientState>,
    deviceId: string,
    paneId: string,
    requestToken: Uint8Array
  ): void {
    const entry = this.connections.get(deviceId);
    if (!entry || !isTmuxPaneId(paneId)) return;

    const respond = (captured: { data: string; alternateScreen: boolean; modes: number } | null) => {
      const payloadBytes = wsBorsh.encodePayload(wsBorsh.schema.TermHistorySchema, {
        deviceId,
        paneId,
        selectToken: requestToken,
        encoding: 1,
        alternateScreen: captured?.alternateScreen ?? false,
        modes: captured?.modes ?? 0,
        data: new TextEncoder().encode(captured?.data ?? ''),
      });
      this.sendChunked(ws, wsBorsh.KIND_TERM_HISTORY, payloadBytes);
    };
    void entry.runtime
      .fetchPaneHistory(paneId)
      .then(respond)
      .catch((error) => {
        console.warn(`[ws] fetch pane history failed on ${deviceId}/${paneId}:`, error);
        // 失败也回空响应:客户端据此结束首屏等待进入实时流,而不是卡在
        // history gate 直到超时(采不到历史是暂态,实时流会重建画面)。
        try {
          respond(null);
        } catch {
          /* 连接已关等发送失败无需处理 */
        }
      });
  }

  private handleResizePaneById(
    deviceId: string,
    paneId: string,
    cols?: number,
    rows?: number
  ): void {
    const entry = this.connections.get(deviceId);
    if (!entry || !isTmuxPaneId(paneId)) return;
    if (cols === undefined && rows === undefined) return;
    entry.runtime.resizePaneById(paneId, { cols, rows });
  }

  // 移动端拼接布局：window 宽 = N*cols+(N-1)、高 = rows，even-horizontal 后每 pane 恰好 cols×rows。
  // 快照几何已匹配时跳过，避免多端/多次触发互相打架。
  private handleApplyStackedLayout(
    deviceId: string,
    windowId: string,
    cols: number,
    rows: number
  ): void {
    const entry = this.connections.get(deviceId);
    if (!entry) return;
    if (!this.canSelectWindow(entry, deviceId, windowId)) return;
    if (cols < 2 || rows < 2) return;

    const window = entry.lastSnapshot?.session?.windows.find(
      (candidate) => candidate.id === windowId
    );
    const paneCount = window?.panes.length ?? 0;
    if (!window || paneCount === 0) return;

    const alreadyStacked = window.panes.every(
      (pane) => pane.width === cols && pane.height === rows
    );
    if (alreadyStacked) return;

    // tmux 窗口宽度硬上限（layout cell 级），超限截断并告警
    const TMUX_MAX_WINDOW_COLS = 10_000;
    const totalCols = paneCount * cols + (paneCount - 1);
    const clampedCols = Math.min(totalCols, TMUX_MAX_WINDOW_COLS);
    if (clampedCols !== totalCols) {
      console.warn(
        `[ws] stacked layout width clamped on ${deviceId}/${windowId}: ${totalCols} -> ${clampedCols}`
      );
    }

    if (paneCount === 1) {
      entry.runtime.resizeWindow(windowId, clampedCols, rows);
      return;
    }

    entry.runtime.applyStackedLayout(windowId, clampedCols, rows);
  }

  private handleSplitPane(deviceId: string, paneId: string, direction: number, cwd?: string): void {
    const entry = this.connections.get(deviceId);
    if (!entry || !isTmuxPaneId(paneId)) return;
    const dir = direction === 2 ? 'v' : 'h';
    entry.runtime.splitPane(paneId, dir, cwd);
  }

  // 分屏内轻量焦点切换：更新 selectedPanes 并 select-window/select-pane，
  // 不走 switch-barrier、不触发 history capture（pane 已在前端持续渲染）
  private handleFocusPane(
    ws: ServerWebSocket<ClientState>,
    deviceId: string,
    windowId: string,
    paneId: string
  ): void {
    const entry = this.connections.get(deviceId);
    if (!entry) return;
    if (!this.canSelectPane(entry, deviceId, windowId, paneId)) return;

    ws.data.borshState.selectedPanes[deviceId] = paneId;
    this.refreshSnapshotPolling(deviceId);
    entry.runtime.focusPane(windowId, paneId);
  }

  private applyWindowCustomNames(payload: StateSnapshotPayload): StateSnapshotPayload {
    const names = this.windowCustomNames.get(payload.deviceId);
    const paneNames = this.paneCustomNames.get(payload.deviceId);
    if ((!names?.size && !paneNames?.size) || !payload.session) return payload;

    const liveWindowIds = new Set(payload.session.windows.map((w) => w.id));
    for (const windowId of names?.keys() ?? []) {
      if (!liveWindowIds.has(windowId)) {
        names?.delete(windowId);
      }
    }

    const livePaneIds = new Set(
      payload.session.windows.flatMap((w) => w.panes.map((pane) => pane.id))
    );
    for (const paneId of paneNames?.keys() ?? []) {
      if (!livePaneIds.has(paneId)) {
        paneNames?.delete(paneId);
      }
    }

    return {
      ...payload,
      session: {
        ...payload.session,
        windows: payload.session.windows.map((window) => {
          const customName = names?.get(window.id);
          const panes = paneNames?.size
            ? window.panes.map((pane) => {
                const paneCustomName = paneNames.get(pane.id);
                return paneCustomName ? { ...pane, customName: paneCustomName } : pane;
              })
            : window.panes;
          return customName || panes !== window.panes
            ? { ...window, ...(customName ? { customName } : {}), panes }
            : window;
        }),
      },
    };
  }

  private storeDeviceTreeOrder(order: DeviceTreeOrderRecord): DeviceTreeOrderRecord {
    const stored = {
      deviceId: order.deviceId,
      windows: [...order.windows],
      panes: Object.fromEntries(
        Object.entries(order.panes).map(([windowId, paneIds]) => [windowId, [...paneIds]])
      ),
    };
    this.deviceTreeOrders.set(order.deviceId, stored);
    return stored;
  }

  private getCachedDeviceTreeOrder(deviceId: string): DeviceTreeOrderRecord {
    const cached = this.deviceTreeOrders.get(deviceId);
    if (cached) {
      return cached;
    }
    return this.storeDeviceTreeOrder(this.deps.loadDeviceTreeOrder(deviceId));
  }

  // 链式 overlay：先按连接生命周期内缓存的 device_tree_order 重排数组，再叠加自定义窗口名
  private encodeSnapshotWithOverlays(payload: StateSnapshotPayload): Uint8Array {
    const ordered = applyDeviceTreeOverlay(
      payload,
      this.getCachedDeviceTreeOrder(payload.deviceId)
    );
    return wsBorsh.encodeStateSnapshot(this.applyWindowCustomNames(ordered));
  }

  private sendSnapshotToClients(entry: DeviceConnectionEntry, payload: StateSnapshotPayload): void {
    const payloadBytes = this.encodeSnapshotWithOverlays(payload);
    let deliveries = 0;
    for (const client of entry.clients) {
      if (entry.canonicalClients?.has(client)) continue;
      if (this.sendChunked(client, wsBorsh.KIND_STATE_SNAPSHOT, payloadBytes)) {
        deliveries += 1;
      }
    }
    this.gatewayActivityMetrics.recordSnapshot(payloadBytes.length, deliveries);
  }

  private async createDeviceConnectionEntry(
    deviceId: string,
    ws: ServerWebSocket<ClientState>
  ): Promise<DeviceConnectionEntry | null> {
    let runtime: DeviceSessionRuntime | null = null;
    let detachRuntime: (() => void) | null = null;

    try {
      runtime = await this.deps.acquireRuntime(deviceId);
      detachRuntime = this.attachRuntime(deviceId, runtime);

      await runtime.connect();
      if (this.currentTheme !== null) {
        await runtime.setWindowStyle(getTmuxWindowStyle(this.currentTheme));
      }
      return {
        runtime,
        detachRuntime,
        clients: new Set(),
        lastSnapshot: runtime.getCurrentSnapshot?.() ?? null,
        snapshotTimer: null,
        snapshotPollTimer: null,
        reconnectAttempts: 0,
        reconnectTimer: null,
        canonicalClients: new Set(),
        idleReleaseTimer: null,
      };
    } catch (err) {
      detachRuntime?.();
      if (runtime) {
        void this.deps.releaseRuntime(deviceId, runtime);
      }
      const errorInfo = classifySshError(err instanceof Error ? err : new Error(String(err)));
      this.sendEnvelope(
        ws,
        wsBorsh.KIND_DEVICE_EVENT,
        wsBorsh.encodeDeviceEventPayload({
          deviceId,
          type: 'error',
          errorType: errorInfo.type,
          message: t(errorInfo.messageKey, { ...errorInfo.messageParams }),
          rawMessage: err instanceof Error ? err.message : String(err),
        })
      );
      return null;
    }
  }

  private async broadcastTmuxEvent(deviceId: string, event: TmuxEvent): Promise<void> {
    const entry = this.connections.get(deviceId);
    if (!entry) return;

    const extendedEvent = await this.extendTmuxEvent(deviceId, event);
    const settings = getSiteSettings();

    if (extendedEvent.type === 'notification') {
      const data = (extendedEvent.data ?? {}) as Record<string, unknown>;
      const title = typeof data.title === 'string' && data.title ? data.title : '';
      const body = typeof data.body === 'string' ? data.body : '';
      if (!title && !body) {
        return;
      }
    }

    const payloadBytes = wsBorsh.encodeTmuxEventPayload({
      deviceId,
      type: extendedEvent.type,
      data: extendedEvent.data,
    });

    if (extendedEvent.type === 'bell') {
      const data = (extendedEvent.data ?? {}) as Record<string, unknown>;
      const paneId = typeof data.paneId === 'string' && data.paneId ? data.paneId : '-';

      let deliveryAttempts = 0;
      for (const client of entry.clients) {
        if (
          !sessionStateStore.shouldAllowBell(client, deviceId, paneId, settings.bellThrottleSeconds)
        ) {
          continue;
        }
        this.sendEnvelope(client, wsBorsh.KIND_TMUX_EVENT, payloadBytes);
        deliveryAttempts += 1;
      }
      this.gatewayActivityMetrics.recordTmuxEvent(extendedEvent.type, deliveryAttempts);
      return;
    }

    if (extendedEvent.type === 'notification') {
      const data = (extendedEvent.data ?? {}) as Record<string, unknown>;
      const paneId = typeof data.paneId === 'string' && data.paneId ? data.paneId : '-';
      const source = typeof data.source === 'string' && data.source ? data.source : 'osc9';

      let deliveryAttempts = 0;
      for (const client of entry.clients) {
        if (
          !sessionStateStore.shouldAllowNotification(
            client,
            deviceId,
            paneId,
            source,
            settings.notificationThrottleSeconds
          )
        ) {
          continue;
        }
        this.sendEnvelope(client, wsBorsh.KIND_TMUX_EVENT, payloadBytes);
        deliveryAttempts += 1;
      }
      this.gatewayActivityMetrics.recordTmuxEvent(extendedEvent.type, deliveryAttempts);
      return;
    }

    for (const client of entry.clients) {
      this.sendEnvelope(client, wsBorsh.KIND_TMUX_EVENT, payloadBytes);
    }
    this.gatewayActivityMetrics.recordTmuxEvent(extendedEvent.type, entry.clients.size);
  }

  private async extendTmuxEvent(deviceId: string, event: TmuxEvent): Promise<TmuxEvent> {
    if (event.type !== 'bell' && event.type !== 'notification') {
      return event;
    }

    const settings = getSiteSettings();
    const snapshot = this.connections.get(deviceId)?.lastSnapshot ?? null;
    const paneContext = resolvePaneContext({
      deviceId,
      siteUrl: settings.siteUrl,
      snapshot,
      rawData: event.data,
    });

    if (event.type === 'bell') {
      return {
        type: 'bell',
        data: paneContext,
      };
    }

    const raw = (event.data as Record<string, unknown> | undefined) ?? {};
    const source =
      raw.source === 'osc9' ||
      raw.source === 'osc99' ||
      raw.source === 'osc777' ||
      raw.source === 'osc1337'
        ? raw.source
        : 'osc9';
    const title = typeof raw.title === 'string' && raw.title ? raw.title : undefined;
    const body = typeof raw.body === 'string' ? raw.body : '';

    return {
      type: 'notification',
      data: {
        ...paneContext,
        source,
        title,
        body,
      },
    };
  }

  private broadcastStateSnapshot(deviceId: string, payload: StateSnapshotPayload): void {
    const entry = this.connections.get(deviceId);
    if (!entry) return;

    entry.lastSnapshot = payload;
    this.sendSnapshotToClients(entry, payload);
  }

  private broadcastLegacyMetadataPatch(
    deviceId: string,
    patch: Parameters<typeof wsBorsh.sourceMetadataPatchToLegacyDiff>[0],
    currentSnapshot: StateSnapshotPayload | null
  ): void {
    const entry = this.connections.get(deviceId);
    if (!entry) return;
    const diff = wsBorsh.sourceMetadataPatchToLegacyDiff(patch);
    if (diff.upserts.length === 0 && diff.removals.length === 0) return;
    entry.lastSnapshot = currentSnapshot;
    const payload = wsBorsh.encodePayload(wsBorsh.schema.StateSnapshotDiffSchema, {
      deviceId,
      baseRevision: Number(patch.fromRevision & 0xffff_ffffn),
      revision: Number(patch.throughRevision & 0xffff_ffffn),
      diffFormat: wsBorsh.STATE_SNAPSHOT_DIFF_FORMAT_ABSOLUTE_JSON,
      diffBytes: wsBorsh.encodeLegacyStateSnapshotDiff(diff),
    });
    for (const client of entry.clients) {
      if (entry.canonicalClients?.has(client)) continue;
      this.sendChunked(client, wsBorsh.KIND_STATE_SNAPSHOT_DIFF, payload);
    }
  }

  private broadcastTerminalOutput(deviceId: string, paneId: string, data: Uint8Array): void {
    const entry = this.connections.get(deviceId);
    let legacyObserved = false;
    if (entry) {
      for (const client of entry.clients) {
        if (entry.canonicalClients?.has(client)) continue;
        if (this.clientWantsPaneOutput(client, deviceId, paneId)) {
          legacyObserved = true;
          break;
        }
      }
    }
    const canonicalObserved = entry?.runtime?.isPaneTerminalRetained?.(paneId) ?? false;
    this.terminalOutputMetrics.recordSource(data.length, {
      legacy: legacyObserved,
      canonical: canonicalObserved,
    });
    this.terminalOutputEventsUntilMetricsCheck -= 1;
    if (this.terminalOutputEventsUntilMetricsCheck === 0) {
      this.terminalOutputEventsUntilMetricsCheck = 1024;
      this.reportTerminalOutputMetricsIfDue();
    }
    if (!legacyObserved) {
      return;
    }
    this.terminalOutputBatcher.push(deviceId, paneId, data);
  }

  private reportTerminalOutputMetricsIfDue(): void {
    const canonicalSessionStats = Array.from(this.canonicalSessions.values(), (session) =>
      session.snapshotStats()
    );
    const metrics = this.terminalOutputMetrics.takeIfDue(Date.now(), {
      batch: this.terminalOutputBatcher.snapshotStats(),
      websocket: gatewayWebSocketSendGuard.snapshotStats(
        this.connectedClients as Set<ServerWebSocket<unknown>>
      ),
      canonical: {
        pendingPaneGaps: canonicalSessionStats.reduce(
          (total, stats) => total + stats.pendingPaneGaps,
          0
        ),
        pendingPaneGapLimit: canonicalSessionStats.reduce(
          (total, stats) => total + stats.pendingPaneGapLimit,
          0
        ),
        streamGapsPending: canonicalSessionStats.reduce(
          (total, stats) => total + Number(stats.streamGapPending),
          0
        ),
      },
    });
    if (!metrics) {
      return;
    }
    const wsTerminationReasons = Object.entries(metrics.queues.websocket.terminationsByReason)
      .map(([reason, count]) => `${reason}:${count}`)
      .join(',');
    console.log(
      `[ws-metrics] terminal_output interval_ms=${metrics.intervalMs} ` +
        `source_events=${metrics.sourceEvents} source_bytes=${metrics.sourceBytes} ` +
        `dropped_events=${metrics.droppedEvents} dropped_bytes=${metrics.droppedBytes} ` +
        `legacy_observed_events=${metrics.legacyObservedEvents} ` +
        `legacy_observed_bytes=${metrics.legacyObservedBytes} ` +
        `canonical_observed_events=${metrics.canonicalObservedEvents} ` +
        `canonical_observed_bytes=${metrics.canonicalObservedBytes} ` +
        `batches=${metrics.batches} batch_bytes=${metrics.batchBytes} ` +
        `recipient_deliveries=${metrics.recipientDeliveries} ` +
        `recipient_bytes=${metrics.recipientBytes} ` +
        `canonical_recipient_deliveries=${metrics.canonicalRecipientDeliveries} ` +
        `canonical_recipient_bytes=${metrics.canonicalRecipientBytes} ` +
        `canonical_delivery_drops=${metrics.canonicalDeliveryDrops} ` +
        `canonical_delivery_drop_bytes=${metrics.canonicalDeliveryDropBytes} ` +
        `batch_queue_bytes=${metrics.queues.batch.pendingBytes} ` +
        `batch_queue_limit_bytes=${metrics.queues.batch.pendingBytesLimit} ` +
        `batch_queue_panes=${metrics.queues.batch.pendingPanes} ` +
        `batch_queue_pane_limit_bytes=${metrics.queues.batch.perPaneBytesLimit} ` +
        `ws_queue_bytes=${metrics.queues.websocket.queuedBytes} ` +
        `ws_queue_limit_bytes=${metrics.queues.websocket.queuedBytesLimit} ` +
        `ws_backpressured_sessions=${metrics.queues.websocket.backpressuredSessions} ` +
        `ws_unavailable_sessions=${metrics.queues.websocket.unavailableSessions} ` +
        `ws_terminations_by_reason=${wsTerminationReasons || 'none'} ` +
        `canonical_pending_gaps=${metrics.queues.canonical.pendingPaneGaps} ` +
        `canonical_pending_gap_limit=${metrics.queues.canonical.pendingPaneGapLimit} ` +
        `canonical_stream_gaps_pending=${metrics.queues.canonical.streamGapsPending} ` +
        `clients=${this.connectedClients.size} devices=${this.connections.size}`
    );
    this.reportGatewayActivityMetricsIfDue();
  }

  private reportGatewayActivityMetricsIfDue(): void {
    const canonicalRuntimes = Array.from(this.connections.values())
      .filter((entry) => (entry.canonicalClients?.size ?? 0) > 0)
      .map((entry) => ({
        stats: entry.runtime.getPaneRetentionStats(),
        limits: entry.runtime.getPaneRetentionLimits(),
      }));
    const canonicalSessions = Array.from(this.canonicalSessions.values(), (session) =>
      session.snapshotStats()
    );
    const canonical = collectCanonicalStateMetrics(canonicalRuntimes, canonicalSessions);
    const metrics = this.gatewayActivityMetrics.takeIfDue(Date.now(), canonical);
    if (!metrics) {
      return;
    }
    const inboundKinds =
      metrics.inboundKinds
        .map(([kind, count]) => `${kind.toString(16).padStart(4, '0')}:${count}`)
        .join(',') || 'none';
    const tmuxEventTypes =
      metrics.tmuxEventTypes.map(([type, count]) => `${type}:${count}`).join(',') || 'none';
    const cacheEvictionReasons =
      Object.entries(metrics.canonical.evictionsByReason)
        .map(([reason, count]) => `${reason}:${count}`)
        .join(',') || 'none';
    let tmexFeClients = 0;
    let companionClients = 0;
    let otherClients = 0;
    let unnegotiatedClients = 0;
    for (const client of this.connectedClients) {
      const clientImpl = client.data.borshState.clientImpl;
      if (clientImpl === null) {
        unnegotiatedClients += 1;
      } else if (clientImpl === 'tmex-fe') {
        tmexFeClients += 1;
      } else if (clientImpl === 'vibex-companion') {
        companionClients += 1;
      } else {
        otherClients += 1;
      }
    }
    console.log(
      `[ws-metrics] gateway_activity interval_ms=${metrics.intervalMs} ` +
        `inbound_messages=${metrics.inboundMessages} inbound_bytes=${metrics.inboundBytes} ` +
        `inbound_kinds=${inboundKinds} snapshots=${metrics.snapshots} ` +
        `snapshot_bytes=${metrics.snapshotBytes} ` +
        `snapshot_deliveries=${metrics.snapshotDeliveries} ` +
        `terminal_histories=${metrics.terminalHistories} ` +
        `terminal_history_bytes=${metrics.terminalHistoryBytes} ` +
        `terminal_history_delivery_attempts=${metrics.terminalHistoryDeliveryAttempts} ` +
        `tmux_events=${metrics.tmuxEvents} ` +
        `tmux_event_delivery_attempts=${metrics.tmuxEventDeliveryAttempts} ` +
        `tmux_event_types=${tmuxEventTypes} ` +
        `canonical_runtimes=${metrics.canonical.runtimes} ` +
        `canonical_sessions=${metrics.canonical.sessions} ` +
        `canonical_runtime_attachments=${metrics.canonical.runtimeAttachments} ` +
        `canonical_active_panes=${metrics.canonical.activePanes} ` +
        `canonical_active_panes_limit=${metrics.canonical.activePanesLimit} ` +
        `canonical_grace_panes=${metrics.canonical.gracePanes} ` +
        `canonical_hot_panes=${metrics.canonical.hotPanes} ` +
        `canonical_hot_panes_limit=${metrics.canonical.hotPanesLimit} ` +
        `canonical_cold_panes=${metrics.canonical.coldPanes} ` +
        `canonical_replay_bytes=${metrics.canonical.replayBytes} ` +
        `canonical_replay_bytes_limit=${metrics.canonical.replayBytesLimit} ` +
        `canonical_checkpoint_bytes=${metrics.canonical.checkpointBytes} ` +
        `canonical_checkpoint_bytes_limit=${metrics.canonical.checkpointBytesLimit} ` +
        `canonical_retained_bytes=${metrics.canonical.retainedBytes} ` +
        `canonical_retained_bytes_limit=${metrics.canonical.retainedBytesLimit} ` +
        `canonical_replay_hits_total=${metrics.canonical.replayHitsTotal} ` +
        `canonical_replay_misses_total=${metrics.canonical.replayMissesTotal} ` +
        `canonical_rebases_total=${metrics.canonical.rebasesTotal} ` +
        `canonical_evictions_total=${metrics.canonical.evictionsTotal} ` +
        `canonical_evictions_by_reason=${cacheEvictionReasons} ` +
        `canonical_screen_jobs=${metrics.canonical.screenJobs} ` +
        `canonical_gated_panes=${metrics.canonical.gatedPanes} ` +
        `canonical_pending_gaps=${metrics.canonical.pendingPaneGaps} ` +
        `canonical_pending_gap_limit=${metrics.canonical.pendingPaneGapsLimit} ` +
        `canonical_stream_gaps_pending=${metrics.canonical.streamGapsPending} ` +
        `canonical_pending_gap_overflows_total=${metrics.canonical.pendingPaneGapOverflowsTotal} ` +
        `canonical_pane_gaps_sent_total=${metrics.canonical.paneGapsSentTotal} ` +
        `canonical_stream_gaps_sent_total=${metrics.canonical.streamGapsSentTotal} ` +
        `canonical_pane_data_drops_total=${metrics.canonical.paneDataDropsTotal} ` +
        `canonical_pane_data_drop_bytes_total=${metrics.canonical.paneDataDropBytesTotal} ` +
        `canonical_screen_transactions_started_total=${metrics.canonical.screenTransactionsStartedTotal} ` +
        `canonical_screen_transactions_completed_total=${metrics.canonical.screenTransactionsCompletedTotal} ` +
        `canonical_screen_transactions_failed_total=${metrics.canonical.screenTransactionsFailedTotal} ` +
        `canonical_screen_transactions_cancelled_total=${metrics.canonical.screenTransactionsCancelledTotal} ` +
        `client_impls=tmex-fe:${tmexFeClients},vibex-companion:${companionClients},` +
        `other:${otherClients},unnegotiated:${unnegotiatedClients}`
    );
  }

  private clientWantsPaneOutput(
    client: ServerWebSocket<ClientState>,
    deviceId: string,
    paneId: string
  ): boolean {
    return (
      client.data.borshState.selectedPanes[deviceId] === paneId ||
      (client.data.borshState.subscribedPanes[deviceId]?.has(paneId) ?? false)
    );
  }

  private sendTerminalOutput(deviceId: string, paneId: string, data: Uint8Array): void {
    const entry = this.connections.get(deviceId);
    if (!entry) return;

    let payloadBytes: Uint8Array | null = null;
    for (const client of entry.clients) {
      if (entry.canonicalClients?.has(client)) continue;
      const isFocused = client.data.borshState.selectedPanes[deviceId] === paneId;
      if (!this.clientWantsPaneOutput(client, deviceId, paneId)) {
        continue;
      }

      // 只有焦点 pane 参与 switch-barrier：barrier flush 会按事务 paneId 重编码缓冲，
      // 非焦点订阅 pane 的输出混入会被错误归属
      if (isFocused && switchBarrier.shouldBufferOutput(client, deviceId)) {
        switchBarrier.bufferOutput(client, deviceId, data);
        continue;
      }

      payloadBytes ??= wsBorsh.encodePayload(wsBorsh.schema.TermOutputSchema, {
        deviceId,
        paneId,
        encoding: 1,
        data,
      });
      if (this.sendChunked(client, wsBorsh.KIND_TERM_OUTPUT, payloadBytes)) {
        this.terminalOutputMetrics.recordRecipient(payloadBytes.length);
      }
    }
  }

  private broadcastClipboardWrite(deviceId: string, paneId: string, text: string): void {
    const entry = this.connections.get(deviceId);
    if (!entry) return;

    const payloadBytes = wsBorsh.encodePayload(wsBorsh.schema.ClipboardWriteSchema, {
      deviceId,
      paneId,
      text,
    });

    for (const client of entry.clients) {
      // canonical 客户端（fe 或下游桥接方）没有 legacy 选中态：原样下发，
      // 由消费端按当前选中 pane 与可见性裁决（payload 自带 pane 标识）。
      if (
        !entry.canonicalClients?.has(client) &&
        client.data.borshState.selectedPanes[deviceId] !== paneId
      ) {
        continue;
      }
      this.sendEnvelope(client, wsBorsh.KIND_CLIPBOARD_WRITE, payloadBytes);
    }
  }

  private broadcastTerminalHistory(
    deviceId: string,
    paneId: string,
    data: string,
    alternateScreen: boolean,
    modes: number
  ): void {
    const entry = this.connections.get(deviceId);
    if (!entry) return;

    const historyBytes = new TextEncoder().encode(data);
    let deliveryAttempts = 0;

    for (const client of entry.clients) {
      if (entry.canonicalClients?.has(client)) continue;
      // 优先按进行中的 barrier 事务路由 history，而非 selectedPanes。
      // split 翻转后前端 focusPane 把 selectedPanes 改为新 pane，但旧 pane 的 barrier
      // 事务仍卡在 ACKED：按事务 context.paneId 路由才能让 barrier history 正确投递。
      const txPaneId = switchBarrier.getTransactionPaneId(client as any, deviceId);
      if (txPaneId !== null && txPaneId === paneId) {
        switchBarrier.sendTermHistory(
          client as any,
          deviceId,
          paneId,
          historyBytes,
          alternateScreen,
          modes
        );
        deliveryAttempts += 1;
        continue;
      }

      if (client.data.borshState.selectedPanes[deviceId] === paneId) {
        switchBarrier.sendTermHistory(
          client as any,
          deviceId,
          paneId,
          historyBytes,
          alternateScreen,
          modes
        );
        deliveryAttempts += 1;
      }
    }
    this.gatewayActivityMetrics.recordTerminalHistory(historyBytes.length, deliveryAttempts);
  }

  private broadcastError(deviceId: string, err: Error): void {
    const entry = this.connections.get(deviceId);
    if (!entry) return;

    const errorInfo = classifySshError(err);

    const payloadBytes = wsBorsh.encodeDeviceEventPayload({
      deviceId,
      type: 'error',
      errorType: errorInfo.type,
      message: t(errorInfo.messageKey, { ...errorInfo.messageParams }),
      rawMessage: err.message,
    });

    for (const client of entry.clients) {
      this.sendEnvelope(client, wsBorsh.KIND_DEVICE_EVENT, payloadBytes);
    }
  }

  broadcastDeviceError(deviceId: string, payload: EventDevicePayload): void {
    const entry = this.connections.get(deviceId);
    if (!entry) return;

    const payloadBytes = wsBorsh.encodeDeviceEventPayload(payload);
    for (const client of entry.clients) {
      this.sendEnvelope(client, wsBorsh.KIND_DEVICE_EVENT, payloadBytes);
    }
  }

  private broadcastDeviceEvent(entry: DeviceConnectionEntry, payload: EventDevicePayload): void {
    const payloadBytes = wsBorsh.encodeDeviceEventPayload(payload);

    for (const client of entry.clients) {
      this.sendEnvelope(client, wsBorsh.KIND_DEVICE_EVENT, payloadBytes);
    }
  }

  private async handleConnectionClose(deviceId: string): Promise<void> {
    const entry = this.connections.get(deviceId);
    if (!entry) {
      return;
    }

    this.clearSnapshotTimer(entry);
    this.clearSnapshotPollTimer(entry);
    entry.detachRuntime?.();
    entry.detachRuntime = null;
    const closedRuntime = entry.runtime;
    void this.deps.releaseRuntime(deviceId, closedRuntime);

    const { sshReconnectMaxRetries, sshReconnectDelaySeconds } = getSiteSettings();

    if (this.entryHasClients(entry) && entry.reconnectAttempts < sshReconnectMaxRetries) {
      entry.reconnectAttempts += 1;
      const delay = Math.max(1, sshReconnectDelaySeconds) * 1000;

      const notifying: EventDevicePayload = {
        deviceId,
        type: 'error',
        errorType: 'reconnecting',
        message: t('sshError.reconnecting', {
          delay: delay / 1000,
          attempt: entry.reconnectAttempts,
          maxRetries: sshReconnectMaxRetries,
        }),
      };
      this.broadcastDeviceEvent(entry, notifying);

      this.clearReconnectTimer(entry);
      entry.reconnectTimer = setTimeout(async () => {
        entry.reconnectTimer = null;

        const current = this.connections.get(deviceId);
        if (!current || current !== entry || !this.entryHasClients(entry)) {
          return;
        }

        const retryClient =
          Array.from(entry.clients)[0] ?? Array.from(entry.canonicalClients ?? [])[0];
        if (!retryClient) return;
        const retryConnection = await this.createDeviceConnectionEntry(deviceId, retryClient);
        if (!retryConnection) {
          if (entry.reconnectAttempts < sshReconnectMaxRetries) {
            await this.handleConnectionClose(deviceId);
            return;
          }

          const finalEvent: EventDevicePayload = {
            deviceId,
            type: 'error',
            errorType: 'reconnect_failed',
            message: t('sshError.reconnectFailed'),
          };
          this.broadcastDeviceEvent(entry, finalEvent);
          return;
        }

        retryConnection.clients = entry.clients;
        retryConnection.canonicalClients = entry.canonicalClients ?? new Set();
        retryConnection.reconnectAttempts = entry.reconnectAttempts;
        this.connections.set(deviceId, retryConnection);

        for (const client of retryConnection.canonicalClients) {
          await this.canonicalSessions.get(client)?.attachDevice(deviceId, retryConnection.runtime);
        }

        const reconnected: EventDevicePayload = {
          deviceId,
          type: 'reconnected',
          message: t('sshError.reconnected'),
        };
        this.broadcastDeviceEvent(retryConnection, reconnected);

        retryConnection.runtime.requestSnapshot();
      }, delay);

      return;
    }

    const disconnected: EventDevicePayload = {
      deviceId,
      type: 'disconnected',
    };
    this.broadcastDeviceEvent(entry, disconnected);

    for (const client of entry.clients) {
      delete client.data.borshState.selectedPanes[deviceId];
    }
    for (const client of entry.canonicalClients ?? []) {
      this.canonicalSessions.get(client)?.detachDevice(deviceId);
    }

    this.clearReconnectTimer(entry);
    this.connections.delete(deviceId);
  }
}
