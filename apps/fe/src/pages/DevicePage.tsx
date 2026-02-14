import { useCallback, useEffect, useMemo, useRef, useState, type FocusEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { Unicode11Addon } from 'xterm-addon-unicode11';
import 'xterm/css/xterm.css';
import { useQuery } from '@tanstack/react-query';
import type { Device } from '@tmex/shared';
import { ArrowDownToLine, Keyboard, Loader2, RefreshCw, Send, Smartphone, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
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
import { Switch } from '@/components/ui/switch';
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

const XTERM_THEME_DARK = {
  background: '#0b1020',
  foreground: '#e7e9ee',
  cursor: '#e7e9ee',
  selectionBackground: 'rgba(79, 70, 229, 0.35)',
  black: '#0b1020',
  red: '#ff6b6b',
  green: '#2bd576',
  yellow: '#ffd166',
  blue: '#4f46e5',
  magenta: '#a855f7',
  cyan: '#22d3ee',
  white: '#e7e9ee',
};

const XTERM_THEME_LIGHT = {
  background: '#f8fafc',
  foreground: '#0f172a',
  cursor: '#0f172a',
  selectionBackground: 'rgba(79, 70, 229, 0.22)',
  black: '#0f172a',
  red: '#b91c1c',
  green: '#15803d',
  yellow: '#a16207',
  blue: '#4338ca',
  magenta: '#7e22ce',
  cyan: '#0e7490',
  white: '#0f172a',
};

function hasTouchCapability(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  if (navigator.maxTouchPoints > 0) {
    return true;
  }

  return window.matchMedia?.('(any-pointer: coarse)').matches ?? false;
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

export default function DevicePage() {
  const { t } = useTranslation();
  const { deviceId, windowId, paneId } = useParams();
  const navigate = useNavigate();
  const terminalRef = useRef<HTMLDivElement>(null);
  const editorContainerRef = useRef<HTMLDivElement | null>(null);
  const editorTextareaRef = useRef<HTMLTextAreaElement | null>(null);
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
  const iosAddressBarCollapseTried = useRef(false);

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
  const [isEditorFocused, setIsEditorFocused] = useState(false);
  const isComposingRef = useRef(false);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
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
    if (!isMobile) {
      return;
    }

    const container = terminalRef.current;
    if (!container) {
      return;
    }

    let startY = 0;
    let viewport: HTMLElement | null = container.querySelector('.xterm-viewport');
    let observer: MutationObserver | null = null;

    const handleTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        return;
      }
      startY = event.touches[0]?.clientY ?? 0;
    };

    const handleTouchMove = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        return;
      }

      const currentY = event.touches[0]?.clientY ?? 0;
      const deltaY = currentY - startY;
      if (deltaY <= 0) {
        return;
      }

      const target = event.currentTarget;
      if (!(target instanceof HTMLElement)) {
        return;
      }

      if (!event.cancelable) {
        return;
      }

      if (target.scrollTop <= 0) {
        event.preventDefault();
      }
    };

    const attach = (el: HTMLElement) => {
      el.addEventListener('touchstart', handleTouchStart, { passive: true });
      el.addEventListener('touchmove', handleTouchMove, { passive: false });
    };

    const detach = (el: HTMLElement) => {
      el.removeEventListener('touchstart', handleTouchStart);
      el.removeEventListener('touchmove', handleTouchMove);
    };

    if (viewport) {
      attach(viewport);
    } else {
      observer = new MutationObserver(() => {
        const el = container.querySelector('.xterm-viewport');
        if (!(el instanceof HTMLElement)) {
          return;
        }

        viewport = el;
        attach(el);
        observer?.disconnect();
        observer = null;
      });
      observer.observe(container, { childList: true });
    }

    return () => {
      if (viewport) {
        detach(viewport);
      }
      observer?.disconnect();
    };
  }, [isMobile]);

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

  useEffect(() => {
    if (inputMode !== 'editor') {
      setIsEditorFocused(false);
    }
  }, [inputMode]);

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

  useEffect(() => {
    if (!terminalRef.current) return;
    if (terminal.current) return;

    const container = terminalRef.current;
    let cleanupComposition: (() => void) | undefined;
    let observer: ResizeObserver | null = null;

    const initTerminal = () => {
      try {
        const touchOptimizedScroll = hasTouchCapability();
        const term = new Terminal({
          fontFamily:
            '"JetBrains Mono", "SF Mono", Menlo, Monaco, Consolas, "Liberation Mono", "Noto Sans Mono CJK SC", "Source Han Mono SC", "Sarasa Mono SC", "Noto Color Emoji", "Apple Color Emoji", "Segoe UI Emoji", monospace',
          fontSize: 13,
          convertEol: true,
          ...(touchOptimizedScroll
            ? {
                scrollSensitivity: 2,
                smoothScrollDuration: 120,
              }
            : {}),
          fastScrollModifier: 'ctrl',
          fastScrollSensitivity: 1,
          letterSpacing: 0,
          theme: terminalTheme,
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

        const textarea = term.textarea;
        const handleCompositionStart = () => {
          isComposingRef.current = true;
        };
        const handleCompositionEnd = () => {
          isComposingRef.current = false;
        };

        if (textarea) {
          textarea.addEventListener('compositionstart', handleCompositionStart);
          textarea.addEventListener('compositionend', handleCompositionEnd);
        }

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

        return () => {
          if (textarea) {
            textarea.removeEventListener('compositionstart', handleCompositionStart);
            textarea.removeEventListener('compositionend', handleCompositionEnd);
          }
        };
      } catch (err) {
        console.error('[DevicePage] Failed to initialize terminal:', err);
        setLoadError(t('terminal.initFailed'));
        setIsLoading(false);
      }
    };

    const rect = container.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      cleanupComposition = initTerminal();
    } else {
      const sizeObserver = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const { width, height } = entry.contentRect;
          if (width > 0 && height > 0 && !terminal.current) {
            cleanupComposition = initTerminal();
            sizeObserver.disconnect();
            break;
          }
        }
      });
      observer = sizeObserver;
      sizeObserver.observe(container);
    }

    return () => {
      observer?.disconnect();
      cleanupComposition?.();
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
      isComposingRef.current = false;
    };
  }, [applyHistoryIfAllowed, t, terminalTheme]);

  useEffect(() => {
    const term = terminal.current;
    if (!term) return;
    const theme = uiTheme === 'light' ? XTERM_THEME_LIGHT : XTERM_THEME_DARK;
    term.options.theme = theme;
    // Force renderer to clear texture atlas and redraw
    const core = (term as unknown as { _core?: {
      renderer?: { clearTextureAtlas?: () => void; clear?: () => void };
      viewport?: { refresh: () => void };
    } })._core;
    if (core?.renderer?.clearTextureAtlas) {
      core.renderer.clearTextureAtlas();
    }
    if (core?.viewport?.refresh) {
      core.viewport.refresh();
    }
    term.refresh(0, term.rows - 1);
  }, [uiTheme]);

  useEffect(() => {
    const term = terminal.current;
    if (!term) return;
    term.options.disableStdin = inputMode === 'editor';
  }, [inputMode]);

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
      sendInput(deviceId, resolvedPaneId, data, isComposingRef.current);
    });

    term.attachCustomKeyEventHandler((domEvent) => {
      if (!canInteractWithPane) return true;
      if (inputMode !== 'direct' || isComposingRef.current) return true;
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
  }, [canInteractWithPane, deviceId, inputMode, resolvedPaneId, sendInput]);

  useEffect(() => {
    setEditorText(paneEditorDraft);
  }, [paneEditorDraft]);

  useEffect(() => {
    const term = terminal.current;
    if (!term || !isTerminalReady.current) {
      return;
    }

    const rafId = window.requestAnimationFrame(() => {
      term.scrollToBottom();
    });
    const timerId = window.setTimeout(() => {
      term.scrollToBottom();
    }, 120);

    return () => {
      window.cancelAnimationFrame(rafId);
      window.clearTimeout(timerId);
    };
  }, [inputMode]);

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
    if (!container) return;

    const observer = new ResizeObserver(() => {
      // 始终执行 fit，确保 PC 端终端铺满
      fitAddon.current?.fit();
      // 只有可交互时才上报尺寸到后端
      if (canInteractWithPane) {
        scheduleResize('resize');
      }
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
    if (!canInteractWithPane) {
      toast.error(t('wsError.checkGateway'));
      return;
    }
    if (!deviceId || !resolvedPaneId) return;
    if (!editorText.trim()) return;

    setIsSending(true);
    window.setTimeout(() => setIsSending(false), 150);

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
  return (
    <div className="flex h-full min-h-0 flex-col bg-background" data-testid="device-page">
      <div className="terminal-shortcuts-strip border-b border-border bg-card/65" data-testid="terminal-shortcuts-strip">
        <div className="shortcut-row" data-testid="editor-shortcuts-row">
          {EDITOR_SHORTCUTS.map((shortcut) => (
            <Button
              key={shortcut.key}
              variant="outline"
              size="sm"
              className="h-7 min-w-9 px-2 text-[10px] font-medium tracking-wide [@media(any-pointer:coarse)]:h-9 [@media(any-pointer:coarse)]:min-w-10 [@media(any-pointer:coarse)]:px-3"
              title={shortcut.label}
              aria-label={shortcut.label}
              data-testid={`editor-shortcut-${shortcut.key}`}
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => {
                handleSendShortcut(shortcut.payload);
                if (isMobile && inputMode === 'editor') {
                  editorTextareaRef.current?.focus({ preventScroll: true });
                }
              }}
              disabled={!canInteractWithPane}
            >
              {shortcut.label}
            </Button>
          ))}
        </div>
      </div>

      <div
        className={`flex-1 relative overflow-hidden min-h-0 min-w-0 ${
          isMobile && inputMode === 'editor' && !shouldDockEditor ? 'pb-2' : ''
        }`}
        style={shouldDockEditor ? { paddingBottom: `${editorDockHeight}px` } : undefined}
      >
        <div
          ref={terminalRef}
          className="h-full min-h-0 min-w-0 w-full"
          style={{ backgroundColor: terminalTheme.background }}
        />

        {(isLoading || showConnecting) && (
          <div
            className="absolute inset-0 flex items-center justify-center bg-background/85 backdrop-blur-sm"
            data-testid="terminal-status-overlay"
          >
            <div className="flex flex-col items-center gap-2 rounded-lg border border-border bg-card/90 px-4 py-3 shadow-sm">
              <div className="h-7 w-7 rounded-full border-2 border-primary border-t-transparent animate-spin" />
              <span className="text-xs text-muted-foreground" data-testid="terminal-status-text">
                {isLoading ? t('terminal.initializing') : t('terminal.connecting')}
              </span>
            </div>
          </div>
        )}
      </div>

      {inputMode === 'editor' && (
        <div
          ref={editorContainerRef}
          className={`editor-mode-input border-t border-border/70 bg-card/85 backdrop-blur-sm ${
            shouldDockEditor ? 'editor-mode-input-docked' : ''
          }`}
        style={shouldDockEditor ? { bottom: `${keyboardInsetBottom}px` } : undefined}
      >
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
            <div className="send-row flex flex-wrap items-center justify-end gap-2" data-testid="editor-send-row">
              <div className="send-with-enter-toggle mr-auto flex items-center gap-2 text-xs text-muted-foreground" data-testid="editor-send-with-enter-toggle">
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
                {isSending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
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
                {isSending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
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
  const deviceConnected = useTmuxStore((state) => deviceId ? state.deviceConnected?.[deviceId] ?? false : false);
  
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
        aria-label={inputMode === 'direct' ? t('nav.switchToEditor') : t('nav.switchToDirect')}
        title={inputMode === 'direct' ? t('nav.switchToEditor') : t('nav.switchToDirect')}
      >
        {inputMode === 'direct' ? <Keyboard className="h-4 w-4" /> : <Smartphone className="h-4 w-4" />}
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
