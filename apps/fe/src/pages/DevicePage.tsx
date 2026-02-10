import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import 'xterm/css/xterm.css';
import { Keyboard, Send, Smartphone, Trash2 } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle, Button } from '../components/ui';
import { useTmuxStore } from '../stores/tmux';
import { useUIStore } from '../stores/ui';

function decodePaneIdFromUrlParam(value: string | undefined): string | undefined {
  if (!value) return value;
  if (value.startsWith('%25')) {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return value;
}

function encodePaneIdForUrl(value: string): string {
  return encodeURIComponent(value);
}

export function DevicePage() {
  const { deviceId, windowId, paneId } = useParams();
  const navigate = useNavigate();
  const terminalRef = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const fitAddon = useRef<FitAddon | null>(null);
  const disposeTimeoutId = useRef<number | null>(null);
  const disposeRafId = useRef<number | null>(null);
  const autoSelected = useRef(false);

  const connectDevice = useTmuxStore((state) => state.connectDevice);
  const selectPane = useTmuxStore((state) => state.selectPane);
  const sendInput = useTmuxStore((state) => state.sendInput);
  const resizePane = useTmuxStore((state) => state.resizePane);
  const subscribeBinary = useTmuxStore((state) => state.subscribeBinary);

  const snapshot = useTmuxStore((state) => (deviceId ? state.snapshots[deviceId] : undefined));
  const deviceError = useTmuxStore((state) =>
    deviceId ? state.deviceErrors?.[deviceId] : undefined
  );
  const deviceConnected = useTmuxStore((state) =>
    deviceId ? state.deviceConnected?.[deviceId] : false
  );

  const resolvedPaneId = useMemo(() => decodePaneIdFromUrlParam(paneId), [paneId]);

  const [isMobile, setIsMobile] = useState(false);
  const [editorText, setEditorText] = useState('');
  const [isComposing, setIsComposing] = useState(false);
  const { inputMode, addEditorHistory } = useUIStore();

  const selectedPane = useMemo(() => {
    if (!snapshot?.session?.windows) return null;
    if (!windowId || !resolvedPaneId) return null;
    const win = snapshot.session.windows.find((w) => w.id === windowId);
    if (!win) return null;
    const pane = win.panes.find((p) => p.id === resolvedPaneId);
    return pane ?? null;
  }, [snapshot, windowId, resolvedPaneId]);

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

    const container = terminalRef.current;
    let resizeObserver: ResizeObserver | null = null;
    let isInitialized = false;

    const clearPendingDispose = () => {
      if (disposeTimeoutId.current) {
        clearTimeout(disposeTimeoutId.current);
        disposeTimeoutId.current = null;
      }
      if (disposeRafId.current) {
        cancelAnimationFrame(disposeRafId.current);
        disposeRafId.current = null;
      }
    };

    const scheduleDispose = (term: Terminal) => {
      clearPendingDispose();
      disposeTimeoutId.current = window.setTimeout(() => {
        disposeTimeoutId.current = null;
        disposeRafId.current = window.requestAnimationFrame(() => {
          disposeRafId.current = null;
          try {
            term.dispose();
          } catch {
            // ignore
          }
          if (terminal.current === term) {
            terminal.current = null;
            fitAddon.current = null;
          }
        });
      }, 0);
    };

    const initializeTerminal = () => {
      if (isInitialized || !container) return;
      isInitialized = true;

      if (resizeObserver) {
        resizeObserver.disconnect();
        resizeObserver = null;
      }

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
      });

      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(container);
      fit.fit();

      terminal.current = term;
      fitAddon.current = fit;
    };

    clearPendingDispose();

    if (terminal.current && fitAddon.current) {
      fitAddon.current.fit();
      return () => scheduleDispose(terminal.current!);
    }

    const rect = container.getBoundingClientRect();
    const hasValidSize = rect.width > 0 && rect.height > 0;

    if (hasValidSize) {
      initializeTerminal();
    } else {
      resizeObserver = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const { width, height } = entry.contentRect;
          if (width > 0 && height > 0) {
            initializeTerminal();
            break;
          }
        }
      });
      resizeObserver.observe(container);
    }

    return () => {
      if (resizeObserver) {
        resizeObserver.disconnect();
      }
      if (terminal.current) {
        scheduleDispose(terminal.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!deviceId) return;
    connectDevice(deviceId);
    autoSelected.current = false;
  }, [connectDevice, deviceId]);

  useEffect(() => {
    if (!deviceId) return;
    return subscribeBinary(deviceId, (output) => {
      terminal.current?.write(output);
    });
  }, [deviceId, subscribeBinary]);

  useEffect(() => {
    if (!deviceId) return;
    if (windowId && resolvedPaneId) return;
    if (autoSelected.current) return;

    const windows = snapshot?.session?.windows;
    if (!windows || windows.length === 0) return;
    const activeWindow = windows.find((w) => w.active) ?? windows[0];
    const activePane = activeWindow.panes.find((p) => p.active) ?? activeWindow.panes[0];
    if (!activePane) return;

    autoSelected.current = true;
    navigate(
      `/devices/${deviceId}/windows/${activeWindow.id}/panes/${encodePaneIdForUrl(activePane.id)}`,
      { replace: true }
    );
  }, [deviceId, navigate, resolvedPaneId, snapshot, windowId]);

  useEffect(() => {
    if (!deviceId || !windowId || !resolvedPaneId) return;
    selectPane(deviceId, windowId, resolvedPaneId);

    const term = terminal.current;
    if (!term) return;
    fitAddon.current?.fit();
    resizePane(deviceId, resolvedPaneId, term.cols, term.rows);
  }, [deviceId, resolvedPaneId, resizePane, selectPane, windowId]);

  useEffect(() => {
    const term = terminal.current;
    if (!term || !deviceId || !resolvedPaneId) return;

    const disposable = term.onData((data) => {
      if (inputMode === 'direct' && !isComposing) {
        sendInput(deviceId, resolvedPaneId, data, false);
      }
    });

    return () => {
      disposable.dispose();
    };
  }, [deviceId, inputMode, isComposing, resolvedPaneId, sendInput]);

  useEffect(() => {
    if (!deviceId || !resolvedPaneId) return;

    const handleResize = () => {
      fitAddon.current?.fit();
      const term = terminal.current;
      if (!term) return;
      resizePane(deviceId, resolvedPaneId, term.cols, term.rows);
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [deviceId, resolvedPaneId, resizePane]);

  const handleEditorSend = () => {
    if (!deviceId || !resolvedPaneId) return;
    if (!editorText.trim()) return;

    sendInput(deviceId, resolvedPaneId, editorText, false);
    addEditorHistory(editorText);
    setEditorText('');
  };

  const handleEditorSendLineByLine = () => {
    if (!deviceId || !resolvedPaneId) return;
    const lines = editorText.split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      sendInput(deviceId, resolvedPaneId, `${line}\r`, false);
    }
    addEditorHistory(editorText);
    setEditorText('');
  };

  if (!deviceId) {
    return <div className="p-6">未选择设备</div>;
  }

  // 只在设备未连接时显示"连接中"，pane 数据加载问题不显示遮罩
  // 因为 pane 切换时可能短暂找不到 selectedPane，但终端仍然可用
  const showConnecting = !deviceConnected;

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-2 bg-[var(--color-bg-secondary)] border-b border-[var(--color-border)]">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">设备: {deviceId}</span>
          {windowId && (
            <span className="text-sm text-[var(--color-text-secondary)]">/ 窗口: {windowId}</span>
          )}
          {paneId && (
            <span className="text-sm text-[var(--color-text-secondary)]">
              / Pane: {resolvedPaneId ?? paneId}
            </span>
          )}
        </div>

        {isMobile && (
          <div className="flex items-center gap-2">
            <Button
              variant="default"
              size="sm"
              onClick={() =>
                useUIStore.setState({ inputMode: inputMode === 'direct' ? 'editor' : 'direct' })
              }
            >
              {inputMode === 'direct' ? (
                <>
                  <Keyboard className="h-4 w-4 mr-1" /> 编辑器
                </>
              ) : (
                <>
                  <Smartphone className="h-4 w-4 mr-1" /> 直接输入
                </>
              )}
            </Button>
          </div>
        )}
      </div>

      {deviceError && (
        <div className="px-4 py-2 bg-[var(--color-bg-secondary)] border-b border-[var(--color-border)]">
          <Alert variant="destructive" className="relative">
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

      <div className="flex-1 relative overflow-hidden">
        <div ref={terminalRef} className="absolute inset-0" />

        {showConnecting && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/50">
            <div className="text-[var(--color-text-secondary)]">连接中...</div>
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
            <Button variant="default" size="sm" onClick={handleEditorSendLineByLine}>
              逐行发送
            </Button>
            <Button variant="primary" size="sm" onClick={handleEditorSend}>
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
            if (!resolvedPaneId) return;
            sendInput(deviceId, resolvedPaneId, (e.target as HTMLInputElement).value, false);
            (e.target as HTMLInputElement).value = '';
          }}
        />
      )}
    </div>
  );
}
