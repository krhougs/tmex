import * as React from 'react';

import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { useIsMobile } from '@/hooks/use-mobile';
import { cn } from '@/lib/utils';
import { PanelRightIcon } from 'lucide-react';

const RIGHT_PANEL_COOKIE_NAME = 'agent_panel_state';
const RIGHT_PANEL_COOKIE_MAX_AGE = 60 * 60 * 24 * 7;
const RIGHT_PANEL_WIDTH_MOBILE = '100vw';
const RIGHT_PANEL_KEYBOARD_SHORTCUT = 'j';
const RIGHT_PANEL_WIDTH_DEFAULT_PX = 360;
const RIGHT_PANEL_WIDTH_MIN_PX = 280;
const RIGHT_PANEL_WIDTH_MAX_PX = 640;
const RIGHT_PANEL_WIDTH_STORAGE_KEY = 'tmex_agent_panel_width';

function clampRightPanelWidth(value: number) {
  return Math.min(RIGHT_PANEL_WIDTH_MAX_PX, Math.max(RIGHT_PANEL_WIDTH_MIN_PX, Math.round(value)));
}

function readRightPanelCookie(): boolean | undefined {
  if (typeof document === 'undefined') return undefined;
  const match = document.cookie
    .split('; ')
    .find((row) => row.startsWith(`${RIGHT_PANEL_COOKIE_NAME}=`));
  if (!match) return undefined;
  return match.split('=')[1] === 'true';
}

type RightPanelContextProps = {
  state: 'expanded' | 'collapsed';
  open: boolean;
  setOpen: (open: boolean) => void;
  openMobile: boolean;
  setOpenMobile: (open: boolean) => void;
  isMobile: boolean;
  togglePanel: () => void;
  width: number;
  setWidth: (width: number) => void;
  resetWidth: () => void;
  isResizing: boolean;
  setIsResizing: (resizing: boolean) => void;
};

const RightPanelContext = React.createContext<RightPanelContextProps | null>(null);

function useRightPanel() {
  const context = React.useContext(RightPanelContext);
  if (!context) {
    throw new Error('useRightPanel must be used within a RightPanelProvider.');
  }

  return context;
}

function RightPanelProvider({
  defaultOpen = false,
  open: openProp,
  onOpenChange: setOpenProp,
  children,
}: {
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children?: React.ReactNode;
}) {
  const isMobile = useIsMobile();
  const [openMobile, setOpenMobile] = React.useState(false);

  const [width, _setWidth] = React.useState<number>(() => {
    if (typeof window === 'undefined') return RIGHT_PANEL_WIDTH_DEFAULT_PX;
    const stored = Number(window.localStorage.getItem(RIGHT_PANEL_WIDTH_STORAGE_KEY));
    return Number.isFinite(stored) && stored > 0
      ? clampRightPanelWidth(stored)
      : RIGHT_PANEL_WIDTH_DEFAULT_PX;
  });
  const [isResizing, setIsResizing] = React.useState(false);

  const setWidth = React.useCallback((value: number) => {
    const next = clampRightPanelWidth(value);
    _setWidth(next);
    window.localStorage.setItem(RIGHT_PANEL_WIDTH_STORAGE_KEY, String(next));
  }, []);

  const resetWidth = React.useCallback(() => {
    _setWidth(RIGHT_PANEL_WIDTH_DEFAULT_PX);
    window.localStorage.removeItem(RIGHT_PANEL_WIDTH_STORAGE_KEY);
  }, []);

  const [_open, _setOpen] = React.useState(() => readRightPanelCookie() ?? defaultOpen);
  const open = openProp ?? _open;
  const setOpen = React.useCallback(
    (value: boolean | ((value: boolean) => boolean)) => {
      const openState = typeof value === 'function' ? value(open) : value;
      if (setOpenProp) {
        setOpenProp(openState);
      } else {
        _setOpen(openState);
      }

      document.cookie = `${RIGHT_PANEL_COOKIE_NAME}=${openState}; path=/; max-age=${RIGHT_PANEL_COOKIE_MAX_AGE}`;
    },
    [setOpenProp, open]
  );

  const togglePanel = React.useCallback(() => {
    return isMobile ? setOpenMobile((open) => !open) : setOpen((open) => !open);
  }, [isMobile, setOpen]);

  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) {
        return;
      }
      // 终端聚焦时按键归终端，不触发面板快捷键
      if (event.target instanceof HTMLElement && event.target.closest('.xterm')) {
        return;
      }
      if (event.key === RIGHT_PANEL_KEYBOARD_SHORTCUT && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        togglePanel();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [togglePanel]);

  const state = open ? 'expanded' : 'collapsed';

  const contextValue = React.useMemo<RightPanelContextProps>(
    () => ({
      state,
      open,
      setOpen,
      isMobile,
      openMobile,
      setOpenMobile,
      togglePanel,
      width,
      setWidth,
      resetWidth,
      isResizing,
      setIsResizing,
    }),
    [
      state,
      open,
      setOpen,
      isMobile,
      openMobile,
      togglePanel,
      width,
      setWidth,
      resetWidth,
      isResizing,
    ]
  );

  return <RightPanelContext.Provider value={contextValue}>{children}</RightPanelContext.Provider>;
}

