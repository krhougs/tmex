import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode, Suspense, lazy, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Outlet, RouterProvider, createBrowserRouter, useParams } from 'react-router';
import { Toaster } from 'sonner';
import './i18n';
import './index.css';

import { GlobalDeviceProvider } from '@/components/global-device-provider';
import { AppSidebar } from '@/components/page-layouts/components/app-sidebar';
import { RightPanel, RightPanelProvider, RightPanelTrigger } from '@/components/ui/right-panel';
import { Separator } from '@/components/ui/separator';
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { WatchEventsInit } from '@/components/watch/watch-events-init';
import { useVirtualKeyboardOffset } from '@/hooks/use-virtual-keyboard-offset';

const AgentPanel = lazy(() =>
  import('@/components/agent-panel').then((m) => ({ default: m.AgentPanel }))
);

function applyInitialTheme(): void {
  try {
    const raw = localStorage.getItem('tmex-ui');
    if (!raw) {
      document.documentElement.classList.add('dark');
      return;
    }

    const parsed = JSON.parse(raw) as { state?: { theme?: unknown } } | null;
    const theme = parsed?.state?.theme;
    const isDark = theme === 'dark' || theme === undefined;
    document.documentElement.classList.toggle('dark', isDark);
  } catch {
    document.documentElement.classList.add('dark');
  }
}

applyInitialTheme();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5000,
      retry: 1,
    },
  },
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PageModule = Record<string, any>;

// Root layout: 包含全局 Provider 和 Sidebar
function RootLayout() {
  // Android 等平台虚拟键盘只缩小 visual viewport，固定布局下会盖住下半屏，
  // 用 translateY 整体平移避让。transform 不参与布局，不会触发终端容器的
  // ResizeObserver。offset 为 0 时必须移除 transform：非 none 的 transform
  // 会成为 fixed 后代的 containing block，破坏 iOS editor dock 的定位。
  const keyboardOffset = useVirtualKeyboardOffset();

  return (
    <GlobalDeviceProvider>
      <WatchEventsInit />
      <SidebarProvider>
        <AppSidebar />
        <RightPanelProvider>
          <SidebarInset
            className="h-dvh overflow-hidden"
            style={
              keyboardOffset > 0
                ? {
                    transform: `translateY(-${keyboardOffset}px)`,
                    transition: 'transform 0.12s ease-out',
                  }
                : undefined
            }
          >
            <div className="h-[var(--tmex-safe-area-top)]" />
            <Outlet />
            <div className="h-[var(--tmex-safe-area-bottom)]" />
          </SidebarInset>
          {/* 桌面端 fixed 容器在 SidebarInset 的 transform 之外，不受虚拟键盘避让影响 */}
          <RightPanel>
            <Suspense fallback={null}>
              <AgentPanel />
            </Suspense>
          </RightPanel>
        </RightPanelProvider>
      </SidebarProvider>
    </GlobalDeviceProvider>
  );
}

// Page wrapper: 处理 header、title、actions 和动态加载
function PageWrapper({ moduleLoader }: { moduleLoader: () => Promise<PageModule> }) {
  const [module, setModule] = useState<PageModule | null>(null);
  const params = useParams();

  useEffect(() => {
    moduleLoader().then(setModule);
  }, [moduleLoader]);

  const Page = module?.default;
  const PageTitle = module?.PageTitle;
  const PageActions = module?.PageActions;

  return (
    <>
      <header
        className="sticky top-0 z-10 flex h-12 md:h-16 shrink-0 items-center justify-between gap-2 bg-background/95 backdrop-blur-sm"
        data-testid="mobile-topbar"
      >
        <div className="flex min-w-0 flex-1 items-center gap-2 px-4">
          <SidebarTrigger className="-ml-1 shrink-0" data-testid="mobile-sidebar-open" />
          <Separator
            orientation="vertical"
            className="mr-2 shrink-0 data-[orientation=vertical]:h-4"
          />
          <span className="min-w-0 flex-1 truncate text-sm font-semibold">
            {PageTitle ? <PageTitle {...params} /> : ''}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1 px-4">
          {PageActions && <PageActions {...params} />}
          <RightPanelTrigger />
        </div>
      </header>

      {/* Page content */}
      <div className="flex min-h-0 flex-1 flex-col gap-4 !pt-0 p-2 md:p-4 mb-2">
        <div className="bg-muted/50 min-h-0 flex-1 overflow-auto overscroll-auto rounded-xl [-webkit-overflow-scrolling:touch]">
          {Page ? <Page /> : null}
        </div>
      </div>
    </>
  );
}

// Lazy load page modules
const settingsModule = () => import('./pages/SettingsPage');
const devicesModule = () => import('./pages/DevicesPage');
const deviceModule = () => import('./pages/DevicePage');

// 路由配置 - Data 模式
const router = createBrowserRouter([
  {
    path: '/',
    Component: RootLayout,
    children: [
      {
        index: true,
        element: <PageWrapper moduleLoader={devicesModule} />,
      },
      {
        path: 'devices',
        element: <PageWrapper moduleLoader={devicesModule} />,
      },
      {
        path: 'devices/:deviceId',
        element: <PageWrapper moduleLoader={deviceModule} />,
      },
      {
        path: 'devices/:deviceId/windows/:windowId/panes/:paneId',
        element: <PageWrapper moduleLoader={deviceModule} />,
      },
      {
        path: 'settings',
        element: <PageWrapper moduleLoader={settingsModule} />,
      },
    ],
  },
]);

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Root element not found');
}

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <Toaster
        richColors
        position="top-right"
        closeButton
        offset={{
          top: 'calc(16px + var(--tmex-safe-area-top))',
          right: '16px',
          bottom: '16px',
          left: '16px',
        }}
        mobileOffset={{
          top: 'calc(12px + var(--tmex-safe-area-top))',
          right: '12px',
          bottom: '12px',
          left: '12px',
        }}
        toastOptions={{
          duration: 6000,
        }}
      />
    </QueryClientProvider>
  </StrictMode>
);
