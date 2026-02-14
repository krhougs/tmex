import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode, useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider, createBrowserRouter, useParams } from 'react-router';
import { Toaster } from 'sonner';
import './i18n';
import './index.css';

// Layout components
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { Separator } from '@/components/ui/separator';
import { AppSidebar } from '@/components/page-layouts/components/app-sidebar';

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

// Lazy load page modules
const settingsModule = () => import('./pages/SettingsPage');
const devicesModule = () => import('./pages/DevicesPage');
const deviceModule = () => import('./pages/DevicePage');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PageModule = Record<string, any>;

// Page wrapper that handles layout + dynamic title/actions
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
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset className="h-dvh overflow-hidden">
        <div className="h-[var(--tmex-safe-area-top)]"></div>
        <header className="sticky top-0 z-10 flex h-12 md:h-16 shrink-0 items-center justify-between gap-2 bg-background/95 backdrop-blur-sm">
          <div className="flex items-center gap-2 px-4">
            <SidebarTrigger className="-ml-1" />
            <Separator orientation="vertical" className="mr-2 data-[orientation=vertical]:h-4" />
            <span className="truncate text-sm font-semibold">
              {PageTitle ? <PageTitle {...params} /> : ''}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-1 px-4">
            {PageActions && <PageActions {...params} />}
          </div>
        </header>

        {/* Page content */}
        <div className="flex min-h-0 flex-1 flex-col gap-4 !pt-0 p-2 md:p-4 mb-2">
          <div className="bg-muted/50 min-h-0 flex-1 overflow-auto overscroll-auto rounded-xl [-webkit-overflow-scrolling:touch]">
            {Page ? <Page /> : null}
          </div>
        </div>
        <div className="h-[var(--tmex-safe-area-bottom)]"></div>
      </SidebarInset>
    </SidebarProvider>
  );
}



const router = createBrowserRouter([
  {
    path: 'settings',
    element: <PageWrapper moduleLoader={settingsModule} />,
  },
  {
    path: 'devices',
    element: <PageWrapper moduleLoader={devicesModule} />,
  },
  {
    path: 'devices/:deviceId/windows/:windowId/panes/:paneId',
    element: <PageWrapper moduleLoader={deviceModule} />,
  },
  {
    path: 'devices/:deviceId',
    element: <PageWrapper moduleLoader={deviceModule} />,
  },
  {
    path: '/',
    element: <PageWrapper moduleLoader={devicesModule} />,
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
