// PC 分屏渲染区域：按 tmux window layout 同屏渲染 window 内全部 pane。
//
// - 布局真相源是 tmux layout：pane 容器按 layout 树的 cells 比例绝对定位，
//   每个 pane 挂一个 sizingMode="follow" 的 Terminal 实例并 resize 到精确 cols/rows；
// - 每个 pane 顶部有标题栏（名称 + 进程@路径），拖动标题栏到目标 pane 的
//   上/下/左/右四分区可重排布局（tmux move-pane），拖拽中显示半区预览；
// - 相邻 pane 间的 1 cell 间隙渲染 splitter，拖拽中只画参考线，
//   pointerup 一次性提交 resize-pane 绝对值，等 layout 经快照回流刷新（无回弹）；
// - 整个区域的容器尺寸经防抖上报为 window 尺寸（resize-window 语义），
//   高度按最深垂直堆叠扣除标题栏总高；
// - 焦点 pane 由 URL 决定，点击非焦点 pane 触发 onUserSelectPane（轻量 focus 路径）。

import { useTmuxStore } from '@/stores/tmux';
import type { TmuxPane, TmuxWindow } from '@tmex/shared';
import { parseWindowLayout } from '@tmex/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Terminal } from './Terminal';
import {
  type DropPosition,
  type SplitGutter,
  computeSplitLayoutGeometry,
  maxVerticalStackDepth,
  resolveDropPosition,
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

interface DragRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

type PaneDragTarget =
  | { type: 'pane'; paneId: string; position: DropPosition }
  // 拖到侧栏其他窗口行：移入该窗口
  | { type: 'window'; windowId: string; rect: DragRect }
  // 拖到侧栏其余区域：拆为独立窗口
  | { type: 'break'; rect: DragRect };

interface PaneDragState {
  srcPaneId: string;
  /** 超过拖拽阈值才算真正开始（避免与点击聚焦冲突） */
  active: boolean;
  pointerX: number;
  pointerY: number;
  target: PaneDragTarget | null;
}

const WINDOW_RESIZE_DEBOUNCE_MS = 150;
const CELL_SIZE_RETRY_MS = 200;
const CELL_SIZE_MAX_RETRIES = 15;
// 标题栏区域总占位：上留白 6px + 浮起标题栏 24px + 下方视觉空间 8px
const PANE_HEADER_PX = 38;
const PANE_DRAG_THRESHOLD_PX = 6;

function paneDisplayName(pane: TmuxPane | undefined): string {
  return pane?.customName?.trim() || pane?.title?.trim() || 'Pane';
}

function paneMetaText(pane: TmuxPane | undefined): string | null {
  const command = pane?.currentCommand?.trim();
  if (!command) return null;
  const path = pane?.currentPath?.trim();
  return path ? `${command}@${path}` : command;
}

const DROP_PREVIEW_CLASS: Record<DropPosition, string> = {
  left: 'left-0 top-0 bottom-0 w-1/2',
  right: 'right-0 top-0 bottom-0 w-1/2',
  top: 'left-0 right-0 top-0 h-1/2',
  bottom: 'left-0 right-0 bottom-0 h-1/2',
};

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
  const [paneDrag, setPaneDrag] = useState<PaneDragState | null>(null);

  const { t } = useTranslation();
  const subscribePanes = useTmuxStore((state) => state.subscribePanes);
  const fetchPaneHistory = useTmuxStore((state) => state.fetchPaneHistory);
  const resizePaneInWindow = useTmuxStore((state) => state.resizePaneInWindow);
  const movePane = useTmuxStore((state) => state.movePane);
  const breakPane = useTmuxStore((state) => state.breakPane);
  const closePane = useTmuxStore((state) => state.closePane);

  const paneInfoById = useMemo(() => {
    const map = new Map<string, TmuxPane>();
    for (const pane of tmuxWindow.panes) {
      map.set(pane.id, pane);
    }
    return map;
  }, [tmuxWindow.panes]);

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

  // 每个 pane 的标题栏占据实际空间：整窗 rows 按最深的一列扣除标题栏总高，
  // 保证该列的终端区也能放下 layout 分配的行数（其余列底部允许少量留白）
  const titleBarStackDepth = useMemo(
    () => (layout ? maxVerticalStackDepth(layout.root) : 1),
    [layout]
  );

  // window 级 resize：容器尺寸 / cell 尺寸 → 整窗 cols/rows（防抖 + cellSize 未就绪重试）
  const reportWindowSize = useCallback(() => {
    const container = containerRef.current;
    if (!container) return false;
    const rect = container.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return false;
    const cell = getFocusedCellSize();
    if (!cell) return false;
    const usableHeight = Math.max(0, rect.height - titleBarStackDepth * PANE_HEADER_PX);
    const cols = Math.max(2, Math.floor(rect.width / cell.width));
    const rows = Math.max(2, Math.floor(usableHeight / cell.height));
    onWindowResize(cols, rows);
    return true;
  }, [getFocusedCellSize, onWindowResize, titleBarStackDepth]);

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

  // 布局结构变化（split/move-pane 使垂直堆叠数变化）时容器尺寸不变、RO 不触发，
  // 但标题栏占用的总高变了，需要重报整窗 rows（如左右拖成上下后可用高度减一条标题栏）
  useEffect(() => {
    const timer = setTimeout(() => {
      reportWindowSizeRef.current();
    }, WINDOW_RESIZE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [titleBarStackDepth]);

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

  // 标题栏拖拽重排：命中测试基于 layout 比例几何（与渲染同源），
  // 目标 pane 内距最近边的四分区决定 move-pane 的方向
  const handleTitleBarPointerDown = useCallback(
    (srcPaneId: string, event: React.PointerEvent<HTMLDivElement>) => {
      const container = containerRef.current;
      const currentGeometry = geometry;
      if (!container || !currentGeometry) return;
      event.preventDefault();

      const startX = event.clientX;
      const startY = event.clientY;
      const handle = event.currentTarget;
      handle.setPointerCapture(event.pointerId);
      let activated = false;

      const hitTestPanes = (
        clientX: number,
        clientY: number
      ): { paneId: string; position: DropPosition } | null => {
        const rect = container.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) return null;
        const cellX = ((clientX - rect.left) / rect.width) * Math.max(1, rootCols);
        const cellY = ((clientY - rect.top) / rect.height) * Math.max(1, rootRows);
        for (const pane of currentGeometry.panes) {
          if (
            cellX >= pane.rect.left &&
            cellX <= pane.rect.left + pane.rect.width &&
            cellY >= pane.rect.top &&
            cellY <= pane.rect.top + pane.rect.height
          ) {
            const relX = (cellX - pane.rect.left) / Math.max(1e-6, pane.rect.width);
            const relY = (cellY - pane.rect.top) / Math.max(1e-6, pane.rect.height);
            return { paneId: pane.paneId, position: resolveDropPosition(relX, relY) };
          }
        }
        return null;
      };

      const within = (clientX: number, clientY: number, r: DOMRect) =>
        clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;

      // 侧栏落点：窗口行 = 移入该窗口；侧栏其余区域 = 拆为独立窗口
      const hitTestSidebar = (clientX: number, clientY: number): PaneDragTarget | null => {
        for (const row of Array.from(
          document.querySelectorAll('[data-testid^="window-item-"]')
        )) {
          const r = row.getBoundingClientRect();
          if (r.width < 1 || !within(clientX, clientY, r)) continue;
          const windowId = (row.getAttribute('data-testid') ?? '').replace('window-item-', '');
          if (!windowId || windowId === tmuxWindow.id) return null;
          return {
            type: 'window',
            windowId,
            rect: { left: r.left, top: r.top, width: r.width, height: r.height },
          };
        }
        for (const sidebar of Array.from(document.querySelectorAll('[data-slot="sidebar"]'))) {
          const r = sidebar.getBoundingClientRect();
          if (r.width < 1 || !within(clientX, clientY, r)) continue;
          return {
            type: 'break',
            rect: { left: r.left, top: r.top, width: r.width, height: r.height },
          };
        }
        return null;
      };

      const resolveTarget = (clientX: number, clientY: number): PaneDragTarget | null => {
        const paneHit = hitTestPanes(clientX, clientY);
        if (paneHit) {
          return paneHit.paneId === srcPaneId ? null : { type: 'pane', ...paneHit };
        }
        return hitTestSidebar(clientX, clientY);
      };

      const onMove = (moveEvent: PointerEvent) => {
        const distance = Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY);
        if (!activated && distance < PANE_DRAG_THRESHOLD_PX) return;
        activated = true;
        setPaneDrag({
          srcPaneId,
          active: true,
          pointerX: moveEvent.clientX,
          pointerY: moveEvent.clientY,
          target: resolveTarget(moveEvent.clientX, moveEvent.clientY),
        });
      };

      const finish = (upEvent: PointerEvent, commit: boolean) => {
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        handle.removeEventListener('pointercancel', onCancel);
        setPaneDrag(null);
        if (!commit || !activated) return;
        const target = resolveTarget(upEvent.clientX, upEvent.clientY);
        if (!target) return;
        if (target.type === 'pane') {
          movePane(deviceId, srcPaneId, target.paneId, target.position);
          return;
        }
        if (target.type === 'window') {
          // 移入目标窗口：挂到其 active pane 右侧（tmux move-pane 支持跨窗口目标）
          const windows = useTmuxStore.getState().snapshots[deviceId]?.session?.windows;
          const dstWindow = windows?.find((w) => w.id === target.windowId);
          const dstPane = dstWindow?.panes.find((p) => p.active) ?? dstWindow?.panes[0];
          if (dstPane) {
            movePane(deviceId, srcPaneId, dstPane.id, 'right');
          }
          return;
        }
        breakPane(deviceId, srcPaneId);
      };

      const onUp = (upEvent: PointerEvent) => finish(upEvent, true);
      const onCancel = (cancelEvent: PointerEvent) => finish(cancelEvent, false);

      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
      handle.addEventListener('pointercancel', onCancel);
    },
    [deviceId, geometry, movePane, breakPane, rootCols, rootRows, tmuxWindow.id]
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
        const info = paneInfoById.get(pane.paneId);
        const meta = paneMetaText(info);
        const isDragSource = paneDrag?.active && paneDrag.srcPaneId === pane.paneId;
        const dropPreview =
          paneDrag?.active &&
          paneDrag.target?.type === 'pane' &&
          paneDrag.target.paneId === pane.paneId
            ? paneDrag.target.position
            : null;
        return (
          <div
            key={pane.paneId}
            className={`absolute flex flex-col ${isDragSource ? 'opacity-60' : ''}`}
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
            {/* 浮起式标题栏：四角圆角、无边框无阴影的独立矩形，下方留 8px 视觉空间；
                active 以背景透明度区分 */}
            <div className="shrink-0 px-1.5 pt-1.5 pb-2" style={{ height: PANE_HEADER_PX }}>
              <div
                data-testid="split-pane-titlebar"
                data-active={isFocused || undefined}
                className={`flex h-6 cursor-grab touch-none select-none items-center gap-1.5 rounded-md px-2.5 transition-colors active:cursor-grabbing ${
                  isFocused ? 'bg-foreground/10' : 'bg-foreground/[0.04]'
                }`}
                onPointerDown={(event) => handleTitleBarPointerDown(pane.paneId, event)}
              >
                <span
                  className={`shrink-0 truncate font-mono text-[10.5px] leading-none ${
                    isFocused ? 'text-foreground/90' : 'text-foreground/50'
                  }`}
                >
                  {paneDisplayName(info)}
                </span>
                {meta && (
                  <span
                    className={`min-w-0 flex-1 truncate font-mono text-[10px] leading-none ${
                      isFocused ? 'text-muted-foreground' : 'text-muted-foreground/60'
                    }`}
                  >
                    {meta}
                  </span>
                )}
                <button
                  type="button"
                  data-testid={`split-pane-close-${pane.paneId}`}
                  aria-label={t('window.closePane')}
                  title={t('window.closePane')}
                  className="ml-auto flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-foreground/50 hover:bg-foreground/10 hover:text-foreground"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    closePane(deviceId, pane.paneId);
                  }}
                >
                  <span className="text-xs leading-none">×</span>
                </button>
              </div>
            </div>
            <div className="relative min-h-0 flex-1">
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
            </div>
            {/* 拖拽重排的落点预览：目标 pane 的半区高亮 */}
            {dropPreview && (
              <div
                data-testid="split-pane-drop-preview"
                data-position={dropPreview}
                className={`pointer-events-none absolute z-30 rounded-sm bg-primary/20 ring-1 ring-inset ring-primary/60 ${DROP_PREVIEW_CLASS[dropPreview]}`}
              />
            )}
          </div>
        );
      })}

      {/* 侧栏落点高亮：移入其他窗口 / 拆为独立窗口 */}
      {paneDrag?.active && paneDrag.target && paneDrag.target.type !== 'pane' && (
        <div
          data-testid="split-pane-sidebar-drop"
          data-drop-type={paneDrag.target.type}
          className="pointer-events-none fixed z-40 rounded-lg bg-primary/15 ring-1 ring-inset ring-primary/50"
          style={{
            left: paneDrag.target.rect.left,
            top: paneDrag.target.rect.top,
            width: paneDrag.target.rect.width,
            height: paneDrag.target.rect.height,
          }}
        />
      )}

      {/* 拖拽中的浮动标签：跟随指针提示正在移动的 pane 与动作 */}
      {paneDrag?.active && (
        <div
          className="pointer-events-none fixed z-50 rounded border border-primary/40 bg-popover/95 px-2 py-1 font-mono text-[10.5px] text-popover-foreground shadow-md"
          style={{ left: paneDrag.pointerX + 12, top: paneDrag.pointerY + 12 }}
        >
          <div>{paneDisplayName(paneInfoById.get(paneDrag.srcPaneId))}</div>
          {paneDrag.target?.type === 'window' && (
            <div className="text-[9.5px] text-muted-foreground">{t('window.moveToWindow')}</div>
          )}
          {paneDrag.target?.type === 'break' && (
            <div className="text-[9.5px] text-muted-foreground">{t('window.breakToWindow')}</div>
          )}
        </div>
      )}

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
                className={`absolute bg-foreground/[0.08] transition-colors hover:bg-primary/50 ${
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
