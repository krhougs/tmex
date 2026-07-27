import {
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  devicesQueryKey as defaultDevicesQueryKey,
  fetchDevices,
  reorderDevices,
} from '@tmex/api-client';
import { useBellStore } from '@tmex/notifications';
import type { Device, TmuxPane, TmuxWindow } from '@tmex/shared';
import { toBCP47 } from '@tmex/shared';
import {
  buildWindowDisplayName,
  buildWindowTitleParts,
  decodePaneIdFromUrlParam,
  encodePaneIdForUrl,
  hostAppPath,
} from '@tmex/stores';
import { useRuntime, useSiteStore, useTmuxStore, useUIStore } from '@tmex/stores/react';
import { cn } from '@tmex/ui';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from '@tmex/ui/alert-dialog';
import { Button } from '@tmex/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@tmex/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@tmex/ui/dropdown-menu';
import { Input } from '@tmex/ui/input';
import { ScrollArea } from '@tmex/ui/scroll-area';
import { SidebarGroup, useSidebar } from '@tmex/ui/sidebar';
import {
  ChevronRight,
  EllipsisVertical,
  FolderOpen,
  Globe,
  GripVertical,
  Monitor,
  Pencil,
  Plus,
  Radar,
  SquareSplitHorizontal,
  SquareSplitVertical,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { matchPath, useLocation, useNavigate } from 'react-router';
import { toast } from '@tmex/ui/toast';
import { DeviceStatusBadge } from '../device-status-badge';
import { WatchDialog } from '../watch/watch-dialog';
import type { DeviceTreeNavigation, SidebarAgentAdapter } from './agent-adapter';

type DeviceListItem = Device & {
  lastError?: string | null;
  lastErrorType?: string | null;
};

type CloseCandidate =
  | { kind: 'window'; deviceId: string; windowId: string; name: string }
  | { kind: 'pane'; deviceId: string; paneId: string; name: string };

type RenameCandidate =
  | { kind: 'window'; deviceId: string; windowId: string; hasCustomName: boolean }
  | { kind: 'pane'; deviceId: string; paneId: string; hasCustomName: boolean };

function WindowBellIcon({ paneIds }: { paneIds: string[] }) {
  const ringing = useBellStore((state) => paneIds.some((id) => state.ringingPanes[id]));
  if (!ringing) return null;
  return <span className="bell-blink shrink-0">🔔 </span>;
}

function PaneBellIcon({ paneId }: { paneId: string }) {
  const ringing = useBellStore((state) => Boolean(state.ringingPanes[paneId]));
  if (!ringing) return null;
  return <span className="bell-blink shrink-0">🔔 </span>;
}

// device/window/pane 三层共用的拖拽 sensors：
// - 鼠标走 distance 约束（按下移动 8px 即激活，无 delay），根治 PC「按下即拖」起不来；
// - 触摸走 delay 约束（长按 250ms 激活，移动 >5px 视为滚动手势让位原生滚动）；
// - 键盘走 sortable 的 coordinateGetter（可访问性）。
// 注：旧版 @dnd-kit/core PointerSensor 无法按 pointerType 分别配约束，故必须拆 Mouse + Touch。
function useDeviceTreeSensors() {
  return useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );
}

const identityExpansionKey = (deviceId: string) => deviceId;

export interface SideBarDeviceListProps {
  /** 展开/选中设备时保证已订阅其 tmux 快照（宿主接自己的连接管理） */
  ensureDeviceSubscribed: (deviceId: string) => void;
  /** ui store sidebarDeviceExpanded 的 key 映射；多 runtime 宿主传复合 key，缺省恒等 */
  expansionKeyFor?: (deviceId: string) => string;
  /** 设备列表 react-query key；缺省沿用 ['devices'] */
  devicesQueryKey?: readonly unknown[];
  /** agent 会话装饰；未传时不渲染任何 agent 面 */
  agent?: SidebarAgentAdapter;
}

