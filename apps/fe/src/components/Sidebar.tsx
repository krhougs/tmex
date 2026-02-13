import { useQuery } from '@tanstack/react-query';
import type { Device, TmuxPane, TmuxWindow } from '@tmex/shared';
import { toBCP47 } from '@tmex/shared';
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Globe,
  Monitor,
  Plus,
  Settings,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, matchPath, useLocation, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import { useSiteStore } from '../stores/site';
import { useTmuxStore } from '../stores/tmux';
import { useUIStore } from '../stores/ui';
import { decodePaneIdFromUrlParam, encodePaneIdForUrl } from '../utils/tmuxUrl';

interface SidebarProps {
  isOpen: boolean;
  onClose: () => void;
}

export function Sidebar({ isOpen, onClose }: SidebarProps) {
  const { t } = useTranslation();
  const location = useLocation();
  const paneMatch = matchPath('/devices/:deviceId/windows/:windowId/panes/:paneId', location.pathname);
  const deviceMatch = matchPath('/devices/:deviceId', location.pathname);
  const selectedDeviceId = paneMatch?.params.deviceId ?? deviceMatch?.params.deviceId;
  const selectedWindowId = paneMatch?.params.windowId;
  const selectedPaneId = decodePaneIdFromUrlParam(paneMatch?.params.paneId);

  const { sidebarCollapsed, setSidebarCollapsed } = useUIStore();
  const [expandedDevices, setExpandedDevices] = useState<Set<string>>(new Set());
  const [pendingWindowSelection, setPendingWindowSelection] = useState<
    Record<string, { windowId: string; requestedAt: number }>
  >({});
  const navigate = useNavigate();
  const snapshots = useTmuxStore((state) => state.snapshots);
  const connectDevice = useTmuxStore((state) => state.connectDevice);
  const disconnectDevice = useTmuxStore((state) => state.disconnectDevice);
  const createWindow = useTmuxStore((state) => state.createWindow);
  const closeWindow = useTmuxStore((state) => state.closeWindow);
  const closePane = useTmuxStore((state) => state.closePane);
  const selectWindow = useTmuxStore((state) => state.selectWindow);
  const deviceConnected = useTmuxStore((state) => state.deviceConnected);
  const siteName = useSiteStore((state) => state.settings?.siteName ?? 'tmex');
  const language = useSiteStore((state) => state.settings?.language ?? 'en_US');

  const { data: devicesData, isError: isDevicesError } = useQuery({
    queryKey: ['devices'],
    queryFn: async () => {
      const res = await fetch('/api/devices');
      if (!res.ok) throw new Error('Failed to fetch devices');
      return res.json() as Promise<{ devices: Device[] }>;
    },
    throwOnError: false,
  });

  useEffect(() => {
    if (!isDevicesError) {
      return;
    }
    toast.error(t('common.error'));
  }, [isDevicesError, t]);

  const toggleDevice = useCallback(
    (deviceId: string) => {
      setExpandedDevices((prev) => {
        const next = new Set(prev);
        if (next.has(deviceId)) {
          next.delete(deviceId);
          if (deviceId !== selectedDeviceId) {
            disconnectDevice(deviceId, 'sidebar');
          }
        } else {
          next.add(deviceId);
          connectDevice(deviceId, 'sidebar');
        }
        return next;
      });
    },
    [connectDevice, disconnectDevice, selectedDeviceId]
  );

  const handleDeviceClick = useCallback(
    (deviceId: string) => {
      navigate(`/devices/${deviceId}`);
      onClose();
    },
    [navigate, onClose]
  );

  const navigateToPane = useCallback(
    (deviceId: string, windowId: string, paneId: string) => {
      navigate(`/devices/${deviceId}/windows/${windowId}/panes/${encodePaneIdForUrl(paneId)}`);
      onClose();
    },
    [navigate, onClose]
  );

  const handlePaneClick = useCallback(
    (deviceId: string, windowId: string, paneId: string) => {
      navigateToPane(deviceId, windowId, paneId);
    },
    [navigateToPane]
  );

  const handleWindowClick = useCallback(
    (deviceId: string, windowId: string, panes: TmuxPane[]) => {
      const targetPane = panes.find((pane) => pane.active) ?? panes[0];
      if (targetPane) {
        navigateToPane(deviceId, windowId, targetPane.id);
        return;
      }

      setPendingWindowSelection((prev) => ({
        ...prev,
        [deviceId]: { windowId, requestedAt: Date.now() },
      }));
      selectWindow(deviceId, windowId);
    },
    [navigateToPane, selectWindow]
  );

  const handleCreateWindow = useCallback(
    (deviceId: string) => {
      createWindow(deviceId);
    },
    [createWindow]
  );

  const handleCloseWindow = useCallback(
    (deviceId: string, windowId: string) => {
      closeWindow(deviceId, windowId);
    },
    [closeWindow]
  );

  const handleClosePane = useCallback(
    (deviceId: string, windowId: string, paneId: string, paneCount: number) => {
      if (paneCount <= 1) {
        closeWindow(deviceId, windowId);
        return;
      }
      closePane(deviceId, paneId);
    },
    [closePane, closeWindow]
  );

  useEffect(() => {
    if (selectedDeviceId && !expandedDevices.has(selectedDeviceId)) {
      setExpandedDevices((prev) => new Set(prev).add(selectedDeviceId));
      const isPaneRoute = Boolean(paneMatch?.params.deviceId);
      if (!isPaneRoute) {
        connectDevice(selectedDeviceId, 'sidebar');
      }
    }
  }, [selectedDeviceId, expandedDevices, connectDevice, paneMatch?.params.deviceId]);

  useEffect(() => {
    const pendingEntries = Object.entries(pendingWindowSelection);
    if (pendingEntries.length === 0) {
      return;
    }

    const now = Date.now();
    const nextPending = { ...pendingWindowSelection };
    let hasChange = false;

    for (const [deviceId, pending] of pendingEntries) {
      const snapshot = snapshots[deviceId];
      const targetWindow = snapshot?.session?.windows.find((window) => window.id === pending.windowId);
      const targetPane = targetWindow?.panes.find((pane) => pane.active) ?? targetWindow?.panes[0];

      if (targetWindow && targetPane) {
        navigateToPane(deviceId, targetWindow.id, targetPane.id);
        delete nextPending[deviceId];
        hasChange = true;
        continue;
      }

      if (now - pending.requestedAt > 3000) {
        delete nextPending[deviceId];
        hasChange = true;
      }
    }

    if (hasChange) {
      setPendingWindowSelection(nextPending);
    }
  }, [pendingWindowSelection, snapshots, navigateToPane]);

  const devices = devicesData?.devices ?? [];

  const sortedDevices = useMemo(() => {
    return [...devices].sort((a, b) => {
      return a.name.localeCompare(b.name, toBCP47(language), {
        numeric: true,
        sensitivity: 'base',
      });
    });
  }, [devices, language]);

  const effectiveCollapsed = sidebarCollapsed && !isOpen;

  return (
    <aside
      data-testid="sidebar"
      className={cn(
        'flex h-full shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-[width] duration-200',
        effectiveCollapsed ? 'w-16' : 'w-72'
      )}
    >
      <div className="tmex-mobile-topbar border-b border-sidebar-border flex-shrink-0">
        <div className="h-11 flex items-center gap-2">
          {!effectiveCollapsed && (
            <span className="line-clamp-1 flex-1 truncate text-sm font-semibold tracking-tight" title={siteName}>
              {siteName}
            </span>
          )}
          {isOpen ? (
            <Button
              variant="ghost"
              size="icon-sm"
              data-testid="mobile-sidebar-close"
              onClick={onClose}
              aria-label={t('nav.closeSidebar')}
              title={t('nav.closeSidebar')}
              className="ml-auto"
            >
              <X className="h-4 w-4" />
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="icon-sm"
              data-testid="sidebar-collapse-toggle"
              onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
              title={sidebarCollapsed ? t('nav.sidebarExpand') : t('nav.sidebarCollapse')}
              className={effectiveCollapsed ? 'mx-auto' : 'ml-auto'}
            >
              {effectiveCollapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
            </Button>
          )}
        </div>
      </div>

      <ScrollArea className="flex-1">
        <div className="space-y-1 p-2">
          {sortedDevices.map((device) => (
            <DeviceTreeItem
              key={device.id}
              device={device}
              isExpanded={expandedDevices.has(device.id)}
              isSelected={device.id === selectedDeviceId}
              selectedWindowId={selectedWindowId}
              selectedPaneId={selectedPaneId}
              windows={snapshots[device.id]?.session?.windows ?? null}
              isConnected={deviceConnected[device.id] ?? false}
              onToggle={() => toggleDevice(device.id)}
              onSelect={() => handleDeviceClick(device.id)}
              onCreateWindow={() => handleCreateWindow(device.id)}
              onCloseWindow={handleCloseWindow}
              onClosePane={handleClosePane}
              collapsed={effectiveCollapsed}
              onPaneClick={handlePaneClick}
              onWindowClick={handleWindowClick}
            />
          ))}

          {sortedDevices.length === 0 && !effectiveCollapsed && (
            <div className="rounded-lg border border-dashed border-sidebar-border bg-sidebar-accent/30 px-3 py-4 text-center">
              <div className="mb-1 text-sm text-sidebar-foreground">{t('sidebar.noDevices')}</div>
              <div className="space-y-1 text-xs">
                <Link
                  to="/devices"
                  className="block text-primary hover:underline"
                  onClick={onClose}
                >
                  {t('sidebar.addDevice')}
                </Link>
                <Link
                  to="/settings"
                  className="block text-muted-foreground hover:text-foreground hover:underline"
                  onClick={onClose}
                >
                  {t('sidebar.openSettings')}
                </Link>
              </div>
            </div>
          )}
        </div>
      </ScrollArea>

      <Separator className="bg-sidebar-border" />

      {!effectiveCollapsed ? (
        <div className="space-y-2 px-3 py-3 tmex-sidebar-bottom-safe-md">
          <Link
            data-testid="sidebar-manage-devices"
            to="/devices"
            onClick={onClose}
            className={cn(buttonVariants({ variant: 'outline' }), 'w-full justify-start')}
          >
            <Monitor className="h-4 w-4" />
            {t('sidebar.manageDevices')}
          </Link>
          <Link
            data-testid="sidebar-settings"
            to="/settings"
            onClick={onClose}
            className={cn(buttonVariants({ variant: 'outline' }), 'w-full justify-start')}
          >
            <Settings className="h-4 w-4" />
            {t('sidebar.settings')}
          </Link>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-2 px-2 py-2 tmex-sidebar-bottom-safe-sm">
          <Link
            data-testid="sidebar-manage-devices"
            to="/devices"
            onClick={onClose}
            title={t('sidebar.manageDevices')}
            className={buttonVariants({ variant: 'ghost', size: 'icon-sm' })}
          >
            <Monitor className="h-4 w-4" />
          </Link>
          <Link
            data-testid="sidebar-settings"
            to="/settings"
            onClick={onClose}
            title={t('sidebar.settings')}
            className={buttonVariants({ variant: 'ghost', size: 'icon-sm' })}
          >
            <Settings className="h-4 w-4" />
          </Link>
        </div>
      )}
    </aside>
  );
}

interface DeviceTreeItemProps {
  device: Device;
  isExpanded: boolean;
  isSelected: boolean;
  selectedWindowId?: string;
  selectedPaneId?: string;
  windows: TmuxWindow[] | null;
  isConnected: boolean;
  onToggle: () => void;
  onSelect: () => void;
  onCreateWindow: () => void;
  onCloseWindow: (deviceId: string, windowId: string) => void;
  onClosePane: (deviceId: string, windowId: string, paneId: string, paneCount: number) => void;
  collapsed: boolean;
  onPaneClick: (deviceId: string, windowId: string, paneId: string) => void;
  onWindowClick: (deviceId: string, windowId: string, panes: TmuxPane[]) => void;
}

function DeviceTreeItem({
  device,
  isExpanded,
  isSelected,
  selectedWindowId,
  selectedPaneId,
  onToggle,
  onSelect,
  onCreateWindow,
  onCloseWindow,
  onClosePane,
  collapsed,
  windows,
  isConnected,
  onPaneClick,
  onWindowClick,
}: DeviceTreeItemProps) {
  const { t } = useTranslation();
  const DeviceIcon = device.type === 'local' ? Monitor : Globe;

  const hasSelectedPaneInDevice = isSelected && Boolean(selectedPaneId);
  const selectedWindow = hasSelectedPaneInDevice
    ? windows?.find((window) => window.id === selectedWindowId)
    : undefined;
  const selectedPaneInWindow = hasSelectedPaneInDevice
    ? selectedWindow?.panes.find((pane) => pane.id === selectedPaneId)
    : undefined;
  const isDeviceTreeSelected = hasSelectedPaneInDevice && Boolean(selectedPaneInWindow);

  if (collapsed) {
    return (
      <div className="flex justify-center">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={onSelect}
          title={device.name}
          data-testid={`device-icon-${device.id}`}
          data-active={isSelected}
          className={cn(
            'relative',
            isSelected && 'bg-sidebar-accent text-sidebar-accent-foreground',
            isConnected && !isSelected && 'after:absolute after:right-1 after:top-1 after:h-1.5 after:w-1.5 after:rounded-full after:bg-emerald-500'
          )}
        >
          <DeviceIcon className="h-4 w-4" />
        </Button>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-transparent bg-sidebar/60">
      <div
        data-testid={`device-item-${device.id}`}
        data-active={isSelected}
        className={cn(
          'rounded-lg border px-1.5 py-1 shadow-xs transition-colors',
          isDeviceTreeSelected && 'border-primary/50 bg-primary/10',
          !isDeviceTreeSelected && isSelected && 'border-sidebar-border bg-sidebar-accent/60',
          !isSelected && 'border-transparent hover:border-sidebar-border hover:bg-sidebar-accent/35'
        )}
      >
        <div className="flex items-center gap-1">
          <button
            type="button"
            data-testid={`device-expand-${device.id}`}
            onClick={onToggle}
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
            title={isExpanded ? t('common.collapse') : t('common.expand')}
          >
            {isExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          </button>

          <button
            type="button"
            data-testid={`device-select-${device.id}`}
            onClick={onSelect}
            className="flex min-w-0 flex-1 items-center gap-2 text-left"
            title={device.name}
          >
            <DeviceIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="truncate text-sm font-medium">{device.name}</span>
          </button>

          {isConnected && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" title={t('device.connected')} />}

          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            data-testid={`window-create-${device.id}`}
            onClick={(event) => {
              event.stopPropagation();
              onCreateWindow();
            }}
            title={t('sidebar.newWindow')}
            aria-label={`${device.name} ${t('sidebar.newWindow')}`}
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {isExpanded && (
        <div className="ml-3 mt-1 space-y-1 border-l border-sidebar-border/70 pl-2">
          {!windows && (
            <div className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground">
              <span className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse" />
              {t('terminal.connecting')}
            </div>
          )}

          {windows && windows.length === 0 && (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">-</div>
          )}

          {windows?.map((window) => (
            <WindowTreeItem
              key={window.id}
              device={device}
              window={window}
              isSelected={isSelected && window.id === selectedWindowId}
              isDeviceTreeSelected={isDeviceTreeSelected}
              selectedPaneId={selectedPaneId}
              parentSelected={isSelected}
              onPaneClick={onPaneClick}
              onWindowClick={onWindowClick}
              onCloseWindow={onCloseWindow}
              onClosePane={onClosePane}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface WindowTreeItemProps {
  device: Device;
  window: TmuxWindow;
  isSelected: boolean;
  isDeviceTreeSelected: boolean;
  selectedPaneId?: string;
  parentSelected: boolean;
  onPaneClick: (deviceId: string, windowId: string, paneId: string) => void;
  onWindowClick: (deviceId: string, windowId: string, panes: TmuxPane[]) => void;
  onCloseWindow: (deviceId: string, windowId: string) => void;
  onClosePane: (deviceId: string, windowId: string, paneId: string, paneCount: number) => void;
}

function WindowTreeItem({
  device,
  window,
  isSelected,
  isDeviceTreeSelected,
  selectedPaneId,
  parentSelected,
  onPaneClick,
  onWindowClick,
  onCloseWindow,
  onClosePane,
}: WindowTreeItemProps) {
  const { t } = useTranslation();
  const [isExpanded, setIsExpanded] = useState(isSelected);

  useEffect(() => {
    if (isSelected) {
      setIsExpanded(true);
    }
  }, [isSelected]);

  const handleWindowClick = useCallback(() => {
    onWindowClick(device.id, window.id, window.panes);
  }, [device.id, window.id, window.panes, onWindowClick]);

  const hasMultiplePanes = window.panes.length > 1;
  const selectedPaneInWindow = window.panes.find((pane) => pane.id === selectedPaneId);
  const isWindowTreeSelected = isDeviceTreeSelected && Boolean(selectedPaneInWindow);

  return (
    <div className="space-y-1">
      <div
        data-testid={`window-item-${window.id}`}
        data-active={isSelected}
        role="button"
        tabIndex={0}
        onClick={handleWindowClick}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            handleWindowClick();
          }
        }}
        className={cn(
          'rounded-md border border-transparent px-1 py-1 transition-colors',
          isWindowTreeSelected && 'border-primary/45 bg-primary/15',
          !isWindowTreeSelected && isSelected && 'border-sidebar-border bg-sidebar-accent/55',
          !isSelected && 'hover:border-sidebar-border hover:bg-sidebar-accent/35',
          !isSelected && parentSelected && 'ml-1'
        )}
      >
        <div className="flex items-center gap-1">
          {hasMultiplePanes ? (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                setIsExpanded(!isExpanded);
              }}
              className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
            >
              {isExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            </button>
          ) : (
            <span className="inline-block h-5 w-5 shrink-0" />
          )}

          <Badge variant="outline" className="h-5 rounded-sm px-1 text-[10px]">
            {window.index}
          </Badge>

          <span className="line-clamp-1 flex-1 truncate text-xs font-medium" title={window.name}>
            {window.name}
          </span>

          {window.active && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" title={t('sidebar.currentWindow')} />}

          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            data-testid={`window-close-${window.id}`}
            onClick={(event) => {
              event.stopPropagation();
              onCloseWindow(device.id, window.id);
            }}
            title={t('sidebar.closeWindow')}
            aria-label={`${t('sidebar.closeWindow')} ${window.name}`}
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      </div>

      {(isExpanded || !hasMultiplePanes) && (
        <div className={cn('space-y-1 border-l border-sidebar-border/60 pl-2', !isSelected && parentSelected && 'ml-2')}>
          {window.panes.map((pane) => (
            <PaneTreeItem
              key={pane.id}
              deviceId={device.id}
              windowId={window.id}
              pane={pane}
              isSelected={isSelected && pane.id === selectedPaneId}
              isWindowTreeSelected={isWindowTreeSelected}
              parentWindowSelected={isSelected}
              paneCount={window.panes.length}
              onClick={onPaneClick}
              onClosePane={onClosePane}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface PaneTreeItemProps {
  deviceId: string;
  windowId: string;
  pane: TmuxPane;
  isSelected: boolean;
  isWindowTreeSelected: boolean;
  parentWindowSelected: boolean;
  paneCount: number;
  onClick: (deviceId: string, windowId: string, paneId: string) => void;
  onClosePane: (deviceId: string, windowId: string, paneId: string, paneCount: number) => void;
}

function PaneTreeItem({
  deviceId,
  windowId,
  pane,
  isSelected,
  isWindowTreeSelected,
  parentWindowSelected,
  paneCount,
  onClick,
  onClosePane,
}: PaneTreeItemProps) {
  const { t } = useTranslation();

  return (
    <div
      data-testid={`pane-item-${pane.id}`}
      data-active={isSelected}
      className={cn(
        'flex items-center gap-1 rounded-md border border-transparent px-1 py-1 text-xs transition-colors',
        isSelected && 'border-primary/65 bg-primary text-primary-foreground',
        !isSelected && isWindowTreeSelected && 'bg-primary/10 text-foreground',
        !isSelected && !isWindowTreeSelected && 'text-muted-foreground hover:bg-sidebar-accent/45 hover:text-foreground',
        !isSelected && parentWindowSelected && 'ml-1'
      )}
    >
      <button
        type="button"
        onClick={() => onClick(deviceId, windowId, pane.id)}
        title={`Pane ${pane.index}${pane.active ? ' (active)' : ''}`}
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
      >
        <span className={cn('text-[10px]', isSelected ? 'text-primary-foreground/80' : 'text-muted-foreground')}>
          ▸
        </span>
        <span className="truncate">Pane {pane.index}</span>
        {pane.active && <span className={cn('h-1 w-1 rounded-full', isSelected ? 'bg-primary-foreground/80' : 'bg-emerald-500')} title={t('sidebar.currentPane')} />}
      </button>

      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        data-testid={`pane-close-${pane.id}`}
        onClick={(event) => {
          event.stopPropagation();
          onClosePane(deviceId, windowId, pane.id, paneCount);
        }}
        title={t('sidebar.closePane')}
        aria-label={`${t('sidebar.closePane')} ${pane.index}`}
      >
        <X className="h-3 w-3" />
      </Button>
    </div>
  );
}
