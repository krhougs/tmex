import {
  FitAddon,
  TERMINAL_ENGINE,
  createTerminalController,
  type CompatibleTerminalLike,
} from 'ghostty-terminal';
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTmuxStore } from '@/stores/tmux';
import { type SelectCallbacks, getSelectStateMachine } from '@/ws-borsh';
import { XTERM_FONT_FAMILY, XTERM_THEME_DARK, XTERM_THEME_LIGHT } from './theme';
import { normalizeHistoryForTerminal, normalizeLiveOutputForTerminal } from './normalization';
import type { TerminalProps, TerminalRef } from './types';
import { useMobileTouch } from './useMobileTouch';
import { useTerminalResize } from './useTerminalResize';

const TERMINAL_CONFIG = {
  fontFamily: XTERM_FONT_FAMILY,
  fontSize: 13,
  scrollback: 10000,
};

function setE2eTerminalProbe(terminal: CompatibleTerminalLike): void {
  const g = globalThis as any;
  g.__tmexE2eXterm = terminal;
  g.__tmexE2eTerminal = terminal;
  g.__tmexE2eTerminalEngine = TERMINAL_ENGINE;
  g.__tmexE2eTerminalRenderer = terminal.getRendererKind?.() ?? null;
}

function clearE2eTerminalProbe(terminal: CompatibleTerminalLike | null): void {
  if (!terminal) {
    return;
  }

  const g = globalThis as any;
  if (g.__tmexE2eTerminal !== terminal && g.__tmexE2eXterm !== terminal) {
    return;
  }

  g.__tmexE2eXterm = null;
  g.__tmexE2eTerminal = null;
  g.__tmexE2eTerminalEngine = null;
  g.__tmexE2eTerminalRenderer = null;
  g.__tmexE2eTerminalSelectionText = null;
}

