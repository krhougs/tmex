import { formatTerminalNotificationToast, useBellStore } from '@tmex/notifications';
import { getTmuxWindowStyle, wsBorsh } from '@tmex/shared';
import type { EventDevicePayload, EventTmuxPayload, StateSnapshotPayload } from '@tmex/shared';
import {
  type ConnectionState,
  type GatewayHistoryCursor,
  type GatewayTransportEvent,
  generateSelectToken,
} from '@tmex/ws-client';
import { create } from 'zustand';
import type { RuntimeCore } from './runtime';
import type { SiteStore } from './site';
import type { UIStore } from './ui';

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

export interface TmuxState {
  connectionState: ConnectionState;
  hasConnectedOnce: boolean;
  wsLatencyMs: number | null;
  snapshots: SnapshotMap;
  connectedDevices: Set<string>;
  deviceConnected: Record<string, boolean | undefined>;
  deviceErrors: Record<string, DeviceError | undefined>;
  deviceReconnecting: Record<string, DeviceReconnecting | undefined>;
  selectedPanes: Record<string, { windowId: string; paneId: string } | undefined>;
  activePaneFromEvent: Record<string, { windowId: string; paneId: string } | undefined>;
  pendingCreateWindow: Record<
    string,
    { at: number; knownWindowIds: string[] | null } | undefined
  >;

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
  createWindow: (deviceId: string, name?: string, cwd?: string) => void;
  clearPendingCreateWindow: (deviceId: string) => void;
  closeWindow: (deviceId: string, windowId: string) => void;
  closePane: (deviceId: string, paneId: string) => void;
  renameWindow: (deviceId: string, windowId: string, name: string) => void;
  reorderWindows: (deviceId: string, windowIds: string[]) => void;
  reorderPanes: (deviceId: string, windowId: string, paneIds: string[]) => void;
  // ---------- 分屏 ----------
  subscribePanes: (deviceId: string, paneIds: string[]) => void;
  mountPane: (deviceId: string, paneId: string) => () => void;
  requestPaneScreen: (deviceId: string, paneId: string) => void;
  fetchPaneHistory: (
    deviceId: string,
    paneId: string,
    cursor?: GatewayHistoryCursor | null
  ) => void;
  focusPane: (deviceId: string, windowId: string, paneId: string) => void;
  splitPane: (deviceId: string, paneId: string, direction: 'right' | 'down', cwd?: string) => void;
  renamePane: (deviceId: string, paneId: string, name: string) => void;
  movePane: (
    deviceId: string,
    srcPaneId: string,
    dstPaneId: string,
    position: 'left' | 'right' | 'top' | 'bottom'
  ) => void;
  breakPane: (deviceId: string, paneId: string) => void;
  resizePaneInWindow: (
    deviceId: string,
    paneId: string,
    size: { cols?: number; rows?: number }
  ) => void;
  applyStackedLayout: (deviceId: string, windowId: string, cols: number, rows: number) => void;
  syncThemeAfterResize: (deviceId: string) => void;
}

const CONNECT_DEDUP_WINDOW_MS = 500;
const SCREEN_BYTE_LIMIT = 512 * 1024;
const HISTORY_PAGE_BYTE_LIMIT = 256 * 1024;

export interface TmuxStoreDeps {
  getUI: () => UIStore;
  getSite: () => SiteStore;
}

