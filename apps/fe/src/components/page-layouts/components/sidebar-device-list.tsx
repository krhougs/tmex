import { DeviceStatusBadge } from '@/components/device-status-badge';
import { useGlobalDevice } from '@/components/global-device-provider';
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
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { SidebarGroup, useSidebar } from '@/components/ui/sidebar';
import { WatchDialog } from '@/components/watch/watch-dialog';
import { cn } from '@/lib/utils';
import { useAgentStore } from '@/stores/agent';
import { useUIStore } from '@/stores/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AgentSessionDto, Device, TmuxPane, TmuxWindow } from '@tmex/shared';
import { toBCP47 } from '@tmex/shared';
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
import {
  Bot,
  ChevronRight,
  EllipsisVertical,
  Globe,
  GripVertical,
  History,
  Monitor,
  MoreHorizontal,
  Pencil,
  Plus,
  Power,
  PowerOff,
  Radar,
  Trash2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { buildWindowDisplayName, buildWindowTitleParts } from '../../../utils/terminalMeta';

type DeviceListItem = Device & {
  lastError?: string | null;
  lastErrorType?: string | null;
};

type CloseCandidate =
  | { kind: 'window'; deviceId: string; windowId: string; name: string }
  | { kind: 'pane'; deviceId: string; paneId: string; name: string };

interface RenameCandidate {
  deviceId: string;
  windowId: string;
  hasCustomName: boolean;
}
import { useTranslation } from 'react-i18next';
import { matchPath, useLocation, useNavigate } from 'react-router';
import { useSiteStore } from '../../../stores/site';
import { useTmuxStore } from '../../../stores/tmux';
import { decodePaneIdFromUrlParam, encodePaneIdForUrl } from '../../../utils/tmuxUrl';

function StatusDot({ status }: { status: AgentSessionDto['status'] }) {
  return (
    <span
      className={cn(
        'size-2 shrink-0 rounded-full',
        status === 'running'
          ? 'bg-emerald-500 animate-pulse'
          : status === 'error'
            ? 'bg-destructive'
            : status === 'waiting_confirmation'
              ? 'bg-amber-500'
              : 'bg-muted-foreground/40'
      )}
    />
  );
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

export function SideBarDeviceList() {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const { toggleDevice } = useGlobalDevice();

  const agentSessions = useAgentStore((state) => state.sessions);
  const activeSessionId = useAgentStore((state) => state.activeSessionId);
  const setSidebarTab = useUIStore((state) => state.setSidebarTab);

  useEffect(() => {
    const store = useAgentStore.getState();
    store.ensureInitialized();
    void store.loadSessions();
  }, []);

  // Get selected window/pane from URL
  const paneMatch = matchPath(
    '/devices/:deviceId/windows/:windowId/panes/:paneId',
    location.pathname
  );
  const selectedDeviceId = paneMatch?.params.deviceId;
  const selectedWindowId = paneMatch?.params.windowId;
  const selectedPaneId = decodePaneIdFromUrlParam(paneMatch?.params.paneId);

  const snapshots = useTmuxStore((state) => state.snapshots);
  const connectedDevices = useTmuxStore((state) => state.connectedDevices);
  const closeWindow = useTmuxStore((state) => state.closeWindow);
  const closePane = useTmuxStore((state) => state.closePane);
  const renameWindow = useTmuxStore((state) => state.renameWindow);
  const language = useSiteStore((state) => state.settings?.language ?? 'en_US');

  const { data: devicesData } = useQuery({
    queryKey: ['devices'],
    queryFn: async () => {
      const res = await fetch('/api/devices');
      if (!res.ok) throw new Error('Failed to fetch devices');
      return res.json() as Promise<{ devices: DeviceListItem[] }>;
    },
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
    (deviceId: string, windowId: string, paneId: string, options?: { keepSidebarOpen?: boolean }) => {
      // Clear any pending navigation to prevent interference
      pendingNavigationRef.current = null;

      window.dispatchEvent(
        new CustomEvent('tmex:user-initiated-selection', {
          detail: { deviceId, windowId, paneId },
        })
      );
      handleNavigate(
        `/devices/${deviceId}/windows/${windowId}/panes/${encodePaneIdForUrl(paneId)}`,
        { keepSidebarOpen: options?.keepSidebarOpen }
      );
    },
    [handleNavigate]
  );

  const handleSelectSession = useCallback(
    (session: AgentSessionDto) => {
      useAgentStore.getState().setActiveSession(session.id);
      setSidebarTab('agent');
      if (session.deviceId && session.paneId) {
        const windows = useTmuxStore.getState().snapshots[session.deviceId]?.session?.windows;
        const window = windows?.find((w) => w.panes.some((p) => p.id === session.paneId));
        if (window) {
          // Agent 聊天就在侧边栏内：导航到对应 pane 提供上下文，但移动端保持 Sheet 打开
          navigateToPane(session.deviceId, window.id, session.paneId, { keepSidebarOpen: true });
        }
      }
    },
    [setSidebarTab, navigateToPane]
  );

  const handleCreateSessionForPane = useCallback(
    (deviceId: string, windowId: string, pane: TmuxPane) => {
      navigateToPane(deviceId, windowId, pane.id, { keepSidebarOpen: true });
      useAgentStore.getState().startDraft(deviceId, pane.id, pane.title ?? null);
      setSidebarTab('agent');
    },
    [navigateToPane, setSidebarTab]
  );

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

  const handleConnectToggle = useCallback(
    (deviceId: string, isConnected: boolean) => {
      if (isConnected) {
        // If disconnecting the currently selected device, navigate to fallback
        if (deviceId === selectedDeviceId) {
          handleNavigate('/devices');
        }
      } else {
        // Connect and navigate to device page
        handleNavigate(`/devices/${deviceId}`);
      }
      toggleDevice(deviceId, isConnected);
    },
    [toggleDevice, selectedDeviceId, handleNavigate]
  );

  const handleCloseWindow = useCallback(
    (deviceId: string, windowId: string) => {
      // If closing the currently selected window, navigate to fallback
      if (deviceId === selectedDeviceId && windowId === selectedWindowId) {
        handleNavigate('/devices');
      }
      closeWindow(deviceId, windowId);
    },
    [closeWindow, selectedDeviceId, selectedWindowId, handleNavigate]
  );

  const [closeCandidate, setCloseCandidate] = useState<CloseCandidate | null>(null);

  const requestCloseWindow = useCallback((deviceId: string, windowId: string) => {
    const windows = useTmuxStore.getState().snapshots[deviceId]?.session?.windows;
    const target = windows?.find((w) => w.id === windowId);
    setCloseCandidate({
      kind: 'window',
      deviceId,
      windowId,
      name: target ? buildWindowDisplayName(target) : '',
    });
  }, []);

  const requestClosePane = useCallback((deviceId: string, windowId: string, paneId: string) => {
    const windows = useTmuxStore.getState().snapshots[deviceId]?.session?.windows;
    const pane = windows?.find((w) => w.id === windowId)?.panes?.find((p) => p.id === paneId);
    setCloseCandidate({
      kind: 'pane',
      deviceId,
      paneId,
      name: pane?.title || `Pane ${pane?.index ?? ''}`,
    });
  }, []);

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

  const requestRenameWindow = useCallback((deviceId: string, windowId: string) => {
    const windows = useTmuxStore.getState().snapshots[deviceId]?.session?.windows;
    const target = windows?.find((w) => w.id === windowId);
    if (!target) return;
    setRenameValue(target.customName ?? buildWindowTitleParts(target).title);
    setRenameCandidate({ deviceId, windowId, hasCustomName: Boolean(target.customName) });
  }, []);

  const confirmRename = useCallback(() => {
    if (!renameCandidate) return;
    const trimmed = renameValue.trim();
    if (!trimmed) return;
    renameWindow(renameCandidate.deviceId, renameCandidate.windowId, trimmed);
    setRenameCandidate(null);
  }, [renameCandidate, renameValue, renameWindow]);

  const resetRename = useCallback(() => {
    if (!renameCandidate) return;
    renameWindow(renameCandidate.deviceId, renameCandidate.windowId, '');
    setRenameCandidate(null);
  }, [renameCandidate, renameWindow]);

  const handleCreateWindow = useCallback((deviceId: string) => {
    useTmuxStore.getState().createWindow(deviceId);
  }, []);

  const [watchTarget, setWatchTarget] = useState<{ deviceId: string; paneId: string } | null>(null);

  const requestWatchPane = useCallback((deviceId: string, paneId: string) => {
    setWatchTarget({ deviceId, paneId });
  }, []);

  const [sessionRenameCandidate, setSessionRenameCandidate] = useState<AgentSessionDto | null>(
    null
  );
  const [sessionRenameValue, setSessionRenameValue] = useState('');
  const [sessionDeleteCandidate, setSessionDeleteCandidate] = useState<AgentSessionDto | null>(
    null
  );

  const requestRenameSession = useCallback((session: AgentSessionDto) => {
    setSessionRenameValue(session.title);
    setSessionRenameCandidate(session);
  }, []);

  const confirmRenameSession = useCallback(() => {
    if (!sessionRenameCandidate) return;
    const trimmed = sessionRenameValue.trim();
    if (!trimmed) return;
    void useAgentStore.getState().renameSession(sessionRenameCandidate.id, trimmed);
    setSessionRenameCandidate(null);
  }, [sessionRenameCandidate, sessionRenameValue]);

  const requestDeleteSession = useCallback((session: AgentSessionDto) => {
    setSessionDeleteCandidate(session);
  }, []);

  const confirmDeleteSession = useCallback(() => {
    if (!sessionDeleteCandidate) return;
    void useAgentStore.getState().deleteSession(sessionDeleteCandidate.id);
    setSessionDeleteCandidate(null);
  }, [sessionDeleteCandidate]);

  const queryClient = useQueryClient();
  const deviceSensors = useDeviceTreeSensors();

  const reorderDevicesMutation = useMutation({
    mutationFn: async (deviceIds: string[]) => {
      const res = await fetch('/api/devices/order', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceIds }),
      });
      if (!res.ok) throw new Error('Failed to reorder devices');
      return res.json() as Promise<{ devices: DeviceListItem[] }>;
    },
    onMutate: async (deviceIds: string[]) => {
      await queryClient.cancelQueries({ queryKey: ['devices'] });
      const previous = queryClient.getQueryData<{ devices: DeviceListItem[] }>(['devices']);
      if (previous) {
        const byId = new Map(previous.devices.map((d) => [d.id, d]));
        const reordered = deviceIds
          .map((id, index) => {
            const d = byId.get(id);
            return d ? { ...d, sortOrder: index } : undefined;
          })
          .filter((d): d is DeviceListItem => d !== undefined);
        const rest = previous.devices.filter((d) => !deviceIds.includes(d.id));
        queryClient.setQueryData(['devices'], { devices: [...reordered, ...rest] });
      }
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(['devices'], context.previous);
      toast.error(t('device.reorderFailed'));
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['devices'] });
    },
  });

  const devices = devicesData?.devices ?? [];
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

  // 会话按 device:pane 分组挂到对应 pane 节点；设备缺失/不在列表的归为孤立
  const { sessionsByPane, orphanSessions } = useMemo(() => {
    const knownDeviceIds = new Set(devices.map((device) => device.id));
    const byPane = new Map<string, AgentSessionDto[]>();
    const orphans: AgentSessionDto[] = [];
    const ordered = Object.values(agentSessions)
      .filter((session): session is AgentSessionDto => Boolean(session))
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    for (const session of ordered) {
      if (!session.deviceId || !session.paneId || !knownDeviceIds.has(session.deviceId)) {
        orphans.push(session);
        continue;
      }
      const key = `${session.deviceId}:${session.paneId}`;
      const list = byPane.get(key);
      if (list) list.push(session);
      else byPane.set(key, [session]);
    }
    return { sessionsByPane: byPane, orphanSessions: orphans };
  }, [agentSessions, devices]);

  return (
    <SidebarGroup className="flex flex-col flex-1 min-h-0 pt-0">
      <DndContext
        sensors={deviceSensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDeviceDragEnd}
      >
        <ScrollArea className="flex-1 min-h-0">
          <div className="space-y-1.5 pb-2 pt-1">
            <SortableContext
              items={sortedDevices.map((d) => d.id)}
              strategy={verticalListSortingStrategy}
            >
              {sortedDevices.map((device) => (
                <DeviceSection
                  key={device.id}
                  device={device}
              windows={snapshots[device.id]?.session?.windows ?? null}
              isConnected={connectedDevices.has(device.id)}
              isSelected={device.id === selectedDeviceId}
              selectedWindowId={selectedWindowId}
              selectedPaneId={selectedPaneId}
              onConnectToggle={() =>
                handleConnectToggle(device.id, connectedDevices.has(device.id))
              }
              onCreateWindow={handleCreateWindow}
              onCloseWindow={requestCloseWindow}
              onClosePane={requestClosePane}
              onRenameWindow={requestRenameWindow}
              onPaneClick={navigateToPane}
              onWindowClick={navigateToWindow}
              onWatchPane={requestWatchPane}
              sessionsByPane={sessionsByPane}
              activeSessionId={activeSessionId}
              onSelectSession={handleSelectSession}
              onCreateSessionForPane={handleCreateSessionForPane}
              onRenameSession={requestRenameSession}
              onDeleteSession={requestDeleteSession}
                />
              ))}
            </SortableContext>
            {sortedDevices.length === 0 && (
              <div className="text-center text-sm text-muted-foreground py-4">
                {t('sidebar.noDevices')}
              </div>
            )}

            {orphanSessions.length > 0 && (
              <OrphanSessions
                sessions={orphanSessions}
                activeSessionId={activeSessionId}
                onSelectSession={handleSelectSession}
                onRenameSession={requestRenameSession}
                onDeleteSession={requestDeleteSession}
              />
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

      <Dialog
        open={sessionRenameCandidate !== null}
        onOpenChange={(open) => !open && setSessionRenameCandidate(null)}
      >
        <DialogContent data-testid="agent-session-rename-dialog">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              confirmRenameSession();
            }}
          >
            <DialogHeader>
              <DialogTitle>{t('agent.session.renameTitle')}</DialogTitle>
            </DialogHeader>
            <div className="py-4">
              <Input
                autoFocus
                maxLength={120}
                value={sessionRenameValue}
                onChange={(e) => setSessionRenameValue(e.target.value)}
                placeholder={t('agent.session.renamePlaceholder')}
                data-testid="agent-session-rename-input"
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setSessionRenameCandidate(null)}
              >
                {t('agent.session.cancel')}
              </Button>
              <Button
                type="submit"
                disabled={!sessionRenameValue.trim()}
                data-testid="agent-session-rename-save"
              >
                {t('agent.session.save')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={sessionDeleteCandidate !== null}
        onOpenChange={(open) => !open && setSessionDeleteCandidate(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia className="bg-destructive/10">
              <X className="h-5 w-5 text-destructive" />
            </AlertDialogMedia>
            <AlertDialogTitle>{t('agent.session.deleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('agent.session.deleteDesc', { title: sessionDeleteCandidate?.title ?? '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={!sessionDeleteCandidate}
              onClick={confirmDeleteSession}
              data-testid="agent-session-delete-confirm"
            >
              {t('agent.session.deleteConfirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {watchTarget && (
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
  isConnected: boolean;
  isSelected: boolean;
  selectedWindowId?: string;
  selectedPaneId?: string;
  onConnectToggle: () => void;
  onCreateWindow: (deviceId: string) => void;
  onCloseWindow: (deviceId: string, windowId: string) => void;
  onClosePane: (deviceId: string, windowId: string, paneId: string) => void;
  onRenameWindow: (deviceId: string, windowId: string) => void;
  onPaneClick: (deviceId: string, windowId: string, paneId: string) => void;
  onWindowClick: (deviceId: string, windowId: string, panes: TmuxPane[]) => void;
  onWatchPane: (deviceId: string, paneId: string) => void;
  sessionsByPane: Map<string, AgentSessionDto[]>;
  activeSessionId: string | null;
  onSelectSession: (session: AgentSessionDto) => void;
  onCreateSessionForPane: (deviceId: string, windowId: string, pane: TmuxPane) => void;
  onRenameSession: (session: AgentSessionDto) => void;
  onDeleteSession: (session: AgentSessionDto) => void;
}

function DeviceSection({
  device,
  windows,
  isConnected,
  isSelected,
  selectedWindowId,
  selectedPaneId,
  onConnectToggle,
  onCreateWindow,
  onCloseWindow,
  onClosePane,
  onRenameWindow,
  onPaneClick,
  onWindowClick,
  onWatchPane,
  sessionsByPane,
  activeSessionId,
  onSelectSession,
  onCreateSessionForPane,
  onRenameSession,
  onDeleteSession,
}: DeviceSectionProps) {
  const { t } = useTranslation();
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
    useTmuxStore.getState().reorderWindows(device.id, arrayMove(ids, oldIndex, newIndex));
  };

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      data-testid={`device-item-${device.id}`}
      className={cn(
        'group/device rounded-xl border border-border/60 overflow-hidden text-select-none',
        isSelected ? 'bg-card' : isConnected ? 'bg-muted/40' : 'bg-muted/20',
        isDragging && 'opacity-60 shadow-lg'
      )}
      onClick={isConnected ? undefined : onConnectToggle}
    >
      {/* Device Header - Not selectable, just shows status and controls */}
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
            className="touch-none cursor-grab shrink-0 -ml-1 text-muted-foreground/50 hover:text-muted-foreground opacity-0 group-hover/device:opacity-100 [@media(any-pointer:coarse)]:opacity-100"
          >
            <GripVertical className="h-3.5 w-3.5 [@media(any-pointer:coarse)]:h-5 [@media(any-pointer:coarse)]:w-5" />
          </button>
          <DeviceIcon className="h-4 w-4 text-muted-foreground shrink-0" />
          <span className="flex-1 truncate text-xs font-medium text-select-none">
            {device.name}
          </span>

          <DeviceStatusBadge deviceId={device.id} className="shrink-0" />

          {/* Connection Status */}
          <div
            className={cn(
              'h-2 w-2 rounded-full shrink-0',
              isConnected ? 'bg-emerald-500' : 'bg-gray-400'
            )}
          />

          {/* Connect/Disconnect Button */}
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={(e) => {
              e.stopPropagation();
              onConnectToggle();
            }}
            data-testid={
              isConnected ? `device-disconnect-${device.id}` : `device-connect-${device.id}`
            }
            title={isConnected ? t('device.disconnect') : t('device.connect')}
          >
            {isConnected ? (
              <PowerOff className="h-3.5 w-3.5 text-orange-500" />
            ) : (
              <Power className="h-3.5 w-3.5 text-emerald-500" />
            )}
          </Button>
        </div>
      </div>

      {/* Windows List - only show when connected */}
      {isConnected && (
        <div className="p-1.5 space-y-1.5 [@media(any-pointer:coarse)]:space-y-2">
          {!windows && (
            <div className="text-xs text-muted-foreground px-2 py-1.5 text-center">
              {t('device.connecting')}
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
                    isSelected={window.id === selectedWindowId}
                    selectedPaneId={selectedPaneId}
                    onPaneClick={onPaneClick}
                    onWindowClick={onWindowClick}
                    onCloseWindow={onCloseWindow}
                    onClosePane={onClosePane}
                    onRenameWindow={onRenameWindow}
                    onWatchPane={onWatchPane}
                    sessionsByPane={sessionsByPane}
                    activeSessionId={activeSessionId}
                    onSelectSession={onSelectSession}
                    onCreateSessionForPane={onCreateSessionForPane}
                    onRenameSession={onRenameSession}
                    onDeleteSession={onDeleteSession}
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
  isSelected: boolean;
  selectedPaneId?: string;
  onPaneClick: (deviceId: string, windowId: string, paneId: string) => void;
  onWindowClick: (deviceId: string, windowId: string, panes: TmuxPane[]) => void;
  onCloseWindow: (deviceId: string, windowId: string) => void;
  onClosePane: (deviceId: string, windowId: string, paneId: string) => void;
  onRenameWindow: (deviceId: string, windowId: string) => void;
  onWatchPane: (deviceId: string, paneId: string) => void;
  sessionsByPane: Map<string, AgentSessionDto[]>;
  activeSessionId: string | null;
  onSelectSession: (session: AgentSessionDto) => void;
  onCreateSessionForPane: (deviceId: string, windowId: string, pane: TmuxPane) => void;
  onRenameSession: (session: AgentSessionDto) => void;
  onDeleteSession: (session: AgentSessionDto) => void;
}

function WindowItem({
  deviceId,
  window,
  isSelected,
  selectedPaneId,
  onPaneClick,
  onWindowClick,
  onCloseWindow,
  onClosePane,
  onRenameWindow,
  onWatchPane,
  sessionsByPane,
  activeSessionId,
  onSelectSession,
  onCreateSessionForPane,
  onRenameSession,
  onDeleteSession,
}: WindowItemProps) {
  const { t } = useTranslation();
  const { isMobile } = useSidebar();
  const hasMultiplePanes = window.panes.length > 1;
  const titleParts = buildWindowTitleParts(window);

  // Find which pane is selected in this window
  const selectedPaneInWindow = window.panes.find((p) => p.id === selectedPaneId);
  const isPaneSelected = isSelected && Boolean(selectedPaneInWindow);

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
    useTmuxStore.getState().reorderPanes(deviceId, window.id, arrayMove(ids, oldIndex, newIndex));
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
            'touch-none cursor-grab shrink-0 flex items-center justify-center text-muted-foreground/50 hover:text-muted-foreground opacity-0 group-hover:opacity-100 [@media(any-pointer:coarse)]:opacity-100',
            isMobile ? 'h-9 w-4' : 'h-6 w-3.5 [@media(any-pointer:coarse)]:h-9 [@media(any-pointer:coarse)]:w-4'
          )}
        >
          <GripVertical className={cn(isMobile ? 'h-4 w-4' : 'h-3.5 w-3.5')} />
        </button>
        <button
          type="button"
          onClick={() => onWindowClick(deviceId, window.id, window.panes)}
          data-testid={`window-item-${window.id}`}
          className={cn(
            'flex-1 min-w-0 flex items-center gap-2 px-2 py-1.5 rounded-lg text-left transition-colors pr-7 [@media(any-pointer:coarse)]:py-2.5 [@media(any-pointer:coarse)]:pr-12',
            isMobile && 'py-2.5 pr-13',
            isPaneSelected
              ? 'bg-primary/10 text-primary'
              : window.active
                ? 'bg-accent text-accent-foreground'
                : 'hover:bg-accent/50 text-foreground'
          )}
        >
          <Badge
            variant={isPaneSelected ? 'default' : 'outline'}
            className="h-5 text-[10px] px-1.5 shrink-0"
          >
            {window.index}
          </Badge>

          <span className="flex-1 min-w-0">
            <span className="font-mono text-[11px] leading-tight font-medium line-clamp-2 [overflow-wrap:break-word]">
              {titleParts.title}
            </span>
            {titleParts.processName && (
              <span className="font-mono text-[10.5px] leading-tight text-muted-foreground line-clamp-1 break-all">
                {titleParts.processName}
              </span>
            )}
          </span>
        </button>

        {/* Window Actions Menu - positioned absolutely */}
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
            <DropdownMenuItem
              data-testid={`window-menu-new-session-${window.id}`}
              className={cn(
                '[@media(any-pointer:coarse)]:py-2.5 [@media(any-pointer:coarse)]:px-2',
                isMobile && 'py-3 px-2.5 text-base gap-2.5'
              )}
              onClick={() => onCreateSessionForPane(deviceId, window.id, selectedPaneInWindow || window.panes[0])}
            >
              <Plus className={cn('h-4 w-4', isMobile && 'h-5 w-5')} />
              {t('agent.session.new')}
            </DropdownMenuItem>
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
                  isActive={pane.id === selectedPaneId}
                  isMobile={isMobile}
                  onPaneClick={onPaneClick}
                  onClosePane={onClosePane}
                  onWatchPane={onWatchPane}
                  sessions={sessionsByPane.get(`${deviceId}:${pane.id}`)}
                  activeSessionId={activeSessionId}
                  onSelectSession={onSelectSession}
                  onCreateSession={() => onCreateSessionForPane(deviceId, window.id, pane)}
                  onRenameSession={onRenameSession}
                  onDeleteSession={onDeleteSession}
                />
              ))}
            </SortableContext>
          </DndContext>
        </div>
      )}

      {/* 单 pane 窗口不渲染 pane 列表，会话挂在窗口节点下 */}
      {!hasMultiplePanes && window.panes[0] && (
        <div className="ml-[36px] pl-2 border-l border-border/50">
          <PaneSessionBranch
            sessions={sessionsByPane.get(`${deviceId}:${window.panes[0].id}`)}
            activeSessionId={activeSessionId}
            onSelectSession={onSelectSession}
            onRenameSession={onRenameSession}
            onDeleteSession={onDeleteSession}
          />
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
  onWatchPane,
  sessions,
  activeSessionId,
  onSelectSession,
  onCreateSession,
  onRenameSession,
  onDeleteSession,
}: {
  deviceId: string;
  windowId: string;
  pane: TmuxPane;
  isActive: boolean;
  isMobile: boolean;
  onPaneClick: (deviceId: string, windowId: string, paneId: string) => void;
  onClosePane: (deviceId: string, windowId: string, paneId: string) => void;
  onWatchPane: (deviceId: string, paneId: string) => void;
  sessions: AgentSessionDto[] | undefined;
  activeSessionId: string | null;
  onSelectSession: (session: AgentSessionDto) => void;
  onCreateSession: () => void;
  onRenameSession: (session: AgentSessionDto) => void;
  onDeleteSession: (session: AgentSessionDto) => void;
}) {
  const { t } = useTranslation();
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
      className={cn('group relative', isDragging && 'opacity-60')}
    >
      <div className="flex items-center gap-1">
        <button
          type="button"
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          aria-label={t('window.dragHandlePane')}
          onClick={(e) => e.stopPropagation()}
          className={cn(
            'touch-none cursor-grab shrink-0 flex items-center justify-center text-muted-foreground/50 hover:text-muted-foreground opacity-0 group-hover:opacity-100 [@media(any-pointer:coarse)]:opacity-100',
            isMobile ? 'h-9 w-4' : 'h-6 w-3 [@media(any-pointer:coarse)]:h-9 [@media(any-pointer:coarse)]:w-4'
          )}
        >
          <GripVertical className={cn(isMobile ? 'h-4 w-4' : 'h-3 w-3')} />
        </button>
        <button
          type="button"
          onClick={() => onPaneClick(deviceId, windowId, pane.id)}
          data-testid={`pane-item-${pane.id}`}
          className={cn(
            'flex-1 min-w-0 flex items-center gap-2 px-2 py-1 rounded-lg text-left transition-colors pr-13 [@media(any-pointer:coarse)]:py-2 [@media(any-pointer:coarse)]:pr-21',
            isMobile && 'py-2.5 pr-24',
            isActive
              ? 'bg-primary/10 text-primary'
              : pane.active
                ? 'bg-accent text-accent-foreground'
                : 'hover:bg-accent/30 text-muted-foreground'
          )}
        >
          <span className="text-[10px] font-mono opacity-60 w-4">{pane.index}</span>

          <span className="flex-1 text-xs line-clamp-2 break-all">
            {pane.title || `Pane ${pane.index}`}
          </span>
        </button>
      </div>

      {/* Pane Actions Menu */}
      <DropdownMenu>
        <DropdownMenuTrigger
          data-testid={`pane-menu-${pane.id}`}
          aria-label={t('watch.openMonitor')}
          className={cn(
            'absolute top-1/2 -translate-y-1/2 flex items-center justify-center rounded text-muted-foreground hover:bg-background hover:text-foreground transition-opacity data-popup-open:opacity-100',
            isMobile
              ? 'h-11 w-11 right-11 rounded-lg bg-background/40 opacity-100'
              : 'h-5 w-5 right-7 [@media(any-pointer:coarse)]:h-10 [@media(any-pointer:coarse)]:w-10 [@media(any-pointer:coarse)]:right-10.5 [@media(any-pointer:coarse)]:rounded-lg',
            isActive
              ? 'opacity-100'
              : 'opacity-0 group-hover:opacity-100 [@media(any-pointer:coarse)]:opacity-100'
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
            : 'opacity-0 group-hover:opacity-100 [@media(any-pointer:coarse)]:opacity-100'
        )}
        title={t('window.closePane')}
      >
        <span className={cn('leading-none', isMobile ? 'text-base' : 'text-xs')}>×</span>
      </button>

      <PaneSessionBranch
        sessions={sessions}
        activeSessionId={activeSessionId}
        onSelectSession={onSelectSession}
        onRenameSession={onRenameSession}
        onDeleteSession={onDeleteSession}
      />
    </div>
  );
}

function SessionActionsMenu({
  session,
  onRenameSession,
  onDeleteSession,
  className,
  enlargeOnTouch = false,
}: {
  session: AgentSessionDto;
  onRenameSession: (session: AgentSessionDto) => void;
  onDeleteSession: (session: AgentSessionDto) => void;
  className?: string;
  enlargeOnTouch?: boolean;
}) {
  const { t } = useTranslation();
  const { isMobile } = useSidebar();
  const enlarged = enlargeOnTouch && isMobile;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            data-testid={`agent-session-menu-${session.id}`}
            aria-label={t('agent.session.rename')}
            onClick={(e) => e.stopPropagation()}
            className={cn(
              'size-5 shrink-0 text-muted-foreground transition-opacity data-popup-open:opacity-100',
              isMobile
                ? 'opacity-100'
                : 'opacity-0 group-hover:opacity-100 [@media(any-pointer:coarse)]:opacity-100',
              enlarged && 'size-9',
              className
            )}
          />
        }
      >
        <MoreHorizontal className={cn('size-3.5', enlarged && 'size-5')} />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        backdrop
        className="w-auto min-w-36 [@media(any-pointer:coarse)]:min-w-48"
      >
        <DropdownMenuItem
          data-testid="agent-session-rename"
          className={cn(
            '[@media(any-pointer:coarse)]:py-2.5 [@media(any-pointer:coarse)]:px-2',
            isMobile && 'py-3 px-2.5 text-base gap-2.5'
          )}
          onClick={() => onRenameSession(session)}
        >
          <Pencil className={cn('h-4 w-4', isMobile && 'h-5 w-5')} />
          {t('agent.session.rename')}
        </DropdownMenuItem>
        <DropdownMenuItem
          variant="destructive"
          data-testid="agent-session-delete"
          className={cn(
            '[@media(any-pointer:coarse)]:py-2.5 [@media(any-pointer:coarse)]:px-2',
            isMobile && 'py-3 px-2.5 text-base gap-2.5'
          )}
          onClick={() => onDeleteSession(session)}
        >
          <Trash2 className={cn('h-4 w-4', isMobile && 'h-5 w-5')} />
          {t('agent.session.delete')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function PaneSessionBranch({
  sessions,
  activeSessionId,
  onSelectSession,
  onRenameSession,
  onDeleteSession,
}: {
  sessions: AgentSessionDto[] | undefined;
  activeSessionId: string | null;
  onSelectSession: (session: AgentSessionDto) => void;
  onRenameSession: (session: AgentSessionDto) => void;
  onDeleteSession: (session: AgentSessionDto) => void;
}) {
  const { t } = useTranslation();
  const { isMobile } = useSidebar();
  return (
    <div className="mt-1 space-y-0.5 [@media(any-pointer:coarse)]:space-y-1">
      {sessions?.map((session) => {
        const isActive = session.id === activeSessionId;
        return (
          <div key={session.id} className="group relative">
            <button
              type="button"
              data-testid={`agent-session-item-${session.id}`}
              onClick={() => onSelectSession(session)}
              className={cn(
                'w-full flex items-center gap-1.5 px-2 py-1 pr-7 rounded-md text-left transition-colors [@media(any-pointer:coarse)]:min-h-11 [@media(any-pointer:coarse)]:py-2 [@media(any-pointer:coarse)]:pr-12',
                isMobile && 'min-h-11 py-2 pr-12',
                isActive
                  ? 'bg-primary/10 text-primary'
                  : 'hover:bg-accent/30 text-muted-foreground'
              )}
            >
              <Bot className="size-3 shrink-0 opacity-70" />
              <span className="min-w-0 flex-1 truncate text-[11px]">{session.title}</span>
              <StatusDot status={session.status} />
            </button>
            <div className="absolute right-0.5 top-1/2 -translate-y-1/2">
              <SessionActionsMenu
                session={session}
                onRenameSession={onRenameSession}
                onDeleteSession={onDeleteSession}
                enlargeOnTouch
              />
            </div>
          </div>
        );
      }      )}
    </div>
  );
}

function OrphanSessions({
  sessions,
  activeSessionId,
  onSelectSession,
  onRenameSession,
  onDeleteSession,
}: {
  sessions: AgentSessionDto[];
  activeSessionId: string | null;
  onSelectSession: (session: AgentSessionDto) => void;
  onRenameSession: (session: AgentSessionDto) => void;
  onDeleteSession: (session: AgentSessionDto) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const language = useSiteStore((state) => state.settings?.language ?? 'en_US');

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-xl border border-border/60 bg-muted/20">
      <CollapsibleTrigger
        data-testid="agent-orphan-sessions-trigger"
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left"
      >
        <History className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="flex-1 truncate text-xs font-medium text-muted-foreground">
          {t('agent.orphan.title', { count: sessions.length })}
        </span>
        <ChevronRight
          className={cn(
            'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-90'
          )}
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-0.5 px-1.5 pb-1.5">
        {sessions.map((session) => {
          const isActive = session.id === activeSessionId;
          const meta = [
            session.originPaneTitle,
            session.originProcessName,
            session.createdAt
              ? new Date(session.createdAt).toLocaleString(toBCP47(language))
              : null,
          ].filter((value): value is string => Boolean(value));
          return (
            <div key={session.id} className="group relative">
              <button
                type="button"
                data-testid={`agent-orphan-session-${session.id}`}
                onClick={() => onSelectSession(session)}
                className={cn(
                  'w-full flex flex-col gap-0.5 px-2 py-1.5 pr-7 rounded-lg text-left transition-colors',
                  isActive
                    ? 'bg-primary/10 text-primary'
                    : 'hover:bg-accent/30'
                )}
              >
                <span className="flex items-center gap-1.5">
                  <Bot className="size-3 shrink-0 opacity-70" />
                  <span className="min-w-0 flex-1 truncate text-[11px]">{session.title}</span>
                  <StatusDot status={session.status} />
                </span>
                {meta.length > 0 && (
                  <span className="truncate pl-[18px] text-[10px] text-muted-foreground">
                    {meta.join(' · ')}
                  </span>
                )}
              </button>
              <div className="absolute right-0.5 top-1.5">
                <SessionActionsMenu
                  session={session}
                  onRenameSession={onRenameSession}
                  onDeleteSession={onDeleteSession}
                />
              </div>
            </div>
          );
        })}
      </CollapsibleContent>
    </Collapsible>
  );
}