export const Terminal = forwardRef<TerminalRef, TerminalProps>(
  (
    { deviceId, paneId, theme, inputMode, deviceConnected, isSelectionInvalid, onResize, onSync },
    ref
  ) => {
    const [instance, setInstance] = useState<CompatibleTerminalLike | null>(null);
    const sendInput = useTmuxStore((state) => state.sendInput);

    const terminalTheme = useMemo(() => {
      switch (theme) {
        case 'light':
          return XTERM_THEME_LIGHT;
        default:
          return XTERM_THEME_DARK;
      }
    }, [theme]);

    const containerRef = useRef<HTMLDivElement>(null);
    const mountRef = useRef<HTMLDivElement>(null);
    const fitAddonRef = useRef<FitAddon | null>(null);
    const currentDeviceIdRef = useRef(deviceId);
    const currentPaneIdRef = useRef(paneId);
    const canWriteRef = useRef(deviceConnected && !isSelectionInvalid);
    const liveOutputEndedWithCR = useRef(false);
    const keepShortHistoryVisibleRef = useRef(false);
    const lastTerminalInstanceRef = useRef<CompatibleTerminalLike | null>(null);

    const getTerminalForTouch = useCallback(() => instance, [instance]);
    useMobileTouch(containerRef, getTerminalForTouch);

    useEffect(() => {
      currentDeviceIdRef.current = deviceId;
      currentPaneIdRef.current = paneId;
      keepShortHistoryVisibleRef.current = false;
    }, [deviceId, paneId]);

    useEffect(() => {
      canWriteRef.current = deviceConnected && !isSelectionInvalid;
    }, [deviceConnected, isSelectionInvalid]);

    const sendTerminalInput = useCallback(
      (data: string) => {
        if (!data || inputMode !== 'direct') {
          return;
        }
        if (!canWriteRef.current) {
          return;
        }

        const activeDeviceId = currentDeviceIdRef.current;
        const activePaneId = currentPaneIdRef.current;
        if (!activeDeviceId || !activePaneId) {
          return;
        }

        sendInput(activeDeviceId, activePaneId, data, false);
      },
      [inputMode, sendInput]
    );

    const { pendingLocalSize, scheduleResize, runPostSelectResize, setFitAddon, setTerminal } =
      useTerminalResize({
        deviceId,
        paneId,
        deviceConnected,
        isSelectionInvalid,
        onResize,
        onSync,
        getContainerRect: () => {
          const el = containerRef.current;
          if (!el) return null;
          const rect = el.getBoundingClientRect();
          return { width: rect.width, height: rect.height };
        },
      });

    useEffect(() => {
      let cancelled = false;
      let createdTerminal: Awaited<ReturnType<typeof createTerminalController>> | null = null;

      void createTerminalController({
        ...TERMINAL_CONFIG,
        theme: terminalTheme,
        disableStdin: inputMode === 'editor',
      }).then((terminal) => {
        if (cancelled) {
          terminal.dispose();
          return;
        }

        createdTerminal = terminal;
        if (mountRef.current) {
          terminal.open(mountRef.current);
        }
        setE2eTerminalProbe(terminal);
        setInstance(terminal);
      });

      return () => {
        cancelled = true;
        setInstance(null);
        clearE2eTerminalProbe(createdTerminal);
        createdTerminal?.dispose();
      };
    }, []);

    useEffect(() => {
      if (!instance || !('setTheme' in instance)) {
        return;
      }

      (instance as any).setTheme(terminalTheme);
    }, [instance, terminalTheme]);

    useEffect(() => {
      if (!instance || !('setDisableStdin' in instance)) {
        return;
      }

      (instance as any).setDisableStdin(inputMode === 'editor');
    }, [instance, inputMode]);

    const callbacks: SelectCallbacks = useMemo(() => {
      if (!instance) {
        return {};
      }

      return {
        onResetTerminal: (targetDeviceId) => {
          if (currentDeviceIdRef.current !== targetDeviceId) return;
          instance.reset();
          liveOutputEndedWithCR.current = false;
          runPostSelectResize();
        },
        onApplyHistory: (targetDeviceId, data) => {
          if (currentDeviceIdRef.current !== targetDeviceId) return;
          keepShortHistoryVisibleRef.current = true;
          instance.write(normalizeHistoryForTerminal(data));
        },
        onFlushBuffer: (targetDeviceId, buffer) => {
          if (currentDeviceIdRef.current !== targetDeviceId) return;
          for (const chunk of buffer) {
            const normalized = normalizeLiveOutputForTerminal(chunk, liveOutputEndedWithCR.current);
            liveOutputEndedWithCR.current = normalized.endedWithCR;
            instance.write(normalized.normalized);
          }
          if (keepShortHistoryVisibleRef.current) {
            if (instance.buffer.active.baseY <= 1) {
              instance.scrollToTop();
            }
            keepShortHistoryVisibleRef.current = false;
          }
        },
        onOutput: (targetDeviceId, targetPaneId, data) => {
          if (currentDeviceIdRef.current !== targetDeviceId) return;
          if (currentPaneIdRef.current !== targetPaneId) return;
          if (!canWriteRef.current) return;
          const normalized = normalizeLiveOutputForTerminal(data, liveOutputEndedWithCR.current);
          liveOutputEndedWithCR.current = normalized.endedWithCR;
          instance.write(normalized.normalized);
          if (keepShortHistoryVisibleRef.current) {
            if (instance.buffer.active.baseY <= 1) {
              instance.scrollToTop();
            }
            keepShortHistoryVisibleRef.current = false;
          }
        },
      };
    }, [instance, runPostSelectResize]);

    useEffect(() => {
      if (!instance) {
        lastTerminalInstanceRef.current = null;
      } else if (lastTerminalInstanceRef.current !== instance) {
        liveOutputEndedWithCR.current = false;
        instance.reset();
        lastTerminalInstanceRef.current = instance;
      }
    }, [instance]);

    useEffect(() => {
      getSelectStateMachine(callbacks);
    }, [callbacks]);

    useEffect(() => {
      return () => {
        getSelectStateMachine({});
      };
    }, []);

    useEffect(() => {
      if (!instance) {
        fitAddonRef.current = null;
        setFitAddon(null);
        setTerminal(null);
        return;
      }

      const fitAddon = new FitAddon();
      instance.loadAddon(fitAddon);
      fitAddonRef.current = fitAddon;
      setFitAddon(fitAddon);
      setTerminal(instance);

      runPostSelectResize();

      return () => {
        try {
          fitAddon.dispose();
        } finally {
          fitAddonRef.current = null;
          setFitAddon(null);
          setTerminal(null);
        }
      };
    }, [instance, runPostSelectResize, setFitAddon, setTerminal]);

    useEffect(() => {
      const el = containerRef.current;
      if (!el) return;
      let rafId: number | null = null;
      const ro = new ResizeObserver(() => {
        if (rafId !== null) {
          cancelAnimationFrame(rafId);
        }
        rafId = requestAnimationFrame(() => {
          rafId = null;
          scheduleResize('resize');
        });
      });
      ro.observe(el);
      return () => {
        ro.disconnect();
        if (rafId !== null) {
          cancelAnimationFrame(rafId);
        }
      };
    }, [scheduleResize]);

    useEffect(() => {
      if (!instance || !deviceId || !paneId) return;

      const disposable = instance.onData((data) => {
        if (!deviceConnected || isSelectionInvalid) return;
        sendTerminalInput(data);
      });

      instance.attachCustomKeyEventHandler((domEvent) => {
        if (!deviceConnected || isSelectionInvalid) return true;
        if (domEvent.type !== 'keydown') return true;
        if (inputMode !== 'direct') return true;

        if (domEvent.shiftKey && domEvent.key === 'Enter') {
          domEvent.preventDefault();
          sendTerminalInput('\x1b[13;2u');
          return false;
        }

        return true;
      });

      return () => {
        disposable.dispose();
        instance.attachCustomKeyEventHandler(() => true);
      };
    }, [
      instance,
      deviceConnected,
      isSelectionInvalid,
      inputMode,
      sendTerminalInput,
      deviceId,
      paneId,
    ]);

    useImperativeHandle(
      ref,
      () => ({
        write: (data) => instance?.write(data),
        reset: () => {
          instance?.reset();
          liveOutputEndedWithCR.current = false;
        },
        scrollToBottom: () => instance?.scrollToBottom(),
        resize: (cols, rows) => instance?.resize(cols, rows),
        getTerminal: () => instance ?? null,
        getSize: () => {
          if (!instance) return null;
          return { cols: Math.max(2, instance.cols), rows: Math.max(2, instance.rows) };
        },
        runPostSelectResize: () => runPostSelectResize(),
        scheduleResize: (kind, options) => scheduleResize(kind, options),
        calculateSizeFromContainer: () => {
          const container = containerRef.current;
          const term = instance;
          const fitAddon = fitAddonRef.current;
          if (!container || !term) return null;

          const rect = container.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) return null;

          const core = term._core;
          let cols: number;
          if (fitAddon) {
            try {
              const dims = fitAddon.proposeDimensions();
              if (dims) {
                cols = Math.max(2, dims.cols);
              } else {
                const cellWidth = core?._renderService?.dimensions?.css?.cell?.width ?? 9;
                cols = Math.max(2, Math.floor(rect.width / cellWidth));
              }
            } catch {
              const cellWidth = core?._renderService?.dimensions?.css?.cell?.width ?? 9;
              cols = Math.max(2, Math.floor(rect.width / cellWidth));
            }
          } else {
            const cellWidth = core?._renderService?.dimensions?.css?.cell?.width ?? 9;
            cols = Math.max(2, Math.floor(rect.width / cellWidth));
          }

          const cellHeight = core?._renderService?.dimensions?.css?.cell?.height ?? 17;
          const rows = Math.max(2, Math.floor(rect.height / cellHeight));

          return { cols, rows };
        },
        getPendingLocalSize: () => pendingLocalSize.current,
      }),
      [instance, pendingLocalSize, runPostSelectResize, scheduleResize]
    );

    return (
      <div
        ref={containerRef}
        className="h-full w-full relative"
        style={{ backgroundColor: terminalTheme.background }}
        data-terminal-engine={TERMINAL_ENGINE}
      >
        <div ref={mountRef} className="absolute inset-0" />
      </div>
    );
  }
);

Terminal.displayName = 'Terminal';
