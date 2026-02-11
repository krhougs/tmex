import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import 'xterm/css/xterm.css';
import { AlertCircle, Keyboard, Maximize, Send, Smartphone, Trash2 } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle, Button } from '../components/ui';
import { useTmuxStore } from '../stores/tmux';
import { useUIStore } from '../stores/ui';
import { decodePaneIdFromUrlParam, encodePaneIdForUrl } from '../utils/tmuxUrl';

export function DevicePage() {
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

  const resizeRaf = useRef<number | null>(null);
  const resizeTimer = useRef<number | null>(null);
  const lastReportedSize = useRef<{ cols: number; rows: number } | null>(null);
  const pendingLocalSize = useRef<{ cols: number; rows: number; at: number } | null>(null);
  const suppressLocalResizeUntil = useRef(0);
  const postSelectResizeTimers = useRef<number[]>([]);

  const connectDevice = useTmuxStore((state) => state.connectDevice);
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
  const socketReady = useTmuxStore((state) => state.socketReady);

  const resolvedPaneId = useMemo(() => decodePaneIdFromUrlParam(paneId), [paneId]);

  const [isMobile, setIsMobile] = useState(false);
  const [editorText, setEditorText] = useState('');
  const [isComposing, setIsComposing] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const { inputMode, addEditorHistory } = useUIStore();

  const windows = snapshot?.session?.windows;

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
    ? '当前窗口已关闭，请在侧边栏重新选择窗口。'
    : isPaneMissing
      ? '当前 Pane 已关闭，请在侧边栏重新选择 Pane。'
      : null;

  const isSelectionInvalid = Boolean(invalidSelectionMessage);
  const canInteractWithPane = Boolean(deviceConnected && resolvedPaneId && !isSelectionInvalid);

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

    term.write(data);
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
          fontFamily: 'SF Mono, Monaco, Inconsolata, "Fira Code", monospace',
          fontSize: 14,
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
        term.loadAddon(fit);
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
        setLoadError('终端初始化失败');
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
  }, [applyHistoryIfAllowed]);

  useEffect(() => {
    if (!deviceId) return;
    connectDevice(deviceId);
    autoSelected.current = false;
  }, [connectDevice, deviceId]);

  useEffect(() => {
    if (!deviceId) return;

    return subscribeBinary(deviceId, (output) => {
      if (!isTerminalReady.current || !terminal.current) {
        historyBuffer.current.push(output.slice());
        return;
      }

      if (!initialReplayReady.current) {
        historyBuffer.current.push(output.slice());
        return;
      }

      terminal.current.write(output);
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
      if (inputMode === 'direct' && !isComposing) {
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

  const handleSyncSize = useCallback(() => {
    scheduleResize('sync', { immediate: true, force: true });
  }, [scheduleResize]);

  const handleEditorSend = useCallback(() => {
    if (!deviceId || !resolvedPaneId || !canInteractWithPane) return;
    if (!editorText.trim()) return;

    sendInput(deviceId, resolvedPaneId, editorText, false);
    addEditorHistory(editorText);
    setEditorText('');
  }, [addEditorHistory, canInteractWithPane, deviceId, editorText, resolvedPaneId, sendInput]);

  const handleEditorSendLineByLine = useCallback(() => {
    if (!deviceId || !resolvedPaneId || !canInteractWithPane) return;

    const lines = editorText.split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      sendInput(deviceId, resolvedPaneId, `${line}\r`, false);
    }

    addEditorHistory(editorText);
    setEditorText('');
  }, [addEditorHistory, canInteractWithPane, deviceId, editorText, resolvedPaneId, sendInput]);

  if (!deviceId) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-[var(--color-text-secondary)]">未选择设备</div>
      </div>
    );
  }

  const showConnecting = !deviceConnected && !deviceError;

  return (
    <div className="flex flex-col h-full bg-[var(--color-bg)]">
      <div className="flex items-center justify-between px-4 py-2 bg-[var(--color-bg-secondary)] border-b border-[var(--color-border)] gap-2 flex-shrink-0">
        <div className="flex items-center gap-2 min-w-0 flex-1 overflow-hidden">
          <span className="text-sm font-medium truncate" title={deviceId}>
            设备: {deviceId.slice(0, 8)}...
          </span>
          {windowId && (
            <span className="text-sm text-[var(--color-text-secondary)] hidden sm:inline whitespace-nowrap">
              / 窗口: {windowId}
            </span>
          )}
          {resolvedPaneId && (
            <span className="text-sm text-[var(--color-text-secondary)] hidden md:inline whitespace-nowrap">
              / Pane: {resolvedPaneId}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          <Button
            variant="ghost"
            size="sm"
            className="px-2 py-1 text-xs"
            onClick={handleSyncSize}
            title="同步终端尺寸"
            disabled={!canInteractWithPane}
          >
            <Maximize className="h-3 w-3 mr-1" />
            <span className="hidden sm:inline">同步尺寸</span>
          </Button>

          {isMobile && (
            <Button
              variant="default"
              size="sm"
              className="px-2 py-1 text-xs"
              onClick={() =>
                useUIStore.setState({ inputMode: inputMode === 'direct' ? 'editor' : 'direct' })
              }
            >
              {inputMode === 'direct' ? (
                <>
                  <Keyboard className="h-3 w-3 mr-1" /> 编辑器
                </>
              ) : (
                <>
                  <Smartphone className="h-3 w-3 mr-1" /> 直接输入
                </>
              )}
            </Button>
          )}
        </div>
      </div>

      {deviceError && (
        <div className="px-4 py-2 bg-[var(--color-bg-secondary)] border-b border-[var(--color-border)] flex-shrink-0">
          <Alert variant="destructive" className="relative">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>连接错误</AlertTitle>
            <AlertDescription>{deviceError.message}</AlertDescription>
            <button
              type="button"
              onClick={() => {
                useTmuxStore.setState((state) => ({
                  deviceErrors: { ...state.deviceErrors, [deviceId]: undefined },
                }));
              }}
              className="absolute top-2 right-2 p-1 text-red-400 hover:text-red-300"
              aria-label="关闭错误提示"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </Alert>
        </div>
      )}

      {loadError && (
        <div className="px-4 py-2 bg-[var(--color-bg-secondary)] border-b border-[var(--color-border)] flex-shrink-0">
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>错误</AlertTitle>
            <AlertDescription>{loadError}</AlertDescription>
          </Alert>
        </div>
      )}

      <div className="flex-1 relative overflow-hidden min-h-0 min-w-0">
        <div ref={terminalRef} className="w-full h-full min-w-0 min-h-0" />

        {(isLoading || showConnecting) && (
          <div className="absolute inset-0 flex items-center justify-center bg-[var(--color-bg)]/80 backdrop-blur-sm">
            <div className="flex flex-col items-center gap-3">
              <div className="w-8 h-8 border-2 border-[var(--color-accent)] border-t-transparent rounded-full animate-spin" />
              <span className="text-[var(--color-text-secondary)]">
                {isLoading ? '初始化终端...' : '连接设备...'}
              </span>
            </div>
          </div>
        )}

        {invalidSelectionMessage && (
          <div className="absolute inset-0 flex items-center justify-center bg-[var(--color-bg)]/85 backdrop-blur-sm p-4">
            <Alert className="max-w-lg border-[var(--color-warning)] bg-[var(--color-bg-secondary)]">
              <AlertCircle className="h-4 w-4 text-[var(--color-warning)]" />
              <AlertTitle>当前目标不可用</AlertTitle>
              <AlertDescription>{invalidSelectionMessage}</AlertDescription>
            </Alert>
          </div>
        )}
      </div>

      {isMobile && inputMode === 'editor' && (
        <div className="editor-mode-input">
          <textarea
            value={editorText}
            onChange={(e) => setEditorText(e.target.value)}
            placeholder="在此输入命令..."
            onCompositionStart={() => setIsComposing(true)}
            onCompositionEnd={() => setIsComposing(false)}
          />
          <div className="actions">
            <Button variant="default" size="sm" onClick={() => setEditorText('')} title="清空">
              <Trash2 className="h-4 w-4 mr-1" />
              清空
            </Button>
            <Button
              variant="default"
              size="sm"
              onClick={handleEditorSendLineByLine}
              disabled={!canInteractWithPane}
            >
              逐行发送
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={handleEditorSend}
              disabled={!canInteractWithPane}
            >
              <Send className="h-4 w-4 mr-1" />
              发送
            </Button>
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
