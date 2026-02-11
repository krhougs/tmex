import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { Unicode11Addon } from 'xterm-addon-unicode11';
import 'xterm/css/xterm.css';
import { useQuery } from '@tanstack/react-query';
import type { Device } from '@tmex/shared';
import { ArrowDownToLine, Keyboard, Send, Smartphone, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '../components/ui';
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

function normalizeHistoryForXterm(data: string): string {
  if (!data) return data;
  return data.replace(/\r?\n/g, '\r\n');
}

function normalizeLiveOutputForXterm(
  data: Uint8Array,
  previousEndedWithCR: boolean
): { normalized: Uint8Array; endedWithCR: boolean } {
  let prevWasCR = previousEndedWithCR;
  let extraCRCount = 0;

  for (const byte of data) {
    if (byte === 0x0a && !prevWasCR) {
      extraCRCount += 1;
    }
    prevWasCR = byte === 0x0d;
  }

  const endedWithCR = prevWasCR;
  if (extraCRCount === 0) {
    return { normalized: data, endedWithCR };
  }

  const normalized = new Uint8Array(data.length + extraCRCount);
  let writeIndex = 0;
  prevWasCR = previousEndedWithCR;

  for (const byte of data) {
    if (byte === 0x0a && !prevWasCR) {
      normalized[writeIndex] = 0x0d;
      writeIndex += 1;
    }
    normalized[writeIndex] = byte;
    writeIndex += 1;
    prevWasCR = byte === 0x0d;
  }

  return { normalized, endedWithCR };
}

const EDITOR_SHORTCUTS: EditorShortcut[] = [
  { key: 'ctrl-c', label: 'CTRL-C', payload: '\u0003' },
  { key: 'ctrl-d', label: 'CTRL-D', payload: '\u0004' },
  { key: 'home', label: 'HOME', payload: '\u001b[H' },
  { key: 'end', label: 'END', payload: '\u001b[F' },
  { key: 'page-up', label: 'PAGE-UP', payload: '\u001b[5;2~' },
  { key: 'page-down', label: 'PAGE-DOWN', payload: '\u001b[6;2~' },
  { key: 'tab', label: 'TAB', payload: '\u0009' },
  { key: 'esc', label: 'ESC', payload: '\u001b' },
  { key: 'shift-enter', label: 'SHIFT+ENTER', payload: '\x1b[13;2u' },
  { key: ':', label: ':', payload: ':' },
  { key: '/', label: '/', payload: '/' },
  { key: "'", label: "'", payload: "'" },
  { key: '"', label: '"', payload: '"' },
  { key: '`', label: '`', payload: '`' },
  { key: 'backspace', label: 'BACKSPACE', payload: '\u0008' },
  { key: 'delete', label: 'DELETE', payload: '\u007f' },
  { key: 'up', label: '↑', payload: '\u001b[A' },
  { key: 'down', label: '↓', payload: '\u001b[B' },
  { key: 'left', label: '←', payload: '\u001b[D' },
  { key: 'right', label: '→', payload: '\u001b[C' },
  { key: 'enter', label: 'ENTER', payload: '\r' },
];

export function DevicePage() {
  const { t } = useTranslation();
  const { deviceId, windowId, paneId } = useParams();
  const navigate = useNavigate();
  const terminalRef = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const fitAddon = useRef<FitAddon | null>(null);
  const autoSelected = useRef(false);
  const historyBuffer = useRef<Uint8Array[]>([]);
  const isTerminalReady = useRef(false);

  const paneSessionId = useRef(0);
  const pendingHistory = useRef<{ sessionId: number; data: string } | null>(null);
  const historyApplied = useRef(false);
  const initialReplayReady = useRef(false);
  const historyFallbackTimer = useRef<number | null>(null);
  const liveOutputEndedWithCR = useRef(false);

  const resizeRaf = useRef<number | null>(null);
  const resizeTimer = useRef<number | null>(null);
  const lastReportedSize = useRef<{ cols: number; rows: number } | null>(null);
  const pendingLocalSize = useRef<{ cols: number; rows: number; at: number } | null>(null);
  const suppressLocalResizeUntil = useRef(0);
  const postSelectResizeTimers = useRef<number[]>([]);
  const invalidToastTimer = useRef<number | null>(null);
  const latestInvalidSelectionKey = useRef<string | null>(null);
  const lastShownInvalidSelectionKey = useRef<string | null>(null);

  const connectDevice = useTmuxStore((state) => state.connectDevice);
  const disconnectDevice = useTmuxStore((state) => state.disconnectDevice);
  const selectPane = useTmuxStore((state) => state.selectPane);
  const sendInput = useTmuxStore((state) => state.sendInput);
  const resizePane = useTmuxStore((state) => state.resizePane);
  const syncPaneSize = useTmuxStore((state) => state.syncPaneSize);
  const subscribeBinary = useTmuxStore((state) => state.subscribeBinary);
  const subscribeHistory = useTmuxStore((state) => state.subscribeHistory);

  const snapshot = useTmuxStore((state) => (deviceId ? state.snapshots[deviceId] : undefined));
  const deviceError = useTmuxStore((state) =>
    deviceId ? state.deviceErrors?.[deviceId] : undefined
  );
  const deviceConnected = useTmuxStore((state) =>
    deviceId ? state.deviceConnected?.[deviceId] : false
  );
  const lastConnectRequest = useTmuxStore((state) => state.lastConnectRequest);
  const socketReady = useTmuxStore((state) => state.socketReady);
  const siteName = useSiteStore((state) => state.settings?.siteName ?? 'tmex');

  const resolvedPaneId = useMemo(() => decodePaneIdFromUrlParam(paneId), [paneId]);
  const draftKey = useMemo(
    () => (deviceId && resolvedPaneId ? `${deviceId}:${resolvedPaneId}` : null),
    [deviceId, resolvedPaneId]
  );

  const [isMobile, setIsMobile] = useState(false);
  const [editorText, setEditorText] = useState('');
  const [isComposing, setIsComposing] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const inputMode = useUIStore((state) => state.inputMode);
  const editorSendWithEnter = useUIStore((state) => state.editorSendWithEnter);
  const setEditorSendWithEnter = useUIStore((state) => state.setEditorSendWithEnter);
  const addEditorHistory = useUIStore((state) => state.addEditorHistory);
  const setEditorDraft = useUIStore((state) => state.setEditorDraft);
  const removeEditorDraft = useUIStore((state) => state.removeEditorDraft);
  const paneEditorDraft = useUIStore((state) =>
    draftKey ? (state.editorDrafts[draftKey] ?? '') : ''
  );

  const windows = snapshot?.session?.windows;

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
  const invalidSelectionKey = useMemo(() => {
    if (!invalidSelectionMessage || !deviceId || !windowId || !resolvedPaneId) {
      return null;
    }
    return `${deviceId}:${windowId}:${resolvedPaneId}:${invalidSelectionMessage}`;
  }, [deviceId, invalidSelectionMessage, resolvedPaneId, windowId]);
  const canInteractWithPane = Boolean(deviceConnected && resolvedPaneId && !isSelectionInvalid);

  const isLocalDevRuntime =
    typeof window !== 'undefined' &&
    (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');

  useEffect(() => {
    if (!isLocalDevRuntime || !deviceId) {
      return;
    }

    if (!lastConnectRequest) {
      return;
    }

    if (lastConnectRequest.deviceId !== deviceId) {
      console.warn('[tmux] route device mismatch with last connect request', {
        routeDeviceId: deviceId,
        lastConnectRequest,
      });
    }
  }, [deviceId, isLocalDevRuntime, lastConnectRequest]);

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

  const reportPaneSize = useCallback(
    (kind: 'resize' | 'sync', force = false) => {
      if (!deviceId || !resolvedPaneId || !deviceConnected || isSelectionInvalid) {
        return false;
      }

      if (!force && Date.now() < suppressLocalResizeUntil.current) {
        return false;
      }

      const term = terminal.current;
      if (!term) {
        return false;
      }

      fitAddon.current?.fit();

      const cols = Math.max(2, term.cols);
      const rows = Math.max(2, term.rows);
      const lastSize = lastReportedSize.current;
      if (!force && lastSize && lastSize.cols === cols && lastSize.rows === rows) {
        return true;
      }

      if (kind === 'sync') {
        syncPaneSize(deviceId, resolvedPaneId, cols, rows);
      } else {
        resizePane(deviceId, resolvedPaneId, cols, rows);
      }

      lastReportedSize.current = { cols, rows };
      pendingLocalSize.current = { cols, rows, at: Date.now() };
      return true;
    },
    [deviceConnected, deviceId, isSelectionInvalid, resizePane, resolvedPaneId, syncPaneSize]
  );

  const scheduleResize = useCallback(
    (
      kind: 'resize' | 'sync' = 'resize',
      options: { immediate?: boolean; force?: boolean } = {}
    ) => {
      const { immediate = false, force = false } = options;

      if (resizeTimer.current !== null) {
        window.clearTimeout(resizeTimer.current);
        resizeTimer.current = null;
      }

      if (resizeRaf.current !== null) {
        cancelAnimationFrame(resizeRaf.current);
        resizeRaf.current = null;
      }

      const run = () => {
        resizeRaf.current = requestAnimationFrame(() => {
          resizeRaf.current = null;
          reportPaneSize(kind, force);
        });
      };

      if (immediate) {
        run();
        return;
      }

      resizeTimer.current = window.setTimeout(() => {
        resizeTimer.current = null;
        run();
      }, 80);
    },
    [reportPaneSize]
  );

  const clearPostSelectResizeTimers = useCallback(() => {
    for (const timerId of postSelectResizeTimers.current) {
      window.clearTimeout(timerId);
    }
    postSelectResizeTimers.current = [];
  }, []);

  const runPostSelectResize = useCallback(() => {
    clearPostSelectResizeTimers();
    scheduleResize('sync', { immediate: true, force: true });

    const retryId = window.setTimeout(() => {
      scheduleResize('sync', { immediate: true, force: true });
    }, 60);
    postSelectResizeTimers.current.push(retryId);

    if (typeof document !== 'undefined' && 'fonts' in document && document.fonts?.ready) {
      document.fonts.ready
        .then(() => {
          scheduleResize('sync', { immediate: true, force: true });
        })
        .catch(() => {
          // ignore
        });
    }
  }, [clearPostSelectResizeTimers, scheduleResize]);

  const applyHistoryIfAllowed = useCallback((sessionId: number, data: string) => {
    if (sessionId !== paneSessionId.current) {
      return;
    }

    if (historyApplied.current) {
      pendingHistory.current = null;
      return;
    }

    if (historyFallbackTimer.current !== null) {
      window.clearTimeout(historyFallbackTimer.current);
      historyFallbackTimer.current = null;
    }

    const term = terminal.current;
    if (!isTerminalReady.current || !term) {
      pendingHistory.current = { sessionId, data };
      return;
    }

    term.write(normalizeHistoryForXterm(data));
    for (const chunk of historyBuffer.current) {
      term.write(chunk);
    }
    historyBuffer.current = [];
    initialReplayReady.current = true;
    historyApplied.current = true;
    pendingHistory.current = null;
  }, []);

  const flushBufferedOutputAsFallback = useCallback((sessionId: number) => {
    if (sessionId !== paneSessionId.current) {
      return;
    }

    if (historyApplied.current) {
      return;
    }

    const term = terminal.current;
    if (!isTerminalReady.current || !term) {
      return;
    }

    if (historyBuffer.current.length > 0) {
      for (const chunk of historyBuffer.current) {
        term.write(chunk);
      }
      historyBuffer.current = [];
    }

    initialReplayReady.current = true;
    historyApplied.current = true;
    pendingHistory.current = null;
  }, []);

  useEffect(() => {
    return () => {
      if (historyFallbackTimer.current !== null) {
        window.clearTimeout(historyFallbackTimer.current);
      }
      clearPostSelectResizeTimers();
      if (resizeTimer.current !== null) {
        window.clearTimeout(resizeTimer.current);
      }
      if (resizeRaf.current !== null) {
        cancelAnimationFrame(resizeRaf.current);
      }
    };
  }, [clearPostSelectResizeTimers]);

  useEffect(() => {
    if (!windowId || !resolvedPaneId) {
      return;
    }

    paneSessionId.current += 1;
    initialReplayReady.current = false;
    historyApplied.current = false;
    pendingHistory.current = null;
    historyBuffer.current = [];
    liveOutputEndedWithCR.current = false;
    lastReportedSize.current = null;
    pendingLocalSize.current = null;

    if (historyFallbackTimer.current !== null) {
      window.clearTimeout(historyFallbackTimer.current);
      historyFallbackTimer.current = null;
    }

    clearPostSelectResizeTimers();

    const term = terminal.current;
    if (term && isTerminalReady.current) {
      term.reset();
    }
  }, [clearPostSelectResizeTimers, deviceId, windowId, resolvedPaneId]);

  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth < 768 || 'ontouchstart' in window);
    };

    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  useEffect(() => {
    if (!terminalRef.current) return;
    if (terminal.current) return;

    const container = terminalRef.current;

    const initTerminal = () => {
      try {
        const term = new Terminal({
          fontFamily:
            '"JetBrains Mono", "SF Mono", Menlo, Monaco, Consolas, "Liberation Mono", "Noto Sans Mono CJK SC", "Source Han Mono SC", "Sarasa Mono SC", "Noto Color Emoji", "Apple Color Emoji", "Segoe UI Emoji", monospace',
          fontSize: 14,
          convertEol: true,
          scrollSensitivity: 2,
          smoothScrollDuration: 120,
          fastScrollModifier: 'none',
          fastScrollSensitivity: 1,
          letterSpacing: 0,
          theme: {
            background: '#0d1117',
            foreground: '#c9d1d9',
            cursor: '#c9d1d9',
            selectionBackground: '#264f78',
            black: '#484f58',
            red: '#ff7b72',
            green: '#3fb950',
            yellow: '#d29922',
            blue: '#58a6ff',
            magenta: '#bc8cff',
            cyan: '#39c5cf',
            white: '#b1bac4',
          },
          cursorBlink: true,
          allowProposedApi: true,
          scrollback: 10000,
        });

        const fit = new FitAddon();
        const unicode11 = new Unicode11Addon();
        term.loadAddon(fit);
        term.loadAddon(unicode11);
        if (term.unicode.versions.includes('11')) {
          term.unicode.activeVersion = '11';
        }
        term.open(container);

        requestAnimationFrame(() => {
          fit.fit();
          isTerminalReady.current = true;

          const cachedHistory = pendingHistory.current;
          if (cachedHistory && cachedHistory.sessionId === paneSessionId.current) {
            applyHistoryIfAllowed(cachedHistory.sessionId, cachedHistory.data);
          } else if (cachedHistory) {
            pendingHistory.current = null;
          }
        });

        terminal.current = term;
        fitAddon.current = fit;
        setIsLoading(false);
      } catch (err) {
        console.error('[DevicePage] Failed to initialize terminal:', err);
        setLoadError(t('terminal.initFailed'));
        setIsLoading(false);
      }
    };

    const rect = container.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      initTerminal();
    } else {
      const observer = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const { width, height } = entry.contentRect;
          if (width > 0 && height > 0 && !terminal.current) {
            initTerminal();
            observer.disconnect();
            break;
          }
        }
      });
      observer.observe(container);
      return () => observer.disconnect();
    }

    return () => {
      if (terminal.current) {
        try {
          terminal.current.dispose();
        } catch {
          // ignore
        }
        terminal.current = null;
      }
      fitAddon.current = null;
      isTerminalReady.current = false;
    };
  }, [applyHistoryIfAllowed, t]);

  useEffect(() => {
    if (!deviceId) return;
    connectDevice(deviceId, 'page');
    autoSelected.current = false;

    return () => {
      disconnectDevice(deviceId, 'page');
    };
  }, [connectDevice, deviceId, disconnectDevice]);

  useEffect(() => {
    if (!deviceId) return;

    return subscribeBinary(deviceId, (output) => {
      const normalizedOutput = normalizeLiveOutputForXterm(output, liveOutputEndedWithCR.current);
      liveOutputEndedWithCR.current = normalizedOutput.endedWithCR;

      if (!isTerminalReady.current || !terminal.current) {
        historyBuffer.current.push(normalizedOutput.normalized.slice());
        return;
      }

      if (!initialReplayReady.current) {
        historyBuffer.current.push(normalizedOutput.normalized.slice());
        return;
      }

      terminal.current.write(normalizedOutput.normalized);
    });
  }, [deviceId, subscribeBinary]);

  useEffect(() => {
    if (!deviceId || !resolvedPaneId || !socketReady) {
      return;
    }

    const sessionId = paneSessionId.current;
    return subscribeHistory(deviceId, resolvedPaneId, (data) => {
      applyHistoryIfAllowed(sessionId, data);
    });
  }, [applyHistoryIfAllowed, deviceId, resolvedPaneId, socketReady, subscribeHistory]);

  useEffect(() => {
    if (!deviceId) return;
    if (windowId && resolvedPaneId) return;
    if (autoSelected.current) return;
    if (!deviceConnected) return;
    if (!windows || windows.length === 0) return;

    const activeWindow = windows.find((win) => win.active) ?? windows[0];
    const activePane = activeWindow.panes.find((pane) => pane.active) ?? activeWindow.panes[0];
    if (!activePane) return;

    autoSelected.current = true;
    navigate(
      `/devices/${deviceId}/windows/${activeWindow.id}/panes/${encodePaneIdForUrl(activePane.id)}`,
      { replace: true }
    );
  }, [deviceConnected, deviceId, navigate, resolvedPaneId, windowId, windows]);

  useEffect(() => {
    if (!deviceId || !windowId || !resolvedPaneId) return;
    if (isLoading || !socketReady || !deviceConnected || isSelectionInvalid) return;

    const sessionId = paneSessionId.current;
    if (historyFallbackTimer.current !== null) {
      window.clearTimeout(historyFallbackTimer.current);
    }
    historyFallbackTimer.current = window.setTimeout(() => {
      historyFallbackTimer.current = null;
      flushBufferedOutputAsFallback(sessionId);
    }, 400);

    reportPaneSize('sync', true);
    selectPane(deviceId, windowId, resolvedPaneId);
    runPostSelectResize();
  }, [
    deviceConnected,
    deviceId,
    flushBufferedOutputAsFallback,
    isLoading,
    isSelectionInvalid,
    reportPaneSize,
    resolvedPaneId,
    runPostSelectResize,
    selectPane,
    socketReady,
    windowId,
  ]);

  useEffect(() => {
    if (!canInteractWithPane || !selectedPane) return;
    if (!isTerminalReady.current) return;

    const term = terminal.current;
    if (!term) return;

    const remoteCols = Math.max(2, Math.floor(selectedPane.width || 0));
    const remoteRows = Math.max(2, Math.floor(selectedPane.height || 0));
    if (!remoteCols || !remoteRows) return;

    if (term.cols === remoteCols && term.rows === remoteRows) {
      return;
    }

    const pending = pendingLocalSize.current;
    if (pending) {
      const elapsed = Date.now() - pending.at;

      if (pending.cols === remoteCols && pending.rows === remoteRows && elapsed < 1800) {
        pendingLocalSize.current = null;
        lastReportedSize.current = { cols: remoteCols, rows: remoteRows };
        return;
      }

      if (elapsed < 900) {
        return;
      }

      pendingLocalSize.current = null;
    }

    suppressLocalResizeUntil.current = Date.now() + 220;
    term.resize(remoteCols, remoteRows);
    lastReportedSize.current = { cols: remoteCols, rows: remoteRows };
  }, [canInteractWithPane, selectedPane]);

  useEffect(() => {
    if (!canInteractWithPane || isLoading) return;
    scheduleResize('resize', { immediate: true, force: true });
  }, [canInteractWithPane, isLoading, scheduleResize]);

  useEffect(() => {
    if (!canInteractWithPane || !selectedPane || isLoading) return;
    runPostSelectResize();
  }, [canInteractWithPane, isLoading, runPostSelectResize, selectedPane?.id]);

  useEffect(() => {
    const term = terminal.current;
    if (!term || !deviceId || !resolvedPaneId) return;

    const disposableData = term.onData((data) => {
      if (!canInteractWithPane) return;
      if (!isComposing) {
        sendInput(deviceId, resolvedPaneId, data, false);
      }
    });

    term.attachCustomKeyEventHandler((domEvent) => {
      if (!canInteractWithPane) return true;
      if (inputMode !== 'direct' || isComposing) return true;
      if (domEvent.type !== 'keydown') return true;

      if (domEvent.shiftKey && domEvent.key === 'Enter') {
        domEvent.preventDefault();
        sendInput(deviceId, resolvedPaneId, '\x1b[13;2u', false);
        return false;
      }

      return true;
    });

    return () => {
      disposableData.dispose();
      term.attachCustomKeyEventHandler(() => true);
    };
  }, [canInteractWithPane, deviceId, inputMode, isComposing, resolvedPaneId, sendInput]);

  useEffect(() => {
    setEditorText(paneEditorDraft);
  }, [paneEditorDraft]);

  useEffect(() => {
    if (!canInteractWithPane) return;

    const handleWindowResize = () => {
      scheduleResize('resize');
    };

    window.addEventListener('resize', handleWindowResize);
    return () => window.removeEventListener('resize', handleWindowResize);
  }, [canInteractWithPane, scheduleResize]);

  useEffect(() => {
    const container = terminalRef.current;
    if (!container || !canInteractWithPane) return;

    const observer = new ResizeObserver(() => {
      scheduleResize('resize');
    });

    observer.observe(container);
    return () => observer.disconnect();
  }, [canInteractWithPane, scheduleResize]);

  useEffect(() => {
    if (!deviceError?.message) {
      return;
    }

    toast.error(deviceError.message);
  }, [deviceError?.message]);

  useEffect(() => {
    if (!loadError) {
      return;
    }

    toast.error(loadError);
  }, [loadError]);

  useEffect(() => {
    latestInvalidSelectionKey.current = invalidSelectionKey;

    if (invalidToastTimer.current !== null) {
      window.clearTimeout(invalidToastTimer.current);
      invalidToastTimer.current = null;
    }

    if (!invalidSelectionKey || !invalidSelectionMessage) {
      lastShownInvalidSelectionKey.current = null;
      return;
    }

    if (lastShownInvalidSelectionKey.current === invalidSelectionKey) {
      return;
    }

    invalidToastTimer.current = window.setTimeout(() => {
      if (latestInvalidSelectionKey.current !== invalidSelectionKey) {
        return;
      }

      toast.error(invalidSelectionMessage);
      lastShownInvalidSelectionKey.current = invalidSelectionKey;
      invalidToastTimer.current = null;
    }, 500);

    return () => {
      if (invalidToastTimer.current !== null) {
        window.clearTimeout(invalidToastTimer.current);
        invalidToastTimer.current = null;
      }
    };
  }, [invalidSelectionKey, invalidSelectionMessage]);

  useEffect(() => {
    document.title = buildBrowserTitle(terminalTopbarLabel);
    return () => {
      document.title = siteName;
    };
  }, [siteName, terminalTopbarLabel]);

  useEffect(() => {
    const handler = () => {
      terminal.current?.scrollToBottom();
    };

    window.addEventListener('tmex:jump-to-latest', handler as EventListener);
    return () => {
      window.removeEventListener('tmex:jump-to-latest', handler as EventListener);
    };
  }, []);

  const handleJumpToLatest = useCallback(() => {
    terminal.current?.scrollToBottom();
  }, []);

  const handleSendShortcut = useCallback(
    (payload: string) => {
      if (!deviceId || !resolvedPaneId || !canInteractWithPane) {
        return;
      }

      sendInput(deviceId, resolvedPaneId, payload, false);
    },
    [canInteractWithPane, deviceId, resolvedPaneId, sendInput]
  );

  const handleEditorSend = useCallback(() => {
    if (!deviceId || !resolvedPaneId || !canInteractWithPane) return;
    if (!editorText.trim()) return;

    const payload = editorSendWithEnter ? `${editorText}\r` : editorText;
    sendInput(deviceId, resolvedPaneId, payload, false);
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
    sendInput,
  ]);

  const handleEditorSendLineByLine = useCallback(() => {
    if (!deviceId || !resolvedPaneId || !canInteractWithPane) return;
    if (!editorText.trim()) return;

    const lines = editorText.split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      sendInput(deviceId, resolvedPaneId, `${line}\r`, false);
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
    sendInput,
  ]);

  if (!deviceId) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-[var(--color-text-secondary)]">{t('device.noDevices')}</div>
      </div>
    );
  }

  const showConnecting = !deviceConnected && !deviceError;

  return (
    <div className="flex flex-col h-full bg-[var(--color-bg)]" data-testid="device-page">
      {!isMobile && (
        <div className="h-11 flex items-center justify-between px-3 bg-[var(--color-bg-secondary)] border-b border-[var(--color-border)] gap-2 flex-shrink-0">
          <div className="flex items-center gap-2 min-w-0 flex-1 overflow-hidden">
            <span
              data-testid="terminal-topbar-title"
              className="text-sm font-medium truncate"
              title={terminalTopbarLabel ?? siteName}
            >
              {terminalTopbarLabel ?? siteName}
            </span>
          </div>

          <div className="flex items-center gap-2 flex-shrink-0">
            <Button
              variant="ghost"
              size="sm"
              data-testid="terminal-jump-latest"
              className="px-2 py-1 text-xs"
              onClick={handleJumpToLatest}
              title={t('nav.jumpToLatest')}
              disabled={!canInteractWithPane}
            >
              <ArrowDownToLine className="h-3 w-3 mr-1" />
              <span className="hidden sm:inline">{t('nav.jumpToLatest')}</span>
            </Button>

            <Button
              variant="default"
              size="sm"
              data-testid="terminal-input-mode-toggle"
              className="px-2 py-1 text-xs"
              onClick={() =>
                useUIStore.setState({ inputMode: inputMode === 'direct' ? 'editor' : 'direct' })
              }
            >
              {inputMode === 'direct' ? (
                <>
                  <Keyboard className="h-3 w-3 mr-1" /> {t('nav.switchToEditor')}
                </>
              ) : (
                <>
                  <Smartphone className="h-3 w-3 mr-1" /> {t('nav.switchToDirect')}
                </>
              )}
            </Button>
          </div>
        </div>
      )}

      <div
        className={`flex-1 relative overflow-hidden min-h-0 min-w-0 ${isMobile && inputMode === 'editor' ? 'pb-2' : ''}`}
      >
        <div ref={terminalRef} className="w-full h-full min-w-0 min-h-0" />

        {(isLoading || showConnecting) && (
          <div
            className="absolute inset-0 flex items-center justify-center bg-[var(--color-bg)]/80 backdrop-blur-sm"
            data-testid="terminal-status-overlay"
          >
            <div className="flex flex-col items-center gap-3">
              <div className="w-8 h-8 border-2 border-[var(--color-accent)] border-t-transparent rounded-full animate-spin" />
              <span
                className="text-[var(--color-text-secondary)]"
                data-testid="terminal-status-text"
              >
                {isLoading ? t('terminal.initializing') : t('terminal.connecting')}
              </span>
            </div>
          </div>
        )}
      </div>

      {inputMode === 'editor' && (
        <div className="editor-mode-input">
          <textarea
            data-testid="editor-input"
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
            onCompositionStart={() => setIsComposing(true)}
            onCompositionEnd={() => setIsComposing(false)}
          />
          <div className="actions">
            <div className="send-row" data-testid="editor-send-row">
              <label className="send-with-enter-toggle" data-testid="editor-send-with-enter-toggle">
                <input
                  type="checkbox"
                  checked={editorSendWithEnter}
                  onChange={(event) => setEditorSendWithEnter(event.target.checked)}
                />
                <span>{t('terminal.editorSendWithEnter')}</span>
              </label>
              <Button
                variant="default"
                size="sm"
                data-testid="editor-clear"
                onClick={() => {
                  setEditorText('');
                  if (draftKey) {
                    removeEditorDraft(draftKey);
                  }
                }}
                title={t('terminal.clear')}
              >
                <Trash2 className="h-4 w-4 mr-1" />
                {t('terminal.clear')}
              </Button>
              <Button
                variant="default"
                size="sm"
                data-testid="editor-send-line-by-line"
                onClick={handleEditorSendLineByLine}
                disabled={!canInteractWithPane}
              >
                <Send className="h-4 w-4 mr-1" />
                {t('terminal.editorSendLineByLine')}
              </Button>
              <Button
                variant="primary"
                size="sm"
                data-testid="editor-send"
                onClick={handleEditorSend}
                disabled={!canInteractWithPane}
              >
                <Send className="h-4 w-4 mr-1" />
                {t('common.send')}
              </Button>
            </div>
            <div className="shortcut-row" data-testid="editor-shortcuts-row">
              {EDITOR_SHORTCUTS.map((shortcut) => (
                <Button
                  key={shortcut.key}
                  variant="default"
                  size="sm"
                  title={shortcut.label}
                  aria-label={shortcut.label}
                  data-testid={`editor-shortcut-${shortcut.key}`}
                  onClick={() => handleSendShortcut(shortcut.payload)}
                  disabled={!canInteractWithPane}
                >
                  {shortcut.label}
                </Button>
              ))}
            </div>
          </div>
        </div>
      )}

      {isMobile && inputMode === 'direct' && (
        <input
          type="text"
          className="sr-only"
          onCompositionStart={() => setIsComposing(true)}
          onCompositionEnd={(e) => {
            setIsComposing(false);
            if (!deviceId || !resolvedPaneId || !canInteractWithPane) return;
            sendInput(deviceId, resolvedPaneId, (e.target as HTMLInputElement).value, false);
            (e.target as HTMLInputElement).value = '';
          }}
        />
      )}
    </div>
  );
}
