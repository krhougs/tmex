import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Device, TmuxPane, TmuxWindow } from '@tmex/shared';
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
import { Link, useMatch, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { useSiteStore } from '../stores/site';
import { useTmuxStore } from '../stores/tmux';
import { useUIStore } from '../stores/ui';
import { decodePaneIdFromUrlParam, encodePaneIdForUrl } from '../utils/tmuxUrl';
import { Button } from './ui';

interface SidebarProps {
  isOpen: boolean;
  onClose: () => void;
}

// ==================== Sidebar 主组件 ====================

export function Sidebar({ onClose }: SidebarProps) {
  const paneMatch = useMatch('/devices/:deviceId/windows/:windowId/panes/:paneId');
  const deviceMatch = useMatch('/devices/:deviceId');
  const selectedDeviceId = paneMatch?.params.deviceId ?? deviceMatch?.params.deviceId;
  const selectedWindowId = paneMatch?.params.windowId;
  const selectedPaneId = decodePaneIdFromUrlParam(paneMatch?.params.paneId);
  
  const { sidebarCollapsed, setSidebarCollapsed } = useUIStore();
  const [expandedDevices, setExpandedDevices] = useState<Set<string>>(new Set());
  const [pendingWindowSelection, setPendingWindowSelection] = useState<Record<string, { windowId: string; requestedAt: number }>>({});
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const snapshots = useTmuxStore((state) => state.snapshots);
  const connectDevice = useTmuxStore((state) => state.connectDevice);
  const disconnectDevice = useTmuxStore((state) => state.disconnectDevice);
  const createWindow = useTmuxStore((state) => state.createWindow);
  const closeWindow = useTmuxStore((state) => state.closeWindow);
  const closePane = useTmuxStore((state) => state.closePane);
  const selectWindow = useTmuxStore((state) => state.selectWindow);
  const deviceConnected = useTmuxStore((state) => state.deviceConnected);
  const siteName = useSiteStore((state) => state.settings?.siteName ?? 'tmex');

  // 获取设备列表
  const { data: devicesData } = useQuery({
    queryKey: ['devices'],
    queryFn: async () => {
      const res = await fetch('/api/devices');
      if (!res.ok) throw new Error('Failed to fetch devices');
      return res.json() as Promise<{ devices: Device[] }>;
    },
    throwOnError: false,
  });

  useEffect(() => {
    if (devicesData) {
      return;
    }
    toast.error('加载设备列表失败');
  }, [devicesData]);

  // 删除设备
  const deleteDevice = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/devices/${id}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error('Failed to delete device');
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['devices'] });
      toast.success('设备已删除');
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : '删除设备失败');
    },
  });

  // 切换设备展开/折叠
  const toggleDevice = useCallback(
    (deviceId: string) => {
      setExpandedDevices((prev) => {
        const next = new Set(prev);
        if (next.has(deviceId)) {
          // 折叠时如果当前设备未选中，则断开连接
          next.delete(deviceId);
          if (deviceId !== selectedDeviceId) {
            disconnectDevice(deviceId);
          }
        } else {
          next.add(deviceId);
          connectDevice(deviceId);
        }
        return next;
      });
    },
    [connectDevice, disconnectDevice, selectedDeviceId]
  );

  // 点击设备名称 - 导航到设备页
  const handleDeviceClick = useCallback((deviceId: string) => {
    navigate(`/devices/${deviceId}`);
    onClose();
  }, [navigate, onClose]);

  const navigateToPane = useCallback((deviceId: string, windowId: string, paneId: string) => {
    navigate(`/devices/${deviceId}/windows/${windowId}/panes/${encodePaneIdForUrl(paneId)}`);
    onClose();
  }, [navigate, onClose]);

  // 点击pane - 导航到pane页
  const handlePaneClick = useCallback((deviceId: string, windowId: string, paneId: string) => {
    navigateToPane(deviceId, windowId, paneId);
  }, [navigateToPane]);

  const handleWindowClick = useCallback((deviceId: string, windowId: string, panes: TmuxPane[]) => {
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
  }, [navigateToPane, selectWindow]);

  // 创建新窗口
  const handleCreateWindow = useCallback((deviceId: string) => {
    createWindow(deviceId);
  }, [createWindow]);

  const handleCloseWindow = useCallback((deviceId: string, windowId: string) => {
    closeWindow(deviceId, windowId);
  }, [closeWindow]);

  const handleClosePane = useCallback((deviceId: string, windowId: string, paneId: string, paneCount: number) => {
    if (paneCount <= 1) {
      closeWindow(deviceId, windowId);
      return;
    }
    closePane(deviceId, paneId);
  }, [closePane, closeWindow]);

  // 自动展开当前选中的设备
  useEffect(() => {
    if (selectedDeviceId && !expandedDevices.has(selectedDeviceId)) {
      setExpandedDevices((prev) => new Set(prev).add(selectedDeviceId));
      connectDevice(selectedDeviceId);
    }
  }, [selectedDeviceId, connectDevice]);

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

  // 按连接状态排序：已连接的在前
  const sortedDevices = useMemo(() => {
    return [...devices].sort((a, b) => {
      const aConnected = deviceConnected[a.id] ? 1 : 0;
      const bConnected = deviceConnected[b.id] ? 1 : 0;
      return bConnected - aConnected;
    });
  }, [devices, deviceConnected]);

  return (
    <aside
      data-testid="sidebar"
      className={`
        h-full flex-shrink-0 bg-[var(--color-bg-secondary)] border-r border-[var(--color-border)] 
        flex flex-col transition-all duration-200 ease-in-out
        ${sidebarCollapsed ? 'w-14' : 'w-64'}
      `}
    >
      {/* 头部 */}
      <div className="flex items-center justify-between px-3 h-11 border-b border-[var(--color-border)] flex-shrink-0">
        {!sidebarCollapsed && (
          <span className="font-semibold text-base text-[var(--color-text)] truncate">
            {siteName}
          </span>
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
          title={sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'}
          className={`
            p-1.5 h-8 w-8
            ${sidebarCollapsed ? 'mx-auto' : ''}
          `}
        >
          {sidebarCollapsed ? (
            <ChevronRight className="h-4 w-4" />
          ) : (
            <ChevronLeft className="h-4 w-4" />
          )}
        </Button>
      </div>

      {/* 设备列表 */}
      <div className="flex-1 overflow-y-auto py-2 min-h-0">
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
            onDelete={() => deleteDevice.mutate(device.id)}
            onCreateWindow={() => handleCreateWindow(device.id)}
            onCloseWindow={handleCloseWindow}
            onClosePane={handleClosePane}
            collapsed={sidebarCollapsed}
            onPaneClick={handlePaneClick}
            onWindowClick={handleWindowClick}
          />
        ))}

        {sortedDevices.length === 0 && !sidebarCollapsed && (
          <div className="px-4 py-8 text-center text-[var(--color-text-secondary)] text-sm">
            <div className="mb-2">暂无设备</div>
            <div className="space-y-1">
              <Link
                to="/devices"
                className="block text-[var(--color-accent)] hover:text-[var(--color-accent-hover)] hover:underline transition-colors"
                onClick={onClose}
              >
                添加设备
              </Link>
              <Link
                to="/settings"
                className="block text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] hover:underline transition-colors"
                onClick={onClose}
              >
                打开设置
              </Link>
            </div>
          </div>
        )}
      </div>

      {/* 底部 */}
      {!sidebarCollapsed && (
        <div className="p-3 border-t border-[var(--color-border)] flex-shrink-0">
          <div className="flex flex-col gap-2">
            <Button variant="default" className="w-full justify-center" asChild>
              <Link to="/devices" onClick={onClose}>
                <Monitor className="h-4 w-4 mr-2 flex-shrink-0" />
                管理设备
              </Link>
            </Button>

            <Button variant="default" className="w-full justify-center" asChild>
              <Link to="/settings" onClick={onClose}>
                <Settings className="h-4 w-4 mr-2 flex-shrink-0" />
                设置
              </Link>
            </Button>
          </div>
        </div>
      )}

      {/* 折叠状态下的快捷按钮 */}
      {sidebarCollapsed && (
        <div className="p-2 border-t border-[var(--color-border)] flex-shrink-0 flex flex-col gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="w-full h-8 p-0 justify-center"
            asChild
            title="管理设备"
          >
            <Link to="/devices" onClick={onClose}>
              <Monitor className="h-4 w-4" />
            </Link>
          </Button>

          <Button
            variant="ghost"
            size="sm"
            className="w-full h-8 p-0 justify-center"
            asChild
            title="设置"
          >
            <Link to="/settings" onClick={onClose}>
              <Settings className="h-4 w-4" />
            </Link>
          </Button>
        </div>
      )}
    </aside>
  );
}

