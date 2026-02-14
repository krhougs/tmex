import { useCallback, useRef, useEffect } from 'react';
import type { Terminal as XTermTerminal } from '@xterm/xterm';
import type { FitAddon } from 'xterm-addon-fit';

interface UseTerminalResizeOptions {
  deviceId: string;
  paneId: string;
  deviceConnected: boolean;
  isSelectionInvalid: boolean;
  onResize: (cols: number, rows: number) => void;
  onSync: (cols: number, rows: number) => void;
}

export function useTerminalResize({
  deviceId,
  paneId,
  deviceConnected,
  isSelectionInvalid,
  onResize,
  onSync,
}: UseTerminalResizeOptions) {
  const resizeRaf = useRef<number | null>(null);
  const resizeTimer = useRef<number | null>(null);
  const lastReportedSize = useRef<{ cols: number; rows: number } | null>(null);
  const pendingLocalSize = useRef<{ cols: number; rows: number; at: number } | null>(null);
  const suppressLocalResizeUntil = useRef(0);
  const postSelectResizeTimers = useRef<number[]>([]);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const terminalRef = useRef<XTermTerminal | null>(null);
  
  // Use refs to store callbacks to avoid dependency cycles
  const onResizeRef = useRef(onResize);
  const onSyncRef = useRef(onSync);
  
  // Update refs when callbacks change
  useEffect(() => {
    onResizeRef.current = onResize;
  }, [onResize]);
  
  useEffect(() => {
    onSyncRef.current = onSync;
  }, [onSync]);

  const reportSize = useCallback(
    (kind: 'resize' | 'sync', force = false) => {
      if (!deviceId || !paneId || !deviceConnected || isSelectionInvalid) {
        return false;
      }

      if (!force && Date.now() < suppressLocalResizeUntil.current) {
        return false;
      }

      const term = terminalRef.current;
      const fitAddon = fitAddonRef.current;
      if (!term || !fitAddon || !term.element) return false;

      try {
        fitAddon.fit();
      } catch (e) {
        // FitAddon may fail if terminal is not fully ready
        return false;
      }
      const cols = Math.max(2, term.cols);
      const rows = Math.max(2, term.rows);
      const lastSize = lastReportedSize.current;

      if (!force && lastSize && lastSize.cols === cols && lastSize.rows === rows) {
        return true;
      }

      if (kind === 'sync') {
        onSyncRef.current(cols, rows);
      } else {
        onResizeRef.current(cols, rows);
      }

      lastReportedSize.current = { cols, rows };
      pendingLocalSize.current = { cols, rows, at: Date.now() };
      return true;
    },
    // Only depend on stable values, not the callbacks
    [deviceId, paneId, deviceConnected, isSelectionInvalid]
  );

  const scheduleResize = useCallback(
    (kind: 'resize' | 'sync' = 'resize', options: { immediate?: boolean; force?: boolean } = {}) => {
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
          reportSize(kind, force);
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
    [reportSize]
  );

  const clearPostSelectResizeTimers = useCallback(() => {
    postSelectResizeTimers.current.forEach((id) => window.clearTimeout(id));
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

  // 清理
  useEffect(() => {
    return () => {
      clearPostSelectResizeTimers();
      if (resizeTimer.current !== null) {
        window.clearTimeout(resizeTimer.current);
      }
      if (resizeRaf.current !== null) {
        cancelAnimationFrame(resizeRaf.current);
      }
    };
  }, [clearPostSelectResizeTimers]);

  const setFitAddon = useCallback((addon: FitAddon | null) => {
    fitAddonRef.current = addon;
  }, []);

  const setTerminal = useCallback((terminal: XTermTerminal | null) => {
    terminalRef.current = terminal;
  }, []);

  return {
    scheduleResize,
    runPostSelectResize,
    clearPostSelectResizeTimers,
    setFitAddon,
    setTerminal,
    lastReportedSize,
    pendingLocalSize,
    suppressLocalResizeUntil,
  };
}
