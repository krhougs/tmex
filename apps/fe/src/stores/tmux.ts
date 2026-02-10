import type { EventDevicePayload, StateSnapshotPayload, WsMessage } from '@tmex/shared';
import { create } from 'zustand';

type SnapshotMap = Record<string, StateSnapshotPayload | undefined>;

type ConnectionRef = 'sidebar' | 'page';

interface DeviceError {
  message: string;
  type?: string;
}

interface PendingBinarySubscriber {
  deviceId: string;
  handler: (data: Uint8Array) => void;
}

interface TmuxState {
  socketReady: boolean;
  snapshots: SnapshotMap;
  connectedDevices: Set<string>;
  deviceConnected: Record<string, boolean | undefined>;
  deviceErrors: Record<string, DeviceError | undefined>;
  selectedPanes: Record<string, { windowId: string; paneId: string } | undefined>;
  connectionRefs: Record<string, Partial<Record<ConnectionRef, true>> | undefined>;

  ensureSocketConnected: () => void;
  connectDevice: (deviceId: string, ref?: ConnectionRef) => void;
  disconnectDevice: (deviceId: string, ref?: ConnectionRef) => void;
  clearDeviceError: (deviceId: string) => void;
  selectPane: (deviceId: string, windowId: string, paneId: string) => void;
  sendInput: (deviceId: string, paneId: string, data: string, isComposing?: boolean) => void;
  resizePane: (deviceId: string, paneId: string, cols: number, rows: number) => void;
  paste: (deviceId: string, paneId: string, data: string) => void;
  createWindow: (deviceId: string, name?: string) => void;
  closeWindow: (deviceId: string, windowId: string) => void;
  closePane: (deviceId: string, paneId: string) => void;

  subscribeBinary: (deviceId: string, handler: (output: Uint8Array) => void) => () => void;
}

let wsSingleton: WebSocket | null = null;
const binarySubscribers: PendingBinarySubscriber[] = [];

function extractTerminalOutput(
  frame: Uint8Array
): { deviceId: string; paneId: string; output: Uint8Array } | null {
  if (frame.length < 4) return null;
  if (frame[0] !== 0x01) return null;
  const deviceIdLen = (frame[1] << 8) | frame[2];
  if (frame.length < 3 + deviceIdLen + 2) return null;
  const deviceId = new TextDecoder().decode(frame.slice(3, 3 + deviceIdLen));
  const paneLenOffset = 3 + deviceIdLen;
  const paneIdLen = (frame[paneLenOffset] << 8) | frame[paneLenOffset + 1];
  const paneOffset = paneLenOffset + 2;
  if (frame.length < paneOffset + paneIdLen) return null;
  const paneId = new TextDecoder().decode(frame.slice(paneOffset, paneOffset + paneIdLen));
  const output = frame.slice(paneOffset + paneIdLen);
  return { deviceId, paneId, output };
}

function sendJson(message: Omit<WsMessage<unknown>, 'timestamp'>): void {
  if (!wsSingleton || wsSingleton.readyState !== WebSocket.OPEN) {
    return;
  }
  wsSingleton.send(JSON.stringify({ ...message, timestamp: new Date().toISOString() }));
}

