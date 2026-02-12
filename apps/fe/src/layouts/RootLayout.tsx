import { useQuery } from '@tanstack/react-query';
import type { Device } from '@tmex/shared';
import { ArrowDownToLine, Keyboard, Smartphone } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Outlet, useLocation, useMatch, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { Sidebar } from '../components/Sidebar';
import { useSiteStore } from '../stores/site';
import { useUIStore } from '../stores/ui';
import { buildTerminalLabel } from '../utils/terminalMeta';
import { decodePaneIdFromUrlParam } from '../utils/tmuxUrl';
import { useTmuxStore } from '../stores/tmux';
import i18next from 'i18next';

declare global {
  interface WindowEventMap {
    'tmex:sonner': CustomEvent<{
      title: string;
      description?: string;
      paneUrl?: string;
    }>;
  }
}

function isIOSMobileBrowser(): boolean {
  if (typeof navigator === 'undefined') {
    return false;
  }

  const userAgent = navigator.userAgent;
  const isIOSDevice = /iPad|iPhone|iPod/.test(userAgent);
  const isTouchMac = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  return isIOSDevice || isTouchMac;
}

function isStandaloneDisplayMode(): boolean {
  const standaloneByNavigator =
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  const standaloneByMedia =
    typeof window !== 'undefined' &&
    window.matchMedia?.('(display-mode: standalone)').matches === true;
  return standaloneByNavigator || standaloneByMedia;
}

function isIOSChromeBrowser(): boolean {
  if (typeof navigator === 'undefined') {
    return false;
  }
  return /\bCriOS\b/i.test(navigator.userAgent);
}

