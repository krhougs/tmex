import type { EventDevicePayload, StateSnapshotPayload, TermHistoryPayload, WsMessage } from '@tmex/shared';
import { create } from 'zustand';

type SnapshotMap = Record<string, StateSnapshotPayload | undefined>;

type ConnectionRef = 'sidebar' | 'page';

type HistoryHandler = (data: string) => void;

interface DeviceError {
  message: string;
  type?: string;
}

interface PendingBinarySubscriber {
  deviceId: string;
  handler: (data: Uint8Array) => void;
}

interface HistorySubscriber {
  deviceId: string;
  paneId: string;
  handler: HistoryHandler;
  subscribedAt: number;
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
  selectWindow: (deviceId: string, windowId: string) => void;
  sendInput: (deviceId: string, paneId: string, data: string, isComposing?: boolean) => void;
  resizePane: (deviceId: string, paneId: string, cols: number, rows: number) => void;
  syncPaneSize: (deviceId: string, paneId: string, cols: number, rows: number) => void;
  paste: (deviceId: string, paneId: string, data: string) => void;
  createWindow: (deviceId: string, name?: string) => void;
  closeWindow: (deviceId: string, windowId: string) => void;
  closePane: (deviceId: string, paneId: string) => void;

  subscribeBinary: (deviceId: string, handler: (output: Uint8Array) => void) => () => void;
  subscribeHistory: (deviceId: string, paneId: string, handler: HistoryHandler) => () => void;
}

let wsSingleton: WebSocket | null = null;
const binarySubscribers: PendingBinarySubscriber[] = [];
const historySubscribers: HistorySubscriber[] = [];

// 待发送的消息队列
const pendingMessages: Array<Omit<WsMessage<unknown>, 'timestamp'>> = [];
const MAX_PENDING_MESSAGES = 100;

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

function flushPendingMessages(): Set<string> {
  const connectedDeviceIds = new Set<string>();
  if (!wsSingleton || wsSingleton.readyState !== WebSocket.OPEN) return connectedDeviceIds;
  while (pendingMessages.length > 0) {
    const msg = pendingMessages.shift();
    if (msg) {
      if (msg.type === 'device/connect') {
        const payload = msg.payload as { deviceId?: string };
        if (payload?.deviceId) {
          connectedDeviceIds.add(payload.deviceId);
        }
      }
      wsSingleton.send(JSON.stringify({ ...msg, timestamp: new Date().toISOString() }));
    }
  }

  return connectedDeviceIds;
}

function sendJson(message: Omit<WsMessage<unknown>, 'timestamp'>): void {
  if (!wsSingleton || wsSingleton.readyState !== WebSocket.OPEN) {
    // 如果 socket 未就绪，将消息加入队列（限制队列大小）
    if (pendingMessages.length < MAX_PENDING_MESSAGES) {
      pendingMessages.push(message);
    }
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

    // 先发送队列中的消息，避免与重连逻辑重复触发 connect
    const alreadyConnected = flushPendingMessages();

    // 重新连接所有已连接的设备
    for (const deviceId of getState().connectedDevices) {
      if (alreadyConnected.has(deviceId)) {
        continue;
      }
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

      case 'term/history': {
        const payload = msg.payload as TermHistoryPayload;
        for (const sub of historySubscribers) {
          if (sub.deviceId === payload.deviceId && sub.paneId === payload.paneId) {
            sub.handler(payload.data);
          }
        }
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

  wsSingleton.onerror = (error) => {
    console.error('[tmux] WebSocket error:', error);
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

    const isFirstReference = Object.keys(existingRefs).length === 0;
    const nextRefs: Partial<Record<ConnectionRef, true>> = { ...existingRefs, [ref]: true };
    const nextConnectionRefs = { ...current.connectionRefs, [deviceId]: nextRefs };
    const nextConnected = new Set(current.connectedDevices);
    nextConnected.add(deviceId);

    set({ connectionRefs: nextConnectionRefs, connectedDevices: nextConnected });

    ensureSocket(set, get);
    if (isFirstReference) {
      sendJson({ type: 'device/connect', payload: { deviceId } });
    }
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

  selectWindow: (deviceId, windowId) => {
    sendJson({ type: 'tmux/select-window', payload: { deviceId, windowId } });
  },

  sendInput: (deviceId, paneId, data, isComposing) => {
    sendJson({ type: 'term/input', payload: { deviceId, paneId, data, isComposing } });
  },

  resizePane: (deviceId, paneId, cols, rows) => {
    sendJson({ type: 'term/resize', payload: { deviceId, paneId, cols, rows } });
  },

  syncPaneSize: (deviceId, paneId, cols, rows) => {
    sendJson({ type: 'term/sync-size', payload: { deviceId, paneId, cols, rows } });
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

  subscribeHistory: (deviceId, paneId, handler) => {
    const sub: HistorySubscriber = { deviceId, paneId, handler, subscribedAt: Date.now() };
    historySubscribers.push(sub);
    
    // 清理过期的订阅（超过10分钟的）
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (let i = historySubscribers.length - 1; i >= 0; i--) {
      if (historySubscribers[i].subscribedAt < cutoff) {
        historySubscribers.splice(i, 1);
      }
    }
    
    return () => {
      const idx = historySubscribers.indexOf(sub);
      if (idx >= 0) historySubscribers.splice(idx, 1);
    };
  },
}));
