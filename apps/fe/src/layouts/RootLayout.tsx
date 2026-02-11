import { useQuery } from '@tanstack/react-query';
import type { Device } from '@tmex/shared';
import { ArrowDownToLine, Keyboard, Smartphone } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Navigate, Outlet, useLocation, useMatch } from 'react-router';
import { Sidebar } from '../components/Sidebar';
import { useUIStore } from '../stores/ui';
import { buildTerminalLabel } from '../utils/terminalMeta';
import { decodePaneIdFromUrlParam } from '../utils/tmuxUrl';
import { useAuthStore } from '../stores/auth';
import { useTmuxStore } from '../stores/tmux';

export function RootLayout() {
  const { isAuthenticated, checkAuth } = useAuthStore();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const location = useLocation();
  const paneMatch = useMatch('/devices/:deviceId/windows/:windowId/panes/:paneId');
  const matchedDeviceId = paneMatch?.params.deviceId;
  const matchedWindowId = paneMatch?.params.windowId;
  const matchedPaneId = decodePaneIdFromUrlParam(paneMatch?.params.paneId);

  const ensureSocketConnected = useTmuxStore((state) => state.ensureSocketConnected);
  const snapshots = useTmuxStore((state) => state.snapshots);
  const matchedDeviceConnected = useTmuxStore((state) =>
    matchedDeviceId ? (state.deviceConnected?.[matchedDeviceId] ?? false) : false
  );
  const matchedSelectedPane = useTmuxStore((state) =>
    matchedDeviceId ? state.selectedPanes?.[matchedDeviceId] : undefined
  );
  const { inputMode, setInputMode } = useUIStore();

  const { data: devicesData } = useQuery({
    queryKey: ['devices'],
    queryFn: async () => {
      const res = await fetch('/api/devices', { credentials: 'include' });
      if (!res.ok) {
        throw new Error('Failed to fetch devices');
      }
      return res.json() as Promise<{ devices: Device[] }>;
    },
  });

  const mobileTerminalLabel = useMemo(() => {
    if (!paneMatch) {
      return null;
    }

    if (!matchedDeviceId || !matchedWindowId || !matchedPaneId) {
      return null;
    }

    const selectedWindow = snapshots[matchedDeviceId]?.session?.windows.find(
      (win) => win.id === matchedWindowId
    );
    const selectedPane = selectedWindow?.panes.find((pane) => pane.id === matchedPaneId);
    if (!selectedWindow || !selectedPane) {
      return null;
    }

    const deviceName =
      devicesData?.devices.find((device) => device.id === matchedDeviceId)?.name ?? matchedDeviceId;
    return buildTerminalLabel({
      paneIdx: selectedPane.index,
      windowIdx: selectedWindow.index,
      paneTitle: selectedPane.title,
      windowName: selectedWindow.name,
      deviceName,
    });
  }, [devicesData?.devices, matchedDeviceId, matchedPaneId, matchedWindowId, paneMatch, snapshots]);

  const isTerminalRoute = Boolean(paneMatch);

  const canInteractWithPane = Boolean(
    isTerminalRoute && matchedPaneId && matchedDeviceConnected && matchedSelectedPane?.paneId === matchedPaneId
  );

  const handleToggleInputMode = () => {
    setInputMode(inputMode === 'direct' ? 'editor' : 'direct');
  };

  const handleJumpToLatest = () => {
    if (!isTerminalRoute) {
      return;
    }

    window.dispatchEvent(new CustomEvent('tmex:jump-to-latest'));
  };

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  useEffect(() => {
    ensureSocketConnected();
  }, [ensureSocketConnected]);

  // 监听窗口大小变化
  useEffect(() => {
    const checkMobile = () => {
      const mobile = window.innerWidth < 768;
      setIsMobile(mobile);
      // 从移动端切换到桌面端时，关闭侧边栏
      if (!mobile) {
        setSidebarOpen(false);
      }
    };
    
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  // 认证检查中
  if (isAuthenticated === null) {
    return (
      <div className="flex items-center justify-center h-screen bg-[var(--color-bg)]">
        <div className="text-[var(--color-text-secondary)]">Loading...</div>
      </div>
    );
  }

  // 未认证，跳转到登录页
  if (!isAuthenticated) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[var(--color-bg)]">
      {/* 移动端遮罩 */}
      {isMobile && sidebarOpen && (
        <button
          type="button"
          aria-label="关闭侧边栏"
          className="fixed inset-0 bg-black/50 z-[99]"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* 侧边栏 */}
      <div 
        className={`${isMobile ? 'fixed left-0 top-0 bottom-0 z-[100] transform -translate-x-full transition-transform duration-200' : ''} 
          ${isMobile && sidebarOpen ? 'translate-x-0' : ''}`}
      >
        <Sidebar isOpen={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      </div>

      {/* 主内容区 */}
      <div className={`flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden ${isMobile ? 'pt-11' : ''}`}>
        {/* 顶部栏（移动端固定单行） */}
        {isMobile && (
          <header className="fixed top-0 left-0 right-0 z-[120] h-11 flex items-center justify-between px-3 bg-[var(--color-bg-secondary)] border-b border-[var(--color-border)] gap-2">
            <button
              type="button"
              onClick={() => setSidebarOpen(true)}
              className="h-7 w-7 inline-flex items-center justify-center -ml-1 rounded hover:bg-[var(--color-bg-tertiary)]"
              aria-label="打开侧边栏"
              title="打开侧边栏"
            >
              <svg
                width="20"
                height="20"
                viewBox="0 0 20 20"
                fill="currentColor"
                aria-hidden="true"
              >
                <path d="M3 5h14v2H3V5zm0 4h14v2H3V9zm0 4h14v2H3v-2z" />
              </svg>
            </button>
            <span
              data-testid="mobile-topbar-title"
              className="font-medium text-sm truncate text-center flex-1"
              title={mobileTerminalLabel ?? 'tmex'}
            >
              {mobileTerminalLabel ?? 'tmex'}
            </span>

            <div className="flex items-center gap-1.5 flex-shrink-0">
              <button
                type="button"
                onClick={handleToggleInputMode}
                className="h-7 w-7 inline-flex items-center justify-center rounded hover:bg-[var(--color-bg-tertiary)]"
                aria-label={inputMode === 'direct' ? '切换到编辑器输入' : '切换到直接输入'}
                title={inputMode === 'direct' ? '切换到编辑器输入' : '切换到直接输入'}
                disabled={!isTerminalRoute}
              >
                {inputMode === 'direct' ? (
                  <Keyboard className="h-4 w-4" />
                ) : (
                  <Smartphone className="h-4 w-4" />
                )}
              </button>
              <button
                type="button"
                onClick={handleJumpToLatest}
                className="h-7 w-7 inline-flex items-center justify-center rounded hover:bg-[var(--color-bg-tertiary)]"
                aria-label="跳转到最新"
                title="跳转到最新"
                disabled={!canInteractWithPane}
              >
                <ArrowDownToLine className="h-4 w-4" />
              </button>
            </div>
          </header>
        )}

        {/* 内容 */}
        <main className="flex-1 min-w-0 min-h-0 overflow-hidden">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