export function SideBarDeviceList({
  ensureDeviceSubscribed,
  expansionKeyFor,
  devicesQueryKey,
  agent,
}: SideBarDeviceListProps) {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const runtime = useRuntime();
  const { host } = runtime;

  const expansionKey = expansionKeyFor ?? identityExpansionKey;
  const queryKey = devicesQueryKey ?? defaultDevicesQueryKey;
  const agentAdapter = runtime.features.agentUi ? agent : undefined;

  const sidebarDeviceExpanded = useUIStore((state) => state.sidebarDeviceExpanded);
  const setSidebarDeviceExpanded = useUIStore((state) => state.setSidebarDeviceExpanded);

  // Get selected window/pane from URL
  const paneMatch = matchPath(
    hostAppPath(host, '/devices/:deviceId/windows/:windowId/panes/:paneId'),
    location.pathname
  );
  const deviceMatch = matchPath(
    { path: hostAppPath(host, '/devices/:deviceId'), end: false },
    location.pathname
  );
  const selectedDeviceId = paneMatch?.params.deviceId ?? deviceMatch?.params.deviceId;
  const selectedWindowId = paneMatch?.params.windowId;
  // matchPath 接收的是 location.pathname，其中 paneId 仍保留 URL 编码；只在这里解码一次，
  // 再交给 tmux URL 工具保持与 useParams 路径一致。
  const selectedPaneId = decodePaneIdFromUrlParam(
    paneMatch?.params.paneId ? decodeURIComponent(paneMatch.params.paneId) : undefined
  );

  const snapshots = useTmuxStore((state) => state.snapshots);
  const deviceConnected = useTmuxStore((state) => state.deviceConnected);
  const deviceErrors = useTmuxStore((state) => state.deviceErrors);
  const deviceReconnecting = useTmuxStore((state) => state.deviceReconnecting);
  const closeWindow = useTmuxStore((state) => state.closeWindow);
  const closePane = useTmuxStore((state) => state.closePane);
  const renameWindow = useTmuxStore((state) => state.renameWindow);
  const language = useSiteStore((state) => state.settings?.language ?? 'en_US');

  const { data: devicesData } = useQuery({
    queryKey,
    queryFn: () => fetchDevices(runtime.apiClient),
    throwOnError: false,
  });

  const hydrateDeviceErrors = useTmuxStore((state) => state.hydrateDeviceErrors);

  useEffect(() => {
    if (!devicesData?.devices) return;
    hydrateDeviceErrors(
      devicesData.devices.map((d) => ({
        deviceId: d.id,
        lastError: d.lastError ?? null,
        lastErrorType: d.lastErrorType ?? null,
      }))
    );
  }, [devicesData, hydrateDeviceErrors]);

  const handleNavigate = useCallback(
    (to: string, options?: { replace?: boolean; keepSidebarOpen?: boolean }) => {
      navigate(to, { replace: options?.replace ?? true });
      if (isMobile && !options?.keepSidebarOpen) setOpenMobile(false);
    },
    [navigate, isMobile, setOpenMobile]
  );

  const navigateToPane = useCallback(
    (
      deviceId: string,
      windowId: string,
      paneId: string,
      options?: { keepSidebarOpen?: boolean }
    ) => {
      // Clear any pending navigation to prevent interference
      pendingNavigationRef.current = null;

      window.dispatchEvent(
        new CustomEvent('tmex:user-initiated-selection', {
          detail: { deviceId, windowId, paneId },
        })
      );
      handleNavigate(
        hostAppPath(
          host,
          `/devices/${deviceId}/windows/${windowId}/panes/${encodePaneIdForUrl(paneId)}`
        ),
        { keepSidebarOpen: options?.keepSidebarOpen }
      );
    },
    [handleNavigate, host]
  );

  const nav = useMemo<DeviceTreeNavigation>(() => ({ navigateToPane }), [navigateToPane]);

  const selectWindow = useTmuxStore((state) => state.selectWindow);

  // Track pending navigation when panes are not yet available (cross-device switch)
  const pendingNavigationRef = useRef<{
    deviceId: string;
    windowId: string;
    at: number;
  } | null>(null);

  // Retry navigation when snapshot updates and pending window's panes become available
  useEffect(() => {
    const pending = pendingNavigationRef.current;
    if (!pending) return;

    // Only process pending navigation if it's recent (within 5 seconds)
    // This prevents stale pending navigation from interfering with user actions
    if (Date.now() - pending.at > 5000) {
      pendingNavigationRef.current = null;
      return;
    }

    const { deviceId: pendingDeviceId, windowId: pendingWindowId } = pending;
    const deviceSnapshot = snapshots[pendingDeviceId];
    const windows = deviceSnapshot?.session?.windows;
    if (!windows) return;

    const targetWindow = windows.find((w) => w.id === pendingWindowId);
    if (!targetWindow?.panes?.length) return;

    // Panes are now available, navigate to active pane
    pendingNavigationRef.current = null;
    const activePane = targetWindow.panes.find((p) => p.active) ?? targetWindow.panes[0];
    navigateToPane(pendingDeviceId, pendingWindowId, activePane.id);
  }, [snapshots, navigateToPane]);

  const navigateToWindow = useCallback(
    (deviceId: string, windowId: string, panes: TmuxPane[]) => {
      // Tell backend to select the window (let tmux decide active pane)
      selectWindow(deviceId, windowId);

      // Navigate to the active pane in this window (based on current snapshot)
      const activePane = panes.find((p) => p.active) ?? panes[0];
      if (activePane) {
        navigateToPane(deviceId, windowId, activePane.id);
        pendingNavigationRef.current = null;
      } else {
        // Panes not available yet (cross-device switch), wait for snapshot
        pendingNavigationRef.current = { deviceId, windowId, at: Date.now() };
      }
    },
    [navigateToPane, selectWindow]
  );

  const handleCloseWindow = useCallback(
    (deviceId: string, windowId: string) => {
      // If closing the currently selected window, navigate to fallback
      if (deviceId === selectedDeviceId && windowId === selectedWindowId) {
        handleNavigate(hostAppPath(host, '/devices'));
      }
      closeWindow(deviceId, windowId);
    },
    [closeWindow, selectedDeviceId, selectedWindowId, handleNavigate, host]
  );

  const [closeCandidate, setCloseCandidate] = useState<CloseCandidate | null>(null);

  const requestCloseWindow = useCallback(
    (deviceId: string, windowId: string) => {
      const windows = runtime.stores.tmux.getState().snapshots[deviceId]?.session?.windows;
      const target = windows?.find((w) => w.id === windowId);
      setCloseCandidate({
        kind: 'window',
        deviceId,
        windowId,
        name: target ? buildWindowDisplayName(target) : '',
      });
    },
    [runtime]
  );

  const requestClosePane = useCallback(
    (deviceId: string, windowId: string, paneId: string) => {
      const windows = runtime.stores.tmux.getState().snapshots[deviceId]?.session?.windows;
      const pane = windows?.find((w) => w.id === windowId)?.panes?.find((p) => p.id === paneId);
      setCloseCandidate({
        kind: 'pane',
        deviceId,
        paneId,
        name: pane?.title || `Pane ${pane?.index ?? ''}`,
      });
    },
    [runtime]
  );

  const confirmClose = useCallback(() => {
    if (!closeCandidate) return;
    if (closeCandidate.kind === 'window') {
      handleCloseWindow(closeCandidate.deviceId, closeCandidate.windowId);
    } else {
      closePane(closeCandidate.deviceId, closeCandidate.paneId);
    }
    setCloseCandidate(null);
  }, [closeCandidate, handleCloseWindow, closePane]);

  const [renameCandidate, setRenameCandidate] = useState<RenameCandidate | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const requestRenameWindow = useCallback(
    (deviceId: string, windowId: string) => {
      const windows = runtime.stores.tmux.getState().snapshots[deviceId]?.session?.windows;
      const target = windows?.find((w) => w.id === windowId);
      if (!target) return;
      setRenameValue(target.customName ?? buildWindowTitleParts(target).title);
      setRenameCandidate({
        kind: 'window',
        deviceId,
        windowId,
        hasCustomName: Boolean(target.customName),
      });
    },
    [runtime]
  );

  const requestRenamePane = useCallback(
    (deviceId: string, paneId: string) => {
      const windows = runtime.stores.tmux.getState().snapshots[deviceId]?.session?.windows;
      const target = windows?.flatMap((w) => w.panes).find((p) => p.id === paneId);
      if (!target) return;
      setRenameValue(target.customName ?? target.title ?? '');
      setRenameCandidate({
        kind: 'pane',
        deviceId,
        paneId,
        hasCustomName: Boolean(target.customName),
      });
    },
    [runtime]
  );

  const renamePane = useTmuxStore((state) => state.renamePane);

  const applyRename = useCallback(
    (name: string) => {
      if (!renameCandidate) return;
      if (renameCandidate.kind === 'window') {
        renameWindow(renameCandidate.deviceId, renameCandidate.windowId, name);
      } else {
        renamePane(renameCandidate.deviceId, renameCandidate.paneId, name);
      }
      setRenameCandidate(null);
    },
    [renameCandidate, renameWindow, renamePane]
  );

  const confirmRename = useCallback(() => {
    const trimmed = renameValue.trim();
    if (!trimmed) return;
    applyRename(trimmed);
  }, [applyRename, renameValue]);

  const resetRename = useCallback(() => {
    applyRename('');
  }, [applyRename]);

  const handleCreateWindow = useCallback(
    (deviceId: string) => {
      runtime.stores.tmux.getState().createWindow(deviceId);
    },
    [runtime]
  );

  const [watchTarget, setWatchTarget] = useState<{ deviceId: string; paneId: string } | null>(null);

  const requestWatchPane = useCallback((deviceId: string, paneId: string) => {
    setWatchTarget({ deviceId, paneId });
  }, []);

  const queryClient = useQueryClient();
  const deviceSensors = useDeviceTreeSensors();

  const reorderDevicesMutation = useMutation({
    mutationFn: (deviceIds: string[]) => reorderDevices(deviceIds, runtime.apiClient),
    onMutate: async (deviceIds: string[]) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<{ devices: DeviceListItem[] }>(queryKey);
      if (previous) {
        const byId = new Map(previous.devices.map((d) => [d.id, d]));
        const reordered = deviceIds
          .map((id, index) => {
            const d = byId.get(id);
            return d ? { ...d, sortOrder: index } : undefined;
          })
          .filter((d): d is DeviceListItem => d !== undefined);
        const rest = previous.devices.filter((d) => !deviceIds.includes(d.id));
        queryClient.setQueryData(queryKey, { devices: [...reordered, ...rest] });
      }
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(queryKey, context.previous);
      toast.error(t('device.reorderFailed'));
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey });
    },
  });

  const devices = devicesData?.devices ?? [];
  const autoExpandedDeviceIdsRef = useRef(new Set<string>());

  const handleDeviceExpandedChange = useCallback(
    (deviceId: string, expanded: boolean) => {
      setSidebarDeviceExpanded(expansionKey(deviceId), expanded);
      if (expanded) {
        ensureDeviceSubscribed(deviceId);
      }
    },
    [ensureDeviceSubscribed, setSidebarDeviceExpanded, expansionKey]
  );

  useEffect(() => {
    if (!selectedDeviceId || !devices.some((device) => device.id === selectedDeviceId)) return;
    if (autoExpandedDeviceIdsRef.current.has(selectedDeviceId)) return;

    autoExpandedDeviceIdsRef.current.add(selectedDeviceId);
    if (
      !Object.prototype.hasOwnProperty.call(sidebarDeviceExpanded, expansionKey(selectedDeviceId))
    ) {
      setSidebarDeviceExpanded(expansionKey(selectedDeviceId), true);
    }
    ensureDeviceSubscribed(selectedDeviceId);
  }, [
    devices,
    ensureDeviceSubscribed,
    selectedDeviceId,
    setSidebarDeviceExpanded,
    sidebarDeviceExpanded,
    expansionKey,
  ]);

  useEffect(() => {
    for (const device of devices) {
      if (sidebarDeviceExpanded[expansionKey(device.id)] !== false) {
        ensureDeviceSubscribed(device.id);
      }
    }
  }, [devices, ensureDeviceSubscribed, sidebarDeviceExpanded, expansionKey]);

  const sortedDevices = useMemo(
    () =>
      [...devices].sort(
        (a, b) =>
          a.sortOrder - b.sortOrder ||
          a.name.localeCompare(b.name, toBCP47(language), { numeric: true, sensitivity: 'base' })
      ),
    [devices, language]
  );

  const handleDeviceDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const ids = sortedDevices.map((d) => d.id);
      const oldIndex = ids.indexOf(String(active.id));
      const newIndex = ids.indexOf(String(over.id));
      if (oldIndex < 0 || newIndex < 0) return;
      reorderDevicesMutation.mutate(arrayMove(ids, oldIndex, newIndex));
    },
    [sortedDevices, reorderDevicesMutation]
  );

  const knownDeviceIds = useMemo(() => devices.map((device) => device.id), [devices]);

  return (
    <SidebarGroup className="flex flex-col flex-1 min-h-0 pt-0">
      <DndContext
        sensors={deviceSensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDeviceDragEnd}
      >
        <ScrollArea className="flex-1 min-h-0">
          <div className="space-y-1.5 pb-2 pt-1 select-none [-webkit-user-select:none] [-webkit-touch-callout:none]">
            <SortableContext
              items={sortedDevices.map((d) => d.id)}
              strategy={verticalListSortingStrategy}
            >
              {sortedDevices.map((device) => (
                <DeviceSection
                  key={device.id}
                  device={device}
                  windows={snapshots[device.id]?.session?.windows ?? null}
                  isExpanded={sidebarDeviceExpanded[expansionKey(device.id)] !== false}
                  isOnline={
                    deviceConnected[device.id] === true &&
                    !deviceErrors[device.id] &&
                    !deviceReconnecting[device.id]
                  }
                  isSelected={device.id === selectedDeviceId}
                  selectedWindowId={selectedWindowId}
                  selectedPaneId={selectedPaneId}
                  onExpandedChange={handleDeviceExpandedChange}
                  onCreateWindow={handleCreateWindow}
                  onCloseWindow={requestCloseWindow}
                  onClosePane={requestClosePane}
                  onRenameWindow={requestRenameWindow}
                  onRenamePane={requestRenamePane}
                  onPaneClick={navigateToPane}
                  onWindowClick={navigateToWindow}
                  onWatchPane={requestWatchPane}
                  agent={agentAdapter}
                  nav={nav}
                />
              ))}
            </SortableContext>
            {sortedDevices.length === 0 && (
              <div className="text-center text-sm text-muted-foreground py-4">
                {t('sidebar.noDevices')}
              </div>
            )}

            {agentAdapter && (
              <agentAdapter.OrphanSessions nav={nav} knownDeviceIds={knownDeviceIds} />
            )}
          </div>
        </ScrollArea>
      </DndContext>

      <AlertDialog
        open={closeCandidate !== null}
        onOpenChange={(open) => !open && setCloseCandidate(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia className="bg-destructive/10">
              <X className="h-5 w-5 text-destructive" />
            </AlertDialogMedia>
            <AlertDialogTitle>
              {closeCandidate?.kind === 'pane'
                ? t('window.closePaneConfirmTitle')
                : t('window.closeConfirmTitle')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('window.closeConfirmDesc', { name: closeCandidate?.name ?? '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={!closeCandidate}
              onClick={confirmClose}
            >
              {t('common.close')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog
        open={renameCandidate !== null}
        onOpenChange={(open) => !open && setRenameCandidate(null)}
      >
        <DialogContent data-testid="window-rename-dialog">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              confirmRename();
            }}
          >
            <DialogHeader>
              <DialogTitle>{t('window.rename')}</DialogTitle>
              <DialogDescription>{t('window.renameDesc')}</DialogDescription>
            </DialogHeader>
            <div className="py-4">
              <Input
                autoFocus
                maxLength={64}
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                placeholder={t('window.renamePlaceholder')}
                data-testid="window-rename-input"
              />
            </div>
            <DialogFooter>
              {renameCandidate?.hasCustomName && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={resetRename}
                  data-testid="window-rename-reset"
                >
                  {t('window.renameReset')}
                </Button>
              )}
              <Button type="button" variant="outline" onClick={() => setRenameCandidate(null)}>
                {t('common.cancel')}
              </Button>
              <Button type="submit" disabled={!renameValue.trim()} data-testid="window-rename-save">
                {t('common.save')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {agentAdapter && <agentAdapter.Dialogs />}

      {runtime.features.watchUi && watchTarget && (
        <WatchDialog
          open
          onOpenChange={(open) => !open && setWatchTarget(null)}
          deviceId={watchTarget.deviceId}
          paneId={watchTarget.paneId}
        />
      )}
    </SidebarGroup>
  );
}

interface DeviceSectionProps {
  device: Device;
  windows: TmuxWindow[] | null;
  isExpanded: boolean;
  isOnline: boolean;
  isSelected: boolean;
  selectedWindowId?: string;
  selectedPaneId?: string;
  onExpandedChange: (deviceId: string, expanded: boolean) => void;
  onCreateWindow: (deviceId: string) => void;
  onCloseWindow: (deviceId: string, windowId: string) => void;
  onClosePane: (deviceId: string, windowId: string, paneId: string) => void;
  onRenameWindow: (deviceId: string, windowId: string) => void;
  onRenamePane: (deviceId: string, paneId: string) => void;
  onPaneClick: (deviceId: string, windowId: string, paneId: string) => void;
  onWindowClick: (deviceId: string, windowId: string, panes: TmuxPane[]) => void;
  onWatchPane: (deviceId: string, paneId: string) => void;
  agent?: SidebarAgentAdapter;
  nav: DeviceTreeNavigation;
}

function DeviceSection({
  device,
  windows,
  isExpanded,
  isOnline,
  isSelected,
  selectedWindowId,
  selectedPaneId,
  onExpandedChange,
  onCreateWindow,
  onCloseWindow,
  onClosePane,
  onRenameWindow,
  onRenamePane,
  onPaneClick,
  onWindowClick,
  onWatchPane,
  agent,
  nav,
}: DeviceSectionProps) {
  const { t } = useTranslation();
  const { stores } = useRuntime();
  const DeviceIcon = device.type === 'local' ? Monitor : Globe;
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: device.id });
  const windowSensors = useDeviceTreeSensors();
  const handleWindowDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id || !windows) return;
    const ids = windows.map((w) => w.id);
    const oldIndex = ids.indexOf(String(active.id));
    const newIndex = ids.indexOf(String(over.id));
    if (oldIndex < 0 || newIndex < 0) return;
    stores.tmux.getState().reorderWindows(device.id, arrayMove(ids, oldIndex, newIndex));
  };

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      data-testid={`device-item-${device.id}`}
      className={cn(
        'group/device rounded-xl border border-border/60 overflow-hidden',
        isSelected ? 'bg-chat-surface' : 'bg-muted/20',
        isDragging && 'opacity-60 shadow-lg'
      )}
    >
      <div className="relative px-3 py-1.5">
        {isSelected && (
          <span className="absolute left-0 top-0 bottom-0 w-0.5 bg-muted-foreground/70" />
        )}
        <div className="flex items-center gap-2">
          <button
            type="button"
            ref={setActivatorNodeRef}
            {...attributes}
            {...listeners}
            aria-label={t('device.dragHandle')}
            onClick={(e) => e.stopPropagation()}
            className="touch-none cursor-grab shrink-0 -ml-1 text-muted-foreground/50 hover:text-muted-foreground opacity-100"
          >
            <GripVertical className="h-3.5 w-3.5 [@media(any-pointer:coarse)]:h-5 [@media(any-pointer:coarse)]:w-5" />
          </button>
          <DeviceIcon className="h-4 w-4 text-muted-foreground shrink-0" />
          <span className="flex-1 truncate text-xs font-medium">{device.name}</span>

          <DeviceStatusBadge deviceId={device.id} className="shrink-0" />
          <span
            data-testid={`device-online-status-${device.id}`}
            data-online={isOnline}
            aria-label={isOnline ? t('device.connected') : t('device.disconnected')}
            title={isOnline ? t('device.connected') : t('device.disconnected')}
            className={cn(
              'h-2 w-2 shrink-0 rounded-full',
              isOnline ? 'bg-emerald-500' : 'bg-gray-400'
            )}
          />
          <button
            type="button"
            data-testid={`device-expand-${device.id}`}
            aria-expanded={isExpanded}
            aria-label={isExpanded ? t('common.collapse') : t('common.expand')}
            title={isExpanded ? t('common.collapse') : t('common.expand')}
            onClick={() => onExpandedChange(device.id, !isExpanded)}
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground [@media(any-pointer:coarse)]:h-9 [@media(any-pointer:coarse)]:w-9"
          >
            <ChevronRight
              className={cn('h-3.5 w-3.5 transition-transform', isExpanded && 'rotate-90')}
            />
          </button>
        </div>
      </div>

      {isExpanded && (
        <div
          data-testid={`device-tree-${device.id}`}
          className="space-y-1.5 py-1.5 pr-1.5 pl-10 [@media(any-pointer:coarse)]:space-y-2"
        >
          {!windows && (
            <div className="text-xs text-muted-foreground px-2 py-1.5 text-center">
              {t('common.loading')}
            </div>
          )}

          {windows?.length === 0 && (
            <div className="text-xs text-muted-foreground px-2 py-1.5 text-center">
              {t('window.noWindows')}
            </div>
          )}

          {windows && windows.length > 0 && (
            <DndContext
              sensors={windowSensors}
              collisionDetection={closestCenter}
              onDragEnd={handleWindowDragEnd}
            >
              <SortableContext
                items={windows.map((w) => w.id)}
                strategy={verticalListSortingStrategy}
              >
                {windows.map((window) => (
                  <WindowItem
                    key={window.id}
                    deviceId={device.id}
                    window={window}
                    isDeviceSelected={isSelected}
                    selectedWindowId={selectedWindowId}
                    selectedPaneId={selectedPaneId}
                    onPaneClick={onPaneClick}
                    onWindowClick={onWindowClick}
                    onCloseWindow={onCloseWindow}
                    onClosePane={onClosePane}
                    onRenameWindow={onRenameWindow}
                    onRenamePane={onRenamePane}
                    onWatchPane={onWatchPane}
                    agent={agent}
                    nav={nav}
                  />
                ))}
              </SortableContext>
            </DndContext>
          )}

          {/* New Window Button */}
          <button
            type="button"
            data-testid={`window-create-${device.id}`}
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={() => onCreateWindow(device.id)}
            className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left transition-colors text-muted-foreground hover:text-foreground hover:bg-accent/30 border border-dashed border-border/50 hover:border-border"
          >
            <Plus className="h-3.5 w-3.5 shrink-0" />
            <span className="text-xs">{t('window.new')}</span>
          </button>
        </div>
      )}
    </div>
  );
}

