import { getTmuxWindowStyle } from '@/components/terminal/theme';
import { navigateToAppUrl } from '@/lib/app-navigation';
import { getBorshClient } from '@/ws-borsh';
import {
  buildDeviceConnect,
  buildDeviceDisconnect,
  buildTermInput,
  buildTermPaste,
  buildTermResize,
  buildTermSyncSize,
  buildTmuxClosePane,
  buildTmuxCloseWindow,
  buildTmuxCreateWindow,
  buildTmuxRenameWindow,
  buildTmuxReorderPanes,
  buildTmuxReorderWindows,
  buildTmuxSelect,
  buildTmuxSelectWindow,
  buildTmuxSetWindowStyle,
  generateSelectToken,
} from '@/ws-borsh';
import { getSelectStateMachine } from '@/ws-borsh';
import type { EventDevicePayload, EventTmuxPayload, StateSnapshotPayload } from '@tmex/shared';
import { wsBorsh } from '@tmex/shared';
import { toast } from 'sonner';
import { create } from 'zustand';
import { useSiteStore } from './site';
import { formatTerminalNotificationToast } from './tmux-notification-format';
import { useUIStore } from './ui';

type SnapshotMap = Record<string, StateSnapshotPayload | undefined>;

interface DeviceError {
  message: string;
  type: string;
  rawMessage?: string;
  at: number;
}

interface DeviceReconnecting {
  message: string;
  at: number;
}

export interface DeviceInitialErrorInput {
  deviceId: string;
  lastError: string | null;
  lastErrorType: string | null;
}

interface TmuxState {
  socketReady: boolean;
  snapshots: SnapshotMap;
  connectedDevices: Set<string>;
  deviceConnected: Record<string, boolean | undefined>;
  deviceErrors: Record<string, DeviceError | undefined>;
  deviceReconnecting: Record<string, DeviceReconnecting | undefined>;
  selectedPanes: Record<string, { windowId: string; paneId: string } | undefined>;
  activePaneFromEvent: Record<string, { windowId: string; paneId: string } | undefined>;
  pendingCreateWindowAt: Record<string, number | undefined>;

  ensureSocketConnected: () => void;
  connectDevice: (deviceId: string) => void;
  disconnectDevice: (deviceId: string) => void;
  clearDeviceError: (deviceId: string) => void;
  hydrateDeviceErrors: (entries: DeviceInitialErrorInput[]) => void;
  selectPane: (
    deviceId: string,
    windowId: string,
    paneId: string,
    size?: { cols?: number; rows?: number }
  ) => void;
  selectWindow: (deviceId: string, windowId: string) => void;
  sendInput: (deviceId: string, paneId: string, data: string, isComposing?: boolean) => void;
  resizePane: (deviceId: string, paneId: string, cols: number, rows: number) => void;
  syncPaneSize: (deviceId: string, paneId: string, cols: number, rows: number) => void;
  paste: (deviceId: string, paneId: string, data: string) => void;
  createWindow: (deviceId: string, name?: string) => void;
  clearPendingCreateWindow: (deviceId: string) => void;
  closeWindow: (deviceId: string, windowId: string) => void;
  closePane: (deviceId: string, paneId: string) => void;
  renameWindow: (deviceId: string, windowId: string, name: string) => void;
  reorderWindows: (deviceId: string, windowIds: string[]) => void;
  reorderPanes: (deviceId: string, windowId: string, paneIds: string[]) => void;
}

const CONNECT_DEDUP_WINDOW_MS = 500;
const lastConnectSentAt = new Map<string, number>();

const lastReportedTerminalSizes = new Map<string, { cols: number; rows: number; at: number }>();

function shouldSkipDuplicateConnect(deviceId: string): boolean {
  const now = Date.now();
  const last = lastConnectSentAt.get(deviceId);
  if (last !== undefined && now - last < CONNECT_DEDUP_WINDOW_MS) {
    return true;
  }
  lastConnectSentAt.set(deviceId, now);
  return false;
}

let initialized = false;

// gateway 连接设备时按 TMEX_TMUX_WINDOW_STYLE 注入默认（暗色）window-style，
// 这里在设备连上/重连/主题切换时按前端当前主题覆盖，保持 tmux 代答的 OSC 10/11 颜色一致。
function sendWindowStyleForCurrentTheme(deviceId: string): void {
  const style = getTmuxWindowStyle(useUIStore.getState().theme);
  const msg = buildTmuxSetWindowStyle(deviceId, style);
  getBorshClient().send(msg.kind, msg.payload);
}

