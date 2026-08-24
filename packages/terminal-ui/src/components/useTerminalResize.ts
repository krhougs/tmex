import type { CompatibleTerminalLike } from 'ghostty-terminal';
import type { FitAddon } from 'ghostty-terminal';
import { useCallback, useEffect, useRef } from 'react';
import { shouldSyncOnViewportRestore } from '../utils/resizeSyncGuards';

interface UseTerminalResizeOptions {
  deviceId: string;
  paneId: string;
  deviceConnected: boolean;
  isSelectionInvalid: boolean;
  /**
   * report（默认）：容器尺寸变化测量后上报 onResize/onSync（单 pane 整窗语义）。
   * follow：分屏模式，pane 尺寸由 tmux layout 决定，本地只对齐不上报，
   * 避免多个 pane 实例互相抢整窗尺寸。
   */
  sizingMode?: 'report' | 'follow';
  onResize: (cols: number, rows: number) => void;
  onSync: (cols: number, rows: number) => void;
  /**
   * resize/sync 成功上报后附加触发（同 150ms 防抖节奏）。
   * 用于 resize 路径附加发一次主题同步消息（KIND_TMUX_SET_WINDOW_STYLE），
   * 让 gateway 重查 OSC 11 代答色，避免 resize 后 TUI 颜色与前端主题脱节。
   * 仅在 reportSize 实际上报（非 short-circuit）时触发。
   */
  onResizeSettled?: (cols: number, rows: number) => void;
  /** 获取容器尺寸的回调函数，用于 fitAddon 失败时的回退计算 */
  getContainerRect?: () => { width: number; height: number } | null;
}

export function useTerminalResize({
  deviceId,
  paneId,
  deviceConnected,
  isSelectionInvalid,
  sizingMode = 'report',
  onResize,
  onSync,
  onResizeSettled,
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
  const onResizeSettledRef = useRef(onResizeSettled);

  // Update refs when callbacks change
  useEffect(() => {
    onResizeRef.current = onResize;
  }, [onResize]);

  useEffect(() => {
    onSyncRef.current = onSync;
  }, [onSync]);

  useEffect(() => {
    onResizeSettledRef.current = onResizeSettled;
  }, [onResizeSettled]);

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
      // follow 模式：pane 的 cols/rows 由 tmux layout 决定并经外部 resize() 显式设定，
      // 容器像素测量（zoom 下有舍入误差）不可作为尺寸来源，也不上报
      if (sizingMode === 'follow') {
        return false;
      }
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

      // 测量值与上次上报相同则不重复上行（force 也不例外）：快照恢复会高频
      // 触发 force sync，重申相同尺寸会与其他客户端互相抢 tmux 尺寸形成
      // resize 乒乓。此时也不把本地终端拉回容器测量值——本地尺寸可能已被
      // remote 尺寸回灌接管（多客户端 last-writer-wins）。
      if (lastSize && lastSize.cols === cols && lastSize.rows === rows) {
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
      onResizeSettledRef.current?.(cols, rows);
      return true;
    },
    // Only depend on stable values, not the callbacks
    [
      applyTerminalSize,
      deviceConnected,
      deviceId,
      isSelectionInvalid,
      measureTerminalSize,
      paneId,
      sizingMode,
    ]
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

  const forceResize = useCallback(() => {
    lastReportedSize.current = null;
    scheduleResize('sync', { immediate: true, force: true });
  }, [scheduleResize]);

  // 断连时清空上报基线：重连后 tmux 尺寸可能已被其他客户端改写，
  // 首次上报必须真实发出（去重基线只在连接内有效）
  useEffect(() => {
    if (!deviceConnected) {
      lastReportedSize.current = null;
    }
  }, [deviceConnected]);

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
        // canvas 位图可能在容器尺寸变化 / DOM 重插入中被 resize 清空，但 ghostty 内核
        // 仍报 dirty='clean'。强制 renderer 全画以避免空白（issue #45 bug 3）。
        // ?.() 容错老版本 terminal 暂未提供 forceFullRepaint 的情形。
        term.forceFullRepaint?.();
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

  const clearPendingLocalSize = useCallback(() => {
    pendingLocalSize.current = null;
  }, []);

  return {
    scheduleResize,
    runPostSelectResize,
    forceResize,
    clearPostSelectResizeTimers,
    setFitAddon,
    setTerminal,
    lastReportedSize,
    pendingLocalSize,
    clearPendingLocalSize,
    suppressLocalResizeUntil,
  };
}