function RightPanel({ className, children, ...props }: React.ComponentProps<'div'>) {
  const { isMobile, state, openMobile, setOpenMobile, width, isResizing } = useRightPanel();

  if (isMobile) {
    return (
      <Sheet open={openMobile} onOpenChange={setOpenMobile} {...props}>
        <SheetContent
          data-slot="right-panel"
          data-mobile="true"
          data-testid="mobile-right-panel-sheet"
          showCloseButton={false}
          className="bg-background text-foreground p-0"
          style={
            {
              '--right-panel-width': RIGHT_PANEL_WIDTH_MOBILE,
              width: RIGHT_PANEL_WIDTH_MOBILE,
              maxWidth: RIGHT_PANEL_WIDTH_MOBILE,
            } as React.CSSProperties
          }
          side="right"
        >
          <SheetHeader className="sr-only">
            <SheetTitle>Agent Panel</SheetTitle>
            <SheetDescription>Displays the agent panel.</SheetDescription>
          </SheetHeader>
          <div
            className="flex h-full w-full flex-col"
            data-testid="right-panel"
            style={{
              paddingTop: 'var(--tmex-safe-area-top)',
              paddingBottom: 'var(--tmex-safe-area-bottom)',
            }}
          >
            {children}
          </div>
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <div
      className="group/right-panel text-foreground hidden md:block"
      data-state={state}
      data-slot="right-panel"
      style={{ '--right-panel-width': `${width}px` } as React.CSSProperties}
    >
      {/* 桌面端占位 gap，收起时宽度归零 */}
      <div
        data-slot="right-panel-gap"
        className={cn(
          !isResizing && 'transition-[width] duration-200 ease-linear',
          'relative w-(--right-panel-width) bg-transparent',
          'group-data-[state=collapsed]/right-panel:w-0'
        )}
      />
      <div
        data-slot="right-panel-container"
        className={cn(
          !isResizing && 'transition-[right,width] duration-200 ease-linear',
          'fixed inset-y-0 right-0 z-10 hidden h-svh w-(--right-panel-width) border-l md:flex',
          'group-data-[state=collapsed]/right-panel:right-[calc(var(--right-panel-width)*-1)]',
          className
        )}
        {...props}
      >
        <div
          data-slot="right-panel-inner"
          data-testid="right-panel"
          className="bg-background flex size-full flex-col"
          style={{ paddingBottom: 'var(--tmex-safe-area-bottom)' }}
        >
          {children}
        </div>
        {state === 'expanded' && <RightPanelResizer />}
      </div>
    </div>
  );
}

function RightPanelResizer() {
  const { width, setWidth, resetWidth, setIsResizing } = useRightPanel();
  const dragStateRef = React.useRef<{
    pointerId: number;
    startX: number;
    startWidth: number;
  } | null>(null);

  return (
    <div
      data-slot="right-panel-resizer"
      data-testid="right-panel-resizer"
      aria-hidden="true"
      className={cn(
        'absolute inset-y-0 z-30 w-2 cursor-col-resize touch-none select-none',
        'after:absolute after:inset-y-0 after:w-[2px] after:bg-transparent hover:after:bg-border active:after:bg-border',
        '-left-1 after:left-[3px]'
      )}
      onPointerDown={(event) => {
        event.preventDefault();
        dragStateRef.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startWidth: width,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
        setIsResizing(true);
      }}
      onPointerMove={(event) => {
        const drag = dragStateRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        const delta = event.clientX - drag.startX;
        setWidth(drag.startWidth - delta);
      }}
      onPointerUp={(event) => {
        if (dragStateRef.current?.pointerId !== event.pointerId) return;
        dragStateRef.current = null;
        setIsResizing(false);
      }}
      onPointerCancel={(event) => {
        if (dragStateRef.current?.pointerId !== event.pointerId) return;
        dragStateRef.current = null;
        setIsResizing(false);
      }}
      onDoubleClick={resetWidth}
    />
  );
}

function RightPanelTrigger({ className, onClick, ...props }: React.ComponentProps<typeof Button>) {
  const { togglePanel } = useRightPanel();

  return (
    <Button
      data-slot="right-panel-trigger"
      data-testid="right-panel-trigger"
      variant="ghost"
      size="icon-sm"
      className={cn(className)}
      onClick={(event) => {
        onClick?.(event);
        togglePanel();
      }}
      {...props}
    >
      <PanelRightIcon />
      <span className="sr-only">Toggle Agent Panel</span>
    </Button>
  );
}

export { RightPanel, RightPanelProvider, RightPanelResizer, RightPanelTrigger, useRightPanel };
