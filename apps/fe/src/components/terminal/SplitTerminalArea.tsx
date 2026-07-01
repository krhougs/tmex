// PC 分屏渲染区域：按 tmux window layout 同屏渲染 window 内全部 pane。
//
// - 布局真相源是 tmux layout：pane 容器按 layout 树的 cells 比例绝对定位，
//   每个 pane 挂一个 sizingMode="follow" 的 Terminal 实例并 resize 到精确 cols/rows；
// - 相邻 pane 间的 1 cell 间隙渲染 splitter，拖拽中只画参考线，
//   pointerup 一次性提交 resize-pane 绝对值，等 layout 经快照回流刷新（无回弹）；
// - 整个区域的容器尺寸经防抖上报为 window 尺寸（resize-window 语义）；
// - 焦点 pane 由 URL 决定，点击非焦点 pane 触发 onUserSelectPane（轻量 focus 路径）。

import { useTmuxStore } from '@/stores/tmux';
import type { TmuxWindow } from '@tmex/shared';
import { parseWindowLayout } from '@tmex/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Terminal } from './Terminal';
import {
  type SplitGutter,
  computeSplitLayoutGeometry,
  resolveGutterDrag,
} from './splitLayoutGeometry';
import type { TerminalRef, TerminalTheme } from './types';

export interface SplitTerminalAreaProps {
  deviceId: string;
  window: TmuxWindow;
  focusedPaneId: string;
  theme: TerminalTheme;
  inputMode: 'direct' | 'editor';
  deviceConnected: boolean;
  /** 焦点 pane 的 TerminalRef 会转发到这里（DevicePage 的 terminalRef） */
  focusedTerminalRef: (ref: TerminalRef | null) => void;
  onUserSelectPane: (windowId: string, paneId: string) => void;
  /** window 级尺寸上报（resize-window 语义），复用单 pane 的 KIND_TERM_RESIZE 通道 */
  onWindowResize: (cols: number, rows: number) => void;
}

interface DragState {
  gutterIndex: number;
  deltaPx: number;
}

const WINDOW_RESIZE_DEBOUNCE_MS = 150;
const CELL_SIZE_RETRY_MS = 200;
const CELL_SIZE_MAX_RETRIES = 15;

