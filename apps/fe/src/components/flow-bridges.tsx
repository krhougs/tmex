import { useSidebar } from '@/components/ui/sidebar';
import { setNavigateBridge, setSidebarBridge } from '@/lib/flow-bridges';
import { useEffect } from 'react';
import { useNavigate } from 'react-router';

// 注册 navigate / sidebar 桥接。必须挂在 RouterProvider + SidebarProvider 内（如 RootLayout）。
export function FlowBridges() {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();

  useEffect(() => {
    setNavigateBridge((to, opts) => navigate(to, opts ?? {}));
    return () => setNavigateBridge(null);
  }, [navigate]);

  useEffect(() => {
    setSidebarBridge({ isMobile, setOpenMobile });
    return () => setSidebarBridge(null);
  }, [isMobile, setOpenMobile]);

  return null;
}
