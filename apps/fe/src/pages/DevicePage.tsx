import { DeviceStatusBadge } from '@/components/device-status-badge';
import { ShortcutButtonRow } from '@/components/settings/ShortcutButtonRow';
import { TerminalSettingsSheet } from '@/components/settings/terminal-settings-sheet';
import {
  fetchTerminalShortcuts,
  terminalShortcutsQueryKey,
} from '@/components/settings/terminal-shortcuts-api';
import { Terminal as TerminalComponent, type TerminalRef } from '@/components/terminal';
import { XTERM_THEME_DARK, XTERM_THEME_LIGHT } from '@/components/terminal/theme';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { fetchWatchRules, watchRulesQueryKey } from '@/components/watch/api';
import { WatchDialog } from '@/components/watch/watch-dialog';
import { useQuery } from '@tanstack/react-query';
import type { Device, TerminalShortcutItem } from '@tmex/shared';
import {
  ArrowDownToLine,
  Keyboard,
  Loader2,
  Radar,
  RefreshCw,
  SearchX,
  Send,
  Settings2,
  Smartphone,
  Trash2,
} from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { useAgentStore } from '../stores/agent';
import { useSiteStore } from '../stores/site';
import { useTmuxStore } from '../stores/tmux';
import { useUIStore } from '../stores/ui';
import { shouldApplyRemotePaneSize } from '../utils/resizeSyncGuards';
import {
  type TimedPaneSelection,
  resolvePendingUserSelection,
  shouldIgnoreActivePaneEvent,
  shouldSkipSnapshotFollow,
  shouldTrackPendingRouteSelection,
} from '../utils/selectionGuards';
import { buildBrowserTitle, buildTerminalLabel } from '../utils/terminalMeta';
import { decodePaneIdFromUrlParam, encodePaneIdForUrl } from '../utils/tmuxUrl';
import { isIOSMobileBrowser } from '../utils/virtualKeyboard';

// 终端快捷键栏：从服务器配置渲染（send 类发送控制序列，action 类触发特殊动作）。
const ShortcutsBar = memo(function ShortcutsBar({
  onActivate,
  disabled,
}: {
  onActivate: (item: TerminalShortcutItem) => void;
  disabled: boolean;
}) {
  const { data } = useQuery({
    queryKey: terminalShortcutsQueryKey,
    queryFn: fetchTerminalShortcuts,
    staleTime: 60_000,
  });
  const items = data?.items ?? [];
  if (items.length === 0) {
    return null;
  }
  return (
    <div className="terminal-shortcuts-strip" data-testid="terminal-shortcuts-strip">
      <ShortcutButtonRow
        items={items}
        useIcons={data?.useIcons ?? false}
        onActivate={onActivate}
        disabled={disabled}
        preventFocusSteal
        rowTestId="terminal-shortcuts-row"
        idPrefix="terminal-shortcut"
      />
    </div>
  );
});

