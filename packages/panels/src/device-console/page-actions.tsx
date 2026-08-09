// 控制台操作区：输入模式切换、分屏、跳到最新、watch、终端设置、刷新页面。
// 路由参数由宿主显式传入；paneId 为路由段原值（React Router 已 decode 一次），包内做归一；
// 包内构造的应用内路径经 hostAppPath 映射宿主路由形状。

import { useQuery } from '@tanstack/react-query';
import { fetchWatchRules, watchRulesQueryKey } from '@tmex/api-client';
import { decodePaneIdFromUrlParam, encodePaneIdForUrl, hostAppPath } from '@tmex/stores';
import { useRuntime, useTmuxStore, useUIStore } from '@tmex/stores/react';
import { PaneSwitcherMenu } from '@tmex/terminal-ui';
import { useIsMobile } from '@tmex/ui';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@tmex/ui/alert-dialog';
import { Button } from '@tmex/ui/button';
import {
  ArrowDownToLine,
  Keyboard,
  Radar,
  RefreshCw,
  Settings2,
  Smartphone,
  SquareSplitHorizontal,
  SquareSplitVertical,
} from 'lucide-react';
import { type ComponentType, useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { WatchDialog } from '../watch/watch-dialog';

export interface DeviceConsoleActionsProps {
  deviceId?: string;
  windowId?: string;
  paneId?: string;
  /** 隐藏整页刷新按钮（嵌入式宿主的页面生命周期由宿主自管时使用）。 */
  hideRefresh?: boolean;
  /** 覆盖终端设置入口：提供时点击不再打开内置 Sheet，改由宿主接管（如跳转独立设置页）。 */
  onOpenTerminalSettings?: () => void;
}

type TerminalSettingsSheetComponent = ComponentType<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
}>;

function DeferredTerminalSettingsSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [SheetComponent, setSheetComponent] = useState<TerminalSettingsSheetComponent | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: loadAttempt is an explicit retry trigger
  useEffect(() => {
    if (!open || SheetComponent) return;
    let cancelled = false;
    setLoadError(false);
    void import('../settings/terminal-settings-sheet').then(
      (module) => {
        if (!cancelled) setSheetComponent(() => module.TerminalSettingsSheet);
      },
      () => {
        if (!cancelled) setLoadError(true);
      }
    );
    return () => {
      cancelled = true;
    };
  }, [loadAttempt, open, SheetComponent]);

  if (SheetComponent) {
    return <SheetComponent open={open} onOpenChange={onOpenChange} />;
  }
  if (!open) return null;

  return (
    <div
      className="fixed inset-x-0 bottom-0 z-50 border-t bg-background px-4 py-5 text-sm shadow-lg"
      role={loadError ? 'alert' : 'status'}
      aria-live="polite"
    >
      <div className="mx-auto flex max-w-md items-center justify-between gap-3">
        <span>
          {loadError ? 'Terminal settings failed to load.' : 'Loading terminal settings…'}
        </span>
        <div className="flex gap-2">
          {loadError && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setLoadAttempt((value) => value + 1)}
            >
              Retry
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </div>
      </div>
    </div>
  );
}

