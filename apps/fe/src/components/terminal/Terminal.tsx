import { forwardRef, useImperativeHandle, useRef, useEffect } from 'react';
import { useXTerm } from 'react-xtermjs';
import '@xterm/xterm/css/xterm.css';
import type { TerminalProps, TerminalRef } from './types';
import { XTERM_THEME_DARK, XTERM_THEME_LIGHT, XTERM_FONT_FAMILY } from './theme';
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
    const lastReportedSize = useRef<{ cols: number; rows: number } | null>(null);

    const subscribeBinary = useTmuxStore((state) => state.subscribeBinary);
    const subscribeHistory = useTmuxStore((state) => state.subscribeHistory);
    const sendInput = useTmuxStore((state) => state.sendInput);
    const socketReady = useTmuxStore((state) => state.socketReady);

    // 主题更新
    useEffect(() => {
      if (!instance) return;
      instance.options.theme = xtermTheme;
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
      lastReportedSize.current = null;
      if (instance) {
        instance.reset();
      }
    }, [deviceId, paneId, instance]);

    // 订阅 binary 数据
    useEffect(() => {
      if (!deviceId || !paneId) return;
      isTerminalReadyRef.current = true;

      return subscribeBinary(deviceId, (output) => {
        const normalized = normalizeLiveOutputForXterm(output, liveOutputEndedWithCR.current);
        liveOutputEndedWithCR.current = normalized.endedWithCR;

        if (!instance) {
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
        if (!term) {
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

    // Resize handling - report size when connected
    useEffect(() => {
      if (!deviceConnected || !instance || isSelectionInvalid) return;
      
      const reportSize = () => {
        const cols = instance.cols;
        const rows = instance.rows;
        const lastSize = lastReportedSize.current;
        
        if (lastSize && lastSize.cols === cols && lastSize.rows === rows) {
          return;
        }
        
        lastReportedSize.current = { cols, rows };
        onSync(cols, rows);
      };

      // Report initial size
      reportSize();

      // Report on window resize
      const handleResize = () => {
        // xterm.js handles its own resize, just report new size
        reportSize();
        onResize(instance.cols, instance.rows);
      };
      
      window.addEventListener('resize', handleResize);
      return () => window.removeEventListener('resize', handleResize);
    }, [deviceConnected, instance, isSelectionInvalid, onResize, onSync]);

    // 暴露方法给父组件
    useImperativeHandle(ref, () => ({
      write: (data) => instance?.write(data),
      reset: () => {
        instance?.reset();
        historyBufferRef.current = [];
        historyAppliedRef.current = false;
        liveOutputEndedWithCR.current = false;
        lastReportedSize.current = null;
      },
      scrollToBottom: () => instance?.scrollToBottom(),
      resize: (cols, rows) => instance?.resize(cols, rows),
      getTerminal: () => instance ?? null,
      runPostSelectResize: () => {},
      scheduleResize: () => {},
    }), [instance]);

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