export function SplitTerminalArea({
  deviceId,
  window: tmuxWindow,
  focusedPaneId,
  theme,
  inputMode,
  deviceConnected,
  focusedTerminalRef,
  onUserSelectPane,
  onWindowResize,
}: SplitTerminalAreaProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRefs = useRef(new Map<string, TerminalRef | null>());
  const [dragState, setDragState] = useState<DragState | null>(null);

  const subscribePanes = useTmuxStore((state) => state.subscribePanes);
  const fetchPaneHistory = useTmuxStore((state) => state.fetchPaneHistory);
  const resizePaneInWindow = useTmuxStore((state) => state.resizePaneInWindow);

  const layout = useMemo(
    () => (tmuxWindow.layout ? parseWindowLayout(tmuxWindow.layout) : null),
    [tmuxWindow.layout]
  );

  // 几何单位先用 cells，渲染时换算为百分比（容器与 window 尺寸过渡期失配时仍铺满）
  const geometry = useMemo(() => {
    if (!layout) return null;
    return computeSplitLayoutGeometry(layout.root, { width: 1, height: 1 });
  }, [layout]);

  const rootCols = layout?.root.width ?? 1;
  const rootRows = layout?.root.height ?? 1;

  // 集合语义用逗号串表达，避免快照每次刷新引用变化导致 effect 空转
  const knownPaneIdsKey = tmuxWindow.panes.map((pane) => pane.id).join(',');

  // 附加订阅集：window 内全部 pane（焦点在 gateway 侧优先走 barrier 路径）
  useEffect(() => {
    subscribePanes(deviceId, knownPaneIdsKey ? knownPaneIdsKey.split(',') : []);
    return () => {
      subscribePanes(deviceId, []);
    };
  }, [deviceId, knownPaneIdsKey, subscribePanes]);

  // 非焦点 pane 首屏：fetch history（焦点 pane 的内容来自 select 流程）；
  // 每个 pane 只 fetch 一次，window 切换时重置
  const fetchStateRef = useRef({ key: '', fetched: new Set<string>() });
  useEffect(() => {
    const windowKey = `${deviceId}:${tmuxWindow.id}`;
    if (fetchStateRef.current.key !== windowKey) {
      fetchStateRef.current = { key: windowKey, fetched: new Set() };
    }
    for (const paneId of knownPaneIdsKey ? knownPaneIdsKey.split(',') : []) {
      if (fetchStateRef.current.fetched.has(paneId)) continue;
      fetchStateRef.current.fetched.add(paneId);
      if (paneId === focusedPaneId) continue;
      fetchPaneHistory(deviceId, paneId);
    }
  }, [deviceId, tmuxWindow.id, knownPaneIdsKey, focusedPaneId, fetchPaneHistory]);

  // 各实例 cols/rows 跟随 layout（tmux 是尺寸权威，不信容器像素测量）
  useEffect(() => {
    if (!geometry) return;
    for (const pane of geometry.panes) {
      terminalRefs.current.get(pane.paneId)?.resize(pane.cols, pane.rows);
    }
  }, [geometry]);

  // 焦点变化时聚焦对应实例
  useEffect(() => {
    if (inputMode !== 'direct') return;
    const isMobileLike = window.innerWidth < 768 || 'ontouchstart' in window;
    if (isMobileLike) return;
    terminalRefs.current.get(focusedPaneId)?.getTerminal()?.focus();
  }, [focusedPaneId, inputMode]);

  const getFocusedCellSize = useCallback((): { width: number; height: number } | null => {
    for (const paneId of [focusedPaneId, ...terminalRefs.current.keys()]) {
      const cell = terminalRefs.current.get(paneId)?.getCellSize();
      if (cell) return cell;
    }
    return null;
  }, [focusedPaneId]);

  // window 级 resize：容器尺寸 / cell 尺寸 → 整窗 cols/rows（防抖 + cellSize 未就绪重试）
  const reportWindowSize = useCallback(() => {
    const container = containerRef.current;
    if (!container) return false;
    const rect = container.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return false;
    const cell = getFocusedCellSize();
    if (!cell) return false;
    const cols = Math.max(2, Math.floor(rect.width / cell.width));
    const rows = Math.max(2, Math.floor(rect.height / cell.height));
    onWindowResize(cols, rows);
    return true;
  }, [getFocusedCellSize, onWindowResize]);

  const reportWindowSizeRef = useRef(reportWindowSize);
  useEffect(() => {
    reportWindowSizeRef.current = reportWindowSize;
  }, [reportWindowSize]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retries = 0;

    const tryReport = () => {
      if (reportWindowSizeRef.current()) {
        retries = 0;
        return;
      }
      // cellSize 未就绪（实例仍在异步创建），有限重试
      if (retries < CELL_SIZE_MAX_RETRIES) {
        retries += 1;
        retryTimer = setTimeout(tryReport, CELL_SIZE_RETRY_MS);
      }
    };

    const observer = new ResizeObserver(() => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(tryReport, WINDOW_RESIZE_DEBOUNCE_MS);
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
      if (debounceTimer) clearTimeout(debounceTimer);
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, []);

  // splitter 拖拽：pointermove 只更新参考线，pointerup 提交 resize-pane 绝对值
  const handleGutterPointerDown = useCallback(
    (gutterIndex: number, gutter: SplitGutter, event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const container = containerRef.current;
      if (!container) return;

      const startX = event.clientX;
      const startY = event.clientY;
      const target = event.currentTarget;
      target.setPointerCapture(event.pointerId);
      setDragState({ gutterIndex, deltaPx: 0 });

      const onMove = (moveEvent: PointerEvent) => {
        const delta = gutter.axis === 'x' ? moveEvent.clientX - startX : moveEvent.clientY - startY;
        setDragState({ gutterIndex, deltaPx: delta });
      };

      const finish = (upEvent: PointerEvent, commit: boolean) => {
        target.removeEventListener('pointermove', onMove);
        target.removeEventListener('pointerup', onUp);
        target.removeEventListener('pointercancel', onCancel);
        setDragState(null);
        if (!commit) return;

        const rect = container.getBoundingClientRect();
        const pxPerCell =
          gutter.axis === 'x'
            ? rect.width / Math.max(1, rootCols)
            : rect.height / Math.max(1, rootRows);
        const deltaPx = gutter.axis === 'x' ? upEvent.clientX - startX : upEvent.clientY - startY;
        const resolved = resolveGutterDrag(gutter, deltaPx, {
          width: gutter.axis === 'x' ? pxPerCell : 1,
          height: gutter.axis === 'y' ? pxPerCell : 1,
        });
        if (!resolved) return;
        resizePaneInWindow(
          deviceId,
          gutter.edgeLeafPaneId,
          gutter.axis === 'x'
            ? { cols: resolved.targetSizeCells }
            : { rows: resolved.targetSizeCells }
        );
      };

      const onUp = (upEvent: PointerEvent) => finish(upEvent, true);
      const onCancel = (cancelEvent: PointerEvent) => finish(cancelEvent, false);

      target.addEventListener('pointermove', onMove);
      target.addEventListener('pointerup', onUp);
      target.addEventListener('pointercancel', onCancel);
    },
    [deviceId, resizePaneInWindow, rootCols, rootRows]
  );

  const bindTerminalRef = useCallback(
    (paneId: string) => (ref: TerminalRef | null) => {
      if (ref) {
        terminalRefs.current.set(paneId, ref);
      } else {
        terminalRefs.current.delete(paneId);
      }
      if (paneId === focusedPaneId) {
        focusedTerminalRef(ref);
      }
    },
    [focusedPaneId, focusedTerminalRef]
  );

  // 焦点切换时把外部 ref 重新指到新焦点实例
  useEffect(() => {
    focusedTerminalRef(terminalRefs.current.get(focusedPaneId) ?? null);
  }, [focusedPaneId, focusedTerminalRef]);

  if (!geometry) {
    return null;
  }

  const pct = (cells: number, total: number) => `${(cells / Math.max(1, total)) * 100}%`;

  return (
    <div
      ref={containerRef}
      className="relative h-full w-full min-h-0 min-w-0"
      data-testid="split-terminal-area"
    >
      {geometry.panes.map((pane) => {
        const isFocused = pane.paneId === focusedPaneId;
        return (
          <div
            key={pane.paneId}
            className="absolute"
            data-testid="split-pane"
            data-pane-id={pane.paneId}
            data-focused={isFocused || undefined}
            style={{
              left: pct(pane.rect.left, rootCols),
              top: pct(pane.rect.top, rootRows),
              width: pct(pane.rect.width, rootCols),
              height: pct(pane.rect.height, rootRows),
            }}
            onPointerDownCapture={() => {
              if (!isFocused) {
                onUserSelectPane(tmuxWindow.id, pane.paneId);
              }
            }}
          >
            <Terminal
              key={`${deviceId}:${pane.paneId}`}
              ref={bindTerminalRef(pane.paneId)}
              deviceId={deviceId}
              paneId={pane.paneId}
              theme={theme}
              inputMode={inputMode}
              deviceConnected={deviceConnected}
              isSelectionInvalid={false}
              sizingMode="follow"
              autoFocus={isFocused}
              onResize={() => {}}
              onSync={() => {}}
            />
            {/* active pane 角标：右上角小圆点，不改边框、不遮内容 */}
            {isFocused && (
              <div
                className="pointer-events-none absolute right-1.5 top-1.5 z-10 h-1.5 w-1.5 rounded-full bg-primary shadow-[0_0_6px_1px] shadow-primary/50"
                data-testid="split-pane-active-indicator"
              />
            )}
          </div>
        );
      })}

      {geometry.gutters.map((gutter, index) => {
        const isVertical = gutter.axis === 'x';
        const isDragging = dragState?.gutterIndex === index;
        return (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: gutter 与 layout 树一一对应，无稳定 id
            key={`${tmuxWindow.layout ?? ''}:${index}`}
            className="absolute z-20"
            style={{
              left: pct(gutter.rect.left, rootCols),
              top: pct(gutter.rect.top, rootRows),
              width: isVertical ? pct(1, rootCols) : pct(gutter.rect.width, rootCols),
              height: isVertical ? pct(gutter.rect.height, rootRows) : pct(1, rootRows),
            }}
          >
            <div
              data-testid="split-gutter"
              data-axis={gutter.axis}
              className={`absolute touch-none select-none ${
                isVertical
                  ? '-inset-x-1 inset-y-0 cursor-col-resize'
                  : 'inset-x-0 -inset-y-1 cursor-row-resize'
              }`}
              onPointerDown={(event) => handleGutterPointerDown(index, gutter, event)}
            >
              <div
                className={`absolute bg-foreground/20 transition-colors hover:bg-primary/70 ${
                  isVertical
                    ? 'inset-y-0 left-1/2 w-px -translate-x-1/2'
                    : 'inset-x-0 top-1/2 h-px -translate-y-1/2'
                } ${isDragging ? 'bg-primary' : ''}`}
              />
            </div>
            {/* 拖拽参考线 */}
            {isDragging && dragState && (
              <div
                className="pointer-events-none absolute bg-primary/70"
                style={
                  isVertical
                    ? {
                        top: 0,
                        bottom: 0,
                        width: 2,
                        left: `calc(50% + ${dragState.deltaPx}px)`,
                      }
                    : {
                        left: 0,
                        right: 0,
                        height: 2,
                        top: `calc(50% + ${dragState.deltaPx}px)`,
                      }
                }
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