function ensureSocket(
  setState: (partial: Partial<TmuxState> | ((prev: TmuxState) => Partial<TmuxState>)) => void,
  getState: () => TmuxState
): void {
  if (wsSingleton && (wsSingleton.readyState === WebSocket.OPEN || wsSingleton.readyState === WebSocket.CONNECTING)) {
    return;
  }

  const wsUrl = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`;
  wsSingleton = new WebSocket(wsUrl);

  wsSingleton.onopen = () => {
    setState({ socketReady: true });
    for (const deviceId of getState().connectedDevices) {
      sendJson({ type: 'device/connect', payload: { deviceId } });
    }
  };

  wsSingleton.onmessage = async (event) => {
    if (event.data instanceof Blob) {
      const buffer = await event.data.arrayBuffer();
      const data = new Uint8Array(buffer);
      const decoded = extractTerminalOutput(data);
      if (!decoded) {
        return;
      }
      const selectedPanes = getState().selectedPanes;
      for (const sub of binarySubscribers) {
        if (decoded.deviceId !== sub.deviceId) {
          continue;
        }
        const selected = selectedPanes[sub.deviceId];
        if (!selected) {
          continue;
        }
        if (decoded.paneId !== selected.paneId) {
          continue;
        }
        sub.handler(decoded.output);
      }
      return;
    }

    let msg: WsMessage<unknown> | null = null;
    try {
      msg = JSON.parse(event.data) as WsMessage<unknown>;
    } catch {
      return;
    }

    if (!msg) return;

    switch (msg.type) {
      case 'device/connected': {
        const deviceId = (msg.payload as { deviceId: string }).deviceId;
        setState((prev) => ({
          deviceConnected: { ...prev.deviceConnected, [deviceId]: true },
        }));
        return;
      }

      case 'device/disconnected': {
        const deviceId = (msg.payload as { deviceId: string }).deviceId;
        setState((prev) => ({
          deviceConnected: { ...prev.deviceConnected, [deviceId]: false },
        }));
        return;
      }

      case 'event/device': {
        const payload = msg.payload as EventDevicePayload;
        if (payload.type === 'error') {
          setState((prev) => ({
            deviceErrors: {
              ...prev.deviceErrors,
              [payload.deviceId]: { message: payload.message ?? '设备错误', type: payload.errorType },
            },
          }));
          return;
        }

        if (payload.type === 'disconnected') {
          setState((prev) => ({
            deviceConnected: { ...prev.deviceConnected, [payload.deviceId]: false },
          }));
          return;
        }
        return;
      }

      case 'state/snapshot': {
        const payload = msg.payload as StateSnapshotPayload;
        setState((prev) => ({
          snapshots: { ...prev.snapshots, [payload.deviceId]: payload },
        }));
        return;
      }
    }
  };

  wsSingleton.onclose = () => {
    setState((prev) => {
      const nextConnected: Record<string, boolean | undefined> = { ...prev.deviceConnected };
      for (const deviceId of prev.connectedDevices) {
        nextConnected[deviceId] = false;
      }
      return { socketReady: false, deviceConnected: nextConnected };
    });
    wsSingleton = null;
  };

  wsSingleton.onerror = () => {
    setState({ socketReady: false });
  };
}

export const useTmuxStore = create<TmuxState>((set, get) => ({
  socketReady: false,
  snapshots: {},
  connectedDevices: new Set(),
  deviceConnected: {},
  deviceErrors: {},
  selectedPanes: {},
  connectionRefs: {},

  ensureSocketConnected: () => {
    ensureSocket(set, get);
  },

  connectDevice: (deviceId, ref = 'page') => {
    const current = get();
    const existingRefs = current.connectionRefs[deviceId] ?? {};
    if (existingRefs[ref]) {
      ensureSocket(set, get);
      return;
    }

    const nextRefs: Partial<Record<ConnectionRef, true>> = { ...existingRefs, [ref]: true };
    const nextConnectionRefs = { ...current.connectionRefs, [deviceId]: nextRefs };
    const nextConnected = new Set(current.connectedDevices);
    nextConnected.add(deviceId);

    set({ connectionRefs: nextConnectionRefs, connectedDevices: nextConnected });

    ensureSocket(set, get);
    sendJson({ type: 'device/connect', payload: { deviceId } });
  },

  disconnectDevice: (deviceId, ref = 'page') => {
    const current = get();
    const existingRefs = current.connectionRefs[deviceId];
    if (!existingRefs?.[ref]) {
      return;
    }

    const nextRefs: Partial<Record<ConnectionRef, true>> = { ...existingRefs };
    delete nextRefs[ref];

    const nextConnectionRefs = { ...current.connectionRefs };
    const stillReferenced = Object.keys(nextRefs).length > 0;
    if (stillReferenced) {
      nextConnectionRefs[deviceId] = nextRefs;
      set({ connectionRefs: nextConnectionRefs });
      return;
    }

    delete nextConnectionRefs[deviceId];
    const nextConnected = new Set(current.connectedDevices);
    nextConnected.delete(deviceId);

    set((prev) => ({
      connectedDevices: nextConnected,
      connectionRefs: nextConnectionRefs,
      selectedPanes: { ...prev.selectedPanes, [deviceId]: undefined },
      deviceConnected: { ...prev.deviceConnected, [deviceId]: false },
    }));

    sendJson({ type: 'device/disconnect', payload: { deviceId } });
  },

  clearDeviceError: (deviceId) => {
    set((prev) => ({
      deviceErrors: { ...prev.deviceErrors, [deviceId]: undefined },
    }));
  },

  selectPane: (deviceId, windowId, paneId) => {
    set((state) => ({
      selectedPanes: { ...state.selectedPanes, [deviceId]: { windowId, paneId } },
    }));
    sendJson({ type: 'tmux/select', payload: { deviceId, windowId, paneId } });
  },

  sendInput: (deviceId, paneId, data, isComposing) => {
    sendJson({ type: 'term/input', payload: { deviceId, paneId, data, isComposing } });
  },

  resizePane: (deviceId, paneId, cols, rows) => {
    sendJson({ type: 'term/resize', payload: { deviceId, paneId, cols, rows } });
  },

  paste: (deviceId, paneId, data) => {
    sendJson({ type: 'term/paste', payload: { deviceId, paneId, data } });
  },

  createWindow: (deviceId, name) => {
    sendJson({ type: 'tmux/create-window', payload: { deviceId, name } });
  },

  closeWindow: (deviceId, windowId) => {
    sendJson({ type: 'tmux/close-window', payload: { deviceId, windowId } });
  },

  closePane: (deviceId, paneId) => {
    sendJson({ type: 'tmux/close-pane', payload: { deviceId, paneId } });
  },

  subscribeBinary: (deviceId, handler) => {
    const sub: PendingBinarySubscriber = { deviceId, handler };
    binarySubscribers.push(sub);
    return () => {
      const idx = binarySubscribers.indexOf(sub);
      if (idx >= 0) binarySubscribers.splice(idx, 1);
    };
  },
}));
