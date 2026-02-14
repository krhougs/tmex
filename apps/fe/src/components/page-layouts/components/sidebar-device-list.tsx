import { useQuery } from '@tanstack/react-query';
import type { Device, TmuxPane, TmuxWindow } from '@tmex/shared';
import { toBCP47 } from '@tmex/shared';
import { Globe, Monitor, Plus, Trash2, Power, PowerOff } from 'lucide-react';
import { useCallback, useMemo } from 'react';
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
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  
  // Get selected window/pane from URL
  const paneMatch = matchPath('/devices/:deviceId/windows/:windowId/panes/:paneId', location.pathname);
  const selectedWindowId = paneMatch?.params.windowId;
  const selectedPaneId = decodePaneIdFromUrlParam(paneMatch?.params.paneId);

  const snapshots = useTmuxStore((state) => state.snapshots);
  const connectDevice = useTmuxStore((state) => state.connectDevice);
  const disconnectDevice = useTmuxStore((state) => state.disconnectDevice);
  const createWindow = useTmuxStore((state) => state.createWindow);
  const closeWindow = useTmuxStore((state) => state.closeWindow);
  const closePane = useTmuxStore((state) => state.closePane);
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

  const navigateToPane = useCallback((deviceId: string, windowId: string, paneId: string) =>
    handleNavigate(`/devices/${deviceId}/windows/${windowId}/panes/${encodePaneIdForUrl(paneId)}`), 
    [handleNavigate]
  );

  const handleWindowClick = useCallback((deviceId: string, windowId: string, panes: TmuxPane[]) => {
    // Click window = select its first/active pane
    const targetPane = panes.find((p) => p.active) ?? panes[0];
    if (targetPane) {
      navigateToPane(deviceId, windowId, targetPane.id);
    }
  }, [navigateToPane]);

  const handleConnectToggle = useCallback((deviceId: string, isConnected: boolean) => {
    if (isConnected) {
      disconnectDevice(deviceId, 'sidebar');
    } else {
      connectDevice(deviceId, 'sidebar');
    }
  }, [connectDevice, disconnectDevice]);

  const devices = devicesData?.devices ?? [];
  const sortedDevices = useMemo(() => 
    [...devices].sort((a, b) => a.name.localeCompare(b.name, toBCP47(language), { numeric: true, sensitivity: 'base' })), 
    [devices, language]
  );

  return (
    <SidebarGroup className="flex flex-col flex-1 min-h-0">
      <SidebarGroupLabel>{t('device.devices')}</SidebarGroupLabel>
      <ScrollArea className="flex-1">
        <div className="space-y-4 p-2">
          {sortedDevices.map((device) => (
            <DeviceSection
              key={device.id}
              device={device}
              windows={snapshots[device.id]?.session?.windows ?? null}
              isConnected={deviceConnected[device.id] ?? false}
              selectedWindowId={selectedWindowId}
              selectedPaneId={selectedPaneId}
              onConnectToggle={() => handleConnectToggle(device.id, deviceConnected[device.id] ?? false)}
              onCreateWindow={() => createWindow(device.id)}
              onCloseWindow={closeWindow}
              onClosePane={closePane}
              onPaneClick={navigateToPane}
              onWindowClick={handleWindowClick}
            />
          ))}
          {sortedDevices.length === 0 && (
            <div className="text-center text-sm text-muted-foreground py-4">
              {t('sidebar.noDevices')}
            </div>
          )}
        </div>
      </ScrollArea>
    </SidebarGroup>
  );
}

interface DeviceSectionProps {
  device: Device;
  windows: TmuxWindow[] | null;
  isConnected: boolean;
  selectedWindowId?: string;
  selectedPaneId?: string;
  onConnectToggle: () => void;
  onCreateWindow: () => void;
  onCloseWindow: (deviceId: string, windowId: string) => void;
  onClosePane: (deviceId: string, windowId: string, paneId: string, paneCount: number) => void;
  onPaneClick: (deviceId: string, windowId: string, paneId: string) => void;
  onWindowClick: (deviceId: string, windowId: string, panes: TmuxPane[]) => void;
}

