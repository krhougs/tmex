import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { formatDisplayVersion } from '@tmex/shared';
import { type CSSProperties, StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Outlet, RouterProvider, createBrowserRouter, useParams } from 'react-router';
import { Toaster } from 'sonner';
import { i18nReady } from './i18n';
import './index.css';

// 浏览器 console 打印 monorepo 版本（非 production 带 _dev 后缀）
console.info(`tmex ${formatDisplayVersion(__MONOREPO_VERSION__, __IS_PROD__)}`);

import { ConnectionIndicator } from '@/components/connection-indicator';
import { FlowBridges } from '@/components/flow-bridges';
import { GlobalDeviceProvider } from '@/components/global-device-provider';
import { AppSidebar } from '@/components/page-layouts/components/app-sidebar';
import { Separator } from '@/components/ui/separator';
import { SidebarInset, SidebarProvider, SidebarTrigger, useSidebar } from '@/components/ui/sidebar';
import { WatchEventsInit } from '@/components/watch/watch-events-init';
import { useKeyboardAvoidance } from '@/hooks/use-keyboard-avoidance';
import { useAppMonoFont } from '@/lib/fonts/useAppMonoFont';
import { useUIStore } from '@/stores/ui';

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

// iOS 26+ standalone: Safari 从 body 背景色推导状态栏颜色。
// Android Chrome: 从 <meta name="theme-color"> 读取，支持运行时动态修改。
// 侧边栏（mobile Sheet）展开时切到 --sidebar，关闭时回到 --background。
function StatusBarSync() {
  const { openMobile } = useSidebar();
  const theme = useUIStore((state) => state.theme);

  useEffect(() => {
    const cssVar = openMobile ? '--sidebar' : '--background';
    document.body.style.backgroundColor = `var(${cssVar})`;

    const updateMeta = () => {
      const computed = getComputedStyle(document.body).backgroundColor;
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', computed);
    };

    requestAnimationFrame(updateMeta);
  }, [openMobile, theme]);

  return null;
}

// Toaster 跟随 app 主题（默认未设 theme 时 sonner 固定浅色，暗色模式下卡片会是白底）。
function ThemedToaster() {
  const theme = useUIStore((state) => state.theme);
  return (
    <Toaster
      theme={theme}
      richColors
      position="top-right"
      closeButton
      offset={{
        top: 'calc(16px + env(safe-area-inset-top, 0px))',
        right: '16px',
        bottom: '16px',
        left: '16px',
      }}
      mobileOffset={{
        top: 'calc(12px + env(safe-area-inset-top, 0px))',
        right: '12px',
        bottom: '12px',
        left: '12px',
      }}
      toastOptions={{
        duration: 6000,
      }}
    />
  );
}

// Root layout: 包含全局 Provider 和 Sidebar
function RootLayout() {
  // 把选中等宽字体派生到 --font-mono（全应用统一）并按需懒加载 woff2
  useAppMonoFont();
  return (
    <GlobalDeviceProvider>
      <WatchEventsInit />
      <SidebarProvider>
        <StatusBarSync />
        <FlowBridges />
        <AppSidebar />
        <MainInset />
      </SidebarProvider>
    </GlobalDeviceProvider>
  );
}

// SidebarInset（<main>）+ 手机虚拟键盘避让（issue #27）。必须在 SidebarProvider 内部
// 才能读取 openMobile：移动端侧边栏 Sheet 打开时终端不可见，此时禁用避让可防止 portal
// 焦点切换导致的 viewport 事件竞态、transform 卡在非零值。
// 避让策略由用户在「键盘行为」设置中选择（keyboardBehaviorMode）：
//   transform=整页上移（页面平移 lift / 光标对齐 follow），不参与布局、不触发终端
//     ResizeObserver；strategy 为 none 时必须移除 transform，否则非 none transform 会成为
//     fixed 后代的 containing block，破坏 iOS editor dock 定位。
//   height=终端缩放（resize），主动收缩可用高度触发终端 ResizeObserver → tmux resize。
function MainInset() {
  const { openMobile } = useSidebar();
  const mode = useUIStore((state) => state.keyboardBehaviorMode);
  const avoidance = useKeyboardAvoidance(openMobile, mode);

  const active = avoidance.strategy !== 'none';
  const style: CSSProperties | undefined =
    avoidance.strategy === 'transform'
      ? {
          transform: `translateY(-${avoidance.offset}px)`,
          // 光标对齐逐帧跟随光标，去掉过渡以即时响应输入；其余模式用平滑过渡
          transition: mode === 'follow' ? undefined : 'transform 0.12s ease-out',
        }
      : avoidance.strategy === 'height'
        ? { height: `${avoidance.height}px`, transition: 'height 0.12s ease-out' }
        : undefined;

  return (
    <SidebarInset className="h-dvh overflow-hidden md:h-[calc(100dvh-1rem)]" style={style}>
      <Outlet />
      <div
        style={{
          height: active ? 0 : 'var(--tmex-safe-area-bottom)',
          transition: 'height 0.12s ease-out',
        }}
      />
    </SidebarInset>
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
        </div>
      </header>

      {/* Page content */}
      <div className="flex min-h-0 flex-1 flex-col gap-4 !pt-0 p-2 md:p-4">
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
const fileModule = () => import('./pages/FilePage');

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
      {
        path: 'file/:ref',
        element: <PageWrapper moduleLoader={fileModule} />,
      },
    ],
  },
]);

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Root element not found');
}

// 当前语言（及 fallback）按需异步加载，渲染前 await 以避免首屏出现未翻译的 key。
// 弱网下即便 locale chunk 加载失败也必须渲染（catch 兜底），否则整页空白比未翻译更糟。
void i18nReady.catch(() => undefined).then(() => {
  createRoot(rootElement).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
        <ConnectionIndicator />
        <ThemedToaster />
      </QueryClientProvider>
    </StrictMode>
  );
});
