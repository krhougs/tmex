import { shouldSyncOnViewportRestore } from '@/utils/resizeSyncGuards';
import type { CompatibleTerminalLike } from 'ghostty-terminal';
import type { FitAddon } from 'ghostty-terminal';
import { useCallback, useEffect, useRef } from 'react';

interface UseTerminalResizeOptions {
  deviceId: string;
  paneId: string;
  deviceConnected: boolean;
  isSelectionInvalid: boolean;
  onResize: (cols: number, rows: number) => void;
  onSync: (cols: number, rows: number) => void;
  /** 获取容器尺寸的回调函数，用于 fitAddon 失败时的回退计算 */
  getContainerRect?: () => { width: number; height: number } | null;
}

export function useTerminalResize({
  deviceId,
  paneId,
  deviceConnected,
  isSelectionInvalid,
  onResize,
  onSync,
  getContainerRect,
}: UseTerminalResizeOptions) {
  const resizeRaf = useRef<number | null>(null);
  const resizeTimer = useRef<number | null>(null);
  const lastReportedSize = useRef<{ cols: number; rows: number } | null>(null);
  const pendingLocalSize = useRef<{ cols: number; rows: number; at: number } | null>(null);
  const suppressLocalResizeUntil = useRef(0);
  const postSelectResizeTimers = useRef<number[]>([]);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const terminalRef = useRef<CompatibleTerminalLike | null>(null);
  const getContainerRectRef = useRef(getContainerRect);
  const viewportRestorePendingRef = useRef(false);

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

  useEffect(() => {
    getContainerRectRef.current = getContainerRect;
  }, [getContainerRect]);

  const measureTerminalSize = useCallback((): { cols: number; rows: number } | null => {
    const term = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    if (!term || !fitAddon || !term.element) {
      return null;
    }

    let cols: number;

    try {
      const proposed = fitAddon.proposeDimensions();
      if (!proposed) {
        throw new Error('fitAddon.proposeDimensions() returned null');
      }
      cols = Math.max(2, proposed.cols);
    } catch {
      const core = (term as any)._core;
      const cellWidth = core?._renderService?.dimensions?.css?.cell?.width ?? 9;
      const rect = getContainerRectRef.current?.();
      if (!rect || rect.width === 0) {
        return null;
      }
      cols = Math.max(2, Math.floor(rect.width / cellWidth));
    }

    const containerRect = getContainerRectRef.current?.();
    if (!containerRect || containerRect.height === 0) {
      return null;
    }
    const core = (term as any)._core;
    const cellHeight = core?._renderService?.dimensions?.css?.cell?.height ?? 17;
    const rows = Math.max(2, Math.floor(containerRect.height / cellHeight));

    return { cols, rows };
  }, []);

  const applyTerminalSize = useCallback((cols: number, rows: number): void => {
    const term = terminalRef.current;
    if (!term) {
      return;
    }
    if (term.cols === cols && term.rows === rows) {
      return;
    }
    term.resize(cols, rows);
  }, []);

  const reportSize = useCallback(
    (kind: 'resize' | 'sync', force = false) => {
      // sync 操作即使在 isSelectionInvalid 时也应该执行，因为尺寸同步是基础功能
      // isSelectionInvalid 主要影响用户输入，不应该阻止终端尺寸同步
      if (!deviceId || !paneId || !deviceConnected) {
        return false;
      }
      if (isSelectionInvalid && kind !== 'sync') {
        return false;
      }

      if (!force && Date.now() < suppressLocalResizeUntil.current) {
        return false;
      }

      const term = terminalRef.current;
      if (!term) {
        return false;
      }

      const measuredSize = measureTerminalSize();
      if (!measuredSize) {
        return false;
      }
      const { cols, rows } = measuredSize;
      // Debug: console.log('[resize] success:', { kind, cols, rows, force });
      const lastSize = lastReportedSize.current;

      if (!force && lastSize && lastSize.cols === cols && lastSize.rows === rows) {
        applyTerminalSize(cols, rows);
        return true;
      }

      applyTerminalSize(cols, rows);

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
    [applyTerminalSize, deviceConnected, deviceId, isSelectionInvalid, measureTerminalSize, paneId]
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
      }, 150);
    },
    [reportSize]
  );

  const clearPostSelectResizeTimers = useCallback(() => {
    for (const id of postSelectResizeTimers.current) {
      window.clearTimeout(id);
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

  // 浏览器窗口 resize 处理 - 共享 scheduleResize 的防抖
  useEffect(() => {
    let rafId: number | null = null;
    const handleWindowResize = () => {
      // 使用 RAF 确保在布局完成后执行，并与 ResizeObserver 协调
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
      }
      rafId = requestAnimationFrame(() => {
        rafId = null;
        scheduleResize('resize');
      });
    };

    window.addEventListener('resize', handleWindowResize);
    return () => {
      window.removeEventListener('resize', handleWindowResize);
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
      }
    };
  }, [scheduleResize]);

  useEffect(() => {
    const handleViewportRestore = () => {
      const term = terminalRef.current;
      const containerSize = measureTerminalSize();
      if (!term || !containerSize) {
        return;
      }

      const shouldSync = shouldSyncOnViewportRestore({
        currentSize: { cols: Math.max(2, term.cols), rows: Math.max(2, term.rows) },
        containerSize,
      });
      if (!shouldSync) {
        term.refresh?.();
        return;
      }

      scheduleResize('sync', { force: true });
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') {
        viewportRestorePendingRef.current = true;
        return;
      }
      if (!viewportRestorePendingRef.current) {
        return;
      }
      viewportRestorePendingRef.current = false;
      handleViewportRestore();
    };

    const handleWindowBlur = () => {
      viewportRestorePendingRef.current = true;
    };

    const handleWindowFocus = () => {
      if (!viewportRestorePendingRef.current) {
        return;
      }
      viewportRestorePendingRef.current = false;
      handleViewportRestore();
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('blur', handleWindowBlur);
    window.addEventListener('focus', handleWindowFocus);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('blur', handleWindowBlur);
      window.removeEventListener('focus', handleWindowFocus);
    };
  }, [measureTerminalSize, scheduleResize]);

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

  const setTerminal = useCallback((terminal: CompatibleTerminalLike | null) => {
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