interface WindowItemProps {
  deviceId: string;
  window: TmuxWindow;
  isDeviceSelected: boolean;
  selectedWindowId?: string;
  selectedPaneId?: string;
  onPaneClick: (deviceId: string, windowId: string, paneId: string) => void;
  onWindowClick: (deviceId: string, windowId: string, panes: TmuxPane[]) => void;
  onCloseWindow: (deviceId: string, windowId: string) => void;
  onClosePane: (deviceId: string, windowId: string, paneId: string) => void;
  onRenameWindow: (deviceId: string, windowId: string) => void;
  onRenamePane: (deviceId: string, paneId: string) => void;
  onWatchPane: (deviceId: string, paneId: string) => void;
  agent?: SidebarAgentAdapter;
  nav: DeviceTreeNavigation;
}

function WindowItem({
  deviceId,
  window,
  isDeviceSelected,
  selectedWindowId,
  selectedPaneId,
  onPaneClick,
  onWindowClick,
  onCloseWindow,
  onClosePane,
  onRenameWindow,
  onRenamePane,
  onWatchPane,
  agent,
  nav,
}: WindowItemProps) {
  const { t } = useTranslation();
  const { isMobile } = useSidebar();
  const { stores, features } = useRuntime();
  const hasMultiplePanes = window.panes.length > 1;
  const titleParts = buildWindowTitleParts(window);
  const activePane = window.panes.find((p) => p.active) ?? window.panes[0];
  const activePaneCwd = activePane?.currentPath;

  const selectedPaneInWindow = window.panes.find((pane) => pane.id === selectedPaneId);
  const isPaneSelected =
    isDeviceSelected && window.id === selectedWindowId && Boolean(selectedPaneInWindow);

  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: window.id });

  const paneSensors = useDeviceTreeSensors();
  const handlePaneDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const ids = window.panes.map((p) => p.id);
    const oldIndex = ids.indexOf(String(active.id));
    const newIndex = ids.indexOf(String(over.id));
    if (oldIndex < 0 || newIndex < 0) return;
    stores.tmux.getState().reorderPanes(deviceId, window.id, arrayMove(ids, oldIndex, newIndex));
  };

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn('space-y-1', isDragging && 'opacity-60')}
    >
      {/* Window Header - Clickable */}
      <div className="group relative flex items-center gap-1">
        <button
          type="button"
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          aria-label={t('window.dragHandle')}
          onClick={(e) => e.stopPropagation()}
          className={cn(
            'touch-none cursor-grab shrink-0 flex items-center justify-center text-muted-foreground/50 hover:text-muted-foreground opacity-100',
            isMobile
              ? 'h-9 w-4'
              : 'h-6 w-3.5 [@media(any-pointer:coarse)]:h-9 [@media(any-pointer:coarse)]:w-4'
          )}
        >
          <GripVertical className={cn(isMobile ? 'h-4 w-4' : 'h-3.5 w-3.5')} />
        </button>
        <button
          type="button"
          onClick={() => onWindowClick(deviceId, window.id, window.panes)}
          data-testid={`window-item-${window.id}`}
          data-active={isPaneSelected ? 'true' : undefined}
          className={cn(
            'flex-1 min-w-0 flex items-center gap-2 px-2 py-1.5 rounded-lg text-left transition-colors pr-7 [@media(any-pointer:coarse)]:py-2.5 [@media(any-pointer:coarse)]:pr-12',
            isMobile && 'py-2.5 pr-13',
            isPaneSelected ? 'bg-primary/10 text-primary' : 'hover:bg-accent/50 text-foreground'
          )}
        >
          <WindowBellIcon paneIds={window.panes.map((p) => p.id)} />

          {hasMultiplePanes ? (
            // 多 pane 窗口：窗口行只做分组标识，标题/进程细节由各 pane 行完整呈现
            <span className="flex-1 min-w-0 font-mono text-[10.5px] leading-tight text-muted-foreground">
              {t('window.paneCount', { count: window.panes.length })}
            </span>
          ) : (
            <span className="flex-1 min-w-0">
              <span className="font-mono text-[11px] leading-tight font-medium line-clamp-2 [overflow-wrap:break-word]">
                {titleParts.title}
              </span>
              {titleParts.processName && (
                <span className="font-mono text-[10.5px] leading-tight text-muted-foreground line-clamp-1 break-all">
                  {activePaneCwd
                    ? `${titleParts.processName}@${activePaneCwd}`
                    : titleParts.processName}
                </span>
              )}
            </span>
          )}
        </button>

        {/* Window Actions Menu - positioned absolutely；多 pane 窗口的操作全部下放到各 pane 行 */}
        {!hasMultiplePanes && (
          <DropdownMenu>
            <DropdownMenuTrigger
              data-testid={`window-menu-${window.id}`}
              aria-label={t('window.menu')}
              title={t('window.menu')}
              className={cn(
                'absolute top-1/2 -translate-y-1/2 flex items-center justify-center rounded text-muted-foreground hover:bg-background hover:text-foreground transition-opacity data-popup-open:opacity-100',
                isMobile
                  ? 'h-11 w-11 right-0 rounded-lg bg-background/40 opacity-100'
                  : 'h-5 w-5 right-1.5 [@media(any-pointer:coarse)]:h-10 [@media(any-pointer:coarse)]:w-10 [@media(any-pointer:coarse)]:right-0.5 [@media(any-pointer:coarse)]:rounded-lg',
                isPaneSelected
                  ? 'opacity-100'
                  : 'opacity-0 group-hover:opacity-100 [@media(any-pointer:coarse)]:opacity-100'
              )}
            >
              <EllipsisVertical
                className={cn(
                  isMobile
                    ? 'h-5 w-5'
                    : 'h-3.5 w-3.5 [@media(any-pointer:coarse)]:h-4.5 [@media(any-pointer:coarse)]:w-4.5'
                )}
              />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              backdrop
              className="w-auto min-w-36 [@media(any-pointer:coarse)]:min-w-48"
            >
              <DropdownMenuItem
                data-testid={`window-menu-rename-${window.id}`}
                className={cn(
                  '[@media(any-pointer:coarse)]:py-2.5 [@media(any-pointer:coarse)]:px-2',
                  isMobile && 'py-3 px-2.5 text-base gap-2.5'
                )}
                onClick={() => onRenameWindow(deviceId, window.id)}
              >
                <Pencil className={cn('h-4 w-4', isMobile && 'h-5 w-5')} />
                {t('window.rename')}
              </DropdownMenuItem>
              {agent && (
                <DropdownMenuItem
                  data-testid={`window-menu-new-session-${window.id}`}
                  className={cn(
                    '[@media(any-pointer:coarse)]:py-2.5 [@media(any-pointer:coarse)]:px-2',
                    isMobile && 'py-3 px-2.5 text-base gap-2.5'
                  )}
                  onClick={() =>
                    agent.onCreateSessionForPane(
                      nav,
                      deviceId,
                      window.id,
                      selectedPaneInWindow || window.panes[0]
                    )
                  }
                >
                  <Plus className={cn('h-4 w-4', isMobile && 'h-5 w-5')} />
                  {t('agent.session.new')}
                </DropdownMenuItem>
              )}
              {activePaneCwd && (
                <DropdownMenuItem
                  className={cn(
                    '[@media(any-pointer:coarse)]:py-2.5 [@media(any-pointer:coarse)]:px-2',
                    isMobile && 'py-3 px-2.5 text-base gap-2.5'
                  )}
                  onClick={() =>
                    stores.tmux.getState().createWindow(deviceId, undefined, activePaneCwd)
                  }
                >
                  <FolderOpen className={cn('h-4 w-4', isMobile && 'h-5 w-5')} />
                  {t('window.newInCwd')}
                </DropdownMenuItem>
              )}
              {activePane && (
                <>
                  <DropdownMenuItem
                    data-testid={`window-menu-split-right-${window.id}`}
                    className={cn(
                      '[@media(any-pointer:coarse)]:py-2.5 [@media(any-pointer:coarse)]:px-2',
                      isMobile && 'py-3 px-2.5 text-base gap-2.5'
                    )}
                    onClick={() =>
                      stores.tmux
                        .getState()
                        .splitPane(deviceId, activePane.id, 'right', activePane.currentPath)
                    }
                  >
                    <SquareSplitHorizontal className={cn('h-4 w-4', isMobile && 'h-5 w-5')} />
                    {t('window.splitRight')}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    data-testid={`window-menu-split-down-${window.id}`}
                    className={cn(
                      '[@media(any-pointer:coarse)]:py-2.5 [@media(any-pointer:coarse)]:px-2',
                      isMobile && 'py-3 px-2.5 text-base gap-2.5'
                    )}
                    onClick={() =>
                      stores.tmux
                        .getState()
                        .splitPane(deviceId, activePane.id, 'down', activePane.currentPath)
                    }
                  >
                    <SquareSplitVertical className={cn('h-4 w-4', isMobile && 'h-5 w-5')} />
                    {t('window.splitDown')}
                  </DropdownMenuItem>
                  {features.watchUi && (
                    <DropdownMenuItem
                      data-testid={`window-menu-watch-${window.id}`}
                      className={cn(
                        '[@media(any-pointer:coarse)]:py-2.5 [@media(any-pointer:coarse)]:px-2',
                        isMobile && 'py-3 px-2.5 text-base gap-2.5'
                      )}
                      onClick={() => onWatchPane(deviceId, activePane.id)}
                    >
                      <Radar className={cn('h-4 w-4', isMobile && 'h-5 w-5')} />
                      {t('watch.openMonitor')}
                    </DropdownMenuItem>
                  )}
                </>
              )}
              <DropdownMenuItem
                variant="destructive"
                data-testid={`window-menu-close-${window.id}`}
                className={cn(
                  '[@media(any-pointer:coarse)]:py-2.5 [@media(any-pointer:coarse)]:px-2',
                  isMobile && 'py-3 px-2.5 text-base gap-2.5'
                )}
                onClick={() => onCloseWindow(deviceId, window.id)}
              >
                <X className={cn('h-4 w-4', isMobile && 'h-5 w-5')} />
                {t('window.close')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {/* Panes List - Only show if window has multiple panes */}
      {hasMultiplePanes && (
        <div className="ml-4 pl-2 border-l border-border/50 space-y-1 [@media(any-pointer:coarse)]:space-y-1.5">
          <DndContext
            sensors={paneSensors}
            collisionDetection={closestCenter}
            onDragEnd={handlePaneDragEnd}
          >
            <SortableContext
              items={window.panes.map((p) => p.id)}
              strategy={verticalListSortingStrategy}
            >
              {window.panes.map((pane) => (
                <PaneRow
                  key={pane.id}
                  deviceId={deviceId}
                  windowId={window.id}
                  pane={pane}
                  isActive={isPaneSelected && pane.id === selectedPaneId}
                  isMobile={isMobile}
                  onPaneClick={onPaneClick}
                  onClosePane={onClosePane}
                  onRenamePane={onRenamePane}
                  onWatchPane={onWatchPane}
                  agent={agent}
                  nav={nav}
                />
              ))}
            </SortableContext>
          </DndContext>
        </div>
      )}

      {/* 单 pane 窗口不渲染 pane 列表，会话挂在窗口节点下 */}
      {!hasMultiplePanes && window.panes[0] && agent && (
        <div className="ml-[36px] pl-2 border-l border-border/50">
          <agent.PaneSessions nav={nav} deviceId={deviceId} paneId={window.panes[0].id} />
        </div>
      )}
    </div>
  );
}

function PaneRow({
  deviceId,
  windowId,
  pane,
  isActive,
  isMobile,
  onPaneClick,
  onClosePane,
  onRenamePane,
  onWatchPane,
  agent,
  nav,
}: {
  deviceId: string;
  windowId: string;
  pane: TmuxPane;
  isActive: boolean;
  isMobile: boolean;
  onPaneClick: (deviceId: string, windowId: string, paneId: string) => void;
  onClosePane: (deviceId: string, windowId: string, paneId: string) => void;
  onRenamePane: (deviceId: string, paneId: string) => void;
  onWatchPane: (deviceId: string, paneId: string) => void;
  agent?: SidebarAgentAdapter;
  nav: DeviceTreeNavigation;
}) {
  const { t } = useTranslation();
  const { stores, features } = useRuntime();
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: pane.id });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(isDragging && 'opacity-60')}
    >
      {/* 菜单/关闭按钮的 absolute 锚点必须只包住 pane 行本身；
          若锚在外层（含 PaneSessionBranch），挂了 Agent session 后 top-1/2 会随容器撑高而错位 */}
      <div className="group/pane relative flex items-center gap-1">
        <button
          type="button"
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          aria-label={t('window.dragHandlePane')}
          onClick={(e) => e.stopPropagation()}
          className={cn(
            'touch-none cursor-grab shrink-0 flex items-center justify-center text-muted-foreground/50 hover:text-muted-foreground opacity-100',
            isMobile
              ? 'h-9 w-4'
              : 'h-6 w-3 [@media(any-pointer:coarse)]:h-9 [@media(any-pointer:coarse)]:w-4'
          )}
        >
          <GripVertical className={cn(isMobile ? 'h-4 w-4' : 'h-3 w-3')} />
        </button>
        <button
          type="button"
          onClick={() => onPaneClick(deviceId, windowId, pane.id)}
          data-testid={`pane-item-${pane.id}`}
          data-active={isActive ? 'true' : undefined}
          className={cn(
            'flex-1 min-w-0 flex items-center gap-2 px-2 py-1 rounded-lg text-left transition-colors pr-13 [@media(any-pointer:coarse)]:py-2 [@media(any-pointer:coarse)]:pr-21',
            isMobile && 'py-2.5 pr-24',
            isActive ? 'bg-primary/10 text-primary' : 'hover:bg-accent/30 text-muted-foreground'
          )}
        >
          <PaneBellIcon paneId={pane.id} />
          {/* 多 pane 窗口的窗口行不再展示细节，pane 行呈现完整的标题 + 进程@路径 */}
          <span className="flex-1 min-w-0">
            <span className="font-mono text-[11px] leading-tight font-medium line-clamp-2 [overflow-wrap:break-word]">
              {pane.customName || pane.title || t('window.pane')}
            </span>
            {pane.currentCommand && (
              <span className="font-mono text-[10.5px] leading-tight text-muted-foreground line-clamp-1 break-all">
                {pane.currentPath
                  ? `${pane.currentCommand}@${pane.currentPath}`
                  : pane.currentCommand}
              </span>
            )}
          </span>
        </button>

        {/* Pane Actions Menu */}
        <DropdownMenu>
          <DropdownMenuTrigger
            data-testid={`pane-menu-${pane.id}`}
            aria-label={t('window.paneMenu')}
            className={cn(
              'absolute top-1/2 -translate-y-1/2 flex items-center justify-center rounded text-muted-foreground hover:bg-background hover:text-foreground transition-opacity data-popup-open:opacity-100',
              isMobile
                ? 'h-11 w-11 right-11 rounded-lg bg-background/40 opacity-100'
                : 'h-5 w-5 right-7 [@media(any-pointer:coarse)]:h-10 [@media(any-pointer:coarse)]:w-10 [@media(any-pointer:coarse)]:right-10.5 [@media(any-pointer:coarse)]:rounded-lg',
              isActive
                ? 'opacity-100'
                : 'opacity-0 group-hover/pane:opacity-100 [@media(any-pointer:coarse)]:opacity-100'
            )}
          >
            <EllipsisVertical className={cn(isMobile ? 'h-5 w-5' : 'h-3.5 w-3.5')} />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            backdrop
            className="w-auto min-w-36 [@media(any-pointer:coarse)]:min-w-48"
          >
            <DropdownMenuItem
              data-testid={`pane-menu-rename-${pane.id}`}
              className={cn(
                '[@media(any-pointer:coarse)]:py-2.5 [@media(any-pointer:coarse)]:px-2',
                isMobile && 'py-3 px-2.5 text-base gap-2.5'
              )}
              onClick={() => onRenamePane(deviceId, pane.id)}
            >
              <Pencil className={cn('h-4 w-4', isMobile && 'h-5 w-5')} />
              {t('window.rename')}
            </DropdownMenuItem>
            {agent && (
              <DropdownMenuItem
                data-testid={`pane-menu-new-session-${pane.id}`}
                className={cn(
                  '[@media(any-pointer:coarse)]:py-2.5 [@media(any-pointer:coarse)]:px-2',
                  isMobile && 'py-3 px-2.5 text-base gap-2.5'
                )}
                onClick={() => agent.onCreateSessionForPane(nav, deviceId, windowId, pane)}
              >
                <Plus className={cn('h-4 w-4', isMobile && 'h-5 w-5')} />
                {t('agent.session.new')}
              </DropdownMenuItem>
            )}
            {pane.currentPath && (
              <DropdownMenuItem
                className={cn(
                  '[@media(any-pointer:coarse)]:py-2.5 [@media(any-pointer:coarse)]:px-2',
                  isMobile && 'py-3 px-2.5 text-base gap-2.5'
                )}
                onClick={() =>
                  stores.tmux.getState().createWindow(deviceId, undefined, pane.currentPath)
                }
              >
                <FolderOpen className={cn('h-4 w-4', isMobile && 'h-5 w-5')} />
                {t('window.newInCwd')}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              data-testid={`pane-split-right-${pane.id}`}
              className={cn(
                '[@media(any-pointer:coarse)]:py-2.5 [@media(any-pointer:coarse)]:px-2',
                isMobile && 'py-3 px-2.5 text-base gap-2.5'
              )}
              onClick={() =>
                stores.tmux.getState().splitPane(deviceId, pane.id, 'right', pane.currentPath)
              }
            >
              <SquareSplitHorizontal className={cn('h-4 w-4', isMobile && 'h-5 w-5')} />
              {t('window.splitRight')}
            </DropdownMenuItem>
            <DropdownMenuItem
              data-testid={`pane-split-down-${pane.id}`}
              className={cn(
                '[@media(any-pointer:coarse)]:py-2.5 [@media(any-pointer:coarse)]:px-2',
                isMobile && 'py-3 px-2.5 text-base gap-2.5'
              )}
              onClick={() =>
                stores.tmux.getState().splitPane(deviceId, pane.id, 'down', pane.currentPath)
              }
            >
              <SquareSplitVertical className={cn('h-4 w-4', isMobile && 'h-5 w-5')} />
              {t('window.splitDown')}
            </DropdownMenuItem>
            {features.watchUi && (
              <DropdownMenuItem
                data-testid={`pane-watch-${pane.id}`}
                className={cn(
                  '[@media(any-pointer:coarse)]:py-2.5 [@media(any-pointer:coarse)]:px-2',
                  isMobile && 'py-3 px-2.5 text-base gap-2.5'
                )}
                onClick={() => onWatchPane(deviceId, pane.id)}
              >
                <Radar className={cn('h-4 w-4', isMobile && 'h-5 w-5')} />
                {t('watch.openMonitor')}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              variant="destructive"
              data-testid={`pane-menu-close-${pane.id}`}
              className={cn(
                '[@media(any-pointer:coarse)]:py-2.5 [@media(any-pointer:coarse)]:px-2',
                isMobile && 'py-3 px-2.5 text-base gap-2.5'
              )}
              onClick={() => onClosePane(deviceId, windowId, pane.id)}
            >
              <X className={cn('h-4 w-4', isMobile && 'h-5 w-5')} />
              {t('window.closePane')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Close Pane Button */}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onClosePane(deviceId, windowId, pane.id);
          }}
          data-testid={`pane-close-${pane.id}`}
          className={cn(
            'absolute top-1/2 -translate-y-1/2 flex items-center justify-center rounded text-muted-foreground hover:bg-background hover:text-foreground transition-opacity',
            isMobile
              ? 'h-11 w-11 right-0 rounded-lg bg-background/40 opacity-100'
              : 'h-5 w-5 right-1.5 [@media(any-pointer:coarse)]:h-10 [@media(any-pointer:coarse)]:w-10 [@media(any-pointer:coarse)]:right-0.5 [@media(any-pointer:coarse)]:rounded-lg',
            isActive
              ? 'opacity-100'
              : 'opacity-0 group-hover/pane:opacity-100 [@media(any-pointer:coarse)]:opacity-100'
          )}
          title={t('window.closePane')}
        >
          <span className={cn('leading-none', isMobile ? 'text-base' : 'text-xs')}>×</span>
        </button>
      </div>

      {agent && <agent.PaneSessions nav={nav} deviceId={deviceId} paneId={pane.id} />}
    </div>
  );
}
