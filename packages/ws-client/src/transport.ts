import {
  type EventDevicePayload,
  type EventTmuxPayload,
  type StateSnapshotPayload,
  wsBorsh,
} from '@tmex/shared';
import type { BorshWebSocketClient, ConnectionState } from './client';
import {
  type MovePanePosition,
  buildDeviceConnect,
  buildDeviceDisconnect,
  buildTermInput,
  buildTermPaste,
  buildTermResize,
  buildTermSyncSize,
  buildTmuxApplyStackedLayout,
  buildTmuxBreakPane,
  buildTmuxClosePane,
  buildTmuxCloseWindow,
  buildTmuxCreateWindow,
  buildTmuxFetchPaneHistory,
  buildTmuxFocusPane,
  buildTmuxMovePane,
  buildTmuxRenamePane,
  buildTmuxRenameWindow,
  buildTmuxReorderPanes,
  buildTmuxReorderWindows,
  buildTmuxResizePane,
  buildTmuxSelect,
  buildTmuxSelectWindow,
  buildTmuxSetWindowStyle,
  buildTmuxSplitPane,
  buildTmuxSubscribePanes,
} from './message-builder';

export interface GatewayTerminalCursor {
  paneEpoch: Uint8Array;
  terminalSeq: bigint;
}

export interface GatewayHistoryCursor {
  paneEpoch: Uint8Array;
  historyEpoch: Uint8Array;
  beforeLine: number;
}

export interface GatewayPaneScreenSnapshot {
  requestId?: Uint8Array;
  deviceId: string;
  paneId: string;
  paneEpoch: Uint8Array;
  baseSeq: bigint;
  rows: number;
  cols: number;
  modes: number;
  data: Uint8Array;
  historyCursor: GatewayHistoryCursor | null;
}

export interface GatewayPaneHistoryPage {
  requestId?: Uint8Array;
  deviceId: string;
  paneId: string;
  paneEpoch: Uint8Array;
  historyEpoch: Uint8Array;
  lineStart: number;
  lineEnd: number;
  truncated: boolean;
  data: Uint8Array;
  nextCursor: GatewayHistoryCursor | null;
}

export interface GatewayTerminalData {
  deviceId: string;
  paneId: string;
  data: Uint8Array;
  paneEpoch?: Uint8Array;
  seqStart?: bigint;
  seqEnd?: bigint;
}

export type GatewayRebaseReason =
  | 'metadata_gap'
  | 'pane_gap'
  | 'epoch_changed'
  | 'cache_evicted'
  | 'resource_exhausted';

export type GatewayTransportEvent =
  | { type: 'connection-state'; state: ConnectionState }
  | { type: 'latency'; latencyMs: number }
  | { type: 'terminal-progress'; deviceId?: string }
  | { type: 'device-connected'; deviceId: string }
  | { type: 'window-created'; deviceId: string; windowId: string }
  | { type: 'device-disconnected'; deviceId: string }
  | { type: 'device-event'; event: EventDevicePayload }
  | { type: 'metadata-snapshot'; snapshot: StateSnapshotPayload }
  | {
      type: 'metadata-patch';
      deviceId: string;
      patch: wsBorsh.LegacyStateSnapshotDiff;
    }
  | { type: 'tmux-event'; event: EventTmuxPayload }
  | { type: 'selection-ack'; deviceId: string; selectToken: Uint8Array }
  | {
      type: 'legacy-history';
      deviceId: string;
      paneId: string;
      selectToken: Uint8Array;
      data: string;
      alternateScreen: boolean;
      modes: number;
    }
  | { type: 'live-resume'; deviceId: string; selectToken: Uint8Array }
  | { type: 'terminal-data'; frame: GatewayTerminalData }
  | { type: 'screen-snapshot'; snapshot: GatewayPaneScreenSnapshot }
  | { type: 'history-page'; page: GatewayPaneHistoryPage }
  | {
      type: 'subscription-applied';
      deviceId: string;
      generation: bigint;
      paneIds: readonly string[];
      rejectedPaneIds: readonly string[];
    }
  | {
      type: 'rebase-required';
      deviceId?: string;
      paneId?: string;
      reason: GatewayRebaseReason;
    }
  | { type: 'clipboard-write'; deviceId: string; paneId: string; text: string }
  | { type: 'site-theme-update'; theme: 'dark' | 'light' }
  | { type: 'transport-error'; error: Error };