export function createTmuxStore(
  core: RuntimeCore,
  deps: TmuxStoreDeps,
  disposers: Array<() => void> = []
) {
  const lastConnectSentAt = new Map<string, number>();

  const lastReportedTerminalSizes = new Map<string, { cols: number; rows: number; at: number }>();
  const selectRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const mountedPaneCounts = new Map<string, Map<string, number>>();
  const manualPaneSubscriptions = new Map<string, Set<string>>();
  const subscriptionGenerations = new Map<string, bigint>();

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
    const style = getTmuxWindowStyle(deps.getUI().getState().theme);
    core.transport.send({ type: 'set-window-style', deviceId, style });
  }

  function currentPaneSubscriptions(deviceId: string): string[] {
    const panes = new Set(manualPaneSubscriptions.get(deviceId) ?? []);
    for (const [paneId, count] of mountedPaneCounts.get(deviceId) ?? []) {
      if (count > 0) panes.add(paneId);
    }
    return [...panes].sort();
  }

  function sendPaneSubscriptions(deviceId: string): void {
    const generation = (subscriptionGenerations.get(deviceId) ?? 0n) + 1n;
    subscriptionGenerations.set(deviceId, generation);
    core.transport.send({
      type: 'set-pane-subscriptions',
      deviceId,
      generation,
      paneIds: currentPaneSubscriptions(deviceId),
    });
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

  function setupTransportHandlers(
    setState: (partial: Partial<TmuxState> | ((prev: TmuxState) => Partial<TmuxState>)) => void,
    getState: () => TmuxState
  ): void {
    if (initialized) return;
    initialized = true;

    const transport = core.transport;

    // 选择状态机的输出/历史统一经 pane-sink-registry 按 (deviceId, paneId) 路由到
    // 各 Terminal 实例（分屏多实例）；回调一次性设置，Terminal 只注册/注销 sink
    core.selectMachine({
      onResetTerminal: (deviceId, paneId) => {
        core.paneSinks.dispatchPaneReset(deviceId, paneId);
      },
      onApplyHistory: (deviceId, paneId, data, alternateScreen, modes) => {
        core.paneSinks.dispatchPaneApplyHistory(deviceId, paneId, data, alternateScreen, modes);
      },
      onFlushBuffer: (deviceId, paneId, buffer) => {
        for (const chunk of buffer) {
          core.paneSinks.dispatchPaneOutput(deviceId, paneId, chunk);
        }
      },
      onOutput: (deviceId, paneId, data) => {
        core.paneSinks.dispatchPaneOutput(deviceId, paneId, data);
      },
      onSelectFailed: (deviceId, reason) => {
        if (reason === 'rejected' || selectRetryTimers.has(deviceId)) {
          return;
        }
        const timer = setTimeout(() => {
          selectRetryTimers.delete(deviceId);
          if (getState().deviceConnected[deviceId] === false) {
            return;
          }
          maybeReselectCurrentPane(deviceId);
        }, 250);
        selectRetryTimers.set(deviceId, timer);
      },
    });

    const maybeReselectCurrentPane = (deviceId: string): void => {
      const current = getState().selectedPanes[deviceId];
      if (!current) return;

      const sm = core.selectMachine();
      if (sm.getTransaction(deviceId)) {
        return;
      }

      getState().selectPane(deviceId, current.windowId, current.paneId);
    };

    disposers.push(() => {
      for (const timer of selectRetryTimers.values()) {
        clearTimeout(timer);
      }
      selectRetryTimers.clear();
    });

    const handleReady = (): void => {
      lastConnectSentAt.clear();
      setState((prev) => {
        const cleared = { ...prev.deviceReconnecting };
        for (const key of Object.keys(cleared)) cleared[key] = undefined;
        return { deviceReconnecting: cleared };
      });
      for (const deviceId of getState().connectedDevices) {
        if (!shouldSkipDuplicateConnect(deviceId)) {
          transport.send({ type: 'connect-device', deviceId });
        }
        if (currentPaneSubscriptions(deviceId).length > 0) sendPaneSubscriptions(deviceId);
      }
    };

    const handleTransportEvent = (event: GatewayTransportEvent): void => {
      const sm = core.selectMachine();
      switch (event.type) {
        case 'connection-state':
          setState((prev) => ({
            connectionState: event.state,
            hasConnectedOnce: event.state === 'READY' ? true : prev.hasConnectedOnce,
            wsLatencyMs: event.state === 'READY' ? prev.wsLatencyMs : null,
          }));
          if (event.state === 'READY') handleReady();
          return;
        case 'latency':
          setState({ wsLatencyMs: event.latencyMs });
          return;
        case 'terminal-progress':
          core.selectMachine().reportTerminalProgress(event.deviceId);
          return;
        case 'device-connected':
          setState((prev) => ({
            deviceConnected: { ...prev.deviceConnected, [event.deviceId]: true },
            deviceErrors: { ...prev.deviceErrors, [event.deviceId]: undefined },
            deviceReconnecting: { ...prev.deviceReconnecting, [event.deviceId]: undefined },
          }));
          sendWindowStyleForCurrentTheme(event.deviceId);
          if (!transport.capabilities.atomicScreen) maybeReselectCurrentPane(event.deviceId);
          return;
        case 'device-disconnected':
          sm.cleanup(event.deviceId);
          core.paneSinks.cleanupDevicePaneState(event.deviceId);
          setState((prev) => ({
            deviceConnected: { ...prev.deviceConnected, [event.deviceId]: false },
          }));
          return;
        case 'device-event':
          handleDeviceEvent(setState, event.event);
          if (event.event.type === 'reconnected') {
            sendWindowStyleForCurrentTheme(event.event.deviceId);
            if (!transport.capabilities.atomicScreen) {
              maybeReselectCurrentPane(event.event.deviceId);
            }
          }
          return;
        case 'metadata-snapshot':
          setState((prev) => ({
            snapshots: {
              ...prev.snapshots,
              [event.snapshot.deviceId]: event.snapshot,
            },
          }));
          return;
        case 'metadata-patch':
          setState((prev) => {
            const current = prev.snapshots[event.deviceId];
            if (!current) return {};
            return {
              snapshots: {
                ...prev.snapshots,
                [event.deviceId]: wsBorsh.applyLegacyStateSnapshotDiff(current, event.patch),
              },
            };
          });
          return;
        case 'tmux-event':
          handleTmuxEvent(setState, event.event);
          return;
        case 'selection-ack':
          sm.dispatch({
            type: 'SWITCH_ACK',
            deviceId: event.deviceId,
            selectToken: event.selectToken,
          });
          return;
        case 'legacy-history':
          if (
            core.paneSinks.dispatchPaneHistory(
              event.deviceId,
              event.paneId,
              event.selectToken,
              event.data,
              event.alternateScreen,
              event.modes
            )
          ) {
            return;
          }
          sm.dispatch({
            type: 'HISTORY',
            deviceId: event.deviceId,
            selectToken: event.selectToken,
            data: event.data,
            alternateScreen: event.alternateScreen,
            modes: event.modes,
          });
          return;
        case 'live-resume':
          sm.dispatch({
            type: 'LIVE_RESUME',
            deviceId: event.deviceId,
            selectToken: event.selectToken,
          });
          return;
        case 'terminal-data':
          if (event.frame.seqStart === undefined) {
            sm.dispatch({
              type: 'OUTPUT',
              deviceId: event.frame.deviceId,
              paneId: event.frame.paneId,
              data: event.frame.data,
            });
          } else {
            core.paneSinks.dispatchPaneTerminalData(event.frame);
          }
          return;
        case 'screen-snapshot':
          core.paneSinks.dispatchPaneScreenSnapshot(event.snapshot);
          return;
        case 'history-page':
          core.paneSinks.dispatchPaneHistoryPage(event.page);
          return;
        case 'subscription-applied':
          for (const paneId of event.rejectedPaneIds) {
            core.paneSinks.dispatchPaneRebase(event.deviceId, paneId, 'resource_exhausted');
          }
          return;
        case 'rebase-required':
          if (event.reason === 'metadata_gap') return;
          if (event.deviceId && event.paneId) {
            core.paneSinks.dispatchPaneRebase(event.deviceId, event.paneId, event.reason);
          } else {
            for (const [deviceId, panes] of mountedPaneCounts) {
              if (event.deviceId && event.deviceId !== deviceId) continue;
              for (const paneId of panes.keys()) {
                core.paneSinks.dispatchPaneRebase(deviceId, paneId, event.reason);
              }
            }
          }
          return;
        case 'clipboard-write': {
          if (typeof document === 'undefined' || document.visibilityState !== 'visible') {
            return;
          }
          const current = getState().selectedPanes[event.deviceId];
          if (!current || current.paneId !== event.paneId) {
            return;
          }
          void core.host.writeClipboardText(event.text).then(
            () => {
              core.notifications.success(core.t('terminal.copied'));
            },
            (err) => {
              console.warn('[tmux] clipboard write failed:', err);
              core.notifications.error(core.t('terminal.copyFailed'));
            }
          );
          return;
        }
        case 'site-theme-update':
          deps.getSite().getState().setThemeFromS2C(event.theme);
          return;
        case 'transport-error':
          console.error('[tmux] gateway transport error:', event.error);
          return;
      }
    };

    disposers.push(transport.onEvent(handleTransportEvent));
    const initialState = transport.getState();
    setState({
      connectionState: initialState,
      hasConnectedOnce: transport.hasConnectedOnce,
      wsLatencyMs: transport.latencyMs,
    });
    if (initialState === 'READY') handleReady();

    // 主题切换时同步所有已连接设备的 tmux window-style
    let lastTheme = deps.getUI().getState().theme;
    disposers.push(
      deps.getUI().subscribe((uiState) => {
        if (uiState.theme === lastTheme) return;
        lastTheme = uiState.theme;
        const state = getState();
        for (const deviceId of state.connectedDevices) {
          if (state.deviceConnected[deviceId]) {
            sendWindowStyleForCurrentTheme(deviceId);
          }
        }
      })
    );
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

        // 宿主接管通知呈现时设备错误 toast 一并让位；deviceErrors 状态照写（错误横幅等 UI 状态不受影响）
        if (shouldToast && !core.features.hostManagedNotifications) {
          core.notifications.error(summary);
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
      core.selectMachine().cleanup(payload.deviceId);
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
      const data = (payload.data ?? {}) as Record<string, unknown>;
      const paneId =
        (typeof data.paneId === 'string' ? data.paneId : undefined) ??
        (typeof data.windowId === 'string' ? data.windowId : undefined);
      if (paneId) {
        useBellStore.getState().triggerBell(paneId);
      }
      const settings = deps.getSite().getState().settings;
      if (settings?.enableBellSound !== false) {
        core.bell.play();
      }
    }

    if (payload.type === 'notification') {
      console.log('[tmex] notification', payload.data);
      if (core.features.hostManagedNotifications) {
        return;
      }
      const settings = deps.getSite().getState().settings;
      if (settings?.enableBrowserNotificationToast === false) {
        return;
      }

      const data = (payload.data ?? {}) as Record<string, unknown>;
      const { title, description } = formatTerminalNotificationToast(data, core.t);
      const paneUrl = typeof data.paneUrl === 'string' ? data.paneUrl : undefined;
      core.notifications.info(title, {
        description,
        action: paneUrl
          ? {
              label: 'Open',
              onClick: () => {
                core.host.navigate(paneUrl);
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

  return create<TmuxState>((set, get) => ({
    connectionState: 'IDLE' as ConnectionState,
    hasConnectedOnce: false,
    wsLatencyMs: null,
    snapshots: {},
    connectedDevices: new Set(),
    deviceConnected: {},
    deviceErrors: {},
    deviceReconnecting: {},
    selectedPanes: {},
    activePaneFromEvent: {},
    pendingCreateWindow: {},

    ensureSocketConnected() {
      setupTransportHandlers(set, get);
      core.transport.connect();
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
      core.transport.send({ type: 'connect-device', deviceId });
    },

    disconnectDevice(deviceId) {
      if (!deviceId) return;

      set((prev) => {
        const nextConnected = new Set(prev.connectedDevices);
        nextConnected.delete(deviceId);
        return { connectedDevices: nextConnected };
      });

      core.selectMachine().cleanup(deviceId);
      manualPaneSubscriptions.delete(deviceId);
      mountedPaneCounts.delete(deviceId);
      subscriptionGenerations.delete(deviceId);
      core.transport.send({ type: 'disconnect-device', deviceId });
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

      if (!core.transport.capabilities.atomicScreen) {
        core.selectMachine().dispatch({
          type: 'SELECT_START',
          deviceId,
          windowId,
          paneId,
          selectToken,
          wantHistory,
        });
      }

      const normalizedSize =
        normalizeTerminalSize(size?.cols, size?.rows) ??
        lastReportedTerminalSizes.get(deviceId) ??
        null;

      core.transport.send({
        type: 'select-pane',
        deviceId,
        windowId,
        paneId,
        selectToken,
        wantHistory,
        cols: normalizedSize?.cols,
        rows: normalizedSize?.rows,
      });
    },

    selectWindow(deviceId, windowId) {
      if (!deviceId || !windowId) return;
      core.transport.send({ type: 'select-window', deviceId, windowId });
    },

    sendInput(deviceId, paneId, data, isComposing = false) {
      if (!deviceId || !paneId) return;
      core.transport.send({ type: 'terminal-input', deviceId, paneId, data, isComposing });
    },

    resizePane(deviceId, paneId, cols, rows) {
      if (!deviceId || !paneId) return;
      const normalizedSize = normalizeTerminalSize(cols, rows);
      if (normalizedSize) {
        lastReportedTerminalSizes.set(deviceId, { ...normalizedSize, at: Date.now() });
      }
      core.transport.send({ type: 'terminal-resize', deviceId, paneId, cols, rows });
    },

    syncPaneSize(deviceId, paneId, cols, rows) {
      if (!deviceId || !paneId) return;
      const normalizedSize = normalizeTerminalSize(cols, rows);
      if (normalizedSize) {
        lastReportedTerminalSizes.set(deviceId, { ...normalizedSize, at: Date.now() });
      }
      core.transport.send({ type: 'terminal-sync-size', deviceId, paneId, cols, rows });
    },

    paste(deviceId, paneId, data) {
      if (!deviceId || !paneId) return;
      core.transport.send({ type: 'terminal-paste', deviceId, paneId, data });
    },

    createWindow(deviceId, name, cwd) {
      if (!deviceId) return;
      core.transport.send({ type: 'create-window', deviceId, name, cwd });
      set((prev) => {
        // 记录创建时刻已存在的 window id，后续只跟随「新出现」的窗口，
        // 避免陈旧快照的 active 把跳转带到无关窗口。
        // 快照尚未就绪时记 null（基线未知），跟随方退回 active 兜底。
        const windows = prev.snapshots[deviceId]?.session?.windows;
        return {
          pendingCreateWindow: {
            ...prev.pendingCreateWindow,
            [deviceId]: {
              at: Date.now(),
              knownWindowIds: windows ? windows.map((win) => win.id) : null,
            },
          },
        };
      });
    },

    clearPendingCreateWindow(deviceId) {
      if (!deviceId) return;
      set((prev) => {
        if (prev.pendingCreateWindow[deviceId] === undefined) return prev;
        const next = { ...prev.pendingCreateWindow };
        delete next[deviceId];
        return { pendingCreateWindow: next };
      });
    },

    closeWindow(deviceId, windowId) {
      if (!deviceId || !windowId) return;
      core.transport.send({ type: 'close-window', deviceId, windowId });
    },

    closePane(deviceId, paneId) {
      if (!deviceId || !paneId) return;
      core.transport.send({ type: 'close-pane', deviceId, paneId });
    },

    renameWindow(deviceId, windowId, name) {
      if (!deviceId || !windowId) return;
      core.transport.send({ type: 'rename-window', deviceId, windowId, name });
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
      core.transport.send({ type: 'reorder-windows', deviceId, windowIds });
    },

    subscribePanes(deviceId, paneIds) {
      if (!deviceId) return;
      manualPaneSubscriptions.set(deviceId, new Set(paneIds));
      sendPaneSubscriptions(deviceId);
    },

    mountPane(deviceId, paneId) {
      if (!deviceId || !paneId) return () => {};
      const counts = mountedPaneCounts.get(deviceId) ?? new Map<string, number>();
      mountedPaneCounts.set(deviceId, counts);
      counts.set(paneId, (counts.get(paneId) ?? 0) + 1);
      sendPaneSubscriptions(deviceId);

      let released = false;
      return () => {
        if (released) return;
        released = true;
        const current = mountedPaneCounts.get(deviceId);
        if (!current) return;
        const nextCount = (current.get(paneId) ?? 1) - 1;
        if (nextCount > 0) current.set(paneId, nextCount);
        else current.delete(paneId);
        if (current.size === 0) mountedPaneCounts.delete(deviceId);
        sendPaneSubscriptions(deviceId);
      };
    },

    requestPaneScreen(deviceId, paneId) {
      if (!deviceId || !paneId) return;
      const requestToken = generateSelectToken();
      if (!core.transport.capabilities.atomicScreen) {
        core.paneSinks.beginPaneHistoryGate(deviceId, paneId, requestToken);
      }
      core.transport.send({
        type: 'request-pane-screen',
        requestId: requestToken,
        deviceId,
        paneId,
        byteLimit: SCREEN_BYTE_LIMIT,
      });
    },

    fetchPaneHistory(deviceId, paneId, cursor = null) {
      if (!deviceId || !paneId) return;
      const requestToken = generateSelectToken();
      if (!core.transport.capabilities.cursorHistory) {
        core.paneSinks.beginPaneHistoryGate(deviceId, paneId, requestToken);
      }
      core.transport.send({
        type: 'request-pane-history',
        requestId: requestToken,
        deviceId,
        paneId,
        cursor,
        byteLimit: HISTORY_PAGE_BYTE_LIMIT,
      });
    },

    focusPane(deviceId, windowId, paneId) {
      if (!deviceId || !windowId || !paneId) return;
      set((prev) => ({
        selectedPanes: { ...prev.selectedPanes, [deviceId]: { windowId, paneId } },
      }));
      core.transport.send({ type: 'focus-pane', deviceId, windowId, paneId });
    },

    splitPane(deviceId, paneId, direction, cwd) {
      if (!deviceId || !paneId) return;
      core.transport.send({ type: 'split-pane', deviceId, paneId, direction, cwd });
    },

    renamePane(deviceId, paneId, name) {
      if (!deviceId || !paneId) return;
      core.transport.send({ type: 'rename-pane', deviceId, paneId, name });
    },

    movePane(deviceId, srcPaneId, dstPaneId, position) {
      if (!deviceId || !srcPaneId || !dstPaneId || srcPaneId === dstPaneId) return;
      core.transport.send({ type: 'move-pane', deviceId, srcPaneId, dstPaneId, position });
    },

    breakPane(deviceId, paneId) {
      if (!deviceId || !paneId) return;
      core.transport.send({ type: 'break-pane', deviceId, paneId });
    },

    resizePaneInWindow(deviceId, paneId, size) {
      if (!deviceId || !paneId) return;
      if (size.cols === undefined && size.rows === undefined) return;
      core.transport.send({ type: 'resize-pane-in-window', deviceId, paneId, ...size });
    },

    applyStackedLayout(deviceId, windowId, cols, rows) {
      if (!deviceId || !windowId) return;
      const normalized = normalizeTerminalSize(cols, rows);
      if (!normalized) return;
      core.transport.send({
        type: 'apply-stacked-layout',
        deviceId,
        windowId,
        cols: normalized.cols,
        rows: normalized.rows,
      });
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
      core.transport.send({ type: 'reorder-panes', deviceId, windowId, paneIds });
    },

    syncThemeAfterResize(deviceId) {
      if (!deviceId) return;
      if (!core.transport.isReady()) return;
      sendWindowStyleForCurrentTheme(deviceId);
    },
  }));
}

export type TmuxStore = ReturnType<typeof createTmuxStore>;
