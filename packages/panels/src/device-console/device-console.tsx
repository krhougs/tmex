// 设备终端控制台主体：单屏/分屏终端渲染、pane 选择与 URL 同步、快捷键栏、编辑器输入。
// 路由参数由宿主显式传入（paneId 为路由段原值，React Router 已 decode 一次，
// 包内经 decodePaneIdFromUrlParam 归一，宿主不要再 decode）；包内构造的应用内
// 路径一律经 hostAppPath 映射宿主路由形状。

import { useQuery } from '@tanstack/react-query';
import {
  devicesQueryKey as defaultDevicesQueryKey,
  fetchDevices,
  fetchTerminalShortcuts,
  terminalShortcutsQueryKey,
} from '@tmex/api-client';
import { useBellStore } from '@tmex/notifications';
import type { TerminalShortcutItem } from '@tmex/shared';
import {
  buildBrowserTitle,
  buildTerminalLabel,
  decodePaneIdFromUrlParam,
  encodePaneIdForUrl,
  hostAppPath,
} from '@tmex/stores';
import { useRuntime, useSiteStore, useTmuxStore, useUIStore } from '@tmex/stores/react';
import { Terminal as TerminalComponent, type TerminalRef } from '@tmex/terminal-ui';
import { SplitTerminalArea } from '@tmex/terminal-ui';
import { XTERM_THEME_DARK, XTERM_THEME_LIGHT } from '@tmex/terminal-ui';
import { shouldApplyRemotePaneSize } from '@tmex/terminal-ui';
import {
  type TimedPaneSelection,
  resolvePendingUserSelection,
  shouldIgnoreActivePaneEvent,
  shouldSkipSnapshotFollow,
  shouldTrackPendingRouteSelection,
} from '@tmex/terminal-ui';
import { isIOSMobileBrowser } from '@tmex/terminal-ui';
import { Button } from '@tmex/ui/button';
import { Switch } from '@tmex/ui/switch';
import { Loader2, SearchX, Send, Trash2 } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { toast } from '@tmex/ui/toast';
import { DeviceStatusBadge } from '../device-status-badge';
import { ShortcutButtonRow } from '../settings/ShortcutButtonRow';
import {
  resolveDeviceDefaultSelection,
  resolveSettledMissingWindowFallback,
} from './selection-recovery';

// URL 目标未出现在快照时的失效判定/回落宽限：覆盖 select 状态机 ackTimeoutMs(1500ms) + 快照传播。
const SELECT_SETTLE_GRACE_MS = 2500;
const REMOTE_PANE_SIZE_GUARD_TTL_MS = 2000;
const CREATE_WINDOW_FOLLOW_TTL_MS = 15000;

// 终端快捷键栏：从服务器配置渲染（send 类发送控制序列，action 类触发特殊动作）。
const ShortcutsBar = memo(function ShortcutsBar({
  onActivate,
  disabled,
}: {
  onActivate: (item: TerminalShortcutItem) => void;
  disabled: boolean;
}) {
  const runtime = useRuntime();
  const { data } = useQuery({
    queryKey: terminalShortcutsQueryKey,
    queryFn: () => fetchTerminalShortcuts(runtime.apiClient),
    staleTime: 60_000,
  });
  const agentUi = runtime.features.agentUi;
  // agent UI 关闭时在渲染前过滤 newAgentSession：服务端配置仍可能下发该按钮，
  // 渲染出来会成为点了没反应的死按钮
  const items = useMemo(() => {
    const all = data?.items ?? [];
    if (agentUi) {
      return all;
    }
    return all.filter((item) => !(item.type === 'action' && item.action === 'newAgentSession'));
  }, [agentUi, data?.items]);
  if (items.length === 0) {
    return null;
  }
  return (
    <div className="terminal-shortcuts-strip" data-testid="terminal-shortcuts-strip">
      <ShortcutButtonRow
        items={items}
        useIcons={data?.useIcons ?? false}
        onActivate={onActivate}
        disabled={disabled}
        preventFocusSteal
        rowTestId="terminal-shortcuts-row"
        idPrefix="terminal-shortcut"
      />
    </div>
  );
});

export interface DeviceConsoleProps {
  deviceId?: string;
  windowId?: string;
  /** 路由段原值（React Router 已 decode 一次），包内做归一，宿主不要再 decode */
  paneId?: string;
  /** devices 列表查询 key（与其他消费方共享缓存时保持一致），缺省 ['devices'] */
  devicesQueryKey?: readonly unknown[];
  /** 自定义浏览器标签页标题：入参为当前终端标签（未选中窗格时为 null），
   *  返回完整 document.title；卸载时以 formatBrowserTitle(null) 复原。
   *  缺省沿用 buildBrowserTitle（`[siteName]label`）与 siteName 复原。 */
  formatBrowserTitle?: (label: string | null) => string;
  prepareTerminalResources?: (fontId: string, fontSize: number) => Promise<void>;
}

