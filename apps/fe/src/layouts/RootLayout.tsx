import { Outlet, Navigate, useLocation } from 'react-router';
import { useState, useEffect } from 'react';
import { Sidebar } from '../components/Sidebar';
import { useAuthStore } from '../stores/auth';

export function RootLayout() {
  const { isAuthenticated, checkAuth } = useAuthStore();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const location = useLocation();
  
  useEffect(() => {
    checkAuth();
  }, [checkAuth]);
  
  // 认证检查中
  if (isAuthenticated === null) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="text-text-secondary">Loading...</div>
      </div>
    );
  }
  
  // 未认证，跳转到登录页
  if (!isAuthenticated) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }
  
  const isMobile = typeof window !== 'undefined' && window.innerWidth < 768;
  
  return (
    <div className="flex h-screen overflow-hidden">
      {/* 移动端遮罩 */}
      {isMobile && (
        <div
          className={`sidebar-overlay ${sidebarOpen ? 'open' : ''}`}
          onClick={() => setSidebarOpen(false)}
        />
      )}
      
      {/* 侧边栏 */}
      <Sidebar
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />
      
      {/* 主内容区 */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* 顶部栏（移动端） */}
        {isMobile && (
          <header className="flex items-center justify-between px-4 py-3 bg-bg-secondary border-b border-border">
            <button
              onClick={() => setSidebarOpen(true)}
              className="p-2 -ml-2 rounded hover:bg-bg-tertiary"
            >
              <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
                <path d="M3 5h14v2H3V5zm0 4h14v2H3V9zm0 4h14v2H3v-2z" />
              </svg>
            </button>
            <span className="font-medium">tmex</span>
            <div className="w-8" />
          </header>
        )}
        
        {/* 内容 */}
        <main className="flex-1 overflow-hidden">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