export function RootLayout() {
  const { t } = useTranslation();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const navigate = useNavigate();
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
  const siteSettings = useSiteStore((state) => state.settings);
  const fetchSiteSettings = useSiteStore((state) => state.fetchSettings);

  const { data: devicesData } = useQuery({
    queryKey: ['devices'],
    queryFn: async () => {
      const res = await fetch('/api/devices');
      if (!res.ok) {
        throw new Error(t('device.loadFailed'));
      }
      return res.json() as Promise<{ devices: Device[] }>;
    },
    throwOnError: false,
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
  const normalizedPath = location.pathname.replace(/\/+$/, '') || '/';
  const isScrollableContentRoute =
    normalizedPath === '/' || normalizedPath === '/devices' || normalizedPath === '/settings';

  const canInteractWithPane = Boolean(
    isTerminalRoute && matchedPaneId && matchedDeviceConnected && matchedSelectedPane?.paneId === matchedPaneId
  );
  const rootRef = useRef<HTMLDivElement | null>(null);

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
    ensureSocketConnected();
  }, [ensureSocketConnected]);

  useEffect(() => {
    void fetchSiteSettings();
  }, [fetchSiteSettings]);

  useEffect(() => {
    if (siteSettings?.language && i18next.language !== siteSettings.language) {
      void i18next.changeLanguage(siteSettings.language);
    }
  }, [siteSettings?.language]);

  useEffect(() => {
    if (devicesData || !isTerminalRoute) {
      return;
    }

    toast.error(t('common.error'));
  }, [devicesData, isTerminalRoute, t]);

  useEffect(() => {
    document.title = siteSettings?.siteName ?? 'tmex';
  }, [siteSettings?.siteName]);

  useEffect(() => {
    if (!isIOSMobileBrowser()) {
      return;
    }
    if (isStandaloneDisplayMode()) {
      return;
    }

    const key = 'tmex:pwa:ios-install-hint-dismissed';
    let dismissed = false;
    try {
      dismissed = localStorage.getItem(key) === '1';
    } catch {
      dismissed = false;
    }
    if (dismissed) {
      return;
    }
    try {
      localStorage.setItem(key, '1');
    } catch {
      // ignore storage errors (e.g. private mode)
    }

    const description = isIOSChromeBrowser()
      ? t('common.pwaInstallHintIOSChrome')
      : t('common.pwaInstallHintIOSSafari');

    toast.custom(
      (toastId) => (
        <div className="w-full max-w-[420px] rounded-md bg-[var(--color-bg-secondary)] border border-[var(--color-border)] px-3 py-2 text-left">
          <div className="text-sm font-medium">{t('common.pwaInstallTitle')}</div>
          <div className="mt-1 text-xs text-[var(--color-text-secondary)]">{description}</div>
          <button
            type="button"
            className="mt-2 text-xs text-[var(--color-accent)]"
            onClick={() => {
              toast.dismiss(toastId);
            }}
          >
            {t('common.close')}
          </button>
        </div>
      ),
      { duration: 12_000 }
    );
  }, [t]);

  useEffect(() => {
    const root = document.documentElement;
    const updateStandaloneDataAttr = () => {
      root.dataset.tmexStandalone = isStandaloneDisplayMode() ? '1' : '0';
    };

    updateStandaloneDataAttr();

    const standaloneMedia = window.matchMedia?.('(display-mode: standalone)');
    const legacyMedia = standaloneMedia as
      | (MediaQueryList & {
        addListener?: (listener: (event: MediaQueryListEvent) => void) => void;
        removeListener?: (listener: (event: MediaQueryListEvent) => void) => void;
      })
      | undefined;

    if (standaloneMedia?.addEventListener) {
      standaloneMedia.addEventListener('change', updateStandaloneDataAttr);
    } else {
      legacyMedia?.addListener?.(updateStandaloneDataAttr);
    }

    return () => {
      if (standaloneMedia?.removeEventListener) {
        standaloneMedia.removeEventListener('change', updateStandaloneDataAttr);
      } else {
        legacyMedia?.removeListener?.(updateStandaloneDataAttr);
      }
    };
  }, []);

  useEffect(() => {
    const listener = (event: Event) => {
      const custom = event as CustomEvent<{
        title: string;
        description?: string;
        paneUrl?: string;
      }>;
      const detail = custom.detail;
      if (!detail?.title) {
        return;
      }

      const handleJump = () => {
        if (!detail.paneUrl) {
          return;
        }
        const target = new URL(detail.paneUrl, window.location.origin);
        navigate(`${target.pathname}${target.search}${target.hash}`);
      };

      if (detail.paneUrl) {
        toast.custom(
          (toastId) => (
            <button
              type="button"
              className="w-full text-left rounded-md bg-[var(--color-bg-secondary)] px-3 py-2"
              onClick={() => {
                toast.dismiss(toastId);
                handleJump();
              }}
            >
              <div className="text-sm font-medium">{detail.title}</div>
              {detail.description && (
                <div className="mt-1 text-xs text-[var(--color-text-secondary)]">{detail.description}</div>
              )}
              <div className="mt-1 text-xs text-[var(--color-accent)]">{t('notification.clickToJump')}</div>
            </button>
          ),
          {
            duration: 6000,
          }
        );
        return;
      }

      toast.info(detail.title, {
        description: detail.description,
      });
    };

    window.addEventListener('tmex:sonner', listener as EventListener);
    return () => window.removeEventListener('tmex:sonner', listener as EventListener);
  }, [navigate]);

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

  useEffect(() => {
    const body = document.body;
    const shouldGuardGesture = isMobile && isTerminalRoute;

    if (shouldGuardGesture) {
      body.classList.add('tmex-terminal-mobile-gesture-guard');
      return () => body.classList.remove('tmex-terminal-mobile-gesture-guard');
    }

    body.classList.remove('tmex-terminal-mobile-gesture-guard');
    return undefined;
  }, [isMobile, isTerminalRoute]);

  useEffect(() => {
    if (!(isMobile && isTerminalRoute)) {
      return;
    }

    const root = rootRef.current;
    if (!root) {
      return;
    }

    let startY = 0;

    const findScrollContainer = (node: EventTarget | null): HTMLElement | null => {
      if (!(node instanceof HTMLElement)) {
        return null;
      }

      let current: HTMLElement | null = node;
      while (current && current !== root) {
        const style = window.getComputedStyle(current);
        const scrollable = /(auto|scroll)/.test(style.overflowY);
        if (scrollable && current.scrollHeight > current.clientHeight) {
          return current;
        }
        current = current.parentElement;
      }

      return null;
    };

    const handleTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        return;
      }
      startY = event.touches[0]?.clientY ?? 0;
    };

    const handleTouchMove = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        return;
      }

      const currentY = event.touches[0]?.clientY ?? 0;
      const deltaY = currentY - startY;

      if (deltaY <= 0) {
        return;
      }

      const scrollContainer = findScrollContainer(event.target);
      const containerAtTop = !scrollContainer || scrollContainer.scrollTop <= 0;
      if (containerAtTop) {
        event.preventDefault();
      }
    };

    root.addEventListener('touchstart', handleTouchStart, { passive: true });
    root.addEventListener('touchmove', handleTouchMove, { passive: false });

    return () => {
      root.removeEventListener('touchstart', handleTouchStart);
      root.removeEventListener('touchmove', handleTouchMove);
    };
  }, [isMobile, isTerminalRoute]);

  useEffect(() => {
    const HEIGHT_DELTA_THRESHOLD_PX = 2;
    const OFFSET_DELTA_THRESHOLD_PX = 1;
    const IOS_STANDALONE_KEYBOARD_THRESHOLD_PX = 80;
    let frameId: number | null = null;
    let shouldSyncHeightInNextFrame = false;
    let lastAppliedHeight: number | null = null;
    let lastAppliedOffsetTop: number | null = null;

    const applyViewportVars = (syncHeight: boolean) => {
      const layoutHeight = window.innerHeight;
      const viewport = window.visualViewport;
      const rawOffsetTop = viewport?.offsetTop ?? 0;

      if (syncHeight) {
        const visualHeight = viewport?.height ?? layoutHeight;
        let rawHeight = visualHeight;

        if (viewport && isStandaloneDisplayMode()) {
          const gap = layoutHeight - (visualHeight + rawOffsetTop);
          if (gap >= 0 && gap <= IOS_STANDALONE_KEYBOARD_THRESHOLD_PX) {
            rawHeight = layoutHeight - rawOffsetTop;
          }
        }

        if (!Number.isFinite(rawHeight) || rawHeight <= 0) {
          return;
        }

        const nextHeight = Math.round(rawHeight);
        if (
          lastAppliedHeight === null ||
          Math.abs(nextHeight - lastAppliedHeight) >= HEIGHT_DELTA_THRESHOLD_PX
        ) {
          lastAppliedHeight = nextHeight;
          document.documentElement.style.setProperty('--tmex-viewport-height', `${nextHeight}px`);
        }
      }

      if (!Number.isFinite(rawOffsetTop)) {
        return;
      }

      const nextOffsetTop = Math.max(0, Math.round(rawOffsetTop));
      if (
        lastAppliedOffsetTop !== null &&
        Math.abs(nextOffsetTop - lastAppliedOffsetTop) < OFFSET_DELTA_THRESHOLD_PX
      ) {
        return;
      }

      lastAppliedOffsetTop = nextOffsetTop;
      document.documentElement.style.setProperty('--tmex-viewport-offset-top', `${nextOffsetTop}px`);
    };

    const scheduleViewportVarSync = (syncHeight: boolean) => {
      shouldSyncHeightInNextFrame ||= syncHeight;
      if (frameId !== null) {
        return;
      }

      frameId = window.requestAnimationFrame(() => {
        const shouldSyncHeight = shouldSyncHeightInNextFrame;
        shouldSyncHeightInNextFrame = false;
        frameId = null;
        applyViewportVars(shouldSyncHeight);
      });
    };

    applyViewportVars(true);

    const handleResizeSync = () => scheduleViewportVarSync(true);
    const handleOffsetSync = () => scheduleViewportVarSync(false);

    window.addEventListener('resize', handleResizeSync);
    window.visualViewport?.addEventListener('resize', handleResizeSync);
    window.visualViewport?.addEventListener('scroll', handleOffsetSync);

    return () => {
      window.removeEventListener('resize', handleResizeSync);
      window.visualViewport?.removeEventListener('resize', handleResizeSync);
      window.visualViewport?.removeEventListener('scroll', handleOffsetSync);
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
    };
  }, []);

  return (
    <div
      ref={rootRef}
      className="flex h-[100vh] w-screen overflow-hidden bg-[var(--color-bg)]"
    >
      {/* 移动端遮罩 */}
      {isMobile && sidebarOpen && (
        <button
          type="button"
          data-testid="mobile-sidebar-overlay"
          aria-label={t('nav.closeSidebar')}
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
      <div
        className={`flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden ${isMobile ? 'tmex-mobile-topbar-spacer' : ''
          }`}
      >
        {/* 顶部栏（移动端固定单行） */}
        {isMobile && (
          <header
            data-testid="mobile-topbar"
            className="tmex-mobile-topbar fixed top-0 left-0 right-0 z-[120] bg-[var(--color-bg-secondary)] border-b border-[var(--color-border)]"
          >
            <div className="h-11 flex items-center justify-between gap-2">
              <button
                type="button"
                data-testid="mobile-sidebar-open"
                onClick={() => setSidebarOpen(true)}
                className="h-7 w-7 inline-flex items-center justify-center -ml-1 rounded hover:bg-[var(--color-bg-tertiary)]"
                aria-label={t('nav.openSidebar')}
                title={t('nav.openSidebar')}
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
                title={mobileTerminalLabel ?? siteSettings?.siteName ?? 'tmex'}
              >
                {mobileTerminalLabel ?? siteSettings?.siteName ?? 'tmex'}
              </span>

              <div className="flex items-center gap-1.5 flex-shrink-0">
                <button
                  type="button"
                  data-testid="terminal-input-mode-toggle"
                  onClick={handleToggleInputMode}
                  className="h-7 w-7 inline-flex items-center justify-center rounded hover:bg-[var(--color-bg-tertiary)]"
                  aria-label={inputMode === 'direct' ? t('nav.switchToEditor') : t('nav.switchToDirect')}
                  title={inputMode === 'direct' ? t('nav.switchToEditor') : t('nav.switchToDirect')}
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
                  data-testid="terminal-jump-latest"
                  onClick={handleJumpToLatest}
                  className="h-7 w-7 inline-flex items-center justify-center rounded hover:bg-[var(--color-bg-tertiary)]"
                  aria-label={t('nav.jumpToLatest')}
                  title={t('nav.jumpToLatest')}
                  disabled={!canInteractWithPane}
                >
                  <ArrowDownToLine className="h-4 w-4" />
                </button>
              </div>
            </div>
          </header>
        )}

        {/* 内容 */}
        <main
          className={`flex-1 min-w-0 min-h-0 ${isScrollableContentRoute ? 'overflow-y-auto' : 'overflow-hidden'} ${isMobile && isTerminalRoute ? 'overscroll-none' : ''
            }`}
        >
          <Outlet />
        </main>
      </div>
    </div>
  );
}