export function DeviceConsoleActions({
  deviceId,
  windowId,
  paneId,
  hideRefresh = false,
  onOpenTerminalSettings,
}: DeviceConsoleActionsProps) {
  const { t } = useTranslation();
  const runtime = useRuntime();
  const navigate = useNavigate();
  const isMobileViewport = useIsMobile();
  const resolvedPaneId = paneId ? decodePaneIdFromUrlParam(paneId) : undefined;
  const inputMode = useUIStore((state) => state.inputMode);
  const setInputMode = useUIStore((state) => state.setInputMode);
  const deviceConnected = useTmuxStore((state) =>
    deviceId ? (state.deviceConnected?.[deviceId] ?? false) : false
  );
  const snapshot = useTmuxStore((state) => (deviceId ? state.snapshots[deviceId] : undefined));
  const selectedWindow = useMemo(() => {
    if (!windowId || !snapshot?.session?.windows) return undefined;
    return snapshot.session.windows.find((w) => w.id === windowId);
  }, [windowId, snapshot]);

  const handleSwitchPane = useCallback(
    (targetPaneId: string) => {
      if (!deviceId || !windowId) return;
      navigate(
        hostAppPath(
          runtime.host,
          `/devices/${deviceId}/windows/${windowId}/panes/${encodePaneIdForUrl(targetPaneId)}`
        ),
        { replace: true }
      );
    },
    [deviceId, windowId, navigate, runtime.host]
  );

  const currentPane = useMemo(() => {
    if (!resolvedPaneId || !selectedWindow) return undefined;
    return selectedWindow.panes.find((p) => p.id === resolvedPaneId);
  }, [resolvedPaneId, selectedWindow]);

  const handleSplitPane = useCallback(
    (direction: 'right' | 'down') => {
      if (!deviceId || !resolvedPaneId) return;
      runtime.stores.tmux
        .getState()
        .splitPane(deviceId, resolvedPaneId, direction, currentPane?.currentPath);
    },
    [deviceId, resolvedPaneId, currentPane?.currentPath, runtime]
  );

  const [showRefreshConfirm, setShowRefreshConfirm] = useState(false);
  const [showWatchDialog, setShowWatchDialog] = useState(false);
  const [showTerminalSettings, setShowTerminalSettings] = useState(false);

  const canInteract = Boolean(resolvedPaneId && deviceConnected);
  const watchUi = runtime.features.watchUi;

  const watchRulesQuery = useQuery({
    queryKey: watchRulesQueryKey(deviceId ?? '', resolvedPaneId ?? ''),
    queryFn: () => fetchWatchRules(deviceId ?? '', resolvedPaneId ?? '', runtime.apiClient),
    enabled: Boolean(watchUi && deviceId && resolvedPaneId),
    throwOnError: false,
  });
  const hasEnabledWatchRule = (watchRulesQuery.data ?? []).some((rule) => rule.enabled);

  const handleToggleInputMode = () => {
    const newMode = inputMode === 'direct' ? 'editor' : 'direct';
    setInputMode(newMode);
  };

  const handleJumpToLatest = () => {
    window.dispatchEvent(new CustomEvent('tmex:jump-to-latest'));
  };

  const handleRefreshClick = () => {
    setShowRefreshConfirm(true);
  };

  const handleConfirmRefresh = () => {
    void (async () => runtime.host.reload())().catch(() => {});
  };

  return (
    <>
      {/* 移动端单 pane 展示：多 pane window 时提供切换入口（标题栏样式不变） */}
      {isMobileViewport && resolvedPaneId && selectedWindow && selectedWindow.panes.length > 1 && (
        <PaneSwitcherMenu
          window={selectedWindow}
          currentPaneId={resolvedPaneId}
          onSelectPane={handleSwitchPane}
        />
      )}
      {/* 桌面端：对当前焦点 pane 分屏 */}
      {!isMobileViewport && (
        <>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => handleSplitPane('right')}
            disabled={!canInteract}
            data-testid="split-right-button"
            aria-label={t('window.splitRight')}
            title={t('window.splitRight')}
          >
            <SquareSplitHorizontal className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => handleSplitPane('down')}
            disabled={!canInteract}
            data-testid="split-down-button"
            aria-label={t('window.splitDown')}
            title={t('window.splitDown')}
          >
            <SquareSplitVertical className="h-4 w-4" />
          </Button>
        </>
      )}
      {!hideRefresh && (
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={handleRefreshClick}
          aria-label={t('nav.refreshPage')}
          title={t('nav.refreshPage')}
        >
          <RefreshCw className="h-4 w-4" />
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={handleToggleInputMode}
        disabled={!canInteract}
        data-testid="terminal-input-mode-toggle"
        aria-label={inputMode === 'direct' ? t('nav.switchToEditor') : t('nav.switchToDirect')}
        title={inputMode === 'direct' ? t('nav.switchToEditor') : t('nav.switchToDirect')}
      >
        {inputMode === 'direct' ? (
          <Keyboard className="h-4 w-4" />
        ) : (
          <Smartphone className="h-4 w-4" />
        )}
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={handleJumpToLatest}
        disabled={!canInteract}
        aria-label={t('nav.jumpToLatest')}
        title={t('nav.jumpToLatest')}
      >
        <ArrowDownToLine className="h-4 w-4" />
      </Button>
      {watchUi && (
        <Button
          variant="ghost"
          size="icon-sm"
          className="relative"
          onClick={() => setShowWatchDialog(true)}
          disabled={!resolvedPaneId}
          data-testid="watch-open-button"
          aria-label={t('watch.title')}
          title={t('watch.title')}
        >
          <Radar className="h-4 w-4" />
          {hasEnabledWatchRule && (
            <span
              className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-primary"
              data-testid="watch-active-indicator"
            />
          )}
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() =>
          onOpenTerminalSettings ? onOpenTerminalSettings() : setShowTerminalSettings(true)
        }
        data-testid="keyboard-behavior-open-button"
        aria-label={t('settings.terminal.title')}
        title={t('settings.terminal.title')}
      >
        <Settings2 className="h-4 w-4" />
      </Button>

      {!onOpenTerminalSettings && (
        <DeferredTerminalSettingsSheet
          open={showTerminalSettings}
          onOpenChange={setShowTerminalSettings}
        />
      )}

      {watchUi && deviceId && resolvedPaneId && (
        <WatchDialog
          open={showWatchDialog}
          onOpenChange={setShowWatchDialog}
          deviceId={deviceId}
          paneId={resolvedPaneId}
        />
      )}

      <AlertDialog open={showRefreshConfirm} onOpenChange={setShowRefreshConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('nav.refreshPage')}</AlertDialogTitle>
            <AlertDialogDescription>{t('nav.refreshPageConfirm')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setShowRefreshConfirm(false)}>
              {t('common.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmRefresh}>
              {t('common.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
