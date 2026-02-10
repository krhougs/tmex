import { useEffect, useState } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router';
import { Sidebar } from '../components/Sidebar';
import { useAuthStore } from '../stores/auth';
import { useTmuxStore } from '../stores/tmux';

export function RootLayout() {
  const { isAuthenticated, checkAuth } = useAuthStore();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const location = useLocation();
  const ensureSocketConnected = useTmuxStore((state) => state.ensureSocketConnected);

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
      <div className="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden">
        {/* 顶部栏（移动端） */}
        {isMobile && (
          <header className="flex items-center justify-between px-4 py-3 bg-[var(--color-bg-secondary)] border-b border-[var(--color-border)] flex-shrink-0">
            <button
              type="button"
              onClick={() => setSidebarOpen(true)}
              className="p-2 -ml-2 rounded hover:bg-[var(--color-bg-tertiary)]"
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
            <span className="font-medium">tmex</span>
            <div className="w-8" />
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