function normalizeTerminalSize(
  cols: number | undefined,
  rows: number | undefined
): { cols: number; rows: number } | null {
  if (typeof cols !== 'number' || typeof rows !== 'number') {
    return null;
  }

  const safeCols = Math.max(2, Math.floor(cols));
  const safeRows = Math.max(2, Math.floor(rows));
  return { cols: safeCols, rows: safeRows };
}

function setupClientHandlers(
  setState: (partial: Partial<TmuxState> | ((prev: TmuxState) => Partial<TmuxState>)) => void,
  getState: () => TmuxState
): void {
  if (initialized) return;
  initialized = true;

  const client = getBorshClient();

  const maybeReselectCurrentPane = (deviceId: string): void => {
    const current = getState().selectedPanes[deviceId];
    if (!current) return;

    const sm = getSelectStateMachine();
    if (sm.getTransaction(deviceId)) {
      return;
    }

    getState().selectPane(deviceId, current.windowId, current.paneId);
  };

  client.onStateChange((state) => {
    setState({ socketReady: state === 'READY' });
  });

  client.onMessage((msg) => {
    const sm = getSelectStateMachine();

    switch (msg.kind) {
      case wsBorsh.KIND_DEVICE_CONNECTED: {
        const decoded = wsBorsh.decodePayload(wsBorsh.schema.DeviceConnectedSchema, msg.payload);
        setState((prev) => ({
          deviceConnected: { ...prev.deviceConnected, [decoded.deviceId]: true },
          deviceErrors: { ...prev.deviceErrors, [decoded.deviceId]: undefined },
          deviceReconnecting: { ...prev.deviceReconnecting, [decoded.deviceId]: undefined },
        }));
        sendWindowStyleForCurrentTheme(decoded.deviceId);
        maybeReselectCurrentPane(decoded.deviceId);
        return;
      }

      case wsBorsh.KIND_DEVICE_DISCONNECTED: {
        const decoded = wsBorsh.decodePayload(wsBorsh.schema.DeviceDisconnectedSchema, msg.payload);
        sm.cleanup(decoded.deviceId);
        setState((prev) => ({
          deviceConnected: { ...prev.deviceConnected, [decoded.deviceId]: false },
        }));
        return;
      }

      case wsBorsh.KIND_DEVICE_EVENT: {
        const payload = wsBorsh.decodeDeviceEventPayload(msg.payload);
        handleDeviceEvent(setState, payload);
        if (payload.type === 'reconnected') {
          sendWindowStyleForCurrentTheme(payload.deviceId);
          maybeReselectCurrentPane(payload.deviceId);
        }
        return;
      }

      case wsBorsh.KIND_STATE_SNAPSHOT: {
        const payload = wsBorsh.decodeStateSnapshot(msg.payload);
        setState((prev) => ({
          snapshots: { ...prev.snapshots, [payload.deviceId]: payload },
        }));
        return;
      }

      case wsBorsh.KIND_TMUX_EVENT: {
        const payload = wsBorsh.decodeTmuxEventPayload(msg.payload);
        handleTmuxEvent(setState, payload);
        return;
      }

      case wsBorsh.KIND_SWITCH_ACK: {
        const decoded = wsBorsh.decodePayload(wsBorsh.schema.SwitchAckSchema, msg.payload);
        sm.dispatch({
          type: 'SWITCH_ACK',
          deviceId: decoded.deviceId,
          selectToken: decoded.selectToken,
        });
        return;
      }

      case wsBorsh.KIND_TERM_HISTORY: {
        const decoded = wsBorsh.decodePayload(wsBorsh.schema.TermHistorySchema, msg.payload);
        const text = new TextDecoder().decode(decoded.data);
        sm.dispatch({
          type: 'HISTORY',
          deviceId: decoded.deviceId,
          selectToken: decoded.selectToken,
          data: text,
          alternateScreen: decoded.alternateScreen,
        });
        return;
      }

      case wsBorsh.KIND_LIVE_RESUME: {
        const decoded = wsBorsh.decodePayload(wsBorsh.schema.LiveResumeSchema, msg.payload);
        sm.dispatch({
          type: 'LIVE_RESUME',
          deviceId: decoded.deviceId,
          selectToken: decoded.selectToken,
        });
        return;
      }

      case wsBorsh.KIND_TERM_OUTPUT: {
        const decoded = wsBorsh.decodePayload(wsBorsh.schema.TermOutputSchema, msg.payload);
        sm.dispatch({
          type: 'OUTPUT',
          deviceId: decoded.deviceId,
          paneId: decoded.paneId,
          data: decoded.data,
        });
        return;
      }

      case wsBorsh.KIND_CLIPBOARD_WRITE: {
        const decoded = wsBorsh.decodePayload(
          wsBorsh.schema.ClipboardWriteSchema,
          msg.payload
        );
        if (document.visibilityState !== 'visible') {
          return;
        }
        const current = getState().selectedPanes[decoded.deviceId];
        if (!current || current.paneId !== decoded.paneId) {
          return;
        }
        navigator.clipboard.writeText(decoded.text).catch((err) => {
          console.warn('[tmux] clipboard write failed:', err);
        });
        return;
      }

      case wsBorsh.KIND_ERROR: {
        // 连接级错误不一定需要 toast；保留给上层需要时再做
        return;
      }
    }
  });

  client.onError((error) => {
    console.error('[tmux] borsh ws error:', error);
    setState({ socketReady: false });
    toast.error('WebSocket Connection Error', {
      description: 'Please check Gateway status',
    });
  });

  // 首次 READY 后补发 connect（避免重连后丢失连接）
  client.onStateChange((state) => {
    if (state !== 'READY') return;
    const connectedDevices = getState().connectedDevices;
    for (const deviceId of connectedDevices) {
      if (shouldSkipDuplicateConnect(deviceId)) continue;
      const msg = buildDeviceConnect(deviceId);
      client.send(msg.kind, msg.payload);
    }
  });

  // 主题切换时同步所有已连接设备的 tmux window-style
  let lastTheme = useUIStore.getState().theme;
  useUIStore.subscribe((uiState) => {
    if (uiState.theme === lastTheme) return;
    lastTheme = uiState.theme;
    const state = getState();
    for (const deviceId of state.connectedDevices) {
      if (state.deviceConnected[deviceId]) {
        sendWindowStyleForCurrentTheme(deviceId);
      }
    }
  });
}

