import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Device } from '@tmex/shared';
import { useCallback, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useUIStore } from '../stores/ui';

interface SidebarProps {
  isOpen: boolean;
  onClose: () => void;
}

export function Sidebar({ isOpen, onClose }: SidebarProps) {
  const {
    deviceId: selectedDeviceId,
    windowId: selectedWindowId,
    paneId: selectedPaneId,
  } = useParams();
  const { sidebarCollapsed, setSidebarCollapsed } = useUIStore();
  const [expandedDevices, setExpandedDevices] = useState<Set<string>>(new Set());
  const navigate = useNavigate();
  const queryClient = useQueryClient();

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

  const toggleDevice = useCallback((deviceId: string) => {
    setExpandedDevices((prev) => {
      const next = new Set(prev);
      if (next.has(deviceId)) {
        next.delete(deviceId);
      } else {
        next.add(deviceId);
      }
      return next;
    });
  }, []);

  const handlePaneClick = (deviceId: string, windowId: string, paneId: string) => {
    navigate(`/devices/${deviceId}/windows/${windowId}/panes/${paneId}`);
    onClose();
  };

  const devices = devicesData?.devices ?? [];

  return (
    <aside
      className={`sidebar ${isOpen ? 'open' : ''} ${sidebarCollapsed ? 'w-12' : 'w-64'} 
        flex-shrink-0 bg-bg-secondary border-r border-border flex flex-col
        ${typeof window !== 'undefined' && window.innerWidth < 768 ? 'fixed' : ''}
      `}
    >
      {/* 头部 */}
      <div className="flex items-center justify-between p-3 border-b border-border">
        {!sidebarCollapsed && <span className="font-semibold text-lg">tmex</span>}
        <button
          type="button"
          onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
          className="p-1 rounded hover:bg-bg-tertiary"
          title={sidebarCollapsed ? '展开' : '收起'}
          aria-label={sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="currentColor"
            aria-hidden="true"
            style={{ transform: sidebarCollapsed ? 'rotate(180deg)' : 'none' }}
          >
            <path d="M9 4L5 8l4 4V4z" />
          </svg>
        </button>
      </div>

      {/* 设备列表 */}
      <div className="flex-1 overflow-y-auto py-2">
        {devices.map((device) => (
          <DeviceTreeItem
            key={device.id}
            device={device}
            isExpanded={expandedDevices.has(device.id)}
            isSelected={device.id === selectedDeviceId}
            selectedWindowId={selectedWindowId}
            selectedPaneId={selectedPaneId}
            onToggle={() => toggleDevice(device.id)}
            onSelect={() => handlePaneClick(device.id, '', '')}
            onDelete={() => deleteDevice.mutate(device.id)}
            collapsed={sidebarCollapsed}
          />
        ))}

        {devices.length === 0 && !sidebarCollapsed && (
          <div className="px-4 py-8 text-center text-text-secondary text-sm">
            暂无设备
            <br />
            <Link
              to="/devices"
              className="text-accent hover:underline mt-2 inline-block"
              onClick={onClose}
            >
              添加设备
            </Link>
          </div>
        )}
      </div>

      {/* 底部 */}
      {!sidebarCollapsed && (
        <div className="p-3 border-t border-border">
          <Link to="/devices" className="btn w-full justify-center" onClick={onClose}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path d="M8 0a8 8 0 100 16A8 8 0 008 0zm1 12H7v-1h2v1zm0-3H7V4h2v5z" />
            </svg>
            管理设备
          </Link>
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
  onToggle: () => void;
  onSelect: () => void;
  onDelete: () => void;
  collapsed: boolean;
}

function DeviceTreeItem({
  device,
  isExpanded,
  isSelected,
  onToggle,
  onSelect,
  collapsed,
}: DeviceTreeItemProps) {
  const [showMenu, setShowMenu] = useState(false);

  const icon = device.type === 'local' ? '🖥️' : '🌐';

  if (collapsed) {
    return (
      <button
        type="button"
        className={`tree-item justify-center ${isSelected ? 'active' : ''}`}
        onClick={onSelect}
        title={device.name}
      >
        <span>{icon}</span>
      </button>
    );
  }

  return (
    <div>
      <button
        type="button"
        className={`tree-item ${isSelected ? 'active' : ''}`}
        onClick={onToggle}
        onContextMenu={(e) => {
          e.preventDefault();
          setShowMenu(true);
        }}
      >
        <span className="icon">{isExpanded ? '📂' : '📁'}</span>
        <span className="icon">{icon}</span>
        <span className="label">{device.name}</span>
        <span className="icon">{isExpanded ? '▼' : '▶'}</span>
      </button>

      {isExpanded && (
        <div className="tree-children">
          <div className="text-text-secondary text-sm px-4 py-2">连接到设备以查看窗口列表</div>
        </div>
      )}

      {showMenu && (
        <button
          type="button"
          className="sr-only"
          aria-label="关闭菜单"
          onClick={() => setShowMenu(false)}
        />
      )}
    </div>
  );
}