export default function DevicePage() {
  const { t } = useTranslation();
  const { deviceId, windowId, paneId } = useParams();
  const navigate = useNavigate();
  const terminalContainerRef = useRef<HTMLDivElement>(null);
  const editorContainerRef = useRef<HTMLDivElement | null>(null);
  const editorTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const terminalRef = useRef<TerminalRef>(null);
  const autoSelected = useRef(false);
  const iosAddressBarCollapseTried = useRef(false);
  // Track user-initiated navigation to prevent auto-redirect overwriting it
  const userInitiatedSelectionRef = useRef<TimedPaneSelection | null>(null);

  const selectPane = useTmuxStore((state) => state.selectPane);

  const snapshot = useTmuxStore((state) => (deviceId ? state.snapshots[deviceId] : undefined));
  const deviceError = useTmuxStore((state) =>
    deviceId ? state.deviceErrors?.[deviceId] : undefined
  );
  const deviceConnected = useTmuxStore((state) =>
    deviceId ? (state.deviceConnected?.[deviceId] ?? false) : false
  );
  const deviceReconnecting = useTmuxStore((state) =>
    deviceId ? state.deviceReconnecting?.[deviceId] : undefined
  );
  const isReconnecting = Boolean(deviceReconnecting);
  // 连接意图：connectDevice 入集、disconnectDevice 出集——用于区分「初次连接中」与「已断开」。
  const hasConnectIntent = useTmuxStore((state) =>
    deviceId ? state.connectedDevices.has(deviceId) : false
  );
  const siteName = useSiteStore((state) => state.settings?.siteName ?? 'tmex');

  const resolvedPaneId = useMemo(() => decodePaneIdFromUrlParam(paneId), [paneId]);
  const draftKey = useMemo(
    () => (deviceId && resolvedPaneId ? `${deviceId}:${resolvedPaneId}` : null),
    [deviceId, resolvedPaneId]
  );

  const [isMobile, setIsMobile] = useState(false);
  const [editorText, setEditorText] = useState('');
  const isComposingRef = useRef(false);
  // Loading state - false when connected and has pane
  const isLoading = !deviceConnected || !resolvedPaneId;
  const [isSending, setIsSending] = useState(false);
  const inputMode = useUIStore((state) => state.inputMode);
  const uiTheme = useUIStore((state) => state.theme);
  const editorSendWithEnter = useUIStore((state) => state.editorSendWithEnter);
  const setEditorSendWithEnter = useUIStore((state) => state.setEditorSendWithEnter);
  const addEditorHistory = useUIStore((state) => state.addEditorHistory);
  const setEditorDraft = useUIStore((state) => state.setEditorDraft);
  const removeEditorDraft = useUIStore((state) => state.removeEditorDraft);
  const paneEditorDraft = useUIStore((state) =>
    draftKey ? (state.editorDrafts[draftKey] ?? '') : ''
  );
  const isIOSBrowser = useMemo(() => isIOSMobileBrowser(), []);

  const windows = snapshot?.session?.windows;
  const terminalTheme = uiTheme === 'light' ? XTERM_THEME_LIGHT : XTERM_THEME_DARK;

  const { data: devicesData } = useQuery({
    queryKey: ['devices'],
    queryFn: async () => {
      const res = await fetch('/api/devices');
      if (!res.ok) {
        throw new Error('Failed to fetch devices');
      }
      return res.json() as Promise<{ devices: Device[] }>;
    },
    throwOnError: false,
  });

  const currentDevice = useMemo(() => {
    if (!deviceId) {
      return undefined;
    }
    return devicesData?.devices.find((device) => device.id === deviceId);
  }, [deviceId, devicesData?.devices]);

  const selectedWindow = useMemo(() => {
    if (!windowId || !windows) return undefined;
    return windows.find((win) => win.id === windowId);
  }, [windowId, windows]);

  const selectedPane = useMemo(() => {
    if (!resolvedPaneId || !selectedWindow) return undefined;
    return selectedWindow.panes.find((pane) => pane.id === resolvedPaneId);
  }, [resolvedPaneId, selectedWindow]);

  const hasWindowSnapshot = Boolean(windows);
  const isWindowMissing = hasWindowSnapshot && Boolean(windowId) && !selectedWindow;
  const isPaneMissing =
    hasWindowSnapshot &&
    Boolean(windowId) &&
    Boolean(resolvedPaneId) &&
    Boolean(selectedWindow) &&
    !selectedPane;

  const invalidSelectionMessage = isWindowMissing
    ? t('terminal.windowClosed')
    : isPaneMissing
      ? t('terminal.paneClosed')
      : null;

  const isSelectionInvalid = Boolean(invalidSelectionMessage);
  const canInteractWithPane = Boolean(deviceConnected && resolvedPaneId && !isSelectionInvalid);

  const terminalTopbarLabel = useMemo(() => {
    if (!selectedWindow || !selectedPane) {
      return null;
    }
    const deviceName = currentDevice?.name ?? deviceId;
    return buildTerminalLabel({
      paneIdx: selectedPane.index,
      windowIdx: selectedWindow.index,
      paneTitle: selectedPane.title,
      windowName: selectedWindow.name,
      windowCustomName: selectedWindow.customName,
      deviceName,
    });
  }, [currentDevice?.name, deviceId, selectedPane, selectedWindow]);

  const snapshotActiveSelection = useMemo(() => {
    if (!windows || windows.length === 0) {
      return null;
    }
    const activeWindow = windows.find((win) => win.active);
    const activePane = activeWindow?.panes.find((pane) => pane.active);
    if (!activeWindow || !activePane) {
      return null;
    }
    return { windowId: activeWindow.id, paneId: activePane.id };
  }, [windows]);

  // Handle resize from terminal - use store directly to avoid unstable callback deps
  const handleResize = useCallback(
    (cols: number, rows: number) => {
      if (!deviceId || !resolvedPaneId) return;
      useTmuxStore.getState().resizePane(deviceId, resolvedPaneId, cols, rows);
    },
    [deviceId, resolvedPaneId]
  );

  // Handle sync from terminal
  const handleSync = useCallback(
    (cols: number, rows: number) => {
      if (!deviceId || !resolvedPaneId) return;
      useTmuxStore.getState().syncPaneSize(deviceId, resolvedPaneId, cols, rows);
    },
    [deviceId, resolvedPaneId]
  );

  const getSelectSize = useCallback(
    (targetWindowId?: string, targetPaneId?: string) => {
      const terminal = terminalRef.current;
      const terminalSize =
        terminal?.calculateSizeFromContainer() ?? terminal?.getSize() ?? undefined;
      if (terminalSize) {
        return terminalSize;
      }

      if (!targetWindowId || !targetPaneId || !windows) {
        return undefined;
      }

      const targetWindow = windows.find((window) => window.id === targetWindowId);
      const targetPane = targetWindow?.panes.find((pane) => pane.id === targetPaneId);
      if (!targetPane || targetPane.width <= 1 || targetPane.height <= 1) {
        return undefined;
      }

      return {
        cols: targetPane.width,
        rows: targetPane.height,
      };
    },
    [windows]
  );

  // Mobile detection
  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth < 768 || 'ontouchstart' in window);
    };

    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  // iOS address bar collapse
  useEffect(() => {
    if (!isMobile || !isIOSBrowser || iosAddressBarCollapseTried.current) {
      return;
    }

    iosAddressBarCollapseTried.current = true;
    const collapseAddressBar = () => {
      window.scrollTo(0, 1);
    };

    const rafId = window.requestAnimationFrame(collapseAddressBar);
    const timerA = window.setTimeout(collapseAddressBar, 120);
    const timerB = window.setTimeout(collapseAddressBar, 420);

    return () => {
      window.cancelAnimationFrame(rafId);
      window.clearTimeout(timerA);
      window.clearTimeout(timerB);
    };
  }, [isIOSBrowser, isMobile]);

  // Ensure device is connected when viewing (GlobalDeviceProvider handles actual connection)
  // This effect resets auto-selection logic and related refs when deviceId changes
  useEffect(() => {
    if (!deviceId) return;
    autoSelected.current = false;
    lastHandledActiveRef.current = null;
    lastSnapshotActiveRef.current = null;
    userInitiatedSelectionRef.current = null;
    recentSelectRequestsRef.current = [];
  }, [deviceId]);

  // Reset autoSelected when device connection changes
  useEffect(() => {
    if (!deviceConnected) {
      autoSelected.current = false;
    }
  }, [deviceConnected]);

  // Handle window/pane changes - both external and from sidebar navigation
  useEffect(() => {
    if (!deviceId) return;
    if (!deviceConnected) return;
    if (!windowId) return;

    // If snapshot not yet arrived, don't navigate (loading state)
    if (!windows) {
      return;
    }

    // If no windows left (all closed), navigate to fallback
    if (windows.length === 0) {
      navigate('/devices', { replace: true });
      return;
    }

    // Find the target window
    const targetWindow = windows.find((w) => w.id === windowId);
    if (!targetWindow) {
      // Window doesn't exist in snapshot yet.
      // Wait for snapshot to arrive. Don't redirect to another window,
      // as the user may have explicitly navigated to this specific window.
      return;
    }

    // If no paneId in URL, select the active pane in this window
    if (!resolvedPaneId) {
      const targetPane = targetWindow.panes.find((p) => p.active) ?? targetWindow.panes[0];
      if (targetPane) {
        navigate(
          `/devices/${deviceId}/windows/${windowId}/panes/${encodePaneIdForUrl(targetPane.id)}`,
          { replace: true }
        );
      }
      return;
    }

    // Check if current pane exists in the window
    const currentPane = targetWindow.panes.find((p) => p.id === resolvedPaneId);
    if (!currentPane) {
      // Pane was closed, navigate to active pane in same window
      const activePane = targetWindow.panes.find((p) => p.active) ?? targetWindow.panes[0];
      if (activePane) {
        navigate(
          `/devices/${deviceId}/windows/${windowId}/panes/${encodePaneIdForUrl(activePane.id)}`,
          { replace: true }
        );
      }
      return;
    }
  }, [deviceId, deviceConnected, windows, windowId, resolvedPaneId, navigate]);

  // Auto-select pane on initial load only
  useEffect(() => {
    if (!deviceId) return;
    if (!deviceConnected) return;
    if (!windows || windows.length === 0) return;
    // If we already have window and pane selected, skip
    if (windowId && resolvedPaneId) return;
    // If autoSelect already done, skip
    if (autoSelected.current) return;

    // Select the active window's active pane (initial load)
    const activeWindow = windows.find((win) => win.active) ?? windows[0];
    const activePane = activeWindow.panes.find((pane) => pane.active) ?? activeWindow.panes[0];
    if (!activePane) return;

    autoSelected.current = true;
    navigate(
      `/devices/${deviceId}/windows/${activeWindow.id}/panes/${encodePaneIdForUrl(activePane.id)}`,
      { replace: true }
    );
  }, [deviceConnected, deviceId, navigate, resolvedPaneId, windowId, windows]);

  // 跟踪当前 Terminal 实例已下发过的 SELECT_START：device/pane 变化时 Terminal 重挂载，
  // 需要让下面的 select 效果重新派发（否则切到其他 device 再切回会命中短路、终端空白）
  const lastDispatchedSelectRef = useRef<string | null>(null);
  useEffect(() => {
    lastDispatchedSelectRef.current = null;
  }, [deviceId, resolvedPaneId]);

  // Select pane when ready
  useEffect(() => {
    if (!deviceId || !windowId || !resolvedPaneId) return;
    // Allow sending TMUX_SELECT before WS is READY: borsh client will queue messages and flush on READY.
    // Note: We don't check isSelectionInvalid here because when user navigates via URL,
    // the snapshot may not yet reflect the new window, but we should still send the select command.
    if (isLoading || !deviceConnected) return;

    const dispatchKey = `${deviceId}:${windowId}:${resolvedPaneId}`;
    if (lastDispatchedSelectRef.current === dispatchKey) {
      return;
    }
    lastDispatchedSelectRef.current = dispatchKey;

    const size = getSelectSize(windowId, resolvedPaneId);
    recordSelectRequest(windowId, resolvedPaneId);
    selectPane(deviceId, windowId, resolvedPaneId, size);
  }, [deviceConnected, deviceId, getSelectSize, isLoading, resolvedPaneId, selectPane, windowId]);

  // Treat explicit route selection as authoritative until snapshot/runtime catches up.
  useEffect(() => {
    if (!deviceId || !deviceConnected || !windowId || !resolvedPaneId) {
      return;
    }

    const routeTarget = { windowId, paneId: resolvedPaneId };
    if (
      !shouldTrackPendingRouteSelection({
        routeTarget,
        snapshotActive: snapshotActiveSelection,
        pendingUserSelection: userInitiatedSelectionRef.current,
      })
    ) {
      return;
    }

    userInitiatedSelectionRef.current = {
      windowId: routeTarget.windowId,
      paneId: routeTarget.paneId,
      at: Date.now(),
    };
  }, [deviceConnected, deviceId, resolvedPaneId, snapshotActiveSelection, windowId]);

  const recentSelectRequestsRef = useRef<Array<{ windowId: string; paneId: string; at: number }>>(
    []
  );
  const recordSelectRequest = useCallback((windowId: string, paneId: string) => {
    const now = Date.now();
    const next = [
      ...recentSelectRequestsRef.current.filter((r) => now - r.at < 2000),
      { windowId, paneId, at: now },
    ];
    recentSelectRequestsRef.current = next.slice(-8);
  }, []);

  // Subscribe to activePaneFromEvent for this device
  const activePaneFromEvent = useTmuxStore((state) =>
    deviceId ? state.activePaneFromEvent[deviceId] : undefined
  );

  // Follow active pane from event/tmux pane-active
  const lastHandledActiveRef = useRef<{ windowId: string; paneId: string } | null>(null);
  useEffect(() => {
    if (!deviceId) return;
    if (!deviceConnected) return;
    if (!windowId || !resolvedPaneId) return;
    if (!activePaneFromEvent) return;

    const now = Date.now();
    const pendingUserSelection = resolvePendingUserSelection(
      userInitiatedSelectionRef.current,
      now
    );
    userInitiatedSelectionRef.current = pendingUserSelection;

    if (
      shouldIgnoreActivePaneEvent({
        now,
        pendingUserSelection,
        activePaneFromEvent,
        currentRoute: { windowId, paneId: resolvedPaneId },
        recentSelectRequests: recentSelectRequestsRef.current,
        lastHandledActive: lastHandledActiveRef.current,
      })
    ) {
      return;
    }

    lastHandledActiveRef.current = { ...activePaneFromEvent };
    if (
      pendingUserSelection &&
      pendingUserSelection.windowId === activePaneFromEvent.windowId &&
      pendingUserSelection.paneId === activePaneFromEvent.paneId
    ) {
      userInitiatedSelectionRef.current = null;
    }

    // Send selectPane to gateway first
    const size = getSelectSize(activePaneFromEvent.windowId, activePaneFromEvent.paneId);
    recordSelectRequest(activePaneFromEvent.windowId, activePaneFromEvent.paneId);
    selectPane(deviceId, activePaneFromEvent.windowId, activePaneFromEvent.paneId, size);

    // Navigate to new URL
    navigate(
      `/devices/${deviceId}/windows/${activePaneFromEvent.windowId}/panes/${encodePaneIdForUrl(activePaneFromEvent.paneId)}`,
      { replace: true }
    );
  }, [
    deviceId,
    deviceConnected,
    windowId,
    resolvedPaneId,
    activePaneFromEvent,
    recordSelectRequest,
    getSelectSize,
    selectPane,
    navigate,
  ]);

  // Fallback: follow active from snapshot (for environments without pane-active event)
  const lastSnapshotActiveRef = useRef<{ windowId: string; paneId: string } | null>(null);
  useEffect(() => {
    if (!deviceId) return;
    if (!deviceConnected) return;
    if (!windows || windows.length === 0) return;

    // Avoid snapshot-driven "bounce back" shortly after we send TMUX_SELECT.
    const recentRequests = recentSelectRequestsRef.current;
    const activeWindow = windows.find((w) => w.active);
    if (!activeWindow) return;

    const activePane = activeWindow.panes.find((p) => p.active);
    if (!activePane) return;

    const currentActive = { windowId: activeWindow.id, paneId: activePane.id };
    const now = Date.now();
    const pendingUserSelection = resolvePendingUserSelection(
      userInitiatedSelectionRef.current,
      now
    );
    userInitiatedSelectionRef.current = pendingUserSelection;

    if (
      shouldSkipSnapshotFollow({
        now,
        pendingUserSelection,
        snapshotActive: currentActive,
        recentSelectRequests: recentRequests,
      })
    ) {
      return;
    }

    // Only follow when active actually changes
    if (
      lastSnapshotActiveRef.current &&
      lastSnapshotActiveRef.current.windowId === currentActive.windowId &&
      lastSnapshotActiveRef.current.paneId === currentActive.paneId
    ) {
      return;
    }

    // Update ref
    lastSnapshotActiveRef.current = { ...currentActive };
    if (
      pendingUserSelection &&
      pendingUserSelection.windowId === currentActive.windowId &&
      pendingUserSelection.paneId === currentActive.paneId
    ) {
      userInitiatedSelectionRef.current = null;
    }

    // If current URL matches, no need to navigate
    if (windowId === currentActive.windowId && resolvedPaneId === currentActive.paneId) {
      return;
    }

    // Send selectPane and navigate
    const size = getSelectSize(currentActive.windowId, currentActive.paneId);
    recordSelectRequest(currentActive.windowId, currentActive.paneId);
    selectPane(deviceId, currentActive.windowId, currentActive.paneId, size);
    navigate(
      `/devices/${deviceId}/windows/${currentActive.windowId}/panes/${encodePaneIdForUrl(currentActive.paneId)}`,
      { replace: true }
    );
  }, [
    deviceId,
    deviceConnected,
    windows,
    windowId,
    resolvedPaneId,
    recordSelectRequest,
    getSelectSize,
    selectPane,
    navigate,
  ]);

  // Force-follow snapshot active after a user-initiated createWindow.
  // Wait for a snapshot whose active differs from the URL (proving the new
  // window is reflected), then navigate there.
  const pendingCreateWindowAt = useTmuxStore((state) =>
    deviceId ? state.pendingCreateWindowAt[deviceId] : undefined
  );
  useEffect(() => {
    if (!deviceId) return;
    if (!deviceConnected) return;
    if (!pendingCreateWindowAt) return;

    const ttlMs = 5000;
    const elapsed = Date.now() - pendingCreateWindowAt;
    if (elapsed > ttlMs) {
      useTmuxStore.getState().clearPendingCreateWindow(deviceId);
      return;
    }

    if (!snapshotActiveSelection) {
      const timer = window.setTimeout(() => {
        useTmuxStore.getState().clearPendingCreateWindow(deviceId);
      }, ttlMs - elapsed);
      return () => window.clearTimeout(timer);
    }

    const target = snapshotActiveSelection;
    if (windowId === target.windowId && resolvedPaneId === target.paneId) {
      const timer = window.setTimeout(() => {
        useTmuxStore.getState().clearPendingCreateWindow(deviceId);
      }, ttlMs - elapsed);
      return () => window.clearTimeout(timer);
    }

    userInitiatedSelectionRef.current = {
      windowId: target.windowId,
      paneId: target.paneId,
      at: Date.now(),
    };
    const size = getSelectSize(target.windowId, target.paneId);
    recordSelectRequest(target.windowId, target.paneId);
    selectPane(deviceId, target.windowId, target.paneId, size);
    navigate(
      `/devices/${deviceId}/windows/${target.windowId}/panes/${encodePaneIdForUrl(target.paneId)}`,
      { replace: true }
    );
    useTmuxStore.getState().clearPendingCreateWindow(deviceId);
  }, [
    deviceId,
    deviceConnected,
    pendingCreateWindowAt,
    snapshotActiveSelection,
    windowId,
    resolvedPaneId,
    recordSelectRequest,
    getSelectSize,
    selectPane,
    navigate,
  ]);

  // Sync pane size from remote
  useEffect(() => {
    if (!canInteractWithPane || !selectedPane || isLoading) return;

    const terminal = terminalRef.current;
    const term = terminal?.getTerminal();
    if (!term) return;

    const remoteCols = Math.max(2, Math.floor(selectedPane.width || 0));
    const remoteRows = Math.max(2, Math.floor(selectedPane.height || 0));
    if (!remoteCols || !remoteRows) return;

    const now = Date.now();
    const remoteSize = { cols: remoteCols, rows: remoteRows };
    const pendingLocalSize = terminal?.getPendingLocalSize() ?? null;
    if (
      !shouldApplyRemotePaneSize({
        now,
        remoteSize,
        pendingLocalSize,
      })
    ) {
      return;
    }

    if (term.cols === remoteCols && term.rows === remoteRows) {
      return;
    }

    term.resize(remoteCols, remoteRows);
  }, [canInteractWithPane, isLoading, selectedPane]);

  // Scroll to bottom on input mode change
  useEffect(() => {
    void inputMode;
    const rafId = window.requestAnimationFrame(() => {
      terminalRef.current?.scrollToBottom();
    });
    const timerId = window.setTimeout(() => {
      terminalRef.current?.scrollToBottom();
    }, 120);

    return () => {
      window.cancelAnimationFrame(rafId);
      window.clearTimeout(timerId);
    };
  }, [inputMode]);

  // Device error toast
  useEffect(() => {
    if (!deviceError?.message) {
      return;
    }

    toast.error(deviceError.message);
  }, [deviceError?.message]);

  // Page title
  useEffect(() => {
    document.title = buildBrowserTitle(terminalTopbarLabel);
    return () => {
      document.title = siteName;
    };
  }, [siteName, terminalTopbarLabel]);

  // Jump to latest event
  useEffect(() => {
    const handler = () => {
      terminalRef.current?.scrollToBottom();
    };

    window.addEventListener('tmex:jump-to-latest', handler as EventListener);
    return () => {
      window.removeEventListener('tmex:jump-to-latest', handler as EventListener);
    };
  }, []);

  // Listen for user-initiated selection from sidebar
  useEffect(() => {
    const handler = (
      event: CustomEvent<{ deviceId: string; windowId: string; paneId: string }>
    ) => {
      const { deviceId: eventDeviceId, windowId, paneId } = event.detail;
      // Only track if it's for the current device
      // Note: when switching devices, refs are reset in the deviceId effect above
      if (eventDeviceId === deviceId) {
        userInitiatedSelectionRef.current = { windowId, paneId, at: Date.now() };
      }
    };

    window.addEventListener('tmex:user-initiated-selection', handler as EventListener);
    return () => {
      window.removeEventListener('tmex:user-initiated-selection', handler as EventListener);
    };
  }, [deviceId]);

  // Sync editor draft
  useEffect(() => {
    setEditorText(paneEditorDraft);
  }, [paneEditorDraft]);

  const handleSendShortcut = useCallback(
    (payload: string) => {
      if (!deviceId || !resolvedPaneId || !canInteractWithPane) {
        return;
      }

      // Send directly to the terminal's input handler
      const store = useTmuxStore.getState();
      store.sendInput(deviceId, resolvedPaneId, payload, false);
    },
    [canInteractWithPane, deviceId, resolvedPaneId]
  );

  const handleActivateShortcut = useCallback(
    (item: TerminalShortcutItem) => {
      // 纯前端 UI 动作：不依赖后端连接 / 有效 pane，先于 canInteractWithPane 守卫处理
      if (item.type === 'action') {
        if (item.action === 'toggleKeyboard') {
          useUIStore.getState().setInputMode(inputMode === 'direct' ? 'editor' : 'direct');
          return;
        }
        if (item.action === 'scrollToBottom') {
          terminalRef.current?.scrollToBottom();
          return;
        }
      }
      if (item.type === 'send') {
        if (item.payload) {
          handleSendShortcut(item.payload);
        }
        return;
      }
      // 需要有效设备 / pane 的动作（paste / newAgentSession）
      if (!deviceId || !resolvedPaneId || !canInteractWithPane) {
        return;
      }
      switch (item.action) {
        case 'paste': {
          // 非安全上下文（HTTP 局域网直连）/ 不支持 Clipboard 时给出明确错误而非静默
          const read = navigator.clipboard?.readText
            ? navigator.clipboard.readText()
            : Promise.reject(new Error('clipboard unavailable'));
          read
            .then((text) => {
              if (text) {
                useTmuxStore.getState().paste(deviceId, resolvedPaneId, text);
              }
            })
            .catch(() => toast.error(t('terminal.pasteFailed')));
          break;
        }
        case 'newAgentSession':
          useAgentStore.getState().startDraft(deviceId, resolvedPaneId, null);
          useUIStore.getState().setSidebarCollapsed(false);
          useUIStore.getState().setSidebarTab('agent');
          break;
        default:
          break;
      }
    },
    [canInteractWithPane, deviceId, handleSendShortcut, inputMode, resolvedPaneId, t]
  );

  const handleEditorSend = useCallback(() => {
    if (!canInteractWithPane) {
      toast.error(t('wsError.checkGateway'));
      return;
    }
    if (!deviceId || !resolvedPaneId) return;
    if (!editorText.trim()) return;

    setIsSending(true);
    window.setTimeout(() => setIsSending(false), 150);

    const payload = editorSendWithEnter ? `${editorText}\r` : editorText;
    const store = useTmuxStore.getState();
    store.sendInput(deviceId, resolvedPaneId, payload, false);
    addEditorHistory(editorText);
    if (draftKey) {
      removeEditorDraft(draftKey);
    }
    setEditorText('');
  }, [
    addEditorHistory,
    canInteractWithPane,
    deviceId,
    draftKey,
    editorSendWithEnter,
    editorText,
    removeEditorDraft,
    resolvedPaneId,
    t,
  ]);

  const handleEditorSendLineByLine = useCallback(() => {
    if (!canInteractWithPane) {
      toast.error(t('wsError.checkGateway'));
      return;
    }
    if (!deviceId || !resolvedPaneId) return;
    if (!editorText.trim()) return;

    setIsSending(true);
    window.setTimeout(() => setIsSending(false), 150);

    const lines = editorText.split(/\r?\n/);
    const store = useTmuxStore.getState();
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      store.sendInput(deviceId, resolvedPaneId, `${line}\r`, false);
    }

    addEditorHistory(editorText);
    if (draftKey) {
      removeEditorDraft(draftKey);
    }
    setEditorText('');
  }, [
    addEditorHistory,
    canInteractWithPane,
    deviceId,
    draftKey,
    editorText,
    removeEditorDraft,
    resolvedPaneId,
    t,
  ]);

  // 聚焦编辑器回调 - 必须在所有早期 return 之前定义
  const handleFocusEditor = useCallback(() => {
    editorTextareaRef.current?.focus({ preventScroll: true });
  }, []);

  if (!deviceId) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <div className="rounded-lg border border-dashed border-border px-4 py-3 text-sm text-muted-foreground">
          {t('device.noDevices')}
        </div>
      </div>
    );
  }

  // 重连期间保持 Terminal 挂载，避免 xterm 卸载导致已有内容消失（issue: 重连要看得清已有内容）。
  const showTerminal =
    Boolean(resolvedPaneId) && !isSelectionInvalid && (deviceConnected || isReconnecting);
  // 已连接、URL 指定了 pane，但 snapshot 尚未解析出它（且不是 not-found）→ 仍在加载，内容本就空白。
  const isResolvingSnapshot =
    deviceConnected && Boolean(resolvedPaneId) && !isSelectionInvalid && !selectedPane;
  // 有连接意图但尚未 ack、无错误、非重连 → 初次连接中，显示 loading 而非误导性的「已断开」。
  const isConnecting = hasConnectIntent && !deviceConnected && !deviceError && !isReconnecting;

  const connectingPlaceholder = (
    <>
      <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center mx-auto">
        <Loader2 className="h-6 w-6 text-muted-foreground animate-spin" />
      </div>
      <h3 className="text-lg font-medium">{t('terminal.connecting')}</h3>
    </>
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-background" data-testid="device-page">
      <div
        className={`flex-1 relative overflow-hidden min-h-0 min-w-0 ${
          isMobile && inputMode === 'editor' ? 'pb-1' : ''
        }`}
      >
        <div
          className="h-full px-3 py-1 min-h-0 min-w-0 w-full relative flex rounded-xl"
          style={{ backgroundColor: terminalTheme.background }}
        >
          {isSelectionInvalid ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center p-8 text-center">
              <div className="max-w-sm space-y-4">
                <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center mx-auto">
                  <SearchX className="h-6 w-6 text-muted-foreground" />
                </div>
                <p
                  className="text-sm text-muted-foreground"
                  data-testid="terminal-selection-invalid"
                >
                  {invalidSelectionMessage}
                </p>
              </div>
            </div>
          ) : showTerminal && resolvedPaneId ? (
            <div
              ref={terminalContainerRef}
              className="flex-1 h-full min-h-0 w-full"
              data-virtual-keyboard-avoid
            >
              <TerminalComponent
                key={`${deviceId}:${resolvedPaneId}`}
                ref={terminalRef}
                deviceId={deviceId}
                paneId={resolvedPaneId}
                theme={uiTheme}
                inputMode={inputMode}
                deviceConnected={deviceConnected}
                isSelectionInvalid={isSelectionInvalid}
                onResize={handleResize}
                onSync={handleSync}
              >
                {/* direct 模式：快捷键栏拼在终端可视区域下方，与终端共用 seoul256 配色。
                    follow 键盘模式弹起时，外层 .kb-floating-shortcuts 按 --tmex-kb-shortcut-lift
                    把这排快捷键 translateY 浮到键盘正上方（不脱流，故不触发终端 resize）。 */}
                {inputMode === 'direct' && (
                  <div
                    className="kb-floating-shortcuts"
                    style={{ backgroundColor: terminalTheme.background }}
                  >
                    <ShortcutsBar
                      onActivate={handleActivateShortcut}
                      disabled={!canInteractWithPane}
                    />
                  </div>
                )}
              </TerminalComponent>
            </div>
          ) : (
            <div className="absolute inset-0 flex flex-col items-center justify-center p-8 text-center">
              <div className="max-w-sm space-y-4">
                {isConnecting ? (
                  connectingPlaceholder
                ) : !deviceConnected && !isReconnecting ? (
                  <>
                    <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center mx-auto">
                      <span className="text-2xl text-muted-foreground">🔌</span>
                    </div>
                    <h3 className="text-lg font-medium">{t('device.disconnected')}</h3>
                    <p className="text-sm text-muted-foreground">{t('device.connectToStart')}</p>
                  </>
                ) : !windowId ? (
                  <>
                    <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center mx-auto">
                      <span className="text-2xl text-muted-foreground">📋</span>
                    </div>
                    <h3 className="text-lg font-medium">{t('window.noWindowSelected')}</h3>
                    <p className="text-sm text-muted-foreground">
                      {t('window.selectWindowToStart')}
                    </p>
                  </>
                ) : (
                  connectingPlaceholder
                )}
              </div>
            </div>
          )}
          {/* 重连指示：非遮挡、置顶居中，保持已有终端内容可见 */}
          {isReconnecting && (
            <div
              className="pointer-events-none absolute inset-x-0 top-2 z-10 flex justify-center"
              data-testid="terminal-reconnecting-indicator"
            >
              <DeviceStatusBadge deviceId={deviceId} className="shadow-sm" />
            </div>
          )}

          {/* loading：已连接但 snapshot 尚未解析出该 pane（内容本就空白，用遮罩 spinner） */}
          {isResolvingSnapshot && (
            <div
              className="absolute inset-0 flex items-center justify-center bg-background/85 backdrop-blur-sm"
              data-testid="terminal-status-overlay"
            >
              <div className="flex flex-col items-center gap-2 rounded-lg border border-border bg-card/90 px-4 py-3 shadow-sm">
                <div className="h-7 w-7 rounded-full border-2 border-primary border-t-transparent animate-spin" />
                <span className="text-xs text-muted-foreground" data-testid="terminal-status-text">
                  {t('terminal.connecting')}
                </span>
              </div>
            </div>
          )}
        </div>
      </div>

      {inputMode === 'editor' && (
        <div
          ref={editorContainerRef}
          data-virtual-keyboard-avoid
          className="editor-mode-input bg-card/85 backdrop-blur-sm"
        >
          {/* 移动端 editor 模式：快捷键栏在编辑器上方 */}
          {isMobile && (
            <ShortcutsBar
              onActivate={(item) => {
                handleActivateShortcut(item);
                if (item.type === 'send') {
                  handleFocusEditor();
                }
              }}
              disabled={!canInteractWithPane}
            />
          )}
          <textarea
            ref={editorTextareaRef}
            data-testid="editor-input"
            className="min-h-[88px] max-h-[28vh] w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground shadow-xs outline-none transition-colors focus:border-ring"
            value={editorText}
            onChange={(e) => {
              const nextText = e.target.value;
              setEditorText(nextText);
              if (!draftKey) {
                return;
              }
              if (nextText) {
                setEditorDraft(draftKey, nextText);
                return;
              }
              removeEditorDraft(draftKey);
            }}
            placeholder={t('terminal.inputPlaceholder')}
            onCompositionStart={() => {
              isComposingRef.current = true;
            }}
            onCompositionEnd={() => {
              isComposingRef.current = false;
            }}
          />
          <div className="actions mt-2">
            <div
              className="send-row flex flex-wrap items-center justify-end gap-2"
              data-testid="editor-send-row"
            >
              <div
                className="send-with-enter-toggle mr-auto flex items-center gap-2 text-xs text-muted-foreground"
                data-testid="editor-send-with-enter-toggle"
              >
                <Switch
                  size="sm"
                  checked={editorSendWithEnter}
                  onCheckedChange={(checked) => setEditorSendWithEnter(Boolean(checked))}
                />
                <span>{t('terminal.editorSendWithEnter')}</span>
              </div>
              <Button
                variant="outline"
                size="sm"
                data-testid="editor-clear"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  setEditorText('');
                  if (draftKey) {
                    removeEditorDraft(draftKey);
                  }
                  if (isMobile && inputMode === 'editor') {
                    editorTextareaRef.current?.focus({ preventScroll: true });
                  }
                }}
                title={t('terminal.clear')}
              >
                <Trash2 className="h-4 w-4" />
                {t('terminal.clear')}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                data-testid="editor-send-line-by-line"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  handleEditorSendLineByLine();
                  if (isMobile && inputMode === 'editor') {
                    editorTextareaRef.current?.focus({ preventScroll: true });
                  }
                }}
                disabled={!canInteractWithPane || isSending}
              >
                {isSending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
                {t('terminal.editorSendLineByLine')}
              </Button>
              <Button
                variant="default"
                size="sm"
                data-testid="editor-send"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  handleEditorSend();
                  if (isMobile && inputMode === 'editor') {
                    editorTextareaRef.current?.focus({ preventScroll: true });
                  }
                }}
                disabled={!canInteractWithPane || isSending}
              >
                {isSending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
                {t('common.send')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Page title component - shows terminal label
export function PageTitle() {
  const { deviceId, windowId, paneId } = useParams();
  const resolvedPaneId = paneId ? decodePaneIdFromUrlParam(paneId) : undefined;
  const snapshots = useTmuxStore((state) => state.snapshots);
  const siteName = useSiteStore((state) => state.settings?.siteName ?? 'tmex');

  const snapshot = deviceId ? snapshots[deviceId] : undefined;
  const selectedWindow = useMemo(() => {
    if (!windowId || !snapshot?.session?.windows) return undefined;
    return snapshot.session.windows.find((w) => w.id === windowId);
  }, [windowId, snapshot]);

  const selectedPane = useMemo(() => {
    if (!resolvedPaneId || !selectedWindow) return undefined;
    return selectedWindow.panes.find((p) => p.id === resolvedPaneId);
  }, [resolvedPaneId, selectedWindow]);

  const title = useMemo(() => {
    if (selectedWindow && selectedPane) {
      return buildTerminalLabel({
        paneIdx: selectedPane.index,
        windowIdx: selectedWindow.index,
        paneTitle: selectedPane.title,
        windowName: selectedWindow.name,
        windowCustomName: selectedWindow.customName,
        deviceName: siteName,
      });
    }
    return deviceId ?? '';
  }, [selectedWindow, selectedPane, siteName, deviceId]);

  return <>{title}</>;
}

// Page actions component - shows input mode toggle, jump to latest and refresh page
export function PageActions() {
  const { t } = useTranslation();
  const { deviceId, paneId } = useParams();
  const resolvedPaneId = paneId ? decodePaneIdFromUrlParam(paneId) : undefined;
  const inputMode = useUIStore((state) => state.inputMode);
  const setInputMode = useUIStore((state) => state.setInputMode);
  const deviceConnected = useTmuxStore((state) =>
    deviceId ? (state.deviceConnected?.[deviceId] ?? false) : false
  );

  const [showRefreshConfirm, setShowRefreshConfirm] = useState(false);
  const [showWatchDialog, setShowWatchDialog] = useState(false);
  const [showTerminalSettings, setShowTerminalSettings] = useState(false);

  const canInteract = Boolean(resolvedPaneId && deviceConnected);

  const watchRulesQuery = useQuery({
    queryKey: watchRulesQueryKey(deviceId ?? '', resolvedPaneId ?? ''),
    queryFn: () => fetchWatchRules(deviceId ?? '', resolvedPaneId ?? ''),
    enabled: Boolean(deviceId && resolvedPaneId),
    throwOnError: false,
  });
  const hasEnabledWatchRule = (watchRulesQuery.data ?? []).some((rule) => rule.enabled);

  const handleToggleInputMode = () => {
    const newMode = inputMode === 'direct' ? 'editor' : 'direct';
    setInputMode(newMode);
  };

  const handleJumpToLatest = () => {
    window.dispatchEvent(new CustomEvent('tmex:jump-to-latest'));
  };

  const handleRefreshClick = () => {
    setShowRefreshConfirm(true);
  };

  const handleConfirmRefresh = () => {
    window.location.reload();
  };

  return (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={handleRefreshClick}
        aria-label={t('nav.refreshPage')}
        title={t('nav.refreshPage')}
      >
        <RefreshCw className="h-4 w-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={handleToggleInputMode}
        disabled={!canInteract}
        data-testid="terminal-input-mode-toggle"
        aria-label={inputMode === 'direct' ? t('nav.switchToEditor') : t('nav.switchToDirect')}
        title={inputMode === 'direct' ? t('nav.switchToEditor') : t('nav.switchToDirect')}
      >
        {inputMode === 'direct' ? (
          <Keyboard className="h-4 w-4" />
        ) : (
          <Smartphone className="h-4 w-4" />
        )}
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={handleJumpToLatest}
        disabled={!canInteract}
        aria-label={t('nav.jumpToLatest')}
        title={t('nav.jumpToLatest')}
      >
        <ArrowDownToLine className="h-4 w-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        className="relative"
        onClick={() => setShowWatchDialog(true)}
        disabled={!resolvedPaneId}
        data-testid="watch-open-button"
        aria-label={t('watch.title')}
        title={t('watch.title')}
      >
        <Radar className="h-4 w-4" />
        {hasEnabledWatchRule && (
          <span
            className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-primary"
            data-testid="watch-active-indicator"
          />
        )}
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => setShowTerminalSettings(true)}
        data-testid="keyboard-behavior-open-button"
        aria-label={t('settings.terminal.title')}
        title={t('settings.terminal.title')}
      >
        <Settings2 className="h-4 w-4" />
      </Button>

      <TerminalSettingsSheet open={showTerminalSettings} onOpenChange={setShowTerminalSettings} />

      {deviceId && resolvedPaneId && (
        <WatchDialog
          open={showWatchDialog}
          onOpenChange={setShowWatchDialog}
          deviceId={deviceId}
          paneId={resolvedPaneId}
        />
      )}

      <AlertDialog open={showRefreshConfirm} onOpenChange={setShowRefreshConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('nav.refreshPage')}</AlertDialogTitle>
            <AlertDialogDescription>{t('nav.refreshPageConfirm')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setShowRefreshConfirm(false)}>
              {t('common.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmRefresh}>
              {t('common.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