export type GatewayTransportCommand =
  | { type: 'connect-device'; deviceId: string }
  | { type: 'disconnect-device'; deviceId: string }
  | {
      type: 'select-pane';
      deviceId: string;
      windowId: string;
      paneId: string;
      selectToken: Uint8Array;
      wantHistory: boolean;
      cols?: number;
      rows?: number;
    }
  | { type: 'select-window'; deviceId: string; windowId: string }
  | {
      type: 'terminal-input';
      deviceId: string;
      paneId: string;
      data: string;
      isComposing: boolean;
    }
  | { type: 'terminal-paste'; deviceId: string; paneId: string; data: string }
  | { type: 'terminal-resize'; deviceId: string; paneId: string; cols: number; rows: number }
  | { type: 'terminal-sync-size'; deviceId: string; paneId: string; cols: number; rows: number }
  | { type: 'create-window'; deviceId: string; name?: string; cwd?: string }
  | { type: 'close-window'; deviceId: string; windowId: string }
  | { type: 'close-pane'; deviceId: string; paneId: string }
  | { type: 'rename-window'; deviceId: string; windowId: string; name: string }
  | { type: 'set-window-style'; deviceId: string; style: string }
  | { type: 'reorder-windows'; deviceId: string; windowIds: string[] }
  | {
      type: 'set-pane-subscriptions';
      deviceId: string;
      generation: bigint;
      paneIds: string[];
    }
  | {
      type: 'request-pane-screen';
      requestId: Uint8Array;
      deviceId: string;
      paneId: string;
      byteLimit: number;
    }
  | {
      type: 'request-pane-history';
      requestId: Uint8Array;
      deviceId: string;
      paneId: string;
      cursor: GatewayHistoryCursor | null;
      byteLimit: number;
    }
  | {
      type: 'resize-pane-in-window';
      deviceId: string;
      paneId: string;
      cols?: number;
      rows?: number;
    }
  | { type: 'apply-stacked-layout'; deviceId: string; windowId: string; cols: number; rows: number }
  | {
      type: 'split-pane';
      deviceId: string;
      paneId: string;
      direction: 'right' | 'down';
      cwd?: string;
    }
  | { type: 'focus-pane'; deviceId: string; windowId: string; paneId: string }
  | { type: 'rename-pane'; deviceId: string; paneId: string; name: string }
  | {
      type: 'move-pane';
      deviceId: string;
      srcPaneId: string;
      dstPaneId: string;
      position: MovePanePosition;
    }
  | { type: 'break-pane'; deviceId: string; paneId: string }
  | { type: 'reorder-panes'; deviceId: string; windowId: string; paneIds: string[] };

export interface GatewayTransportCapabilities {
  sequencedTerminal: boolean;
  atomicScreen: boolean;
  cursorHistory: boolean;
  // select-pane / select-window / focus-pane 是否真正驱动服务端（tmux）的 active 状态。
  // 为 false 时 selection 是纯本地语义，消费方不得再拿快照里的 tmux active 反向改写
  // 本地路由，否则本地选择会被服务端 active 弹回。
  serverSelection: boolean;
}

export type GatewayTransportSourceRoute = 'gateway' | 'local' | 'relay' | 'unknown';

export interface GatewayTransport {
  readonly kind: 'websocket' | 'shared';
  readonly sourceRoute: GatewayTransportSourceRoute;
  readonly capabilities: GatewayTransportCapabilities;
  readonly hasConnectedOnce: boolean;
  readonly latencyMs: number | null;
  readonly serverCapabilities: readonly string[];
  connect(): void;
  disconnect(): void;
  dispose(): void;
  getState(): ConnectionState;
  isReady(): boolean;
  send(command: GatewayTransportCommand): boolean;
  onEvent(handler: (event: GatewayTransportEvent) => void): () => void;
}