function handleDeviceEvent(
  setState: (partial: Partial<TmuxState> | ((prev: TmuxState) => Partial<TmuxState>)) => void,
  payload: EventDevicePayload
): void {
  if (payload.type === 'error') {
    const summary = payload.message ?? 'Device Error';
    const errorType = payload.errorType ?? 'unknown';

    if (errorType === 'reconnecting') {
      setState((prev) => ({
        deviceReconnecting: {
          ...prev.deviceReconnecting,
          [payload.deviceId]: { message: summary, at: Date.now() },
        },
      }));
      return;
    }

    setState((prev) => {
      const previousError = prev.deviceErrors[payload.deviceId];
      const shouldToast = !previousError || previousError.type !== errorType;

      if (shouldToast) {
        toast.error(summary);
      }

      return {
        deviceErrors: {
          ...prev.deviceErrors,
          [payload.deviceId]: {
            message: summary,
            type: errorType,
            rawMessage: payload.rawMessage,
            at: Date.now(),
          },
        },
        deviceReconnecting: { ...prev.deviceReconnecting, [payload.deviceId]: undefined },
      };
    });

    return;
  }

  if (payload.type === 'disconnected') {
    getSelectStateMachine().cleanup(payload.deviceId);
    setState((prev) => ({
      deviceConnected: { ...prev.deviceConnected, [payload.deviceId]: false },
    }));
    return;
  }

  if (payload.type === 'reconnected') {
    setState((prev) => ({
      deviceConnected: { ...prev.deviceConnected, [payload.deviceId]: true },
      deviceErrors: { ...prev.deviceErrors, [payload.deviceId]: undefined },
      deviceReconnecting: { ...prev.deviceReconnecting, [payload.deviceId]: undefined },
    }));
  }
}

