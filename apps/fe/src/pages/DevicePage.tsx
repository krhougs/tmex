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
import { useQuery } from '@tanstack/react-query';
import type { Device } from '@tmex/shared';
import {
  ArrowDownToLine,
  Keyboard,
  Loader2,
  RefreshCw,
  Send,
  Smartphone,
  Trash2,
} from 'lucide-react';
import { type FocusEvent, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { useSiteStore } from '../stores/site';
import { useTmuxStore } from '../stores/tmux';
import { useUIStore } from '../stores/ui';
import { buildBrowserTitle, buildTerminalLabel } from '../utils/terminalMeta';
import { decodePaneIdFromUrlParam, encodePaneIdForUrl } from '../utils/tmuxUrl';

interface EditorShortcut {
  key: string;
  label: string;
  payload: string;
}

function isIOSMobileBrowser(): boolean {
  if (typeof navigator === 'undefined') {
    return false;
  }

  const userAgent = navigator.userAgent;
  const isIOSDevice = /iPad|iPhone|iPod/.test(userAgent);
  const isTouchMac = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  return isIOSDevice || isTouchMac;
}

const EDITOR_SHORTCUTS: EditorShortcut[] = [
  { key: 'enter', label: 'ENTER', payload: '\r' },
  { key: 'ctrl-c', label: 'CTRL-C', payload: '\u0003' },
  { key: 'ctrl-d', label: 'CTRL-D', payload: '\u0004' },
  { key: 'up', label: '↑', payload: '\u001b[A' },
  { key: 'down', label: '↓', payload: '\u001b[B' },
  { key: 'left', label: '←', payload: '\u001b[D' },
  { key: 'right', label: '→', payload: '\u001b[C' },
  { key: 'shift-enter', label: 'SHIFT+ENTER', payload: '\x1b[13;2u' },
  { key: 'tab', label: 'TAB', payload: '\u0009' },
  { key: 'backspace', label: 'BACKSPACE', payload: '\u0008' },
  { key: 'esc', label: 'ESC', payload: '\u001b' },
  { key: 'delete', label: 'DELETE', payload: '\u007f' },
  { key: ':', label: ':', payload: ':' },
  { key: '/', label: '/', payload: '/' },
  { key: "'", label: "'", payload: "'" },
  { key: '"', label: '"', payload: '"' },
  { key: '`', label: '`', payload: '`' },
];

// ShortcutsBar 组件 - 使用 memo 避免不必要的重绘
interface ShortcutsBarProps {
  onSend: (payload: string) => void;
  onFocusEditor?: () => void;
  disabled: boolean;
  isMobile: boolean;
  inputMode: 'direct' | 'editor';
}

const ShortcutsBar = memo(function ShortcutsBar({
  onSend,
  onFocusEditor,
  disabled,
  isMobile,
  inputMode,
}: ShortcutsBarProps) {
  return (
    <div
      className="terminal-shortcuts-strip my-2 bg-muted rounded-xl"
      data-testid="terminal-shortcuts-strip"
    >
      <div
        className="shortcut-row flex items-center gap-1.5 p-2 overflow-x-auto scrollbar-thin"
        data-testid="editor-shortcuts-row"
      >
        {EDITOR_SHORTCUTS.map((shortcut) => (
          <Button
            key={shortcut.key}
            variant="secondary"
            size="sm"
            className="h-7 min-w-9 px-2.5 rounded-full text-[11px] font-medium tracking-wide shrink-0 [@media(any-pointer:coarse)]:h-9 [@media(any-pointer:coarse)]:min-w-10 [@media(any-pointer:coarse)]:px-3"
            title={shortcut.label}
            aria-label={shortcut.label}
            data-testid={`editor-shortcut-${shortcut.key}`}
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => {
              onSend(shortcut.payload);
              if (isMobile && inputMode === 'editor') {
                onFocusEditor?.();
              }
            }}
            disabled={disabled}
          >
            {shortcut.label}
          </Button>
        ))}
      </div>
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
  const userInitiatedSelectionRef = useRef<{ windowId: string; paneId: string } | null>(null);

  const selectPane = useTmuxStore((state) => state.selectPane);

  const snapshot = useTmuxStore((state) => (deviceId ? state.snapshots[deviceId] : undefined));
  const deviceError = useTmuxStore((state) =>
    deviceId ? state.deviceErrors?.[deviceId] : undefined
  );
  const deviceConnected = useTmuxStore((state) =>
    deviceId ? (state.deviceConnected?.[deviceId] ?? false) : false
  );
  const siteName = useSiteStore((state) => state.settings?.siteName ?? 'tmex');

  const resolvedPaneId = useMemo(() => decodePaneIdFromUrlParam(paneId), [paneId]);
  const draftKey = useMemo(
    () => (deviceId && resolvedPaneId ? `${deviceId}:${resolvedPaneId}` : null),
    [deviceId, resolvedPaneId]
  );

  const [isMobile, setIsMobile] = useState(false);
  const [editorText, setEditorText] = useState('');
  const [isEditorFocused, setIsEditorFocused] = useState(false);
  const isComposingRef = useRef(false);
  // Loading state - false when connected and has pane
  const isLoading = !deviceConnected || !resolvedPaneId;
  const [keyboardInsetBottom, setKeyboardInsetBottom] = useState(0);
  const [editorDockHeight, setEditorDockHeight] = useState(0);
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
  const shouldDockEditor = isMobile && inputMode === 'editor' && isIOSBrowser && isEditorFocused;

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
    ? t('wsError.checkGateway')
    : isPaneMissing
      ? t('wsError.checkGateway')
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
      deviceName,
    });
  }, [currentDevice?.name, deviceId, selectedPane, selectedWindow]);

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

  // Reset editor focus when switching modes
  useEffect(() => {
    if (inputMode !== 'editor') {
      setIsEditorFocused(false);
    }
  }, [inputMode]);

  // iOS keyboard inset handling
  useEffect(() => {
    if (!(isMobile && isIOSBrowser && inputMode === 'editor' && isEditorFocused)) {
      setKeyboardInsetBottom(0);
      return;
    }

    let frameId: number | null = null;
    const updateKeyboardInset = () => {
      const viewport = window.visualViewport;
      const viewportHeight = viewport?.height ?? window.innerHeight;
      const offsetTop = viewport?.offsetTop ?? 0;
      const nextInset = Math.max(0, Math.round(window.innerHeight - viewportHeight - offsetTop));
      setKeyboardInsetBottom(nextInset);
    };

    const scheduleUpdate = () => {
      if (frameId !== null) {
        return;
      }

      frameId = window.requestAnimationFrame(() => {
        frameId = null;
        updateKeyboardInset();
      });
    };

    updateKeyboardInset();

    window.visualViewport?.addEventListener('resize', scheduleUpdate);
    window.visualViewport?.addEventListener('scroll', scheduleUpdate);
    window.addEventListener('resize', scheduleUpdate);

    return () => {
      window.visualViewport?.removeEventListener('resize', scheduleUpdate);
      window.visualViewport?.removeEventListener('scroll', scheduleUpdate);
      window.removeEventListener('resize', scheduleUpdate);
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
    };
  }, [inputMode, isEditorFocused, isIOSBrowser, isMobile]);

  // Editor dock height handling
  useEffect(() => {
    if (!shouldDockEditor) {
      setEditorDockHeight(0);
      return;
    }

    const editorContainer = editorContainerRef.current;
    if (!editorContainer) {
      return;
    }

    const updateEditorHeight = () => {
      setEditorDockHeight(Math.ceil(editorContainer.getBoundingClientRect().height));
    };

    updateEditorHeight();
    const observer = new ResizeObserver(updateEditorHeight);
    observer.observe(editorContainer);

    return () => observer.disconnect();
  }, [shouldDockEditor]);

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

  // Select pane when ready
  useEffect(() => {
    if (!deviceId || !windowId || !resolvedPaneId) return;
    // Allow sending TMUX_SELECT before WS is READY: borsh client will queue messages and flush on READY.
    // Note: We don't check isSelectionInvalid here because when user navigates via URL,
    // the snapshot may not yet reflect the new window, but we should still send the select command.
    if (isLoading || !deviceConnected) return;

    // Short-circuit: if already selected, don't send again
    const currentSelected = useTmuxStore.getState().selectedPanes[deviceId];
    if (
      currentSelected &&
      currentSelected.windowId === windowId &&
      currentSelected.paneId === resolvedPaneId
    ) {
      return;
    }

    const size = terminalRef.current?.calculateSizeFromContainer() ?? undefined;
    recordSelectRequest(windowId, resolvedPaneId);
    selectPane(deviceId, windowId, resolvedPaneId, size);
  }, [deviceConnected, deviceId, isLoading, resolvedPaneId, selectPane, windowId]);

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

    // Ignore pane-active events that are likely confirmations (or stale echoes) of our own recent selects.
    // Without this, rapid user navigation can cause us to "follow back" to an older pane-active event.
    {
      const now = Date.now();
      const isRecentRequested = recentSelectRequestsRef.current.some(
        (r) =>
          r.windowId === activePaneFromEvent.windowId &&
          r.paneId === activePaneFromEvent.paneId &&
          now - r.at < 1200
      );
      if (isRecentRequested) {
        return;
      }
    }

    // Ignore if already at the right place
    if (
      activePaneFromEvent.windowId === windowId &&
      activePaneFromEvent.paneId === resolvedPaneId
    ) {
      return;
    }

    // Avoid duplicate handling
    if (
      lastHandledActiveRef.current &&
      lastHandledActiveRef.current.windowId === activePaneFromEvent.windowId &&
      lastHandledActiveRef.current.paneId === activePaneFromEvent.paneId
    ) {
      return;
    }

    lastHandledActiveRef.current = { ...activePaneFromEvent };

    // Send selectPane to gateway first
    const size = terminalRef.current?.calculateSizeFromContainer() ?? undefined;
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
    selectPane,
    navigate,
  ]);

  // Fallback: follow active from snapshot (for environments without pane-active event)
  const lastSnapshotActiveRef = useRef<{ windowId: string; paneId: string } | null>(null);
  useEffect(() => {
    if (!deviceId) return;
    if (!deviceConnected) return;
    if (!windows || windows.length === 0) return;

    // Skip if user just manually selected a different window/pane
    if (userInitiatedSelectionRef.current) {
      return;
    }

    // Avoid snapshot-driven "bounce back" shortly after we send TMUX_SELECT.
    const recentRequests = recentSelectRequestsRef.current;
    const lastRequest =
      recentRequests.length > 0 ? recentRequests[recentRequests.length - 1] : null;
    if (lastRequest && Date.now() - lastRequest.at < 1200) {
      return;
    }

    const activeWindow = windows.find((w) => w.active);
    if (!activeWindow) return;

    const activePane = activeWindow.panes.find((p) => p.active);
    if (!activePane) return;

    const currentActive = { windowId: activeWindow.id, paneId: activePane.id };

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

    // If current URL matches, no need to navigate
    if (windowId === currentActive.windowId && resolvedPaneId === currentActive.paneId) {
      return;
    }

    // Send selectPane and navigate
    const size = terminalRef.current?.calculateSizeFromContainer() ?? undefined;
    recordSelectRequest(currentActive.windowId, currentActive.paneId);
    selectPane(deviceId, currentActive.windowId, currentActive.paneId, size);
    navigate(
      `/devices/${deviceId}/windows/${currentActive.windowId}/panes/${encodePaneIdForUrl(currentActive.paneId)}`,
      { replace: true }
    );
  }, [deviceId, deviceConnected, windows, windowId, resolvedPaneId, selectPane, navigate]);

  // Sync pane size from remote
  useEffect(() => {
    if (!canInteractWithPane || !selectedPane || isLoading) return;

    const term = terminalRef.current?.getTerminal();
    if (!term) return;

    const remoteCols = Math.max(2, Math.floor(selectedPane.width || 0));
    const remoteRows = Math.max(2, Math.floor(selectedPane.height || 0));
    if (!remoteCols || !remoteRows) return;

    if (term.cols === remoteCols && term.rows === remoteRows) {
      return;
    }

    term.resize(remoteCols, remoteRows);
  }, [canInteractWithPane, isLoading, selectedPane]);

  // Scroll to bottom on input mode change
  useEffect(() => {
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
        userInitiatedSelectionRef.current = { windowId, paneId };
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

  const handleEditorFocus = useCallback(
    (event: FocusEvent<HTMLTextAreaElement>) => {
      setIsEditorFocused(true);

      if (!(isMobile && isIOSBrowser)) {
        return;
      }

      const target = event.currentTarget;
      window.requestAnimationFrame(() => {
        target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      });
      window.setTimeout(() => {
        window.scrollTo(0, 1);
      }, 60);
    },
    [isIOSBrowser, isMobile]
  );

  const handleEditorBlur = useCallback(() => {
    setIsEditorFocused(false);
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

  const showConnecting = !deviceConnected && !deviceError;

  // 聚焦编辑器回调
  const handleFocusEditor = useCallback(() => {
    editorTextareaRef.current?.focus({ preventScroll: true });
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background" data-testid="device-page">
      <div
        className={`flex-1 relative overflow-hidden min-h-0 min-w-0 ${isMobile && inputMode === 'editor' && !shouldDockEditor ? 'pb-1' : ''
          }`}
        style={{
          paddingBottom: shouldDockEditor
            ? `${editorDockHeight + 60}px`
            : undefined
        }}
      >
        <div
          className="h-full px-3 py-1 min-h-0 min-w-0 w-full relative flex rounded-xl"
          style={{ backgroundColor: terminalTheme.background }}
        >

          {deviceConnected && resolvedPaneId ? (
            <div ref={terminalContainerRef} className="flex-1 w-full">
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
              /></div>
          ) : (
            <div className="absolute inset-0 flex flex-col items-center justify-center p-8 text-center">
              <div className="max-w-sm space-y-4">
                {!deviceConnected ? (
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
                  <>
                    <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center mx-auto">
                      <Loader2 className="h-6 w-6 text-muted-foreground animate-spin" />
                    </div>
                    <h3 className="text-lg font-medium">{t('terminal.connecting')}</h3>
                  </>
                )}
              </div>
            </div>
          )}
        </div>

        {showConnecting && (
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

      {/* 快捷键栏：PC端和移动端 direct 模式都在终端下方 */}
      {inputMode === 'direct' && (
        <div className="">
          <ShortcutsBar
            onSend={handleSendShortcut}
            disabled={!canInteractWithPane}
            isMobile={isMobile}
            inputMode={inputMode}
          />
        </div>
      )}

      {inputMode === 'editor' && (
        <div
          ref={editorContainerRef}
          className={`editor-mode-input bg-card/85 backdrop-blur-sm ${shouldDockEditor ? 'fixed left-0 right-0 z-50' : ''
            }`}
          style={shouldDockEditor ? { bottom: `${keyboardInsetBottom}px` } : undefined}
        >
          {/* 移动端 editor 模式：快捷键栏在编辑器上方 */}
          {isMobile && (
            <ShortcutsBar
              onSend={handleSendShortcut}
              onFocusEditor={handleFocusEditor}
              disabled={!canInteractWithPane}
              isMobile={isMobile}
              inputMode={inputMode}
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
            onFocus={handleEditorFocus}
            onBlur={handleEditorBlur}
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
                onPointerDown={(e) => e.preventDefault()}
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
                onPointerDown={(e) => e.preventDefault()}
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
                onPointerDown={(e) => e.preventDefault()}
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

  const canInteract = Boolean(resolvedPaneId && deviceConnected);

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