export function encodeGatewayTransportCommand(command: GatewayTransportCommand): {
  kind: number;
  payload: Uint8Array;
} {
  switch (command.type) {
    case 'connect-device':
      return buildDeviceConnect(command.deviceId);
    case 'disconnect-device':
      return buildDeviceDisconnect(command.deviceId);
    case 'select-pane':
      return buildTmuxSelect(command);
    case 'select-window':
      return buildTmuxSelectWindow(command.deviceId, command.windowId);
    case 'terminal-input':
      return buildTermInput(command.deviceId, command.paneId, command.data, command.isComposing);
    case 'terminal-paste':
      return buildTermPaste(command.deviceId, command.paneId, command.data);
    case 'terminal-resize':
      return buildTermResize(command.deviceId, command.paneId, command.cols, command.rows);
    case 'terminal-sync-size':
      return buildTermSyncSize(command.deviceId, command.paneId, command.cols, command.rows);
    case 'create-window':
      return buildTmuxCreateWindow(command.deviceId, command.name, command.cwd);
    case 'close-window':
      return buildTmuxCloseWindow(command.deviceId, command.windowId);
    case 'close-pane':
      return buildTmuxClosePane(command.deviceId, command.paneId);
    case 'rename-window':
      return buildTmuxRenameWindow(command.deviceId, command.windowId, command.name);
    case 'set-window-style':
      return buildTmuxSetWindowStyle(command.deviceId, command.style);
    case 'reorder-windows':
      return buildTmuxReorderWindows(command.deviceId, command.windowIds);
    case 'set-pane-subscriptions':
      return buildTmuxSubscribePanes(command.deviceId, command.paneIds);
    case 'request-pane-screen':
      return buildTmuxFetchPaneHistory(command.deviceId, command.paneId, command.requestId);
    case 'request-pane-history':
      return buildTmuxFetchPaneHistory(command.deviceId, command.paneId, command.requestId);
    case 'resize-pane-in-window':
      return buildTmuxResizePane(command.deviceId, command.paneId, {
        cols: command.cols,
        rows: command.rows,
      });
    case 'apply-stacked-layout':
      return buildTmuxApplyStackedLayout(
        command.deviceId,
        command.windowId,
        command.cols,
        command.rows
      );
    case 'split-pane':
      return buildTmuxSplitPane(command.deviceId, command.paneId, command.direction, command.cwd);
    case 'focus-pane':
      return buildTmuxFocusPane(command.deviceId, command.windowId, command.paneId);
    case 'rename-pane':
      return buildTmuxRenamePane(command.deviceId, command.paneId, command.name);
    case 'move-pane':
      return buildTmuxMovePane(
        command.deviceId,
        command.srcPaneId,
        command.dstPaneId,
        command.position
      );
    case 'break-pane':
      return buildTmuxBreakPane(command.deviceId, command.paneId);
    case 'reorder-panes':
      return buildTmuxReorderPanes(command.deviceId, command.windowId, command.paneIds);
  }
}

export class WebSocketGatewayTransport implements GatewayTransport {
  readonly kind = 'websocket' as const;
  readonly sourceRoute = 'gateway' as const;
  readonly capabilities: GatewayTransportCapabilities = {
    sequencedTerminal: false,
    atomicScreen: false,
    cursorHistory: false,
    serverSelection: true,
  };

  private readonly handlers = new Set<(event: GatewayTransportEvent) => void>();
  private readonly disposers: Array<() => void>;

  constructor(readonly client: BorshWebSocketClient) {
    this.disposers = [
      client.onStateChange((state) => this.emit({ type: 'connection-state', state })),
      client.onLatency((latencyMs) => this.emit({ type: 'latency', latencyMs })),
      client.onChunkProgress(({ originalKind }) => {
        if (
          originalKind === wsBorsh.KIND_TERM_HISTORY ||
          originalKind === wsBorsh.KIND_TERM_OUTPUT
        ) {
          this.emit({ type: 'terminal-progress' });
        }
      }),
      client.onMessage((message) => this.handleMessage(message.kind, message.payload)),
      client.onError((error) => this.emit({ type: 'transport-error', error })),
    ];
  }

  get hasConnectedOnce(): boolean {
    return this.client.hasConnectedOnce;
  }

  get latencyMs(): number | null {
    return this.client.latencyMs;
  }

  get serverCapabilities(): readonly string[] {
    return this.client.serverCapabilities;
  }

  connect(): void {
    this.client.connect();
  }

  disconnect(): void {
    this.client.disconnect();
  }

  dispose(): void {
    for (const dispose of this.disposers.splice(0)) dispose();
    this.handlers.clear();
  }

  getState(): ConnectionState {
    return this.client.getState();
  }

  isReady(): boolean {
    return this.client.isReady();
  }

  send(command: GatewayTransportCommand): boolean {
    const message = encodeGatewayTransportCommand(command);
    return this.client.send(message.kind, message.payload);
  }

