import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Device, TmuxPane, TmuxWindow } from '@tmex/shared';
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Folder,
  FolderOpen,
  Globe,
  Monitor,
  Plus,
  Settings,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useMatch, useNavigate } from 'react-router';
import { useTmuxStore } from '../stores/tmux';
import { useUIStore } from '../stores/ui';
import { Button } from './ui';

interface SidebarProps {
  isOpen: boolean;
  onClose: () => void;
}

function decodePaneIdFromUrlParam(value: string | undefined): string | undefined {
  if (!value) return value;
  if (value.startsWith('%25')) {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return value;
}

export function Sidebar({ isOpen, onClose }: SidebarProps) {
  const paneMatch = useMatch('/devices/:deviceId/windows/:windowId/panes/:paneId');
  const deviceMatch = useMatch('/devices/:deviceId');
  const selectedDeviceId = paneMatch?.params.deviceId ?? deviceMatch?.params.deviceId;
  const selectedWindowId = paneMatch?.params.windowId;
  const selectedPaneId = decodePaneIdFromUrlParam(paneMatch?.params.paneId);
  const { sidebarCollapsed, setSidebarCollapsed } = useUIStore();
  const [expandedDevices, setExpandedDevices] = useState<Set<string>>(new Set());
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const snapshots = useTmuxStore((state) => state.snapshots);
  const connectDevice = useTmuxStore((state) => state.connectDevice);
  const disconnectDevice = useTmuxStore((state) => state.disconnectDevice);
  const createWindow = useTmuxStore((state) => state.createWindow);

  // 获取设备列表
  const { data: devicesData } = useQuery({
    queryKey: ['devices'],
    queryFn: async () => {
      const res = await fetch('/api/devices', { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to fetch devices');
      return res.json() as Promise<{ devices: Device[] }>;
    },
  });

  // 删除设备
  const deleteDevice = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/devices/${id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) throw new Error('Failed to delete device');
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['devices'] });
    },
  });

  const toggleDevice = useCallback(
    (deviceId: string) => {
      setExpandedDevices((prev) => {
        const next = new Set(prev);
        if (next.has(deviceId)) {
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

  const handleDeviceClick = (deviceId: string) => {
    navigate(`/devices/${deviceId}`);
    onClose();
  };

  const handlePaneClick = (deviceId: string, windowId: string, paneId: string) => {
    navigate(`/devices/${deviceId}/windows/${windowId}/panes/${encodeURIComponent(paneId)}`);
    onClose();
  };

  const handleCreateWindow = (deviceId: string) => {
    createWindow(deviceId);
  };

  // 自动展开当前选中的设备
  useEffect(() => {
    if (selectedDeviceId && !expandedDevices.has(selectedDeviceId)) {
      setExpandedDevices((prev) => new Set(prev).add(selectedDeviceId));
      connectDevice(selectedDeviceId);
    }
  }, [selectedDeviceId, connectDevice]);

  const devices = devicesData?.devices ?? [];

  return (
    <aside
      className={`h-full flex-shrink-0 bg-[var(--color-bg-secondary)] border-r border-[var(--color-border)] flex flex-col transition-all duration-200
        ${sidebarCollapsed ? 'w-12' : 'w-64'}
      `}
    >
      {/* 头部 */}
      <div className="flex items-center justify-between p-3 border-b border-[var(--color-border)] h-12">
        {!sidebarCollapsed && <span className="font-semibold text-lg truncate">tmex</span>}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
          title={sidebarCollapsed ? '展开' : '收起'}
          className={sidebarCollapsed ? 'w-6 h-6 p-0 mx-auto' : ''}
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
        {devices.map((device) => (
          <DeviceTreeItem
            key={device.id}
            device={device}
            isExpanded={expandedDevices.has(device.id)}
            isSelected={device.id === selectedDeviceId}
            selectedWindowId={selectedWindowId}
            selectedPaneId={selectedPaneId}
            windows={snapshots[device.id]?.session?.windows ?? null}
            onToggle={() => toggleDevice(device.id)}
            onSelect={() => handleDeviceClick(device.id)}
            onDelete={() => deleteDevice.mutate(device.id)}
            onCreateWindow={() => handleCreateWindow(device.id)}
            collapsed={sidebarCollapsed}
            onPaneClick={handlePaneClick}
          />
        ))}

        {devices.length === 0 && !sidebarCollapsed && (
          <div className="px-4 py-8 text-center text-[var(--color-text-secondary)] text-sm">
            暂无设备
            <br />
            <Link
              to="/devices"
              className="text-[var(--color-accent)] hover:underline mt-2 inline-block"
              onClick={onClose}
            >
              添加设备
            </Link>
          </div>
        )}
      </div>

      {/* 底部 */}
      {!sidebarCollapsed && (
        <div className="p-3 border-t border-[var(--color-border)]">
          <Button variant="default" className="w-full" asChild>
            <Link to="/devices" onClick={onClose}>
              <Settings className="h-4 w-4 mr-2" />
              管理设备
            </Link>
          </Button>
        </div>
      )}
    </aside>
  );
}

// ==================== 子组件 ====================

interface DeviceTreeItemProps {
  device: Device;
  isExpanded: boolean;
  isSelected: boolean;
  selectedWindowId?: string;
  selectedPaneId?: string;
  windows: TmuxWindow[] | null;
  onToggle: () => void;
  onSelect: () => void;
  onDelete: () => void;
  onCreateWindow: () => void;
  collapsed: boolean;
  onPaneClick: (deviceId: string, windowId: string, paneId: string) => void;
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
  collapsed,
  windows,
  onPaneClick,
}: DeviceTreeItemProps) {
  const icon =
    device.type === 'local' ? <Monitor className="h-4 w-4" /> : <Globe className="h-4 w-4" />;

  if (collapsed) {
    return (
      <button
        type="button"
        className={`tree-item justify-center ${isSelected ? 'active' : ''}`}
        onClick={onSelect}
        title={device.name}
      >
        <span className="text-[var(--color-accent)]">{icon}</span>
      </button>
    );
  }

  return (
    <div className="select-none">
      <div
        className={`tree-item group ${isSelected ? 'active' : ''}`}
      >
        <button
          type="button"
          className="flex items-center gap-2 flex-1 min-w-0"
          onClick={onToggle}
        >
          <span className="icon text-[var(--color-text-secondary)]">
            {isExpanded ? <FolderOpen className="h-4 w-4" /> : <Folder className="h-4 w-4" />}
          </span>
          <span className="icon text-[var(--color-accent)]">{icon}</span>
          <span className="label">{device.name}</span>
          <span className="icon text-[var(--color-text-muted)]">
            {isExpanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          </span>
        </button>
        
        {/* 新增窗口按钮 - 只在展开时显示 */}
        {isExpanded && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onCreateWindow();
            }}
            className="p-1 rounded hover:bg-[var(--color-bg-tertiary)] opacity-0 group-hover:opacity-100 transition-opacity"
            title="新建窗口"
          >
            <Plus className="h-3 w-3" />
          </button>
        )}
      </div>

      {isExpanded && (
        <div className="tree-children">
          {!windows && (
            <div className="text-[var(--color-text-secondary)] text-sm px-4 py-2">连接中...</div>
          )}

          {windows && windows.length === 0 && (
            <div className="text-[var(--color-text-secondary)] text-sm px-4 py-2">暂无窗口</div>
          )}

          {windows?.map((window) => (
            <WindowTreeItem
              key={window.id}
              device={device}
              window={window}
              isSelected={window.id === selectedWindowId}
              selectedPaneId={selectedPaneId}
              onPaneClick={onPaneClick}
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
  selectedPaneId?: string;
  onPaneClick: (deviceId: string, windowId: string, paneId: string) => void;
}

function WindowTreeItem({ device, window, isSelected, selectedPaneId, onPaneClick }: WindowTreeItemProps) {
  const [isExpanded, setIsExpanded] = useState(isSelected);

  // 当选中状态变化时，自动展开
  useEffect(() => {
    if (isSelected) {
      setIsExpanded(true);
    }
  }, [isSelected]);

  const handleWindowClick = () => {
    const activePane = window.panes.find((pane) => pane.active) ?? window.panes[0];
    if (!activePane) return;
    onPaneClick(device.id, window.id, activePane.id);
  };

  const hasMultiplePanes = window.panes.length > 1;

  return (
    <div>
      <div className={`tree-item window-item ${isSelected ? 'active' : ''}`}>
        <button
          type="button"
          className="flex items-center gap-2 flex-1 min-w-0"
          onClick={handleWindowClick}
        >
          <span className="icon text-[var(--color-text-secondary)]">
            {window.index}:
          </span>
          <span className="label truncate">{window.name}</span>
          {window.active && <span className="window-active-indicator" title="当前窗口" />}
        </button>
        
        {/* 展开/收起 pane 列表按钮 - 只有多 pane 时显示 */}
        {hasMultiplePanes && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setIsExpanded(!isExpanded);
            }}
            className="p-1 rounded hover:bg-[var(--color-bg-tertiary)]"
          >
            {isExpanded ? (
              <ChevronUp className="h-3 w-3 text-[var(--color-text-muted)]" />
            ) : (
              <ChevronDown className="h-3 w-3 text-[var(--color-text-muted)]" />
            )}
          </button>
        )}
      </div>

      {/* Pane 列表 */}
      {(isExpanded || !hasMultiplePanes) && (
        <div className="tree-children pane-list">
          {window.panes.map((pane) => (
            <PaneTreeItem
              key={pane.id}
              deviceId={device.id}
              windowId={window.id}
              pane={pane}
              isSelected={pane.id === selectedPaneId}
              onClick={onPaneClick}
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
  onClick: (deviceId: string, windowId: string, paneId: string) => void;
}

function PaneTreeItem({ deviceId, windowId, pane, isSelected, onClick }: PaneTreeItemProps) {
  return (
    <button
      type="button"
      className={`tree-item pane-item ${isSelected ? 'active' : ''}`}
      onClick={() => onClick(deviceId, windowId, pane.id)}
      title={`Pane ${pane.index}${pane.active ? ' (active)' : ''}`}
    >
      <span className="icon text-[var(--color-text-secondary)]">↳</span>
      <span className="label">{pane.index}</span>
      {pane.active && <span className="pane-active-indicator" title="当前 pane" />}
    </button>
  );
}
