import { forwardRef, useImperativeHandle, useRef, useEffect } from 'react';
import { useXTerm } from 'react-xtermjs';
import { FitAddon } from 'xterm-addon-fit';
import { Unicode11Addon } from 'xterm-addon-unicode11';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import type { TerminalProps, TerminalRef } from './types';
import { XTERM_THEME_DARK, XTERM_THEME_LIGHT, XTERM_FONT_FAMILY } from './theme';
import { useTerminalResize } from './useTerminalResize';
import { useMobileTouch } from './useMobileTouch';
import { useTmuxStore } from '@/stores/tmux';

// 工具函数
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

// Stable terminal options - defined outside component to prevent re-creation
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
  (
    {
      deviceId,
      paneId,
      theme,
      inputMode,
      deviceConnected,
      isSelectionInvalid,
      onResize,
      onSync,
    },
    ref
  ) => {
    // Use stable options
    const { instance, ref: xtermRef } = useXTerm({
      options: TERMINAL_OPTIONS,
    });

    const containerRef = useRef<HTMLDivElement>(null);
    const xtermTheme = theme === 'light' ? XTERM_THEME_LIGHT : XTERM_THEME_DARK;

    // 历史数据相关 refs
    const historyBufferRef = useRef<Uint8Array[]>([]);
    const historyAppliedRef = useRef(false);
    const liveOutputEndedWithCR = useRef(false);
    const isTerminalReadyRef = useRef(false);
    const initialResizeDoneRef = useRef(false);
    const fitAddonRef = useRef<FitAddon | null>(null);

    const subscribeBinary = useTmuxStore((state) => state.subscribeBinary);
    const subscribeHistory = useTmuxStore((state) => state.subscribeHistory);
    const sendInput = useTmuxStore((state) => state.sendInput);
    const socketReady = useTmuxStore((state) => state.socketReady);

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
    });

    // 移动端触摸处理
    useMobileTouch(containerRef);

    // 初始化 addons 和 terminal
    useEffect(() => {
      if (!instance) return;

      const fit = new FitAddon();
      const unicode11 = new Unicode11Addon();

      // Load FitAddon first
      instance.loadAddon(fit);
      instance.loadAddon(unicode11);

      // Try to load WebGL addon - but don't fail if it doesn't work
      // Note: WebGL addon may conflict with FitAddon in some cases
      let webgl: WebglAddon | null = null;
      try {
        webgl = new WebglAddon();
        instance.loadAddon(webgl);
        console.log('[xterm] WebGL renderer enabled');
      } catch (e) {
        console.log('[xterm] WebGL not supported, using default renderer');
      }

      if (instance.unicode.versions.includes('11')) {
        instance.unicode.activeVersion = '11';
      }

      fitAddonRef.current = fit;
      setFitAddon(fit);
      setTerminal(instance);

      // 初始 fit - 延迟确保 terminal 已附加到 DOM
      const initTimer = window.setTimeout(() => {
        try {
          // Check if terminal element is ready
          if (fitAddonRef.current && instance.element && instance.element.parentElement) {
            fitAddonRef.current.fit();
            console.log('[Terminal] Initial fit done, cols:', instance.cols, 'rows:', instance.rows);
          } else {
            console.warn('[Terminal] Terminal element not ready for initial fit');
          }
        } catch (e) {
          console.warn('[Terminal] FitAddon initial fit failed:', e);
        }
        isTerminalReadyRef.current = true;
      }, 100);

      return () => {
        window.clearTimeout(initTimer);
        // Dispose addons in reverse order
        try {
          webgl?.dispose();
        } catch (e) {
          // ignore
        }
        fitAddonRef.current = null;
        setFitAddon(null);
        setTerminal(null);
        isTerminalReadyRef.current = false;
        initialResizeDoneRef.current = false;
      };
    }, [instance, setFitAddon, setTerminal]);

    // 主题更新
    useEffect(() => {
      if (!instance) return;
      instance.options.theme = xtermTheme;
      const core = (instance as unknown as {
        _core?: {
          renderer?: { clearTextureAtlas?: () => void };
          viewport?: { refresh: () => void };
        };
      })._core;
      core?.renderer?.clearTextureAtlas?.();
      core?.viewport?.refresh?.();
      instance.refresh(0, instance.rows - 1);
    }, [instance, xtermTheme]);

    // input mode 切换
    useEffect(() => {
      if (!instance) return;
      instance.options.disableStdin = inputMode === 'editor';
    }, [instance, inputMode]);

    // pane 切换时重置状态
    useEffect(() => {
      historyBufferRef.current = [];
      historyAppliedRef.current = false;
      liveOutputEndedWithCR.current = false;
      initialResizeDoneRef.current = false;
      if (instance) {
        instance.reset();
      }
    }, [deviceId, paneId, instance]);

    // 订阅 binary 数据
    useEffect(() => {
      if (!deviceId || !paneId) return;

      return subscribeBinary(deviceId, (output) => {
        const normalized = normalizeLiveOutputForXterm(output, liveOutputEndedWithCR.current);
        liveOutputEndedWithCR.current = normalized.endedWithCR;

        if (!isTerminalReadyRef.current || !instance) {
          historyBufferRef.current.push(normalized.normalized.slice());
          return;
        }

        if (!historyAppliedRef.current) {
          historyBufferRef.current.push(normalized.normalized.slice());
          return;
        }

        instance.write(normalized.normalized);
      });
    }, [deviceId, paneId, instance, subscribeBinary]);

    // 订阅 history 数据
    useEffect(() => {
      if (!deviceId || !paneId || !socketReady) return;

      return subscribeHistory(deviceId, paneId, (data) => {
        if (historyAppliedRef.current) return;

        const term = instance;
        if (!isTerminalReadyRef.current || !term) {
          return;
        }

        term.write(normalizeHistoryForXterm(data));
        // 写入 buffer
        historyBufferRef.current.forEach(chunk => term.write(chunk));
        historyBufferRef.current = [];
        historyAppliedRef.current = true;
      });
    }, [deviceId, paneId, socketReady, instance, subscribeHistory]);

    // 键盘事件处理
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

    // 容器 resize 监听
    useEffect(() => {
      const container = containerRef.current;
      if (!container) return;

      const observer = new ResizeObserver(() => {
        try {
          if (fitAddonRef.current && instance?.element) {
            fitAddonRef.current.fit();
          }
        } catch (e) {
          // Ignore fit errors during resize
        }
        if (deviceConnected && !isSelectionInvalid) {
          scheduleResize('resize');
        }
      });

      observer.observe(container);
      return () => observer.disconnect();
    }, [deviceConnected, isSelectionInvalid, scheduleResize, instance]);

    // window resize
    useEffect(() => {
      if (!deviceConnected || isSelectionInvalid) return;

      const handleResize = () => scheduleResize('resize');
      window.addEventListener('resize', handleResize);
      return () => window.removeEventListener('resize', handleResize);
    }, [deviceConnected, isSelectionInvalid, scheduleResize]);

    // pane 选择后的 resize - 只在 paneId 变化时触发一次
    useEffect(() => {
      if (!deviceConnected || !paneId || isSelectionInvalid) return;
      if (initialResizeDoneRef.current) return;
      
      initialResizeDoneRef.current = true;
      runPostSelectResize();
    }, [deviceConnected, paneId, isSelectionInvalid, runPostSelectResize]);

    // 暴露方法给父组件
    useImperativeHandle(ref, () => ({
      write: (data) => instance?.write(data),
      reset: () => {
        instance?.reset();
        historyBufferRef.current = [];
        historyAppliedRef.current = false;
        liveOutputEndedWithCR.current = false;
        initialResizeDoneRef.current = false;
      },
      scrollToBottom: () => instance?.scrollToBottom(),
      resize: (cols, rows) => instance?.resize(cols, rows),
      getTerminal: () => instance ?? null,
      runPostSelectResize,
      scheduleResize,
    }), [instance, runPostSelectResize, scheduleResize]);

    return (
      <div
        ref={containerRef}
        className="h-full w-full relative"
        style={{ backgroundColor: xtermTheme.background }}
      >
        {/* useXTerm's ref attaches the xterm container here */}
        <div ref={xtermRef} className="absolute inset-0" />
      </div>
    );
  }
);

Terminal.displayName = 'Terminal';