  onEvent(handler: (event: GatewayTransportEvent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  private emit(event: GatewayTransportEvent): void {
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch (error) {
        console.error('[gateway-transport] event handler failed:', error);
      }
    }
  }

  private handleMessage(kind: number, payload: Uint8Array): void {
    switch (kind) {
      case wsBorsh.KIND_DEVICE_CONNECTED: {
        const decoded = wsBorsh.decodePayload(wsBorsh.schema.DeviceConnectedSchema, payload);
        this.emit({ type: 'device-connected', deviceId: decoded.deviceId });
        return;
      }
      case wsBorsh.KIND_TMUX_WINDOW_CREATED: {
        const decoded = wsBorsh.decodePayload(wsBorsh.schema.TmuxWindowCreatedSchema, payload);
        this.emit({
          type: 'window-created',
          deviceId: decoded.deviceId,
          windowId: decoded.windowId,
        });
        return;
      }
      case wsBorsh.KIND_DEVICE_DISCONNECTED: {
        const decoded = wsBorsh.decodePayload(wsBorsh.schema.DeviceDisconnectedSchema, payload);
        this.emit({ type: 'device-disconnected', deviceId: decoded.deviceId });
        return;
      }
      case wsBorsh.KIND_DEVICE_EVENT:
        this.emit({ type: 'device-event', event: wsBorsh.decodeDeviceEventPayload(payload) });
        return;
      case wsBorsh.KIND_STATE_SNAPSHOT:
        this.emit({ type: 'metadata-snapshot', snapshot: wsBorsh.decodeStateSnapshot(payload) });
        return;
      case wsBorsh.KIND_STATE_SNAPSHOT_DIFF: {
        const decoded = wsBorsh.decodePayload(wsBorsh.schema.StateSnapshotDiffSchema, payload);
        if (decoded.diffFormat !== wsBorsh.STATE_SNAPSHOT_DIFF_FORMAT_ABSOLUTE_JSON) return;
        this.emit({
          type: 'metadata-patch',
          deviceId: decoded.deviceId,
          patch: wsBorsh.decodeLegacyStateSnapshotDiff(decoded.diffBytes),
        });
        return;
      }
      case wsBorsh.KIND_TMUX_EVENT:
        this.emit({ type: 'tmux-event', event: wsBorsh.decodeTmuxEventPayload(payload) });
        return;
      case wsBorsh.KIND_SWITCH_ACK: {
        const decoded = wsBorsh.decodePayload(wsBorsh.schema.SwitchAckSchema, payload);
        this.emit({
          type: 'selection-ack',
          deviceId: decoded.deviceId,
          selectToken: decoded.selectToken,
        });
        return;
      }
      case wsBorsh.KIND_TERM_HISTORY: {
        const decoded = wsBorsh.decodePayload(wsBorsh.schema.TermHistorySchema, payload);
        this.emit({
          type: 'legacy-history',
          deviceId: decoded.deviceId,
          paneId: decoded.paneId,
          selectToken: decoded.selectToken,
          data: new TextDecoder().decode(decoded.data),
          alternateScreen: decoded.alternateScreen,
          modes: decoded.modes,
        });
        return;
      }
      case wsBorsh.KIND_LIVE_RESUME: {
        const decoded = wsBorsh.decodePayload(wsBorsh.schema.LiveResumeSchema, payload);
        this.emit({
          type: 'live-resume',
          deviceId: decoded.deviceId,
          selectToken: decoded.selectToken,
        });
        return;
      }
      case wsBorsh.KIND_TERM_OUTPUT: {
        const decoded = wsBorsh.decodePayload(wsBorsh.schema.TermOutputSchema, payload);
        this.emit({
          type: 'terminal-data',
          frame: { deviceId: decoded.deviceId, paneId: decoded.paneId, data: decoded.data },
        });
        return;
      }
      case wsBorsh.KIND_CLIPBOARD_WRITE: {
        const decoded = wsBorsh.decodePayload(wsBorsh.schema.ClipboardWriteSchema, payload);
        this.emit({
          type: 'clipboard-write',
          deviceId: decoded.deviceId,
          paneId: decoded.paneId,
          text: decoded.text,
        });
        return;
      }
      case wsBorsh.KIND_SITE_THEME_UPDATE: {
        const decoded = wsBorsh.decodePayload(wsBorsh.schema.SiteThemeUpdateS2CSchema, payload);
        this.emit({
          type: 'site-theme-update',
          theme: decoded.theme === wsBorsh.SITE_THEME_LIGHT ? 'light' : 'dark',
        });
        return;
      }
      case wsBorsh.KIND_ERROR: {
        const decoded = wsBorsh.decodePayload(wsBorsh.schema.ErrorSchema, payload);
        this.emit({ type: 'transport-error', error: new Error(decoded.message) });
      }
    }
  }
}

export class LazyWebSocketGatewayTransport implements GatewayTransport {
  readonly kind = 'websocket' as const;
  readonly sourceRoute = 'gateway' as const;
  readonly capabilities: GatewayTransportCapabilities = {
    sequencedTerminal: false,
    atomicScreen: false,
    cursorHistory: false,
    serverSelection: true,
  };