// ==================== DeviceTreeItem 子组件 ====================

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
  onDelete: () => void;
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
  const DeviceIcon = device.type === 'local' ? Monitor : Globe;
  const hasSelectedPaneInDevice = Boolean(selectedPaneId);
  const selectedWindow = windows?.find((window) => window.id === selectedWindowId);
  const selectedPaneInWindow = selectedWindow?.panes.find((pane) => pane.id === selectedPaneId);
  const isDeviceTreeSelected = isSelected && hasSelectedPaneInDevice && Boolean(selectedPaneInWindow);
  
  // 折叠状态 - 只显示图标
  if (collapsed) {
    return (
      <div className="px-2 py-1">
        <button
          type="button"
          onClick={onSelect}
          title={device.name}
          data-testid={`device-icon-${device.id}`}
          data-active={isSelected}
          className={`
            w-full h-9 rounded-md flex items-center justify-center
            transition-all duration-150 ease-in-out
            ${isSelected 
              ? 'bg-[rgba(88,166,255,0.15)] text-[var(--color-text)] shadow-sm' 
              : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)]'
            }
            ${isConnected && !isSelected ? 'border-l-2 border-[var(--color-success)]' : ''}
          `}
        >
          <DeviceIcon className="h-4 w-4 flex-shrink-0" />
        </button>
      </div>
    );
  }

  // 展开状态
  return (
    <div className="select-none group">
      {/* 设备项 */}
      <div
        data-testid={`device-item-${device.id}`}
        data-active={isSelected}
        className={`
          mx-2 mb-1 rounded-md overflow-hidden
          ${isDeviceTreeSelected
            ? 'bg-[rgba(88,166,255,0.15)] text-[var(--color-text)]'
            : isSelected
              ? 'bg-[var(--color-bg-tertiary)] text-[var(--color-text)]'
              : 'text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)]'
          }
          ${isSelected && !isDeviceTreeSelected ? 'border-l-2 border-[var(--color-accent)]' : ''}
          transition-colors duration-150
        `}
      >
        <div className="flex items-center px-2 py-2">
          {/* 展开/折叠按钮 */}
          <button
            type="button"
            onClick={onToggle}
            className={`
              p-1 rounded mr-1 flex-shrink-0
              text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg)]
              transition-colors duration-150
            `}
            title={isExpanded ? '折叠' : '展开'}
          >
            {isExpanded ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
          </button>

          {/* 设备图标 */}
          <span className={`
            mr-2 flex-shrink-0
            ${isSelected ? 'text-[var(--color-text)]' : 'text-[var(--color-text-secondary)]'}
          `}>
            <DeviceIcon className="h-4 w-4" />
          </span>

          {/* 设备名称 - 可点击导航 */}
          <button
            type="button"
            onClick={onSelect}
            className="flex-1 min-w-0 text-left font-medium truncate"
            title={device.name}
          >
            {device.name}
          </button>

          {/* 连接状态指示器 */}
          {isConnected && (
            <span 
              className={`
                ml-1.5 w-2 h-2 rounded-full flex-shrink-0
                ${isSelected ? 'bg-[var(--color-success)]' : 'bg-[var(--color-success)]'}
              `}
              title="已连接"
            />
          )}

          {/* 新建窗口按钮 */}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onCreateWindow();
            }}
            className={`
              ml-1 p-1 rounded flex-shrink-0
              transition-colors duration-150
              ${isSelected 
                ? 'text-[var(--color-text)] hover:bg-[var(--color-bg)]/40' 
                : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg)]'
              }
            `}
            title="新建窗口"
            aria-label={`为设备 ${device.name} 新建窗口`}
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* 展开的窗口列表 */}
      {isExpanded && (
        <div className="ml-4 mr-2 mb-2">
          {!windows && (
            <div className="px-3 py-2 text-sm text-[var(--color-text-secondary)] flex items-center gap-2">
              <span className="w-1.5 h-1.5 bg-[var(--color-accent)] rounded-full animate-pulse" />
              连接中...
            </div>
          )}

          {windows && windows.length === 0 && (
            <div className="px-3 py-2 text-sm text-[var(--color-text-secondary)]">
              暂无窗口
            </div>
          )}

          {windows?.map((window) => (
            <WindowTreeItem
              key={window.id}
              device={device}
              window={window}
              isSelected={window.id === selectedWindowId}
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

// ==================== WindowTreeItem 子组件 ====================

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
  const [isExpanded, setIsExpanded] = useState(isSelected);

  // 当选中状态变化时，自动展开
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
    <div className="select-none">
      {/* 窗口项 */}
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
        className={`
          rounded-md mb-0.5
          ${isWindowTreeSelected
            ? 'bg-[rgba(88,166,255,0.3)] text-[var(--color-text)] border-l-2 border-[var(--color-accent)]'
            : isSelected
              ? 'bg-[var(--color-bg-tertiary)] text-[var(--color-text)] border-l-2 border-[var(--color-accent)]'
              : 'text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)]'
          }
          ${!isSelected && parentSelected ? 'ml-2' : ''}
          transition-colors duration-150
        `}
      >
        <div className="flex items-center px-2 py-1.5">
          {/* Pane展开按钮（只有多pane时显示） */}
          {hasMultiplePanes ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setIsExpanded(!isExpanded);
              }}
              className={`
                p-0.5 rounded mr-1 flex-shrink-0
                ${isSelected 
                  ? 'text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg)]' 
                  : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg)]'
                }
                transition-colors duration-150
              `}
            >
              {isExpanded ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronRight className="h-3 w-3" />
              )}
            </button>
          ) : (
            <span className="w-5 flex-shrink-0" />
          )}

          {/* 窗口索引 */}
          <span className={`
            text-xs mr-1.5 flex-shrink-0 min-w-[1.25rem]
            ${isSelected 
              ? 'text-[var(--color-text-secondary)]' 
              : 'text-[var(--color-text-muted)]'
            }
          `}>
            {window.index}:
          </span>

          {/* 窗口名称 */}
          <span
            className="flex-1 min-w-0 text-left text-sm truncate"
            title={window.name}
          >
            {window.name}
          </span>

          {/* 当前窗口指示器 */}
          {window.active && (
            <span 
              className={`
                ml-1.5 w-1.5 h-1.5 rounded-full flex-shrink-0
                ${isSelected 
                  ? 'bg-[var(--color-success)]' 
                  : 'bg-[var(--color-success)]'
                }
              `}
              title="当前窗口"
            />
          )}

          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onCloseWindow(device.id, window.id);
            }}
            className={`
              ml-1 p-1 rounded flex-shrink-0
              ${isSelected
                ? 'text-[var(--color-text)] hover:bg-[var(--color-bg)]/40'
                : 'text-[var(--color-text-muted)] hover:text-[var(--color-danger)] hover:bg-[var(--color-bg)]'
              }
              transition-colors duration-150
            `}
            title="关闭窗口"
            aria-label={`关闭窗口 ${window.name}`}
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      </div>

      {/* Pane列表 */}
      {(isExpanded || !hasMultiplePanes) && (
        <div className={`
          ${!isSelected && parentSelected ? 'ml-4' : 'ml-3'}
          border-l border-[var(--color-border)] pl-2
        `}>
          {window.panes.map((pane) => (
            <PaneTreeItem
              key={pane.id}
              deviceId={device.id}
              windowId={window.id}
              pane={pane}
              isSelected={pane.id === selectedPaneId}
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

// ==================== PaneTreeItem 子组件 ====================

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
  return (
    <div
      data-testid={`pane-item-${pane.id}`}
      data-active={isSelected}
      className={`
        w-full flex items-center px-2 py-1 rounded-md text-left text-sm
        ${isSelected 
          ? 'bg-[rgba(88,166,255,0.9)] text-[var(--color-bg)] border-l-2 border-[var(--color-accent)]' 
          : isWindowTreeSelected
            ? 'text-[var(--color-text)] bg-[rgba(88,166,255,0.15)] hover:bg-[rgba(88,166,255,0.2)]'
          : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)]'
        }
        ${!isSelected && parentWindowSelected ? 'ml-2' : ''}
        transition-colors duration-150 mb-0.5
      `}
    >
      <button
        type="button"
        onClick={() => onClick(deviceId, windowId, pane.id)}
        title={`Pane ${pane.index}${pane.active ? ' (active)' : ''}`}
        className="flex items-center flex-1 min-w-0"
      >
        {/* Pane指示符 */}
        <span className={`
          mr-1.5 text-xs flex-shrink-0
          ${isSelected ? 'text-[var(--color-bg)]' : 'text-[var(--color-text-muted)]'}
        `}>
          ›
        </span>

        {/* Pane索引 */}
        <span className="truncate flex-1 text-left">
          Pane {pane.index}
        </span>

        {/* 当前pane指示器 */}
        {pane.active && (
          <span 
            className={`
              ml-1.5 w-1 h-1 rounded-full flex-shrink-0
              ${isSelected 
                ? 'bg-[var(--color-bg)]/80' 
                : 'bg-[var(--color-success)]'
              }
            `}
            title="当前pane"
          />
        )}
      </button>

      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onClosePane(deviceId, windowId, pane.id, paneCount);
        }}
        className={`
          ml-1 p-1 rounded flex-shrink-0
          ${isSelected
            ? 'text-[var(--color-bg)] hover:bg-[var(--color-bg)]/20'
            : isWindowTreeSelected
              ? 'text-[var(--color-text)] hover:text-[var(--color-danger)] hover:bg-[var(--color-bg)]/40'
            : 'text-[var(--color-text-muted)] hover:text-[var(--color-danger)] hover:bg-[var(--color-bg)]'
          }
          transition-colors duration-150
        `}
        title="关闭 pane"
        aria-label={`关闭 pane ${pane.index}`}
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}
