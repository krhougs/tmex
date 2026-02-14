import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import { useXTerm } from 'react-xtermjs';
import '@xterm/xterm/css/xterm.css';
import type { TerminalProps, TerminalRef } from './types';
import { XTERM_FONT_FAMILY, XTERM_THEME_DARK, XTERM_THEME_LIGHT } from './theme';
import { useTmuxStore } from '@/stores/tmux';
import { getSelectStateMachine, type SelectCallbacks } from '@/ws-borsh';
import { FitAddon } from 'xterm-addon-fit';
import { useTerminalResize } from './useTerminalResize';

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

const TERMINAL_OPTIONS = {
  fontFamily: XTERM_FONT_FAMILY,
  fontSize: 13,
  convertEol: true,
  scrollSensitivity: 2,
  smoothScrollDuration: 120,
  letterSpacing: 0,
  cursorBlink: true,
  allowProposedApi: true,
  scrollback: 10000,
};

export const Terminal = forwardRef<TerminalRef, TerminalProps>(
  ({ deviceId, paneId, theme, inputMode, deviceConnected, isSelectionInvalid, onResize, onSync }, ref) => {
    const { instance, ref: xtermRef } = useXTerm({
      options: TERMINAL_OPTIONS,
    });

    const xtermTheme = theme === 'light' ? XTERM_THEME_LIGHT : XTERM_THEME_DARK;

    const sendInput = useTmuxStore((state) => state.sendInput);

    const containerRef = useRef<HTMLDivElement>(null);
    const currentDeviceIdRef = useRef(deviceId);
    const currentPaneIdRef = useRef(paneId);
    const canWriteRef = useRef(deviceConnected && !isSelectionInvalid);
    const liveOutputEndedWithCR = useRef(false);
    const lastXtermInstanceRef = useRef<typeof instance>(null);
    const fitAddonRef = useRef<FitAddon | null>(null);

    useEffect(() => {
      currentDeviceIdRef.current = deviceId;
      currentPaneIdRef.current = paneId;
    }, [deviceId, paneId]);

    useEffect(() => {
      canWriteRef.current = deviceConnected && !isSelectionInvalid;
    }, [deviceConnected, isSelectionInvalid]);

    const {
      scheduleResize,
      runPostSelectResize,
      setFitAddon,
      setTerminal,
    } = useTerminalResize({
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
      if (!instance) return;
      instance.options.theme = xtermTheme;
    }, [instance, xtermTheme]);

    useEffect(() => {
      if (!instance) return;
      instance.options.disableStdin = inputMode === 'editor';
    }, [instance, inputMode]);

    const callbacks: SelectCallbacks = useMemo(
      () => {
        // xterm 实例未就绪时不注册回调，让状态机走 deferred 重放，避免 history/live 被“消费掉”。
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
            instance.write(normalizeHistoryForXterm(data));
          },
          onFlushBuffer: (targetDeviceId, buffer) => {
            if (currentDeviceIdRef.current !== targetDeviceId) return;
            for (const chunk of buffer) {
              const normalized = normalizeLiveOutputForXterm(chunk, liveOutputEndedWithCR.current);
              liveOutputEndedWithCR.current = normalized.endedWithCR;
              instance.write(normalized.normalized);
            }
          },
          onOutput: (targetDeviceId, targetPaneId, data) => {
            if (currentDeviceIdRef.current !== targetDeviceId) return;
            if (currentPaneIdRef.current !== targetPaneId) return;
            if (!canWriteRef.current) return;
            const normalized = normalizeLiveOutputForXterm(data, liveOutputEndedWithCR.current);
            liveOutputEndedWithCR.current = normalized.endedWithCR;
            instance.write(normalized.normalized);
          },
        };
      },
      [instance, runPostSelectResize]
    );

    useEffect(() => {
      if (!instance) {
        lastXtermInstanceRef.current = null;
      } else if (lastXtermInstanceRef.current !== instance) {
        // 先 reset，再注册回调，确保 deferred history 重放不会被后续 reset 清掉。
        liveOutputEndedWithCR.current = false;
        instance.reset();
        lastXtermInstanceRef.current = instance;
      }
    }, [instance]);

    useEffect(() => {
      if (!import.meta.env.DEV) return;
      const g = globalThis as any;
      if (!g.__TMEX_E2E_DEBUG) return;
      if (instance) {
        g.__tmexE2eXterm = instance;
      }
      return () => {
        if (g.__tmexE2eXterm === instance) {
          g.__tmexE2eXterm = null;
        }
      };
    }, [instance]);

    useEffect(() => {
      getSelectStateMachine(callbacks);
    }, [callbacks]);

    useEffect(() => {
      return () => {
        // Terminal 卸载时清空回调，避免把 in-flight history/output 写入已销毁的 xterm。
        // 状态/事务不在这里 cleanup，cleanup 由“真实断连路径”负责。
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

      scheduleResize('sync', { immediate: true, force: true });

      return () => {
        try {
          fitAddon.dispose();
        } finally {
          fitAddonRef.current = null;
          setFitAddon(null);
          setTerminal(null);
        }
      };
    }, [instance, scheduleResize, setFitAddon, setTerminal]);

    useEffect(() => {
      const el = containerRef.current;
      if (!el) return;
      let rafId: number | null = null;
      const ro = new ResizeObserver(() => {
        // 使用 requestAnimationFrame 确保在布局完成后执行
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
        sendInput(deviceId, paneId, data, false);
      });

      instance.attachCustomKeyEventHandler((domEvent) => {
        if (!deviceConnected || isSelectionInvalid) return true;
        if (domEvent.type !== 'keydown') return true;
        if (inputMode !== 'direct') return true;

        if (domEvent.shiftKey && domEvent.key === 'Enter') {
          domEvent.preventDefault();
          sendInput(deviceId, paneId, '\x1b[13;2u', false);
          return false;
        }

        return true;
      });

      return () => {
        disposable.dispose();
        instance.attachCustomKeyEventHandler(() => true);
      };
    }, [instance, deviceId, paneId, deviceConnected, isSelectionInvalid, inputMode, sendInput]);

    useImperativeHandle(
      ref,
      () => ({
        write: (data) => instance?.write(data as any),
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

          const core = (term as any)._core;

          // 宽度：信任 fitAddon
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

          // 高度：永远信任容器
          const cellHeight = core?._renderService?.dimensions?.css?.cell?.height ?? 17;
          const rows = Math.max(2, Math.floor(rect.height / cellHeight));

          return { cols, rows };
        },
      }),
      [instance, runPostSelectResize, scheduleResize]
    );

    return (
      <div
        ref={containerRef}
        className="h-full w-full relative"
        style={{ backgroundColor: xtermTheme.background }}
      >
        <div ref={xtermRef} className="absolute inset-0" />
      </div>
    );
  }
);

Terminal.displayName = 'Terminal';