  private delegateTransport: WebSocketGatewayTransport | null = null;

  constructor(private readonly resolveClient: () => BorshWebSocketClient) {}

  get hasConnectedOnce(): boolean {
    return this.delegate().hasConnectedOnce;
  }

  get latencyMs(): number | null {
    return this.delegate().latencyMs;
  }

  get serverCapabilities(): readonly string[] {
    return this.delegate().serverCapabilities;
  }

  connect(): void {
    this.delegate().connect();
  }

  disconnect(): void {
    this.delegateTransport?.disconnect();
  }

  dispose(): void {
    this.delegateTransport?.dispose();
    this.delegateTransport = null;
  }

  getState(): ConnectionState {
    return this.delegate().getState();
  }

  isReady(): boolean {
    return this.delegate().isReady();
  }

  send(command: GatewayTransportCommand): boolean {
    return this.delegate().send(command);
  }

  onEvent(handler: (event: GatewayTransportEvent) => void): () => void {
    return this.delegate().onEvent(handler);
  }

  private delegate(): WebSocketGatewayTransport {
    this.delegateTransport ??= new WebSocketGatewayTransport(this.resolveClient());
    return this.delegateTransport;
  }
}

export interface SharedGatewayTransportOptions {
  initialState?: ConnectionState;
  sourceRoute?: GatewayTransportSourceRoute;
  serverCapabilities?: readonly string[];
  serverSelection?: boolean;
  onConnect?: () => void;
  onDisconnect?: () => void;
  // biome-ignore lint/suspicious/noConfusingVoidType: void accepts fire-and-forget owners; false is the explicit rejection signal
  onCommand: (command: GatewayTransportCommand) => boolean | void;
}

export interface SharedGatewayTransport extends GatewayTransport {
  readonly kind: 'shared';
  publish(event: GatewayTransportEvent): void;
}

export function createSharedGatewayTransport(
  options: SharedGatewayTransportOptions
): SharedGatewayTransport {
  let state = options.initialState ?? 'IDLE';
  let connectedOnce = state === 'READY';
  let latencyMs: number | null = null;
  let disposed = false;
  let connectRequested = false;
  const handlers = new Set<(event: GatewayTransportEvent) => void>();

  const publish = (event: GatewayTransportEvent): void => {
    if (disposed) return;
    if (event.type === 'connection-state') {
      state = event.state;
      if (state === 'READY') connectedOnce = true;
      if (state !== 'READY') latencyMs = null;
    } else if (event.type === 'latency') {
      latencyMs = event.latencyMs;
    }
    for (const handler of handlers) {
      try {
        handler(event);
      } catch (error) {
        console.error('[shared-gateway-transport] event handler failed:', error);
      }
    }
  };

  return {
    kind: 'shared',
    sourceRoute: options.sourceRoute ?? 'unknown',
    capabilities: {
      sequencedTerminal: true,
      atomicScreen: true,
      cursorHistory: true,
      serverSelection: options.serverSelection ?? true,
    },
    get hasConnectedOnce() {
      return connectedOnce;
    },
    get latencyMs() {
      return latencyMs;
    },
    serverCapabilities: options.serverCapabilities ?? [],
    connect() {
      if (disposed || state === 'READY' || state === 'WS_CONNECTING') return;
      connectRequested = true;
      publish({ type: 'connection-state', state: 'WS_CONNECTING' });
      options.onConnect?.();
    },
    disconnect() {
      if (disposed || state === 'CLOSED') return;
      if (connectRequested || state === 'READY') options.onDisconnect?.();
      connectRequested = false;
      publish({ type: 'connection-state', state: 'CLOSED' });
    },
    dispose() {
      if (disposed) return;
      if (connectRequested || state === 'READY') options.onDisconnect?.();
      connectRequested = false;
      disposed = true;
      state = 'CLOSED';
      handlers.clear();
    },
    getState: () => state,
    isReady: () => state === 'READY',
    send(command) {
      if (disposed) return false;
      return options.onCommand(command) !== false;
    },
    onEvent(handler) {
      if (disposed) return () => {};
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    publish,
  };
}
