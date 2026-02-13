import { useQuery } from '@tanstack/react-query';
import type { Device, TmuxPane, TmuxWindow } from '@tmex/shared';
import { toBCP47 } from '@tmex/shared';
import { ChevronDown, ChevronRight, Globe, Monitor, Plus, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { matchPath, useLocation, useNavigate } from 'react-router';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { SidebarGroup, SidebarGroupLabel, useSidebar } from '@/components/ui/sidebar';
import { cn } from '@/lib/utils';
import { useSiteStore } from '../../../stores/site';
import { useTmuxStore } from '../../../stores/tmux';
import { decodePaneIdFromUrlParam, encodePaneIdForUrl } from '../../../utils/tmuxUrl';

export function SideBarDeviceList() {
  const { t } = useTranslation();
  const location = useLocation();
  const paneMatch = matchPath('/devices/:deviceId/windows/:windowId/panes/:paneId', location.pathname);
  const deviceMatch = matchPath('/devices/:deviceId', location.pathname);
  const selectedDeviceId = paneMatch?.params.deviceId ?? deviceMatch?.params.deviceId;
  const selectedWindowId = paneMatch?.params.windowId;
  const selectedPaneId = decodePaneIdFromUrlParam(paneMatch?.params.paneId);

  const [expandedDevices, setExpandedDevices] = useState<Set<string>>(new Set());
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const snapshots = useTmuxStore((state) => state.snapshots);
  const connectDevice = useTmuxStore((state) => state.connectDevice);
  const disconnectDevice = useTmuxStore((state) => state.disconnectDevice);
  const createWindow = useTmuxStore((state) => state.createWindow);
  const closeWindow = useTmuxStore((state) => state.closeWindow);
  const closePane = useTmuxStore((state) => state.closePane);
  const selectWindow = useTmuxStore((state) => state.selectWindow);
  const deviceConnected = useTmuxStore((state) => state.deviceConnected);
  const language = useSiteStore((state) => state.settings?.language ?? 'en_US');

  const { data: devicesData } = useQuery({
    queryKey: ['devices'],
    queryFn: async () => {
      const res = await fetch('/api/devices');
      if (!res.ok) throw new Error('Failed to fetch devices');
      return res.json() as Promise<{ devices: Device[] }>;
    },
    throwOnError: false,
  });

  const handleNavigate = useCallback((to: string) => {
    navigate(to);
    if (isMobile) setOpenMobile(false);
  }, [navigate, isMobile, setOpenMobile]);

  const toggleDevice = useCallback((deviceId: string) => {
    setExpandedDevices((prev) => {
      const next = new Set(prev);
      if (next.has(deviceId)) {
        next.delete(deviceId);
        if (deviceId !== selectedDeviceId) disconnectDevice(deviceId, 'sidebar');
      } else {
        next.add(deviceId);
        connectDevice(deviceId, 'sidebar');
      }
      return next;
    });
  }, [connectDevice, disconnectDevice, selectedDeviceId]);

  const handleDeviceClick = useCallback((deviceId: string) => handleNavigate(`/devices/${deviceId}`), [handleNavigate]);

  const navigateToPane = useCallback((deviceId: string, windowId: string, paneId: string) =>
    handleNavigate(`/devices/${deviceId}/windows/${windowId}/panes/${encodePaneIdForUrl(paneId)}`), [handleNavigate]);

  const handleWindowClick = useCallback((deviceId: string, windowId: string, panes: TmuxPane[]) => {
    const targetPane = panes.find((p) => p.active) ?? panes[0];
    if (targetPane) navigateToPane(deviceId, windowId, targetPane.id);
    else selectWindow(deviceId, windowId);
  }, [navigateToPane, selectWindow]);

  useEffect(() => {
    if (selectedDeviceId && !expandedDevices.has(selectedDeviceId)) {
      setExpandedDevices((prev) => new Set(prev).add(selectedDeviceId));
      if (!paneMatch?.params.deviceId) connectDevice(selectedDeviceId, 'sidebar');
    }
  }, [selectedDeviceId, expandedDevices, connectDevice, paneMatch?.params.deviceId]);

  const devices = devicesData?.devices ?? [];
  const sortedDevices = useMemo(() => [...devices].sort((a, b) =>
    a.name.localeCompare(b.name, toBCP47(language), { numeric: true, sensitivity: 'base' })), [devices, language]);

  return (
    <SidebarGroup>
      <SidebarGroupLabel>{t('device.devices')}</SidebarGroupLabel>
      <ScrollArea className="flex-1">
        <div className="space-y-1 p-2">
          {sortedDevices.map((device) => (
            <DeviceItem key={device.id} device={device} isExpanded={expandedDevices.has(device.id)}
              isSelected={device.id === selectedDeviceId} selectedWindowId={selectedWindowId} selectedPaneId={selectedPaneId}
              windows={snapshots[device.id]?.session?.windows ?? null} isConnected={deviceConnected[device.id] ?? false}
              onToggle={() => toggleDevice(device.id)} onSelect={() => handleDeviceClick(device.id)}
              onCreateWindow={() => createWindow(device.id)} onCloseWindow={closeWindow} onClosePane={closePane}
              onPaneClick={navigateToPane} onWindowClick={handleWindowClick} />
          ))}
          {sortedDevices.length === 0 && <div className="text-center text-sm text-muted-foreground py-4">{t('sidebar.noDevices')}</div>}
        </div>
      </ScrollArea>
    </SidebarGroup>
  );
}

interface DeviceItemProps {
  device: Device; isExpanded: boolean; isSelected: boolean; selectedWindowId?: string; selectedPaneId?: string;
  windows: TmuxWindow[] | null; isConnected: boolean; onToggle: () => void; onSelect: () => void;
  onCreateWindow: () => void; onCloseWindow: (d: string, w: string) => void; onClosePane: (d: string, w: string, p: string, n: number) => void;
  onPaneClick: (d: string, w: string, p: string) => void; onWindowClick: (d: string, w: string, panes: TmuxPane[]) => void;
}

function DeviceItem({ device, isExpanded, isSelected, selectedWindowId, selectedPaneId, windows, isConnected, onToggle, onSelect, onCreateWindow, onCloseWindow, onClosePane, onPaneClick, onWindowClick }: DeviceItemProps) {
  const DeviceIcon = device.type === 'local' ? Monitor : Globe;
  const hasSelectedPane = isSelected && Boolean(selectedPaneId);
  const selectedWindow = hasSelectedPane ? windows?.find((w) => w.id === selectedWindowId) : undefined;
  const selectedPaneInWindow = hasSelectedPane ? selectedWindow?.panes.find((p) => p.id === selectedPaneId) : undefined;
  const isTreeSelected = hasSelectedPane && Boolean(selectedPaneInWindow);

  return (
    <div className="rounded-lg border border-transparent bg-sidebar/60">
      <div className={cn('group rounded-lg border px-1.5 py-1', isTreeSelected && 'border-primary/50 bg-primary/10', !isTreeSelected && isSelected && 'border-sidebar-border bg-sidebar-accent/60', !isSelected && 'hover:border-sidebar-border hover:bg-sidebar-accent/35')}>
        <div className="flex items-center gap-1">
          <button onClick={onToggle} className="inline-flex h-6 w-6 items-center justify-center">{isExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}</button>
          <button onClick={onSelect} className="flex flex-1 items-center gap-2 text-left min-w-0"><DeviceIcon className="h-4 w-4" /><span className="truncate text-sm font-medium">{device.name}</span></button>
          {isConnected && <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />}
          <Button variant="ghost" size="icon-xs" onClick={(e) => { e.stopPropagation(); onCreateWindow(); }}><Plus className="h-3.5 w-3.5" /></Button>
          <Button variant="ghost" size="icon-xs" onClick={(e) => { e.stopPropagation(); }} className="opacity-0 group-hover:opacity-100"><Trash2 className="h-3.5 w-3.5" /></Button>
        </div>
      </div>
      {isExpanded && (
        <div className="ml-3 mt-1 space-y-1 border-l pl-2">
          {!windows && <div className="text-xs text-muted-foreground px-2">Connecting...</div>}
          {windows?.map((window) => (
            <WindowItem key={window.id} device={device} window={window} isSelected={isSelected && window.id === selectedWindowId}
              isDeviceTreeSelected={isTreeSelected} selectedPaneId={selectedPaneId}
              onPaneClick={onPaneClick} onWindowClick={onWindowClick} onCloseWindow={onCloseWindow} onClosePane={onClosePane} />
          ))}
        </div>
      )}
    </div>
  );
}

interface WindowItemProps {
  device: Device; window: TmuxWindow; isSelected: boolean; isDeviceTreeSelected: boolean; selectedPaneId?: string;
  onPaneClick: (d: string, w: string, p: string) => void; onWindowClick: (d: string, w: string, panes: TmuxPane[]) => void;
  onCloseWindow: (d: string, w: string) => void; onClosePane: (d: string, w: string, p: string, n: number) => void;
}

function WindowItem({ device, window, isSelected, isDeviceTreeSelected, selectedPaneId, onPaneClick, onWindowClick, onCloseWindow, onClosePane }: WindowItemProps) {
  const [isExpanded, setIsExpanded] = useState(isSelected);
  useEffect(() => { if (isSelected) setIsExpanded(true); }, [isSelected]);

  const selectedPaneInWindow = window.panes.find((p) => p.id === selectedPaneId);
  const isWindowTreeSelected = isDeviceTreeSelected && Boolean(selectedPaneInWindow);

  return (
    <div className="space-y-1">
      <div className={cn('rounded-md border px-1 py-1', isWindowTreeSelected && 'border-primary/45 bg-primary/15', !isWindowTreeSelected && isSelected && 'border-sidebar-border bg-sidebar-accent/55', !isSelected && 'hover:border-sidebar-border hover:bg-sidebar-accent/35')}>
        <div className="flex items-center gap-1">
          {window.panes.length > 1 ? (
            <button onClick={() => setIsExpanded(!isExpanded)} className="h-5 w-5 inline-flex items-center justify-center">{isExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}</button>
          ) : <span className="h-5 w-5" />}
          <Badge variant="outline" className="h-5 text-[10px] px-1">{window.index}</Badge>
          <span className="flex-1 truncate text-xs font-medium" onClick={() => onWindowClick(device.id, window.id, window.panes)}>{window.name}</span>
          {window.active && <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />}
          <Button variant="ghost" size="icon-xs" onClick={(e) => { e.stopPropagation(); onCloseWindow(device.id, window.id); }}><X className="h-3 w-3" /></Button>
        </div>
      </div>
      {(isExpanded || window.panes.length === 1) && window.panes.map((pane) => (
        <div key={pane.id} className={cn('flex items-center gap-1 rounded-md px-1 py-1 text-xs', isSelected && pane.id === selectedPaneId ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-sidebar-accent/45')}>
          <button onClick={() => onPaneClick(device.id, window.id, pane.id)} className="flex flex-1 items-center gap-1.5 text-left min-w-0">
            <span>Pane {pane.index}</span>
            {pane.active && <span className="h-1 w-1 rounded-full bg-emerald-500" />}
          </button>
          <Button variant="ghost" size="icon-xs" onClick={(e) => { e.stopPropagation(); onClosePane(device.id, window.id, pane.id, window.panes.length); }}><X className="h-3 w-3" /></Button>
        </div>
      ))}
    </div>
  );
}