function handleTmuxEvent(
  setState: (partial: Partial<TmuxState> | ((prev: TmuxState) => Partial<TmuxState>)) => void,
  payload: EventTmuxPayload
): void {
  if (payload.type === 'bell') {
    console.log('[tmex] bell', payload.data);
    const settings = useSiteStore.getState().settings;
    if (settings?.enableBrowserBellToast === false) {
      return;
    }

    const data = (payload.data ?? {}) as Record<string, unknown>;
    const title = 'Terminal Bell';
    const description = [
      typeof data.windowIndex === 'number' ? `Window ${data.windowIndex}` : undefined,
      typeof data.paneIndex === 'number' ? `Pane ${data.paneIndex}` : undefined,
    ]
      .filter(Boolean)
      .join(' · ');
    const paneUrl = typeof data.paneUrl === 'string' ? data.paneUrl : undefined;
    toast(title, {
      description: description || 'Received tmux bell',
      action: paneUrl
        ? {
            label: 'Open',
            onClick: () => {
              navigateToAppUrl(paneUrl);
            },
          }
        : undefined,
    });
  }

  if (payload.type === 'notification') {
    console.log('[tmex] notification', payload.data);
    const settings = useSiteStore.getState().settings;
    if (settings?.enableBrowserNotificationToast === false) {
      return;
    }

    const data = (payload.data ?? {}) as Record<string, unknown>;
    const { title, description } = formatTerminalNotificationToast(data);
    const paneUrl = typeof data.paneUrl === 'string' ? data.paneUrl : undefined;
    toast(title, {
      description,
      action: paneUrl
        ? {
            label: 'Open',
            onClick: () => {
              navigateToAppUrl(paneUrl);
            },
          }
        : undefined,
    });
  }

  if (payload.type === 'pane-active') {
    const data = payload.data as { windowId: string; paneId: string } | undefined;
    if (data?.windowId && data?.paneId) {
      setState((prev) => ({
        activePaneFromEvent: {
          ...prev.activePaneFromEvent,
          [payload.deviceId]: { windowId: data.windowId, paneId: data.paneId },
        },
      }));
    }
  }
}

