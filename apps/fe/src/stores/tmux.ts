import type { EventDevicePayload, EventTmuxPayload, StateSnapshotPayload } from '@tmex/shared';
import { wsBorsh } from '@tmex/shared';
import { create } from 'zustand';
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
  buildTmuxSelect,
  buildTmuxSelectWindow,
  generateSelectToken,
} from '@/ws-borsh';
import { getSelectStateMachine } from '@/ws-borsh';
import { useSiteStore } from './site';

type SnapshotMap = Record<string, StateSnapshotPayload | undefined>;

type ConnectionRef = 'sidebar' | 'page';

interface DeviceError {
  message: string;
  type?: string;
}

interface TmuxState {
  socketReady: boolean;
  snapshots: SnapshotMap;
  connectedDevices: Set<string>;
  deviceConnected: Record<string, boolean | undefined>;
  deviceErrors: Record<string, DeviceError | undefined>;
  selectedPanes: Record<string, { windowId: string; paneId: string } | undefined>;
  activePaneFromEvent: Record<string, { windowId: string; paneId: string } | undefined>;
  connectionRefs: Record<string, Partial<Record<ConnectionRef, true>> | undefined>;
  lastConnectRequest: { deviceId: string; ref: ConnectionRef; at: number } | null;

  ensureSocketConnected: () => void;
  connectDevice: (deviceId: string, ref?: ConnectionRef) => void;
  disconnectDevice: (deviceId: string, ref?: ConnectionRef) => void;
  clearDeviceError: (deviceId: string) => void;
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
  closeWindow: (deviceId: string, windowId: string) => void;
  closePane: (deviceId: string, paneId: string) => void;
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
        }));
        maybeReselectCurrentPane(decoded.deviceId);
        return;
      }

      case wsBorsh.KIND_DEVICE_DISCONNECTED: {
        const decoded = wsBorsh.decodePayload(
          wsBorsh.schema.DeviceDisconnectedSchema,
          msg.payload
        );
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
        sm.dispatch({ type: 'SWITCH_ACK', deviceId: decoded.deviceId, selectToken: decoded.selectToken });
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
        });
        return;
      }

      case wsBorsh.KIND_LIVE_RESUME: {
        const decoded = wsBorsh.decodePayload(wsBorsh.schema.LiveResumeSchema, msg.payload);
        sm.dispatch({ type: 'LIVE_RESUME', deviceId: decoded.deviceId, selectToken: decoded.selectToken });
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

      case wsBorsh.KIND_ERROR: {
        // 连接级错误不一定需要 toast；保留给上层需要时再做
        return;
      }
    }
  });

  client.onError((error) => {
    console.error('[tmux] borsh ws error:', error);
    setState({ socketReady: false });
    window.dispatchEvent(
      new CustomEvent('tmex:sonner', {
        detail: {
          title: 'WebSocket Connection Error',
          description: 'Please check Gateway status',
        },
      })
    );
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
}

function handleDeviceEvent(
  setState: (partial: Partial<TmuxState> | ((prev: TmuxState) => Partial<TmuxState>)) => void,
  payload: EventDevicePayload
): void {
  if (payload.type === 'error') {
    const summary = payload.message ?? 'Device Error';

    setState((prev) => {
      const previousError = prev.deviceErrors[payload.deviceId];
      if (previousError?.message === summary && previousError?.type === payload.errorType) {
        return {};
      }

      return {
        deviceErrors: {
          ...prev.deviceErrors,
          [payload.deviceId]: { message: summary, type: payload.errorType },
        },
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
    }));
  }
}

function handleTmuxEvent(
  setState: (partial: Partial<TmuxState> | ((prev: TmuxState) => Partial<TmuxState>)) => void,
  payload: EventTmuxPayload
): void {
  if (payload.type === 'bell') {
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

    window.dispatchEvent(
      new CustomEvent('tmex:sonner', {
        detail: {
          title,
          description: description || 'Received tmux bell',
          paneUrl: typeof data.paneUrl === 'string' ? data.paneUrl : undefined,
        },
      })
    );
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
  selectedPanes: {},
  activePaneFromEvent: {},
  connectionRefs: {},
  lastConnectRequest: null,

  ensureSocketConnected() {
    setupClientHandlers(set, get);
    getBorshClient().connect();
  },

  connectDevice(deviceId, ref = 'page') {
    if (!deviceId) return;

    set((prev) => {
      const nextRefs = { ...prev.connectionRefs };
      nextRefs[deviceId] = { ...(nextRefs[deviceId] ?? {}), [ref]: true };

      const nextConnected = new Set(prev.connectedDevices);
      nextConnected.add(deviceId);

      return {
        connectionRefs: nextRefs,
        connectedDevices: nextConnected,
        lastConnectRequest: { deviceId, ref, at: Date.now() },
      };
    });

    get().ensureSocketConnected();

    if (shouldSkipDuplicateConnect(deviceId)) return;
    const msg = buildDeviceConnect(deviceId);
    getBorshClient().send(msg.kind, msg.payload);
  },

  disconnectDevice(deviceId, ref = 'page') {
    if (!deviceId) return;

    let shouldDisconnect = false;

    set((prev) => {
      const nextRefs = { ...prev.connectionRefs };
      const currentRefs = nextRefs[deviceId] ?? {};
      const updatedRefs = { ...currentRefs };
      delete updatedRefs[ref];
      if (Object.keys(updatedRefs).length === 0) {
        delete nextRefs[deviceId];
        shouldDisconnect = true;
      } else {
        nextRefs[deviceId] = updatedRefs;
      }

      const nextConnected = new Set(prev.connectedDevices);
      if (shouldDisconnect) {
        nextConnected.delete(deviceId);
      }

      return {
        connectionRefs: nextRefs,
        connectedDevices: nextConnected,
      };
    });

    if (!shouldDisconnect) return;

    getSelectStateMachine().cleanup(deviceId);
    const msg = buildDeviceDisconnect(deviceId);
    getBorshClient().send(msg.kind, msg.payload);
  },

  clearDeviceError(deviceId) {
    set((prev) => ({
      deviceErrors: { ...prev.deviceErrors, [deviceId]: undefined },
    }));
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
      (lastReportedTerminalSizes.get(deviceId) ?? null);

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
}));