function DeviceSection({
  device,
  windows,
  isConnected,
  selectedWindowId,
  selectedPaneId,
  onConnectToggle,
  onCreateWindow,
  onCloseWindow,
  onClosePane,
  onPaneClick,
  onWindowClick,
}: DeviceSectionProps) {
  const { t } = useTranslation();
  const DeviceIcon = device.type === 'local' ? Monitor : Globe;

  return (
    <div className="rounded-lg border bg-card/50 overflow-hidden">
      {/* Device Header - Not selectable, just shows status and controls */}
      <div className="px-3 py-2.5 bg-muted/50 border-b">
        <div className="flex items-center gap-2">
          <DeviceIcon className="h-4 w-4 text-muted-foreground shrink-0" />
          <span className="flex-1 truncate text-sm font-medium">{device.name}</span>
          
          {/* Connection Status */}
          <div className={cn(
            "h-2 w-2 rounded-full shrink-0",
            isConnected ? "bg-emerald-500" : "bg-gray-400"
          )} />
          
          {/* Connect/Disconnect Button */}
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={onConnectToggle}
            title={isConnected ? t('device.disconnect') : t('device.connect')}
          >
            {isConnected ? (
              <PowerOff className="h-3.5 w-3.5 text-orange-500" />
            ) : (
              <Power className="h-3.5 w-3.5 text-emerald-500" />
            )}
          </Button>
          
          {/* Add Window Button */}
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={onCreateWindow}
            disabled={!isConnected}
            title={t('window.create')}
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
          
          {/* Delete Device Button */}
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => {/* TODO: delete device */}}
            title={t('device.delete')}
          >
            <Trash2 className="h-3.5 w-3.5 text-destructive" />
          </Button>
        </div>
      </div>

      {/* Windows List */}
      <div className="p-1.5 space-y-1">
        {!isConnected && (
          <div className="text-xs text-muted-foreground px-2 py-1.5 text-center">
            {t('device.disconnected')}
          </div>
        )}
        
        {isConnected && !windows && (
          <div className="text-xs text-muted-foreground px-2 py-1.5 text-center">
            {t('device.connecting')}
          </div>
        )}
        
        {isConnected && windows?.length === 0 && (
          <div className="text-xs text-muted-foreground px-2 py-1.5 text-center">
            {t('window.noWindows')}
          </div>
        )}
        
        {windows?.map((window) => (
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
          />
        ))}
      </div>
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
  onClosePane: (deviceId: string, windowId: string, paneId: string, paneCount: number) => void;
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
}: WindowItemProps) {
  const hasMultiplePanes = window.panes.length > 1;
  
  // Find which pane is selected in this window
  const selectedPaneInWindow = window.panes.find((p) => p.id === selectedPaneId);
  const isPaneSelected = isSelected && Boolean(selectedPaneInWindow);

  return (
    <div className="space-y-0.5">
      {/* Window Header - Clickable */}
      <button
        onClick={() => onWindowClick(deviceId, window.id, window.panes)}
        className={cn(
          "w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left transition-colors",
          isPaneSelected 
            ? "bg-primary text-primary-foreground" 
            : "hover:bg-accent/50 text-foreground"
        )}
      >
        <Badge 
          variant={isPaneSelected ? "secondary" : "outline"} 
          className="h-5 text-[10px] px-1 shrink-0"
        >
          {window.index}
        </Badge>
        
        <span className="flex-1 truncate text-xs font-medium">
          {window.name}
        </span>
        
        {window.active && (
          <span className={cn(
            "h-1.5 w-1.5 rounded-full shrink-0",
            isPaneSelected ? "bg-primary-foreground" : "bg-emerald-500"
          )} />
        )}
        
        <Button
          variant="ghost"
          size="icon-xs"
          className={cn("shrink-0 opacity-0 group-hover:opacity-100", isPaneSelected && "opacity-100")}
          onClick={(e) => {
            e.stopPropagation();
            onCloseWindow(deviceId, window.id);
          }}
        >
          <span className="sr-only">{/* Close window */}</span>
          <span className="text-xs">×</span>
        </Button>
      </button>

      {/* Panes List - Only show if window has multiple panes */}
      {hasMultiplePanes && (
        <div className="ml-4 pl-2 border-l border-border/50 space-y-0.5">
          {window.panes.map((pane) => {
            const isPaneActive = pane.id === selectedPaneId;
            
            return (
              <button
                key={pane.id}
                onClick={() => onPaneClick(deviceId, window.id, pane.id)}
                className={cn(
                  "w-full flex items-center gap-2 px-2 py-1 rounded-md text-left transition-colors",
                  isPaneActive
                    ? "bg-primary/90 text-primary-foreground"
                    : "hover:bg-accent/40 text-muted-foreground"
                )}
              >
                <span className="text-[10px] font-mono opacity-70">
                  {pane.index}
                </span>
                
                <span className="flex-1 truncate text-xs">
                  {pane.title || `Pane ${pane.index}`}
                </span>
                
                {pane.active && (
                  <span className={cn(
                    "h-1 w-1 rounded-full shrink-0",
                    isPaneActive ? "bg-primary-foreground" : "bg-emerald-500"
                  )} />
                )}
                
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className={cn("shrink-0 opacity-0", isPaneActive && "opacity-100")}
                  onClick={(e) => {
                    e.stopPropagation();
                    onClosePane(deviceId, window.id, pane.id, window.panes.length);
                  }}
                >
                  <span className="sr-only">{/* Close pane */}</span>
                  <span className="text-xs">×</span>
                </Button>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