export function DeviceConsole({
  deviceId,
  windowId,
  paneId,
  devicesQueryKey = defaultDevicesQueryKey,
  formatBrowserTitle,
  prepareTerminalResources,
}: DeviceConsoleProps) {
  const { t } = useTranslation();
  const runtime = useRuntime();
  const navigate = useNavigate();
  const terminalContainerRef = useRef<HTMLDivElement>(null);
  const editorContainerRef = useRef<HTMLDivElement | null>(null);
  const editorTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const terminalRef = useRef<TerminalRef>(null);
  const autoSelected = useRef(false);
  const iosAddressBarCollapseTried = useRef(false);
  // Track user-initiated navigation to prevent auto-redirect overwriting it
  const userInitiatedSelectionRef = useRef<TimedPaneSelection | null>(null);

  const selectPane = useTmuxStore((state) => state.selectPane);
  const focusPane = useTmuxStore((state) => state.focusPane);
  const fetchPaneHistory = useTmuxStore((state) => state.fetchPaneHistory);

  const snapshot = useTmuxStore((state) => (deviceId ? state.snapshots[deviceId] : undefined));
  const deviceError = useTmuxStore((state) =>
    deviceId ? state.deviceErrors?.[deviceId] : undefined
  );
  const deviceConnected = useTmuxStore((state) =>
    deviceId ? (state.deviceConnected?.[deviceId] ?? false) : false
  );
  const deviceReconnecting = useTmuxStore((state) =>
    deviceId ? state.deviceReconnecting?.[deviceId] : undefined
  );
  const isReconnecting = Boolean(deviceReconnecting);
  const siteName = useSiteStore((state) => state.settings?.siteName ?? 'tmex');

  const resolvedPaneId = useMemo(() => decodePaneIdFromUrlParam(paneId), [paneId]);
  const draftKey = useMemo(
    () => (deviceId && resolvedPaneId ? `${deviceId}:${resolvedPaneId}` : null),
    [deviceId, resolvedPaneId]
  );

  const [isMobile, setIsMobile] = useState(
    () => typeof window !== 'undefined' && (window.innerWidth < 768 || 'ontouchstart' in window)
  );
  const isMobileRef = useRef(isMobile);
  isMobileRef.current = isMobile;
  const [editorText, setEditorText] = useState('');
  const [remoteSizeRetryRevision, setRemoteSizeRetryRevision] = useState(0);
  const isComposingRef = useRef(false);
  // Loading state - false when connected and has pane
  const isLoading = !deviceConnected || !resolvedPaneId;
  const [isSending, setIsSending] = useState(false);
  const inputMode = useUIStore((state) => state.inputMode);
  const uiTheme = useUIStore((state) => state.theme);
  const terminalFontId = useUIStore((state) => state.terminalFontId);
  const terminalFontSize = useUIStore((state) => state.terminalFontSize);
  const editorSendWithEnter = useUIStore((state) => state.editorSendWithEnter);
  const setEditorSendWithEnter = useUIStore((state) => state.setEditorSendWithEnter);
  const addEditorHistory = useUIStore((state) => state.addEditorHistory);
  const setEditorDraft = useUIStore((state) => state.setEditorDraft);
  const removeEditorDraft = useUIStore((state) => state.removeEditorDraft);
  const paneEditorDraft = useUIStore((state) =>
    draftKey ? (state.editorDrafts[draftKey] ?? '') : ''
  );
  const isIOSBrowser = useMemo(() => isIOSMobileBrowser(), []);

  const windows = snapshot?.session?.windows;
  const terminalTheme = uiTheme === 'light' ? XTERM_THEME_LIGHT : XTERM_THEME_DARK;
  const prepareResources = useCallback(
    () => prepareTerminalResources?.(terminalFontId, terminalFontSize) ?? Promise.resolve(),
    [prepareTerminalResources, terminalFontId, terminalFontSize]
  );

  const { data: devicesData } = useQuery({
    queryKey: devicesQueryKey,
    queryFn: () => fetchDevices(runtime.apiClient),
    throwOnError: false,
  });

  const currentDevice = useMemo(() => {
    if (!deviceId) {
      return undefined;
    }
    return devicesData?.devices.find((device) => device.id === deviceId);
  }, [deviceId, devicesData?.devices]);

  const selectedWindow = useMemo(() => {
    if (!windowId || !windows) return undefined;
    return windows.find((win) => win.id === windowId);
  }, [windowId, windows]);

  const selectedPane = useMemo(() => {
    if (!resolvedPaneId || !selectedWindow) return undefined;
    return selectedWindow.panes.find((pane) => pane.id === resolvedPaneId);
  }, [resolvedPaneId, selectedWindow]);

  const hasWindowSnapshot = Boolean(windows);
  const isWindowMissing = hasWindowSnapshot && Boolean(windowId) && !selectedWindow;
  const isPaneMissing =
    hasWindowSnapshot &&
    Boolean(windowId) &&
    Boolean(resolvedPaneId) &&
    Boolean(selectedWindow) &&
    !selectedPane;

  // 本地发起的关闭是确定事件：目标从快照消失时无需 settle 宽限，立即回落导航，
  // 也不该亮「连接中」遮罩或触发 isSelectionInvalid（后者会翻转 isSplitView，
  // 把存活 pane 整体 remount）
  const recentlyClosedTargets = useTmuxStore((state) => state.recentlyClosedTargets);
  const isKnownClosedPane = Boolean(
    isPaneMissing &&
      resolvedPaneId &&
      recentlyClosedTargets[`pane:${deviceId}:${resolvedPaneId}`] !== undefined
  );
  const isKnownClosedWindow = Boolean(
    isWindowMissing && windowId && recentlyClosedTargets[`window:${deviceId}:${windowId}`] !== undefined
  );

  // URL 点名的 window/pane 不在当前快照 ≠ 目标失效：select 不等快照校验就已下发，
  // 深链目标可能尚未出现在最新快照里（快照传播中、重连中）。若立即按失效处理/回落，
  // 会把刚下发的合法深链 replace 掉。因此给「URL 点名了 window」的场景一个 settle
  // 宽限期（覆盖 select 状态机 ackTimeoutMs=1500ms + 快照传播），宽限内目标仍未出现
  // 才视为失效。宽限值按最佳实践先行。
  const missingSelectionKey =
    isWindowMissing || isPaneMissing ? `${deviceId}:${windowId}:${resolvedPaneId ?? ''}` : null;
  const [settledMissingKey, setSettledMissingKey] = useState<string | null>(null);
  useEffect(() => {
    setSettledMissingKey(null);
    if (!missingSelectionKey) return;
    const timer = window.setTimeout(
      () => setSettledMissingKey(missingSelectionKey),
      SELECT_SETTLE_GRACE_MS
    );
    return () => window.clearTimeout(timer);
  }, [missingSelectionKey]);
  const isSelectionSettledMissing =
    missingSelectionKey !== null && settledMissingKey === missingSelectionKey;

  const invalidSelectionMessage = !isSelectionSettledMissing
    ? null
    : isWindowMissing
      ? t('terminal.windowClosed')
      : isPaneMissing
        ? t('terminal.paneClosed')
        : null;

  const isSelectionInvalid = Boolean(invalidSelectionMessage);
  const canInteractWithPane = Boolean(deviceConnected && resolvedPaneId && !isSelectionInvalid);

  // PC 分屏：≥768px 且当前 window 多 pane 且 layout 可用
  const isSplitView = Boolean(
    !isMobile &&
      selectedWindow &&
      selectedWindow.panes.length > 1 &&
      selectedWindow.layout &&
      !isSelectionInvalid
  );
  const isSplitViewRef = useRef(isSplitView);
  useEffect(() => {
    isSplitViewRef.current = isSplitView;
  }, [isSplitView]);
  const ringingPanes = useBellStore((state) => state.ringingPanes);
  const terminalTopbarLabel = useMemo(() => {
    if (!selectedWindow || !selectedPane) {
      return null;
    }
    const deviceName = currentDevice?.name ?? deviceId;
    const label = buildTerminalLabel({
      paneCustomName: selectedPane.customName,
      paneTitle: selectedPane.title,
      windowName: selectedWindow.name,
      windowCustomName: selectedWindow.customName,
      deviceName,
    });
    return ringingPanes[selectedPane.id] ? `🔔 ${label}` : label;
  }, [currentDevice?.name, deviceId, selectedPane, selectedWindow, ringingPanes]);

  const snapshotActiveSelection = useMemo(() => {
    if (!windows || windows.length === 0) {
      return null;
    }
    const activeWindow = windows.find((win) => win.active);
    const activePane = activeWindow?.panes.find((pane) => pane.active);
    if (!activeWindow || !activePane) {
      return null;
    }
    return { windowId: activeWindow.id, paneId: activePane.id };
  }, [windows]);

  // 移动端多 pane window：终端上报的尺寸即「单屏适配尺寸」，改道拼接布局
  // （window 宽 = N*cols+(N-1)、even-horizontal，每 pane 恰好一屏），
  // 不得发普通 TERM_RESIZE，否则整窗被压成单 pane 尺寸破坏拼接
  const stackedLayoutTarget =
    isMobile && selectedWindow && selectedWindow.panes.length > 1 ? selectedWindow.id : null;
  const stackedLayoutTargetRef = useRef(stackedLayoutTarget);
  stackedLayoutTargetRef.current = stackedLayoutTarget;
  useEffect(() => {
    if (!deviceConnected || !stackedLayoutTarget) return;
    terminalRef.current?.runPostSelectResize();
  }, [deviceConnected, stackedLayoutTarget]);

  const hasWindowSnapshotRef = useRef(false);
  useEffect(() => {
    hasWindowSnapshotRef.current = Boolean(windows) && Boolean(windowId);
  }, [windows, windowId]);

  // Handle resize from terminal - use store directly to avoid unstable callback deps
  const handleResize = useCallback(
    (cols: number, rows: number) => {
      if (!deviceId || !resolvedPaneId) return;
      const stackedWindowId = stackedLayoutTargetRef.current;
      if (stackedWindowId) {
        runtime.stores.tmux.getState().applyStackedLayout(deviceId, stackedWindowId, cols, rows);
        return;
      }
      if (isMobileRef.current && !hasWindowSnapshotRef.current) return;
      runtime.stores.tmux.getState().resizePane(deviceId, resolvedPaneId, cols, rows);
    },
    [deviceId, resolvedPaneId, runtime]
  );

  // Handle sync from terminal
  const handleSync = useCallback(
    (cols: number, rows: number) => {
      if (!deviceId || !resolvedPaneId) return;
      const stackedWindowId = stackedLayoutTargetRef.current;
      if (stackedWindowId) {
        runtime.stores.tmux.getState().applyStackedLayout(deviceId, stackedWindowId, cols, rows);
        return;
      }
      if (isMobileRef.current && !hasWindowSnapshotRef.current) return;
      runtime.stores.tmux.getState().syncPaneSize(deviceId, resolvedPaneId, cols, rows);
    },
    [deviceId, resolvedPaneId, runtime]
  );

  const handleResizeSettled = useCallback(() => {
    if (!deviceId) return;
    runtime.stores.tmux.getState().syncThemeAfterResize(deviceId);
  }, [deviceId, runtime]);

  const getSelectSize = useCallback(
    (targetWindowId?: string, targetPaneId?: string) => {
      const terminal = terminalRef.current;

      // 分屏模式下焦点 Terminal 的容器只是它自己的 pane 区域，
      // select 携带的尺寸应是整个终端区域换算出的 window 尺寸
      if (isSplitViewRef.current) {
        const rect = terminalContainerRef.current?.getBoundingClientRect();
        const cell = terminal?.getCellSize();
        if (rect && cell && rect.width > 0 && rect.height > 0) {
          return {
            cols: Math.max(2, Math.floor(rect.width / cell.width)),
            rows: Math.max(2, Math.floor(rect.height / cell.height)),
          };
        }
        return undefined;
      }

      // 移动端不携带 select 尺寸：整窗尺寸由 stacked layout（多 pane）或
      // Terminal ResizeObserver 的 sync 路径（单 pane）异步驱动，
      // select 只负责切焦点 + 拉 history，不主动 resize
      if (isMobileRef.current) return undefined;

      const terminalSize =
        terminal?.calculateSizeFromContainer() ?? terminal?.getSize() ?? undefined;
      if (terminalSize) {
        return terminalSize;
      }

      if (!targetWindowId || !targetPaneId || !windows) {
        return undefined;
      }

      const targetWindow = windows.find((window) => window.id === targetWindowId);
      const targetPane = targetWindow?.panes.find((pane) => pane.id === targetPaneId);
      if (!targetPane || targetPane.width <= 1 || targetPane.height <= 1) {
        return undefined;
      }

      return {
        cols: targetPane.width,
        rows: targetPane.height,
      };
    },
    [windows]
  );

  // 分屏：点击非焦点 pane 切焦点（URL 为真相源，select effect 走轻量 FOCUS_PANE）
  const handleUserSelectPane = useCallback(
    (targetWindowId: string, targetPaneId: string) => {
      if (!deviceId) return;
      userInitiatedSelectionRef.current = {
        windowId: targetWindowId,
        paneId: targetPaneId,
        at: Date.now(),
      };
      navigate(
        hostAppPath(
          runtime.host,
          `/devices/${deviceId}/windows/${targetWindowId}/panes/${encodePaneIdForUrl(targetPaneId)}`
        ),
        { replace: true }
      );
    },
    [deviceId, navigate, runtime.host]
  );

  // 分屏中把焦点 pane 的 TerminalRef 转接到控制台的 terminalRef（快捷键/editor 等共用）
  const bindFocusedTerminalRef = useCallback((ref: TerminalRef | null) => {
    terminalRef.current = ref;
  }, []);

  // Mobile detection
  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth < 768 || 'ontouchstart' in window);
    };

    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  // iOS address bar collapse
  useEffect(() => {
    if (!isMobile || !isIOSBrowser || iosAddressBarCollapseTried.current) {
      return;
    }

    iosAddressBarCollapseTried.current = true;
    const collapseAddressBar = () => {
      window.scrollTo(0, 1);
    };

    const rafId = window.requestAnimationFrame(collapseAddressBar);
    const timerA = window.setTimeout(collapseAddressBar, 120);
    const timerB = window.setTimeout(collapseAddressBar, 420);

    return () => {
      window.cancelAnimationFrame(rafId);
      window.clearTimeout(timerA);
      window.clearTimeout(timerB);
    };
  }, [isIOSBrowser, isMobile]);

  // Ensure device is connected when viewing (host device provider handles actual connection)
  // This effect resets auto-selection logic and related refs when deviceId changes
  useEffect(() => {
    if (!deviceId) return;
    autoSelected.current = false;
    lastHandledActiveRef.current = null;
    lastSnapshotActiveRef.current = null;
    userInitiatedSelectionRef.current = null;
    recentSelectRequestsRef.current = [];
  }, [deviceId]);

  // Reset autoSelected when device connection changes
  useEffect(() => {
    if (!deviceConnected) {
      autoSelected.current = false;
    }
  }, [deviceConnected]);

  // Handle window/pane changes - both external and from sidebar navigation
  useEffect(() => {
    if (!deviceId) return;
    if (!deviceConnected) return;
    if (!windowId) return;

    // If snapshot not yet arrived, don't navigate (loading state)
    if (!windows) {
      return;
    }

    // If no windows left (all closed), navigate to fallback
    if (windows.length === 0) {
      navigate(hostAppPath(runtime.host, '/devices'), { replace: true });
      return;
    }

    // Find the target window
    const targetWindow = windows.find((w) => w.id === windowId);
    if (!targetWindow) {
      const fallback = resolveSettledMissingWindowFallback({
        windows,
        routeWindowId: windowId,
        settled: isSelectionSettledMissing || isKnownClosedWindow,
      });
      if (fallback) {
        navigate(
          hostAppPath(
            runtime.host,
            `/devices/${deviceId}/windows/${fallback.windowId}/panes/${encodePaneIdForUrl(fallback.paneId)}`
          ),
          { replace: true }
        );
      }
      return;
    }

    // If no paneId in URL, select the active pane in this window
    if (!resolvedPaneId) {
      const targetPane = targetWindow.panes.find((p) => p.active) ?? targetWindow.panes[0];
      if (targetPane) {
        navigate(
          hostAppPath(
            runtime.host,
            `/devices/${deviceId}/windows/${windowId}/panes/${encodePaneIdForUrl(targetPane.id)}`
          ),
          { replace: true }
        );
      }
      return;
    }

    // Check if current pane exists in the window
    const currentPane = targetWindow.panes.find((p) => p.id === resolvedPaneId);
    if (!currentPane) {
      // pane 不在本窗口时先查它是否被 move/break 到了其他窗口——是则跟随过去
      // （否则这里抢先导航回本窗口会与 pane-active 事件竞争，把 tmux 焦点拉回来）
      const relocatedWindow = windows.find((w) => w.panes.some((p) => p.id === resolvedPaneId));
      if (relocatedWindow) {
        navigate(
          hostAppPath(
            runtime.host,
            `/devices/${deviceId}/windows/${relocatedWindow.id}/panes/${encodePaneIdForUrl(resolvedPaneId)}`
          ),
          { replace: true }
        );
        return;
      }
      // 快照里没有 ≠ 已关闭：settle 宽限内等快照追上（见 missingSelectionKey），
      // 宽限后仍未出现才按已关闭回落到本窗口的活动 pane；
      // 本地刚关闭的 pane 是确定事件，跳过宽限立即回落
      if (!isSelectionSettledMissing && !isKnownClosedPane) {
        return;
      }
      const activePane = targetWindow.panes.find((p) => p.active) ?? targetWindow.panes[0];
      if (activePane) {
        navigate(
          hostAppPath(
            runtime.host,
            `/devices/${deviceId}/windows/${windowId}/panes/${encodePaneIdForUrl(activePane.id)}`
          ),
          { replace: true }
        );
      }
      return;
    }
  }, [
    deviceId,
    deviceConnected,
    isSelectionSettledMissing,
    isKnownClosedPane,
    isKnownClosedWindow,
    windows,
    windowId,
    resolvedPaneId,
    navigate,
    runtime.host,
  ]);

  // Auto-select pane on initial load only
  const pendingCreateWindow = useTmuxStore((state) =>
    deviceId ? state.pendingCreateWindow[deviceId] : undefined
  );
  useEffect(() => {
    if (!deviceId) return;
    if (!deviceConnected) return;
    if (!windows || windows.length === 0) return;
    // window-only routes are resolved by the target-window effect above.
    if (windowId) return;
    // If autoSelect already done, skip
    if (autoSelected.current) return;
    // A user-initiated createWindow is in flight: hold off the default
    // selection so the create-follow effect can target the new window first.
    if (pendingCreateWindow && Date.now() - pendingCreateWindow.at <= CREATE_WINDOW_FOLLOW_TTL_MS) {
      return;
    }

    const target = resolveDeviceDefaultSelection({ windows });
    if (!target) return;

    autoSelected.current = true;
    navigate(
      hostAppPath(
        runtime.host,
        `/devices/${deviceId}/windows/${target.windowId}/panes/${encodePaneIdForUrl(target.paneId)}`
      ),
      { replace: true }
    );
  }, [
    deviceConnected,
    deviceId,
    navigate,
    pendingCreateWindow,
    resolvedPaneId,
    runtime.host,
    windowId,
    windows,
  ]);

  const recentSelectRequestsRef = useRef<Array<{ windowId: string; paneId: string; at: number }>>(
    []
  );
  const recordSelectRequest = useCallback((windowId: string, paneId: string) => {
    const now = Date.now();
    const next = [
      ...recentSelectRequestsRef.current.filter((r) => now - r.at < 2000),
      { windowId, paneId, at: now },
    ];
    recentSelectRequestsRef.current = next.slice(-8);
  }, []);

  // 跟踪当前 Terminal 实例已下发过的 SELECT_START：device/pane 变化时 Terminal 重挂载，
  // 需要让下面的 select 效果重新派发（否则切到其他 device 再切回会命中短路、终端空白）
  const lastDispatchedSelectRef = useRef<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 路由身份变化必须重置仅由 ref 持有的派发守卫
  useEffect(() => {
    lastDispatchedSelectRef.current = null;
  }, [deviceId, resolvedPaneId]);

  // 最近一次完整 select（走 barrier/history）落在哪个 window：
  // 分屏内同 window 切焦点时改走轻量 FOCUS_PANE，避免已渲染 pane 被 reset 重放
  const lastFullSelectWindowRef = useRef<string | null>(null);

  // isSplitView 翻转会重建 Terminal 实例（单 Terminal ↔ SplitTerminalArea），
  // 焦点 pane 的新实例需要完整 select 重新拉 history，否则空白
  const prevSplitViewRef = useRef(isSplitView);
  useEffect(() => {
    if (prevSplitViewRef.current === isSplitView) return;
    prevSplitViewRef.current = isSplitView;
    lastDispatchedSelectRef.current = null;
    lastFullSelectWindowRef.current = null;
  }, [isSplitView]);

  // Select pane when ready
  useEffect(() => {
    if (!deviceId || !windowId || !resolvedPaneId) return;
    // Allow sending TMUX_SELECT before WS is READY: borsh client will queue messages and flush on READY.
    // Note: We don't check isSelectionInvalid here because when user navigates via URL,
    // the snapshot may not yet reflect the new window, but we should still send the select command.
    if (isLoading || !deviceConnected) return;

    const dispatchKey = `${deviceId}:${windowId}:${resolvedPaneId}`;
    if (lastDispatchedSelectRef.current === dispatchKey) {
      return;
    }
    lastDispatchedSelectRef.current = dispatchKey;

    const canUseLightFocus =
      isSplitView &&
      lastFullSelectWindowRef.current === `${deviceId}:${windowId}` &&
      Boolean(selectedWindow?.panes.some((pane) => pane.id === resolvedPaneId));

    recordSelectRequest(windowId, resolvedPaneId);
    if (canUseLightFocus) {
      focusPane(deviceId, windowId, resolvedPaneId);
      return;
    }

    const size = getSelectSize(windowId, resolvedPaneId);
    selectPane(deviceId, windowId, resolvedPaneId, size);
    lastFullSelectWindowRef.current = `${deviceId}:${windowId}`;
  }, [
    deviceConnected,
    deviceId,
    focusPane,
    getSelectSize,
    isLoading,
    isSplitView,
    recordSelectRequest,
    resolvedPaneId,
    selectPane,
    selectedWindow,
    windowId,
  ]);

  // Treat explicit route selection as authoritative until snapshot/runtime catches up.
  useEffect(() => {
    if (!deviceId || !deviceConnected || !windowId || !resolvedPaneId) {
      return;
    }

    const routeTarget = { windowId, paneId: resolvedPaneId };
    if (
      !shouldTrackPendingRouteSelection({
        routeTarget,
        snapshotActive: snapshotActiveSelection,
        pendingUserSelection: userInitiatedSelectionRef.current,
      })
    ) {
      return;
    }

    userInitiatedSelectionRef.current = {
      windowId: routeTarget.windowId,
      paneId: routeTarget.paneId,
      at: Date.now(),
    };
  }, [deviceConnected, deviceId, resolvedPaneId, snapshotActiveSelection, windowId]);

  // Subscribe to activePaneFromEvent for this device
  const activePaneFromEvent = useTmuxStore((state) =>
    deviceId ? state.activePaneFromEvent[deviceId] : undefined
  );

  // Follow active pane from event/tmux pane-active
  // selection 为纯本地语义的 transport（serverSelection=false）下，select 命令不会真正
  // 驱动 tmux active，跟随 tmux active 改写路由只会把用户刚选中的终端弹回去，必须禁用。
  const serverSelection = runtime.transport.capabilities.serverSelection;
  const lastHandledActiveRef = useRef<{ windowId: string; paneId: string } | null>(null);
  useEffect(() => {
    if (!serverSelection) return;
    if (!deviceId) return;
    if (!deviceConnected) return;
    if (!windowId || !resolvedPaneId) return;
    if (!activePaneFromEvent) return;

    const now = Date.now();
    const pendingUserSelection = resolvePendingUserSelection(
      userInitiatedSelectionRef.current,
      now
    );
    userInitiatedSelectionRef.current = pendingUserSelection;

    if (
      shouldIgnoreActivePaneEvent({
        now,
        pendingUserSelection,
        activePaneFromEvent,
        currentRoute: { windowId, paneId: resolvedPaneId },
        recentSelectRequests: recentSelectRequestsRef.current,
        lastHandledActive: lastHandledActiveRef.current,
      })
    ) {
      return;
    }

    lastHandledActiveRef.current = { ...activePaneFromEvent };
    if (
      pendingUserSelection &&
      pendingUserSelection.windowId === activePaneFromEvent.windowId &&
      pendingUserSelection.paneId === activePaneFromEvent.paneId
    ) {
      userInitiatedSelectionRef.current = null;
    }

    // 分屏内同 window 的焦点变化：只更新 URL，select effect 会走轻量 FOCUS_PANE
    const splitSameWindow = isSplitViewRef.current && activePaneFromEvent.windowId === windowId;
    if (!splitSameWindow) {
      // Send selectPane to gateway first
      const size = getSelectSize(activePaneFromEvent.windowId, activePaneFromEvent.paneId);
      recordSelectRequest(activePaneFromEvent.windowId, activePaneFromEvent.paneId);
      selectPane(deviceId, activePaneFromEvent.windowId, activePaneFromEvent.paneId, size);
    }

    // Navigate to new URL
    navigate(
      hostAppPath(
        runtime.host,
        `/devices/${deviceId}/windows/${activePaneFromEvent.windowId}/panes/${encodePaneIdForUrl(activePaneFromEvent.paneId)}`
      ),
      { replace: true }
    );
  }, [
    deviceId,
    deviceConnected,
    windowId,
    resolvedPaneId,
    activePaneFromEvent,
    recordSelectRequest,
    getSelectSize,
    selectPane,
    navigate,
    runtime.host,
    serverSelection,
  ]);

  // Fallback: follow active from snapshot (for environments without pane-active event)
  const lastSnapshotActiveRef = useRef<{ windowId: string; paneId: string } | null>(null);
  useEffect(() => {
    if (!serverSelection) return;
    if (!deviceId) return;
    if (!deviceConnected) return;
    if (!windows || windows.length === 0) return;

    // Avoid snapshot-driven "bounce back" shortly after we send TMUX_SELECT.
    const recentRequests = recentSelectRequestsRef.current;
    const activeWindow = windows.find((w) => w.active);
    if (!activeWindow) return;

    const activePane = activeWindow.panes.find((p) => p.active);
    if (!activePane) return;

    const currentActive = { windowId: activeWindow.id, paneId: activePane.id };
    const now = Date.now();
    const pendingUserSelection = resolvePendingUserSelection(
      userInitiatedSelectionRef.current,
      now
    );
    userInitiatedSelectionRef.current = pendingUserSelection;

    if (
      shouldSkipSnapshotFollow({
        now,
        pendingUserSelection,
        snapshotActive: currentActive,
        recentSelectRequests: recentRequests,
      })
    ) {
      return;
    }

    // Only follow when active actually changes
    if (
      lastSnapshotActiveRef.current &&
      lastSnapshotActiveRef.current.windowId === currentActive.windowId &&
      lastSnapshotActiveRef.current.paneId === currentActive.paneId
    ) {
      return;
    }

    // Update ref
    lastSnapshotActiveRef.current = { ...currentActive };
    if (
      pendingUserSelection &&
      pendingUserSelection.windowId === currentActive.windowId &&
      pendingUserSelection.paneId === currentActive.paneId
    ) {
      userInitiatedSelectionRef.current = null;
    }

    // If current URL matches, no need to navigate
    if (windowId === currentActive.windowId && resolvedPaneId === currentActive.paneId) {
      return;
    }

    // 分屏内同 window 的焦点变化：只更新 URL，select effect 会走轻量 FOCUS_PANE
    const splitSameWindow = isSplitViewRef.current && currentActive.windowId === windowId;
    if (!splitSameWindow) {
      // Send selectPane and navigate
      const size = getSelectSize(currentActive.windowId, currentActive.paneId);
      recordSelectRequest(currentActive.windowId, currentActive.paneId);
      selectPane(deviceId, currentActive.windowId, currentActive.paneId, size);
    }
    navigate(
      hostAppPath(
        runtime.host,
        `/devices/${deviceId}/windows/${currentActive.windowId}/panes/${encodePaneIdForUrl(currentActive.paneId)}`
      ),
      { replace: true }
    );
  }, [
    deviceId,
    deviceConnected,
    windows,
    windowId,
    resolvedPaneId,
    recordSelectRequest,
    getSelectSize,
    selectPane,
    navigate,
    runtime.host,
    serverSelection,
  ]);

  // Follow the newly created window after a user-initiated createWindow.
  // Only a window that was NOT present when createWindow was issued counts —
  // a stale snapshot's active window must never consume the pending marker.
  useEffect(() => {
    if (!deviceId) return;
    if (!deviceConnected) return;
    if (!pendingCreateWindow) return;

    const elapsed = Date.now() - pendingCreateWindow.at;
    if (elapsed > CREATE_WINDOW_FOLLOW_TTL_MS) {
      runtime.stores.tmux.getState().clearPendingCreateWindow(deviceId);
      return;
    }

    // Preferred: the gateway acked the exact created window id — follow it as
    // soon as it shows up in the snapshot. Fallback (older gateways without the
    // ack frame): diff against the known-window baseline; with no baseline,
    // follow the snapshot's active window.
    const knownIds =
      pendingCreateWindow.knownWindowIds === null
        ? null
        : new Set(pendingCreateWindow.knownWindowIds);
    const ackedWindowId = pendingCreateWindow.createdWindowId;
    const createdWindow = ackedWindowId
      ? windows?.find((win) => win.id === ackedWindowId && win.panes.length > 0)
      : knownIds
        ? windows?.find((win) => !knownIds.has(win.id) && win.panes.length > 0)
        : windows?.find((win) => win.active && win.panes.length > 0);
    if (!createdWindow) {
      // New window not reflected in the snapshot yet; keep waiting until TTL.
      const timer = window.setTimeout(() => {
        runtime.stores.tmux.getState().clearPendingCreateWindow(deviceId);
      }, CREATE_WINDOW_FOLLOW_TTL_MS - elapsed);
      return () => window.clearTimeout(timer);
    }

    const targetPane =
      createdWindow.panes.find((pane) => pane.active) ?? createdWindow.panes[0];
    const target = { windowId: createdWindow.id, paneId: targetPane.id };
    runtime.stores.tmux.getState().clearPendingCreateWindow(deviceId);
    if (windowId === target.windowId && resolvedPaneId === target.paneId) {
      return;
    }

    userInitiatedSelectionRef.current = {
      windowId: target.windowId,
      paneId: target.paneId,
      at: Date.now(),
    };
    const size = getSelectSize(target.windowId, target.paneId);
    recordSelectRequest(target.windowId, target.paneId);
    selectPane(deviceId, target.windowId, target.paneId, size);
    navigate(
      hostAppPath(
        runtime.host,
        `/devices/${deviceId}/windows/${target.windowId}/panes/${encodePaneIdForUrl(target.paneId)}`
      ),
      { replace: true }
    );
  }, [
    deviceId,
    deviceConnected,
    pendingCreateWindow,
    windows,
    windowId,
    resolvedPaneId,
    recordSelectRequest,
    getSelectSize,
    selectPane,
    navigate,
    runtime,
  ]);

  // Sync pane size from remote
  useEffect(() => {
    void remoteSizeRetryRevision;
    // 分屏模式：pane 尺寸完全由 layout 驱动（SplitTerminalArea 内部 resize），不走回灌
    if (isSplitView) return;
    if (!canInteractWithPane || !selectedPane || isLoading) return;

    const terminal = terminalRef.current;
    const term = terminal?.getTerminal();
    if (!term) return;

    const remoteCols = Math.max(2, Math.floor(selectedPane.width || 0));
    const remoteRows = Math.max(2, Math.floor(selectedPane.height || 0));
    if (!remoteCols || !remoteRows) return;

    const now = Date.now();
    const remoteSize = { cols: remoteCols, rows: remoteRows };
    const pendingLocalSize = terminal?.getPendingLocalSize() ?? null;
    if (
      !shouldApplyRemotePaneSize({
        now,
        remoteSize,
        pendingLocalSize,
        ttlMs: REMOTE_PANE_SIZE_GUARD_TTL_MS,
      })
    ) {
      const elapsed = Math.max(0, now - (pendingLocalSize?.at ?? now));
      const retryAfterMs = Math.max(1, REMOTE_PANE_SIZE_GUARD_TTL_MS - elapsed + 1);
      const timer = window.setTimeout(() => {
        setRemoteSizeRetryRevision((revision) => revision + 1);
      }, retryAfterMs);
      return () => window.clearTimeout(timer);
    }

    if (pendingLocalSize) terminal?.clearPendingLocalSize();

    if (term.cols === remoteCols && term.rows === remoteRows) {
      return;
    }

    term.resize(remoteCols, remoteRows);
    // 远端 resize 后本地 reflow 与 tmux reflow 不保证一致（差一行即让 TUI 的
    // 相对移动重绘永久错位），重拉 history 以 tmux 权威状态重建本地屏幕；
    // fetch gate 会缓冲期间的 live 输出保序
    if (deviceId && resolvedPaneId) {
      fetchPaneHistory(deviceId, resolvedPaneId);
    }
  }, [
    canInteractWithPane,
    deviceId,
    fetchPaneHistory,
    isLoading,
    isSplitView,
    resolvedPaneId,
    remoteSizeRetryRevision,
    selectedPane,
  ]);

  // Scroll to bottom on input mode change
  useEffect(() => {
    void inputMode;
    const rafId = window.requestAnimationFrame(() => {
      terminalRef.current?.scrollToBottom();
    });
    const timerId = window.setTimeout(() => {
      terminalRef.current?.scrollToBottom();
    }, 120);

    return () => {
      window.cancelAnimationFrame(rafId);
      window.clearTimeout(timerId);
    };
  }, [inputMode]);

  // Device error toast
  useEffect(() => {
    if (!deviceError?.message) {
      return;
    }

    toast.error(deviceError.message);
  }, [deviceError?.message]);

  // Page title
  useEffect(() => {
    document.title = formatBrowserTitle
      ? formatBrowserTitle(terminalTopbarLabel ?? null)
      : buildBrowserTitle(terminalTopbarLabel);
    return () => {
      document.title = formatBrowserTitle ? formatBrowserTitle(null) : siteName;
    };
  }, [siteName, terminalTopbarLabel, formatBrowserTitle]);

  // Jump to latest event
  useEffect(() => {
    const handler = () => {
      terminalRef.current?.scrollToBottom();
    };

    window.addEventListener('tmex:jump-to-latest', handler as EventListener);
    return () => {
      window.removeEventListener('tmex:jump-to-latest', handler as EventListener);
    };
  }, []);

  // Listen for user-initiated selection from sidebar
  useEffect(() => {
    const handler = (
      event: CustomEvent<{ deviceId: string; windowId: string; paneId: string }>
    ) => {
      const { deviceId: eventDeviceId, windowId, paneId } = event.detail;
      // Only track if it's for the current device
      // Note: when switching devices, refs are reset in the deviceId effect above
      if (eventDeviceId === deviceId) {
        userInitiatedSelectionRef.current = { windowId, paneId, at: Date.now() };
      }
    };

    window.addEventListener('tmex:user-initiated-selection', handler as EventListener);
    return () => {
      window.removeEventListener('tmex:user-initiated-selection', handler as EventListener);
    };
  }, [deviceId]);

  // Sync editor draft
  useEffect(() => {
    setEditorText(paneEditorDraft);
  }, [paneEditorDraft]);

  const handleSendShortcut = useCallback(
    (payload: string) => {
      if (!deviceId || !resolvedPaneId || !canInteractWithPane) {
        return;
      }

      // Send directly to the terminal's input handler
      const store = runtime.stores.tmux.getState();
      store.sendInput(deviceId, resolvedPaneId, payload, false);
    },
    [canInteractWithPane, deviceId, resolvedPaneId, runtime]
  );

  const handleActivateShortcut = useCallback(
    (item: TerminalShortcutItem) => {
      // 纯前端 UI 动作：不依赖后端连接 / 有效 pane，先于 canInteractWithPane 守卫处理
      if (item.type === 'action') {
        if (item.action === 'toggleKeyboard') {
          runtime.stores.ui.getState().setInputMode(inputMode === 'direct' ? 'editor' : 'direct');
          return;
        }
        if (item.action === 'scrollToBottom') {
          terminalRef.current?.scrollToBottom();
          return;
        }
      }
      if (item.type === 'send') {
        if (item.payload) {
          handleSendShortcut(item.payload);
        }
        return;
      }
      // 需要有效设备 / pane 的动作（paste / newAgentSession）
      if (!deviceId || !resolvedPaneId || !canInteractWithPane) {
        return;
      }
      switch (item.action) {
        case 'paste': {
          // 非安全上下文 / 宿主 clipboard 不可用时给出明确错误而非静默
          void runtime.host
            .readClipboardText()
            .then((text) => {
              if (text) {
                runtime.stores.tmux.getState().paste(deviceId, resolvedPaneId, text);
              }
            })
            .catch(() => toast.error(t('terminal.pasteFailed')));
          break;
        }
        case 'newAgentSession':
          // agent UI 关闭时按钮已在渲染前过滤，这里再兜底一次
          if (!runtime.features.agentUi) {
            break;
          }
          runtime.stores.agent.getState().startDraft(deviceId, resolvedPaneId, null);
          runtime.stores.ui.getState().setSidebarCollapsed(false);
          runtime.stores.ui.getState().expandSidebarSection('agent');
          break;
        default:
          break;
      }
    },
    [canInteractWithPane, deviceId, handleSendShortcut, inputMode, resolvedPaneId, runtime, t]
  );

  const handleEditorSend = useCallback(() => {
    if (!canInteractWithPane) {
      toast.error(t('wsError.checkGateway'));
      return;
    }
    if (!deviceId || !resolvedPaneId) return;
    if (!editorText.trim()) return;

    setIsSending(true);
    window.setTimeout(() => setIsSending(false), 150);

    const payload = editorSendWithEnter ? `${editorText}\r` : editorText;
    const store = runtime.stores.tmux.getState();
    store.sendInput(deviceId, resolvedPaneId, payload, false);
    addEditorHistory(editorText);
    if (draftKey) {
      removeEditorDraft(draftKey);
    }
    setEditorText('');
  }, [
    addEditorHistory,
    canInteractWithPane,
    deviceId,
    draftKey,
    editorSendWithEnter,
    editorText,
    removeEditorDraft,
    resolvedPaneId,
    runtime,
    t,
  ]);

  const handleEditorSendLineByLine = useCallback(() => {
    if (!canInteractWithPane) {
      toast.error(t('wsError.checkGateway'));
      return;
    }
    if (!deviceId || !resolvedPaneId) return;
    if (!editorText.trim()) return;

    setIsSending(true);
    window.setTimeout(() => setIsSending(false), 150);

    const lines = editorText.split(/\r?\n/);
    const store = runtime.stores.tmux.getState();
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      store.sendInput(deviceId, resolvedPaneId, `${line}\r`, false);
    }

    addEditorHistory(editorText);
    if (draftKey) {
      removeEditorDraft(draftKey);
    }
    setEditorText('');
  }, [
    addEditorHistory,
    canInteractWithPane,
    deviceId,
    draftKey,
    editorText,
    removeEditorDraft,
    resolvedPaneId,
    runtime,
    t,
  ]);

  // 聚焦编辑器回调 - 必须在所有早期 return 之前定义
  const handleFocusEditor = useCallback(() => {
    editorTextareaRef.current?.focus({ preventScroll: true });
  }, []);

  if (!deviceId) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <div className="rounded-lg border border-dashed border-border px-4 py-3 text-sm text-muted-foreground">
          {t('device.noDevices')}
        </div>
      </div>
    );
  }

  // 重连期间保持 Terminal 挂载，避免 xterm 卸载导致已有内容消失（issue: 重连要看得清已有内容）。
  const showTerminal =
    Boolean(resolvedPaneId) && !isSelectionInvalid && (deviceConnected || isReconnecting);
  // 已连接、URL 指定了 pane，但 snapshot 尚未解析出它（且不是 not-found）→ 仍在加载，内容本就空白。
  // 本地刚关闭的目标除外：导航 effect 马上回落，不亮遮罩
  const isResolvingSnapshot =
    deviceConnected &&
    Boolean(resolvedPaneId) &&
    !isSelectionInvalid &&
    !selectedPane &&
    !isKnownClosedPane &&
    !isKnownClosedWindow;

  const loadingPlaceholder = (
    <>
      <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center mx-auto">
        <Loader2 className="h-6 w-6 text-muted-foreground animate-spin" />
      </div>
      <h3 className="text-lg font-medium">{t('common.loading')}</h3>
    </>
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-background" data-testid="device-page">
      <div
        className={`flex-1 relative overflow-hidden min-h-0 min-w-0 ${
          isMobile && inputMode === 'editor' ? 'pb-1' : ''
        }`}
      >
        <div
          className="h-full px-3 py-1 min-h-0 min-w-0 w-full relative flex rounded-xl"
          style={{ backgroundColor: terminalTheme.background }}
        >
          {isSelectionInvalid ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center p-8 text-center">
              <div className="max-w-sm space-y-4">
                <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center mx-auto">
                  <SearchX className="h-6 w-6 text-muted-foreground" />
                </div>
                <p
                  className="text-sm text-muted-foreground"
                  data-testid="terminal-selection-invalid"
                >
                  {invalidSelectionMessage}
                </p>
              </div>
            </div>
          ) : showTerminal && resolvedPaneId ? (
            isSplitView && selectedWindow ? (
              <div
                className="flex h-full min-h-0 w-full flex-1 flex-col"
                data-virtual-keyboard-avoid
              >
                <div ref={terminalContainerRef} className="relative min-h-0 flex-1">
                  <SplitTerminalArea
                    key={`${deviceId}:${selectedWindow.id}`}
                    deviceId={deviceId}
                    window={selectedWindow}
                    focusedPaneId={resolvedPaneId}
                    theme={uiTheme}
                    inputMode={inputMode}
                    deviceConnected={deviceConnected}
                    focusedTerminalRef={bindFocusedTerminalRef}
                    onUserSelectPane={handleUserSelectPane}
                    onWindowResize={handleResize}
                    onWindowResizeSettled={handleResizeSettled}
                    prepareResources={prepareResources}
                  />
                </div>
                {inputMode === 'direct' && (
                  <div
                    className="kb-floating-shortcuts"
                    style={{ backgroundColor: terminalTheme.background }}
                  >
                    <ShortcutsBar
                      onActivate={handleActivateShortcut}
                      disabled={!canInteractWithPane}
                    />
                  </div>
                )}
              </div>
            ) : (
              <div
                ref={terminalContainerRef}
                className="flex-1 h-full min-h-0 w-full"
                data-virtual-keyboard-avoid
              >
                <TerminalComponent
                  key={`${deviceId}:${resolvedPaneId}`}
                  ref={terminalRef}
                  deviceId={deviceId}
                  paneId={resolvedPaneId}
                  theme={uiTheme}
                  inputMode={inputMode}
                  deviceConnected={deviceConnected}
                  isSelectionInvalid={isSelectionInvalid}
                  prepareResources={prepareResources}
                  onResize={handleResize}
                  onSync={handleSync}
                  onResizeSettled={handleResizeSettled}
                >
                  {/* direct 模式：快捷键栏拼在终端可视区域下方，与终端共用 seoul256 配色。
                      follow 键盘模式弹起时，外层 .kb-floating-shortcuts 按 --tmex-kb-shortcut-lift
                      把这排快捷键 translateY 浮到键盘正上方（不脱流，故不触发终端 resize）。 */}
                  {inputMode === 'direct' && (
                    <div
                      className="kb-floating-shortcuts"
                      style={{ backgroundColor: terminalTheme.background }}
                    >
                      <ShortcutsBar
                        onActivate={handleActivateShortcut}
                        disabled={!canInteractWithPane}
                      />
                    </div>
                  )}
                </TerminalComponent>
              </div>
            )
          ) : (
            <div className="absolute inset-0 flex flex-col items-center justify-center p-8 text-center">
              <div className="max-w-sm space-y-4">
                {!deviceConnected || isReconnecting ? (
                  loadingPlaceholder
                ) : !windowId ? (
                  <>
                    <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center mx-auto">
                      <span className="text-2xl text-muted-foreground">📋</span>
                    </div>
                    <h3 className="text-lg font-medium">{t('window.noWindowSelected')}</h3>
                    <p className="text-sm text-muted-foreground">
                      {t('window.selectWindowToStart')}
                    </p>
                  </>
                ) : (
                  loadingPlaceholder
                )}
              </div>
            </div>
          )}
          {/* 重连指示：非遮挡、置顶居中，保持已有终端内容可见 */}
          {isReconnecting && (
            <div
              className="pointer-events-none absolute inset-x-0 top-2 z-10 flex justify-center"
              data-testid="terminal-reconnecting-indicator"
            >
              <DeviceStatusBadge deviceId={deviceId} className="shadow-sm" />
            </div>
          )}

          {/* loading：已连接但 snapshot 尚未解析出该 pane（内容本就空白，用遮罩 spinner） */}
          {isResolvingSnapshot && (
            <div
              className="absolute inset-0 flex items-center justify-center bg-background/85 backdrop-blur-sm"
              data-testid="terminal-status-overlay"
            >
              <div className="flex flex-col items-center gap-2 rounded-lg border border-border bg-card/90 px-4 py-3 shadow-sm">
                <div className="h-7 w-7 rounded-full border-2 border-primary border-t-transparent animate-spin" />
                <span className="text-xs text-muted-foreground" data-testid="terminal-status-text">
                  {t('terminal.connecting')}
                </span>
              </div>
            </div>
          )}
        </div>
      </div>

      {inputMode === 'editor' && (
        <div
          ref={editorContainerRef}
          data-virtual-keyboard-avoid
          className="editor-mode-input bg-card/85 backdrop-blur-sm"
        >
          {/* 移动端 editor 模式：快捷键栏在编辑器上方 */}
          {isMobile && (
            <ShortcutsBar
              onActivate={(item) => {
                handleActivateShortcut(item);
                if (item.type === 'send') {
                  handleFocusEditor();
                }
              }}
              disabled={!canInteractWithPane}
            />
          )}
          <textarea
            ref={editorTextareaRef}
            data-testid="editor-input"
            className="min-h-[88px] max-h-[28vh] w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground shadow-xs outline-none transition-colors focus:border-ring"
            value={editorText}
            onChange={(e) => {
              const nextText = e.target.value;
              setEditorText(nextText);
              if (!draftKey) {
                return;
              }
              if (nextText) {
                setEditorDraft(draftKey, nextText);
                return;
              }
              removeEditorDraft(draftKey);
            }}
            placeholder={t('terminal.inputPlaceholder')}
            onCompositionStart={() => {
              isComposingRef.current = true;
            }}
            onCompositionEnd={() => {
              isComposingRef.current = false;
            }}
          />
          <div className="actions mt-2">
            <div
              className="send-row flex flex-wrap items-center justify-end gap-2"
              data-testid="editor-send-row"
            >
              <div
                className="send-with-enter-toggle mr-auto flex items-center gap-2 text-xs text-muted-foreground"
                data-testid="editor-send-with-enter-toggle"
              >
                <Switch
                  size="sm"
                  checked={editorSendWithEnter}
                  onCheckedChange={(checked) => setEditorSendWithEnter(Boolean(checked))}
                />
                <span>{t('terminal.editorSendWithEnter')}</span>
              </div>
              <Button
                variant="outline"
                size="sm"
                data-testid="editor-clear"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  setEditorText('');
                  if (draftKey) {
                    removeEditorDraft(draftKey);
                  }
                  if (isMobile && inputMode === 'editor') {
                    editorTextareaRef.current?.focus({ preventScroll: true });
                  }
                }}
                title={t('terminal.clear')}
              >
                <Trash2 className="h-4 w-4" />
                {t('terminal.clear')}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                data-testid="editor-send-line-by-line"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  handleEditorSendLineByLine();
                  if (isMobile && inputMode === 'editor') {
                    editorTextareaRef.current?.focus({ preventScroll: true });
                  }
                }}
                disabled={!canInteractWithPane || isSending}
              >
                {isSending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
                {t('terminal.editorSendLineByLine')}
              </Button>
              <Button
                variant="default"
                size="sm"
                data-testid="editor-send"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  handleEditorSend();
                  if (isMobile && inputMode === 'editor') {
                    editorTextareaRef.current?.focus({ preventScroll: true });
                  }
                }}
                disabled={!canInteractWithPane || isSending}
              >
                {isSending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
                {t('common.send')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