export const useTmuxStore = create<TmuxState>((set, get) => ({
  socketReady: false,
  snapshots: {},
  connectedDevices: new Set(),
  deviceConnected: {},
  deviceErrors: {},
  deviceReconnecting: {},
  selectedPanes: {},
  activePaneFromEvent: {},
  pendingCreateWindowAt: {},

  ensureSocketConnected() {
    setupClientHandlers(set, get);
    getBorshClient().connect();
  },

  connectDevice(deviceId) {
    if (!deviceId) return;

    set((prev) => {
      const nextConnected = new Set(prev.connectedDevices);
      nextConnected.add(deviceId);
      return { connectedDevices: nextConnected };
    });

    get().ensureSocketConnected();

    if (shouldSkipDuplicateConnect(deviceId)) return;
    const msg = buildDeviceConnect(deviceId);
    getBorshClient().send(msg.kind, msg.payload);
  },

  disconnectDevice(deviceId) {
    if (!deviceId) return;

    set((prev) => {
      const nextConnected = new Set(prev.connectedDevices);
      nextConnected.delete(deviceId);
      return { connectedDevices: nextConnected };
    });

    getSelectStateMachine().cleanup(deviceId);
    const msg = buildDeviceDisconnect(deviceId);
    getBorshClient().send(msg.kind, msg.payload);
  },

  clearDeviceError(deviceId) {
    set((prev) => ({
      deviceErrors: { ...prev.deviceErrors, [deviceId]: undefined },
      deviceReconnecting: { ...prev.deviceReconnecting, [deviceId]: undefined },
    }));
  },

  hydrateDeviceErrors(entries) {
    set((prev) => {
      const next: Record<string, DeviceError | undefined> = { ...prev.deviceErrors };
      for (const entry of entries) {
        if (next[entry.deviceId]) continue;
        if (!entry.lastError || !entry.lastErrorType) continue;
        next[entry.deviceId] = {
          message: entry.lastError,
          type: entry.lastErrorType,
          at: 0,
        };
      }
      return { deviceErrors: next };
    });
  },

  selectPane(deviceId, windowId, paneId, size) {
    if (!deviceId || !windowId || !paneId) return;

    set((prev) => ({
      selectedPanes: { ...prev.selectedPanes, [deviceId]: { windowId, paneId } },
    }));

    const selectToken = generateSelectToken();
    const wantHistory = true;

    getSelectStateMachine().dispatch({
      type: 'SELECT_START',
      deviceId,
      windowId,
      paneId,
      selectToken,
      wantHistory,
    });

    const normalizedSize =
      normalizeTerminalSize(size?.cols, size?.rows) ??
      lastReportedTerminalSizes.get(deviceId) ??
      null;

    const msg = buildTmuxSelect({
      deviceId,
      windowId,
      paneId,
      selectToken,
      wantHistory,
      cols: normalizedSize?.cols,
      rows: normalizedSize?.rows,
    });
    getBorshClient().send(msg.kind, msg.payload);
  },

  selectWindow(deviceId, windowId) {
    if (!deviceId || !windowId) return;
    const msg = buildTmuxSelectWindow(deviceId, windowId);
    getBorshClient().send(msg.kind, msg.payload);
  },

  sendInput(deviceId, paneId, data, isComposing = false) {
    if (!deviceId || !paneId) return;
    const msg = buildTermInput(deviceId, paneId, data, isComposing);
    getBorshClient().send(msg.kind, msg.payload);
  },

  resizePane(deviceId, paneId, cols, rows) {
    if (!deviceId || !paneId) return;
    const normalizedSize = normalizeTerminalSize(cols, rows);
    if (normalizedSize) {
      lastReportedTerminalSizes.set(deviceId, { ...normalizedSize, at: Date.now() });
    }
    const msg = buildTermResize(deviceId, paneId, cols, rows);
    getBorshClient().send(msg.kind, msg.payload);
  },

  syncPaneSize(deviceId, paneId, cols, rows) {
    if (!deviceId || !paneId) return;
    const normalizedSize = normalizeTerminalSize(cols, rows);
    if (normalizedSize) {
      lastReportedTerminalSizes.set(deviceId, { ...normalizedSize, at: Date.now() });
    }
    const msg = buildTermSyncSize(deviceId, paneId, cols, rows);
    getBorshClient().send(msg.kind, msg.payload);
  },

  paste(deviceId, paneId, data) {
    if (!deviceId || !paneId) return;
    const msg = buildTermPaste(deviceId, paneId, data);
    getBorshClient().send(msg.kind, msg.payload);
  },

  createWindow(deviceId, name) {
    if (!deviceId) return;
    const msg = buildTmuxCreateWindow(deviceId, name);
    getBorshClient().send(msg.kind, msg.payload);
    set((prev) => ({
      pendingCreateWindowAt: { ...prev.pendingCreateWindowAt, [deviceId]: Date.now() },
    }));
  },

  clearPendingCreateWindow(deviceId) {
    if (!deviceId) return;
    set((prev) => {
      if (prev.pendingCreateWindowAt[deviceId] === undefined) return prev;
      const next = { ...prev.pendingCreateWindowAt };
      delete next[deviceId];
      return { pendingCreateWindowAt: next };
    });
  },

  closeWindow(deviceId, windowId) {
    if (!deviceId || !windowId) return;
    const msg = buildTmuxCloseWindow(deviceId, windowId);
    getBorshClient().send(msg.kind, msg.payload);
  },

  closePane(deviceId, paneId) {
    if (!deviceId || !paneId) return;
    const msg = buildTmuxClosePane(deviceId, paneId);
    getBorshClient().send(msg.kind, msg.payload);
  },

  renameWindow(deviceId, windowId, name) {
    if (!deviceId || !windowId) return;
    const msg = buildTmuxRenameWindow(deviceId, windowId, name);
    getBorshClient().send(msg.kind, msg.payload);
  },

  reorderWindows(deviceId, windowIds) {
    if (!deviceId || windowIds.length === 0) return;
    // 乐观本地重排，立即反馈；服务端会用带 overlay 的快照重广播确认
    set((prev) => {
      const snapshot = prev.snapshots[deviceId];
      const session = snapshot?.session;
      if (!session) return {};
      const byId = new Map(session.windows.map((w) => [w.id, w] as const));
      const known = windowIds.map((id) => byId.get(id)).filter((w) => w !== undefined);
      const rest = session.windows.filter((w) => !windowIds.includes(w.id));
      return {
        snapshots: {
          ...prev.snapshots,
          [deviceId]: { ...snapshot, session: { ...session, windows: [...known, ...rest] } },
        },
      };
    });
    const msg = buildTmuxReorderWindows(deviceId, windowIds);
    getBorshClient().send(msg.kind, msg.payload);
  },

  reorderPanes(deviceId, windowId, paneIds) {
    if (!deviceId || !windowId || paneIds.length === 0) return;
    set((prev) => {
      const snapshot = prev.snapshots[deviceId];
      const session = snapshot?.session;
      if (!session) return {};
      const windows = session.windows.map((w) => {
        if (w.id !== windowId) return w;
        const byId = new Map(w.panes.map((p) => [p.id, p] as const));
        const known = paneIds.map((id) => byId.get(id)).filter((p) => p !== undefined);
        const rest = w.panes.filter((p) => !paneIds.includes(p.id));
        return { ...w, panes: [...known, ...rest] };
      });
      return {
        snapshots: {
          ...prev.snapshots,
          [deviceId]: { ...snapshot, session: { ...session, windows } },
        },
      };
    });
    const msg = buildTmuxReorderPanes(deviceId, windowId, paneIds);
    getBorshClient().send(msg.kind, msg.payload);
  },
}));
