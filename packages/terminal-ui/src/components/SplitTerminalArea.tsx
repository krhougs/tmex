// PC 分屏渲染区域：按 tmux window layout 同屏渲染 window 内全部 pane。
//
// - 布局拓扑真相源是 tmux layout；pane 盒子按恒等像素几何绝对定位
//   （1 cell 恒等于 1 cellPx + 每 pane 固定 chrome，不做比例缩放），
//   每个 pane 挂一个 sizingMode="follow" 的 Terminal 实例并 resize 到精确 cols/rows；
// - 每个 pane 顶部有标题栏（名称 + 进程@路径），拖动标题栏到目标 pane 的
//   上/下/左/右四分区可重排布局（tmux move-pane），拖拽中显示半区预览；
// - 相邻 pane 间的 1 cell 间隙渲染 splitter，拖拽中只画参考线，
//   pointerup 一次性提交 resize-pane 绝对值，等 layout 经快照回流刷新（无回弹）；
// - 整个区域的容器尺寸经防抖上报为 window 尺寸（resize-window 语义），
//   高度按最深垂直堆叠扣除标题栏总高；
// - 焦点 pane 由 URL 决定，点击非焦点 pane 触发 onUserSelectPane（轻量 focus 路径）。

import { useBellStore } from '@tmex/notifications';
import type { TmuxPane, TmuxWindow } from '@tmex/shared';
import { parseWindowLayout } from '@tmex/shared';
import { usePaneAgentState, useRuntime, useTmuxStore } from '@tmex/stores/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Terminal } from './Terminal';
import {
  type DropPosition,
  type SplitGutter,
  computeSplitLayoutGeometry,
  computeSplitLayoutPxGeometry,
  computeSplitWindowGridSize,
  maxHorizontalStackDepth,
  maxVerticalStackDepth,
  paneSizesKey,
  resolveDropPosition,
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
  onWindowResizeSettled?: (cols: number, rows: number) => void;
  prepareResources?: () => Promise<void>;
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

// 跨窗口/重挂缓存最近一次真实 cell 尺寸：再次进入分屏首帧即可用像素几何，
// 避免 cellSize 未就绪的引导帧回落百分比排布（字体变更后由首个真实上报自愈）
let lastKnownCellSize: { width: number; height: number } | null = null;
// 每个 pane 的垂直占位：上留白 6px + 浮起标题栏 24px + 下方视觉空间 8px + 底部留白 8px
const PANE_V_OVERHEAD_PX = 46;
// 标题栏区域高度（垂直占位的上半部分）
const PANE_HEADER_PX = 38;
// 每个 pane 的水平留白：左右各 6px，让内容与 splitter/边缘之间有视觉空白
const PANE_H_OVERHEAD_PX = 12;
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

function PaneBellIcon({ paneId }: { paneId: string }) {
  const ringing = useBellStore((state) => Boolean(state.ringingPanes[paneId]));
  if (!ringing) return null;
  return <span className="bell-blink shrink-0">🔔 </span>;
}

function PaneAgentBadge({ deviceId, paneId }: { deviceId: string; paneId: string }) {
  const { t } = useTranslation();
  const state = usePaneAgentState(deviceId, paneId);
  if (state === 'none') return null;
  if (state === 'generating') {
    return (
      <span
        className="shrink-0 select-none text-xs"
        title={t('agent.paneBadge.generating')}
        aria-label={t('agent.paneBadge.generating')}
      >
        🤖<span className="ml-0.5 text-[10px] animate-pulse">✨</span>
      </span>
    );
  }
  return (
    <span
      className="text-muted-foreground/60 shrink-0 select-none text-xs grayscale"
      title={t('agent.paneBadge.bound')}
      aria-label={t('agent.paneBadge.bound')}
    >
      🤖
    </span>
  );
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
  onWindowResizeSettled,
  prepareResources,
}: SplitTerminalAreaProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRefs = useRef(new Map<string, TerminalRef | null>());
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [paneDrag, setPaneDrag] = useState<PaneDragState | null>(null);
  const [cellSize, setCellSize] = useState<{ width: number; height: number } | null>(
    () => lastKnownCellSize
  );
  const [containerPx, setContainerPx] = useState<{ width: number; height: number } | null>(null);

  const { t } = useTranslation();
  const runtime = useRuntime();
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

  // cells 几何：pane cols/rows 权威值（resize effect / 拖拽基准），
  // 兼作 cellSize 首次就绪前唯一一帧的引导排布（百分比占位，稳态不用）
  const geometry = useMemo(() => {
    if (!layout) return null;
    return computeSplitLayoutGeometry(layout.root, { width: 1, height: 1 });
  }, [layout]);

  const geometryRef = useRef(geometry);
  geometryRef.current = geometry;

  // pane chrome（header + padding 占位）用 DOM 实测：pane 盒子与其内终端
  // 根元素的 rect 差值。常量只作首帧兜底——样式或缩放使真实占位偏离常量时，
  // 整窗上报与像素几何若各信一套会造成 cols/rows 恒溢出/恒不足
  const [measuredChrome, setMeasuredChrome] = useState<{ width: number; height: number } | null>(
    null
  );
  const paneChrome = useMemo(
    () => measuredChrome ?? { width: PANE_H_OVERHEAD_PX, height: PANE_V_OVERHEAD_PX },
    [measuredChrome]
  );
  const paneChromeRef = useRef(paneChrome);
  paneChromeRef.current = paneChrome;

  const measurePaneChrome = useCallback((): { width: number; height: number } | null => {
    const container = containerRef.current;
    if (!container) return null;
    const paneEl = container.querySelector<HTMLElement>('[data-pane-id]');
    const termEl = paneEl?.querySelector<HTMLElement>('[data-pane-content-id]')
      ?.firstElementChild as HTMLElement | null | undefined;
    if (!paneEl || !termEl) return null;
    const paneRect = paneEl.getBoundingClientRect();
    const termRect = termEl.getBoundingClientRect();
    if (paneRect.width < 1 || paneRect.height < 1 || termRect.width < 1 || termRect.height < 1) {
      return null;
    }
    const width = paneRect.width - termRect.width;
    const height = paneRect.height - termRect.height;
    // 挤压极限或过渡帧下差值可能失真，超出合理带宽时弃测保留兜底
    if (width < 0 || height < 0 || width > 100 || height > 150) return null;
    const chrome = { width, height };
    setMeasuredChrome((prev) =>
      prev && prev.width === width && prev.height === height ? prev : chrome
    );
    return chrome;
  }, []);

  // 恒等像素几何（稳态唯一渲染真源）：1 cell 恒等于 1 cellPx + 每 pane
  // 固定 chrome，不缩放不分摊；与 computeSplitWindowGridSize 上报的整窗
  // grid 收敛后恰好铺满，失配时确定性截尾（诚实 clip，收敛即消失）。
  const pxGeometry = useMemo(() => {
    if (!layout || !cellSize || !containerPx) return null;
    return computeSplitLayoutPxGeometry(layout.root, {
      viewport: containerPx,
      cell: cellSize,
      paneChrome,
    });
  }, [layout, cellSize, containerPx, paneChrome]);

  const pxGeometryRef = useRef(pxGeometry);
  pxGeometryRef.current = pxGeometry;

  const rootCols = layout?.root.width ?? 1;
  const rootRows = layout?.root.height ?? 1;

  // 集合语义用逗号串表达，避免快照每次刷新引用变化导致 effect 空转
  const knownPaneIdsKey = tmuxWindow.panes.map((pane) => pane.id).join(',');

  // 非焦点 pane 首屏：fetch history（焦点 pane 的内容来自 select 流程）；
  // 每个 pane 只 fetch 一次，window 切换时重置
  const fetchStateRef = useRef({ key: '', fetched: new Set<string>() });
  useEffect(() => {
    if (runtime.transport.capabilities.atomicScreen) return;
    const windowKey = `${deviceId}:${tmuxWindow.id}`;
    if (fetchStateRef.current.key !== windowKey) {
      fetchStateRef.current = { key: windowKey, fetched: new Set() };
    }
    for (const paneId of knownPaneIdsKey ? knownPaneIdsKey.split(',') : []) {
      if (fetchStateRef.current.fetched.has(paneId)) continue;
      if (paneId === focusedPaneId) continue;
      fetchStateRef.current.fetched.add(paneId);
      fetchPaneHistory(deviceId, paneId);
    }
  }, [deviceId, tmuxWindow.id, knownPaneIdsKey, focusedPaneId, fetchPaneHistory, runtime]);

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
      if (cell) {
        lastKnownCellSize = cell;
        setCellSize((prev) =>
          prev && prev.width === cell.width && prev.height === cell.height ? prev : cell
        );
        return cell;
      }
    }
    return null;
  }, [focusedPaneId]);

  // 各实例 cols/rows 跟随 tmux layout（tmux 是尺寸权威）
  // 依赖 paneSizesKey 而非 geometry 引用：layout 字符串抖动（A pane 输出导致光标移动）
  // 会使 geometry 引用变化但 pane 尺寸不变，此时不应触发 resize（Bug 1）
  const paneSizes = paneSizesKey(geometry);
  // biome-ignore lint/correctness/useExhaustiveDependencies: paneSizes 是触发条件，geometry 通过 ref 访问避免引用抖动
  useEffect(() => {
    const geometry = geometryRef.current;
    if (!geometry) return;
    for (const pane of geometry.panes) {
      terminalRefs.current.get(pane.paneId)?.resize(pane.cols, pane.rows);
    }
  }, [paneSizes]);

  // 每个 pane 的标题栏占据实际空间：整窗 rows 按最深的一列扣除标题栏总高，
  // 保证该列的终端区也能放下 layout 分配的行数（其余列底部允许少量留白）
  const titleBarStackDepth = useMemo(
    () => (layout ? maxVerticalStackDepth(layout.root) : 1),
    [layout]
  );
  const horizontalStackDepth = useMemo(
    () => (layout ? maxHorizontalStackDepth(layout.root) : 1),
    [layout]
  );

  // 容器尺寸 / cell 尺寸 → 本端期望的整窗 cols/rows（未就绪时 null）
  const computeTargetWindowGrid = useCallback((): { cols: number; rows: number } | null => {
    const container = containerRef.current;
    if (!container || !layout) return null;
    const rect = container.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return null;
    const cell = getFocusedCellSize();
    if (!cell) return null;
    return computeSplitWindowGridSize(layout.root, {
      viewport: { width: rect.width, height: rect.height },
      cell,
      paneChrome: measurePaneChrome() ?? paneChromeRef.current,
    });
  }, [getFocusedCellSize, layout, measurePaneChrome]);

  // 上报后自校验：挂载/导航瞬间容器可能在头部/工具栏布局稳定前测得偏大，
  // 按错误值上报后 RO 不再触发就永久错位。每次上报 1.2s 后按当时实测复核，
  // 失配则按新实测重报一次。校验链只走一层（校验触发的重报不再挂校验），
  // 只修正自己最近的写入，不与其他客户端形成周期对抗。
  const REPORT_VERIFY_DELAY_MS = 1200;
  const reportVerifyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inReportVerifyRef = useRef(false);
  useEffect(() => {
    return () => {
      if (reportVerifyTimerRef.current) clearTimeout(reportVerifyTimerRef.current);
    };
  }, []);

  // window 级 resize：整窗 cols/rows 上报（防抖 + cellSize 未就绪重试）
  const reportWindowSize = useCallback(() => {
    const target = computeTargetWindowGrid();
    if (!target) return false;
    onWindowResize(target.cols, target.rows);
    onWindowResizeSettled?.(target.cols, target.rows);
    if (!inReportVerifyRef.current) {
      if (reportVerifyTimerRef.current) clearTimeout(reportVerifyTimerRef.current);
      reportVerifyTimerRef.current = setTimeout(() => {
        reportVerifyTimerRef.current = null;
        inReportVerifyRef.current = true;
        try {
          reclaimWindowSizeRef.current();
        } finally {
          inReportVerifyRef.current = false;
        }
      }, REPORT_VERIFY_DELAY_MS);
    }
    return true;
  }, [computeTargetWindowGrid, onWindowResize, onWindowResizeSettled]);

  const reportWindowSizeRef = useRef(reportWindowSize);
  useEffect(() => {
    reportWindowSizeRef.current = reportWindowSize;
  }, [reportWindowSize]);

  // 多端仲裁夺回：tmux window 被其他客户端（移动 stacked/其他端）改成别的
  // 尺寸时，容器 RO 与堆叠深度均不变，本端会永久静默错位。收敛时零流量。
  const reclaimWindowSize = useCallback(() => {
    if (!layout) return;
    const target = computeTargetWindowGrid();
    if (!target) return;
    if (target.cols === layout.root.width && target.rows === layout.root.height) return;
    reportWindowSize();
  }, [computeTargetWindowGrid, layout, reportWindowSize]);
  const reclaimWindowSizeRef = useRef(reclaimWindowSize);
  useEffect(() => {
    reclaimWindowSizeRef.current = reclaimWindowSize;
  }, [reclaimWindowSize]);

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
      const rect = container.getBoundingClientRect();
      if (rect.width >= 1 && rect.height >= 1) {
        setContainerPx((prev) =>
          prev && prev.width === rect.width && prev.height === rect.height
            ? prev
            : { width: rect.width, height: rect.height }
        );
      }
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: layout depth values intentionally trigger a ref-backed report
  useEffect(() => {
    const timer = setTimeout(() => {
      reportWindowSizeRef.current();
    }, WINDOW_RESIZE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [titleBarStackDepth, horizontalStackDepth]);

  // 夺回只由真实交互瞬间触发（容器内 pointerdown/wheel/keydown，含 native
  // 盖层聚焦时合成回 DOM 的 pointerdown）：谁被触摸谁拥有窗口尺寸，本端
  // 绝不在无人交互时自动反击（时间窗启发式会让刚离手的桌面压制正在手上的
  // 移动端）。已收敛时校验即返回，零流量。
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onInteraction = () => {
      reclaimWindowSizeRef.current();
    };
    container.addEventListener('pointerdown', onInteraction, true);
    container.addEventListener('wheel', onInteraction, { capture: true, passive: true });
    container.addEventListener('keydown', onInteraction, true);
    return () => {
      container.removeEventListener('pointerdown', onInteraction, true);
      container.removeEventListener('wheel', onInteraction, {
        capture: true,
      } as EventListenerOptions);
      container.removeEventListener('keydown', onInteraction, true);
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
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onCancel);
        setDragState(null);
        if (!commit) return;

        const cell = getFocusedCellSize();
        if (!cell) return;
        const deltaPx = gutter.axis === 'x' ? upEvent.clientX - startX : upEvent.clientY - startY;
        const axisCell = gutter.axis === 'x' ? cell.width : cell.height;
        if (axisCell <= 0) return;
        const deltaCells = Math.round(deltaPx / axisCell);
        if (deltaCells === 0) return;

        // 当前尺寸从 layout cells 直取：pane 盒子含标题栏/留白 chrome，
        // 反除 cell 会虚大 2~3 cell，导致每次拖拽单向漂移
        const edgePane = geometryRef.current?.panes.find((p) => p.paneId === gutter.edgeLeafPaneId);
        if (!edgePane) return;
        const currentSize = gutter.axis === 'x' ? edgePane.cols : edgePane.rows;
        const targetSize = currentSize + deltaCells;
        if (targetSize < 2) return;
        reportWindowSizeRef.current();
        resizePaneInWindow(
          deviceId,
          gutter.edgeLeafPaneId,
          gutter.axis === 'x' ? { cols: targetSize } : { rows: targetSize }
        );
      };

      const onUp = (upEvent: PointerEvent) => finish(upEvent, true);
      const onCancel = (cancelEvent: PointerEvent) => finish(cancelEvent, false);

      target.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onCancel);
    },
    [deviceId, getFocusedCellSize, resizePaneInWindow]
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
        // 与渲染同源：像素几何可用时按像素命中，否则按 cell 比例命中
        const px = pxGeometryRef.current;
        const hitGeometry = px ?? currentGeometry;
        const hitX = px
          ? clientX - rect.left
          : ((clientX - rect.left) / rect.width) * Math.max(1, rootCols);
        const hitY = px
          ? clientY - rect.top
          : ((clientY - rect.top) / rect.height) * Math.max(1, rootRows);
        for (const pane of hitGeometry.panes) {
          if (
            hitX >= pane.rect.left &&
            hitX <= pane.rect.left + pane.rect.width &&
            hitY >= pane.rect.top &&
            hitY <= pane.rect.top + pane.rect.height
          ) {
            const relX = (hitX - pane.rect.left) / Math.max(1e-6, pane.rect.width);
            const relY = (hitY - pane.rect.top) / Math.max(1e-6, pane.rect.height);
            return { paneId: pane.paneId, position: resolveDropPosition(relX, relY) };
          }
        }
        return null;
      };

      const within = (clientX: number, clientY: number, r: DOMRect) =>
        clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;

      // 侧栏落点：窗口行 = 移入该窗口；侧栏其余区域 = 拆为独立窗口
      const hitTestSidebar = (clientX: number, clientY: number): PaneDragTarget | null => {
        for (const row of Array.from(document.querySelectorAll('[data-testid^="window-item-"]'))) {
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
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onCancel);
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
          const windows = runtime.stores.tmux.getState().snapshots[deviceId]?.session?.windows;
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
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onCancel);
    },
    [deviceId, geometry, movePane, breakPane, rootCols, rootRows, runtime, tmuxWindow.id]
  );

  const bindTerminalRef = useCallback(
    (paneId: string) => (ref: TerminalRef | null) => {
      if (ref) {
        terminalRefs.current.set(paneId, ref);
        const pane = geometryRef.current?.panes.find((p) => p.paneId === paneId);
        if (pane) {
          ref.resize(pane.cols, pane.rows);
        }
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
  const renderGeometry = pxGeometry ?? geometry;
  const usePx = pxGeometry !== null;

  return (
    <div
      ref={containerRef}
      className="relative h-full w-full min-h-0 min-w-0"
      data-testid="split-terminal-area"
    >
      {renderGeometry.panes.map((pane) => {
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
            className={`absolute flex flex-col overflow-hidden ${isDragSource ? 'opacity-60' : ''}`}
            data-testid="split-pane"
            data-pane-id={pane.paneId}
            data-focused={isFocused || undefined}
            style={
              usePx
                ? {
                    left: pane.rect.left,
                    top: pane.rect.top,
                    width: pane.rect.width,
                    height: pane.rect.height,
                  }
                : {
                    left: pct(pane.rect.left, rootCols),
                    top: pct(pane.rect.top, rootRows),
                    width: pct(pane.rect.width, rootCols),
                    height: pct(pane.rect.height, rootRows),
                  }
            }
            onPointerDownCapture={(event) => {
              // 点关闭按钮不算选择该 pane：否则 URL/焦点先切到即将被杀的
              // pane，关闭后必然踩「目标从快照消失」的回落路径
              if ((event.target as Element).closest?.('[data-pane-close]')) return;
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
                <PaneBellIcon paneId={pane.paneId} />
                <PaneAgentBadge deviceId={deviceId} paneId={pane.paneId} />
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
                  data-pane-close
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
            <div
              className="relative min-h-0 flex-1 overflow-hidden px-1.5 pb-2"
              data-pane-content-id={pane.paneId}
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
                focused={isFocused}
                prepareResources={prepareResources}
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

      {/* 拖拽（splitter / 标题栏）期间的事件隔离层：吞掉滑过终端的鼠标事件，
          避免触发 canvas 的文本选择等另一套事件体系（拖拽本身经 pointer capture 不受遮挡影响） */}
      {(dragState !== null || paneDrag?.active) && (
        <div
          data-testid="split-drag-shield"
          className={`absolute inset-0 z-30 ${
            dragState !== null
              ? geometry.gutters[dragState.gutterIndex]?.axis === 'x'
                ? 'cursor-col-resize'
                : 'cursor-row-resize'
              : 'cursor-grabbing'
          }`}
        />
      )}

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
          data-testid="split-pane-drag-label"
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

      {renderGeometry.gutters.map((gutter, index) => {
        const isVertical = gutter.axis === 'x';
        const isDragging = dragState?.gutterIndex === index;
        return (
          <div
            key={`${tmuxWindow.layout ?? ''}:${index}`}
            className="absolute z-20"
            style={
              usePx
                ? {
                    left: gutter.rect.left,
                    top: gutter.rect.top,
                    width: gutter.rect.width,
                    height: gutter.rect.height,
                  }
                : {
                    left: pct(gutter.rect.left, rootCols),
                    top: pct(gutter.rect.top, rootRows),
                    width: isVertical ? pct(1, rootCols) : pct(gutter.rect.width, rootCols),
                    height: isVertical ? pct(gutter.rect.height, rootRows) : pct(1, rootRows),
                  }
            }
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
                className={`absolute bg-foreground/[0.08] transition-colors ${
                  isVertical
                    ? 'inset-y-0 left-1/2 w-px -translate-x-1/2'
                    : 'inset-x-0 top-1/2 h-px -translate-y-1/2'
                } ${isDragging ? 'bg-primary/60' : 'hover:bg-primary/50'}`}
              />
            </div>
            {/* 拖拽参考线 */}
            {isDragging && dragState && (
              <div
                data-testid="split-gutter-guide"
                className="pointer-events-none absolute bg-primary/45"
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
