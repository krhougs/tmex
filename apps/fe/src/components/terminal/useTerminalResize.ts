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
      const fitAddon = fitAddonRef.current;
      if (!term || !fitAddon || !term.element) {
        return false;
      }

      // 宽度信任 fitAddon，高度信任容器
      let cols: number;
      let rows: number;

      // 先调用 fitAddon.fit() 计算宽度
      try {
        fitAddon.fit();
        cols = Math.max(2, term.cols);
      } catch {
        // fitAddon 失败时使用容器宽度和字符宽度计算
        const core = (term as any)._core;
        const cellWidth = core?._renderService?.dimensions?.css?.cell?.width ?? 9;
        const rect = getContainerRect?.();
        if (!rect || rect.width === 0) {
          return false;
        }
        cols = Math.max(2, Math.floor(rect.width / cellWidth));
      }

      // 高度永远使用容器尺寸
      const containerRect = getContainerRect?.();
      if (!containerRect || containerRect.height === 0) {
        return false;
      }
      const core = (term as any)._core;
      const cellHeight = core?._renderService?.dimensions?.css?.cell?.height ?? 17;
      rows = Math.max(2, Math.floor(containerRect.height / cellHeight));
      // Debug: console.log('[resize] success:', { kind, cols, rows, force });
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
      }, 150);
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

  // 重新获得焦点时触发 resize sync - 共享 scheduleResize 的防抖
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        // 使用 sync 类型，因为重新获得焦点时需要同步到远程 pty
        // 不使用 immediate，共享同一个防抖延时
        scheduleResize('sync', { force: true });
      }
    };

    const handleWindowFocus = () => {
      // 不使用 immediate，共享同一个防抖延时
      scheduleResize('sync', { force: true });
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', handleWindowFocus);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', handleWindowFocus);
    };
  }, [scheduleResize]);

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
