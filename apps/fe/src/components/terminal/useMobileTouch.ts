import { useEffect, useRef } from 'react';

interface TerminalScroller {
  scrollLines: (amount: number) => void;
  handleViewportGesture?: (gesture: {
    source: 'touch';
    deltaY: number;
    clientX: number;
    clientY: number;
  }) => boolean;
  buffer?: {
    active?: {
      viewportY?: number;
    };
  };
}

const TOUCH_SCROLL_GAIN = 1.3;
const SCROLLBAR_TOUCH_HOTZONE_PX = 36;

export function useMobileTouch(
  containerRef: React.RefObject<HTMLElement | null>,
  getTerminal?: () => TerminalScroller | null
) {
  const isActiveRef = useRef(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const isMobile =
      window.innerWidth < 768 || navigator.maxTouchPoints > 0 || 'ontouchstart' in window;
    if (!isMobile) return;

    isActiveRef.current = true;
    let lastTouchY = 0;
    let touchId: number | null = null;
    let bypassCustomScroll = false;
    let pendingPixelDelta = 0;

    const isScrollbarElement = (target: Element | null): boolean => {
      if (!target) return false;
      return Boolean(
        target.closest('.scrollbar') ||
          target.closest('.slider') ||
          target.closest('.xterm-scroll-area')
      );
    };

    const shouldBypassCustomScroll = (
      clientX: number,
      clientY: number,
      eventTarget: EventTarget | null
    ): boolean => {
      const directTarget = eventTarget instanceof Element ? eventTarget : null;
      if (isScrollbarElement(directTarget)) {
        return true;
      }

      const pointTarget = document.elementFromPoint(clientX, clientY);
      if (isScrollbarElement(pointTarget)) {
        return true;
      }

      const xtermRoot = container.querySelector('.xterm');
      if (!(xtermRoot instanceof HTMLElement)) {
        return false;
      }

      const rect = xtermRoot.getBoundingClientRect();
      const insideX = clientX >= rect.left && clientX <= rect.right;
      const insideY = clientY >= rect.top && clientY <= rect.bottom;
      if (!insideX || !insideY) {
        return false;
      }

      return clientX >= rect.right - SCROLLBAR_TOUCH_HOTZONE_PX;
    };

    const findScrollTargets = (): HTMLElement[] => {
      const candidates = [
        container.querySelector('.xterm-viewport'),
        container.querySelector('.xterm-scrollable-element'),
      ];

      return candidates.filter((el): el is HTMLElement => el instanceof HTMLElement);
    };

    const findTouchById = (touchList: TouchList): Touch | null => {
      if (touchId === null) return null;
      for (let i = 0; i < touchList.length; i += 1) {
        const touch = touchList.item(i);
        if (touch && touch.identifier === touchId) {
          return touch;
        }
      }
      return null;
    };

    const handleTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) return;
      const touch = event.touches.item(0);
      if (!touch) return;

      touchId = touch.identifier;
      lastTouchY = touch.clientY;
      pendingPixelDelta = 0;
      bypassCustomScroll = shouldBypassCustomScroll(touch.clientX, touch.clientY, event.target);
    };

    const handleTouchMove = (event: TouchEvent) => {
      const touch = findTouchById(event.touches) ?? event.touches.item(0);
      if (!touch) return;
      if (!bypassCustomScroll) {
        bypassCustomScroll = shouldBypassCustomScroll(touch.clientX, touch.clientY, event.target);
        if (bypassCustomScroll) {
          pendingPixelDelta = 0;
        }
      }
      if (bypassCustomScroll) return;

      const currentY = touch.clientY;
      const deltaY = lastTouchY - currentY;
      lastTouchY = currentY;

      if (deltaY === 0) return;

      let didScroll = false;
      let atTopWhilePullingDown = false;
      const terminal = getTerminal?.() ?? null;

      if (terminal) {
        const core = (terminal as any)?._core;
        const lineHeight = core?._renderService?.dimensions?.css?.cell?.height ?? 18;
        pendingPixelDelta += deltaY * TOUCH_SCROLL_GAIN;
        const linesToScroll =
          pendingPixelDelta > 0
            ? Math.floor(pendingPixelDelta / lineHeight)
            : Math.ceil(pendingPixelDelta / lineHeight);

        if (typeof terminal.handleViewportGesture === 'function') {
          if (linesToScroll !== 0) {
            didScroll = terminal.handleViewportGesture({
              source: 'touch',
              deltaY: linesToScroll * lineHeight,
              clientX: touch.clientX,
              clientY: touch.clientY,
            });
            pendingPixelDelta -= linesToScroll * lineHeight;
          }
        } else {
          if (linesToScroll !== 0) {
            const beforeViewportY = terminal.buffer?.active?.viewportY ?? 0;
            terminal.scrollLines(linesToScroll);
            const afterViewportY = terminal.buffer?.active?.viewportY ?? 0;
            didScroll = beforeViewportY !== afterViewportY;
            atTopWhilePullingDown = linesToScroll < 0 && beforeViewportY <= 0 && afterViewportY <= 0;
            pendingPixelDelta -= linesToScroll * lineHeight;
          }
        }
      } else {
        const scrollTargets = findScrollTargets();
        if (scrollTargets.length === 0) return;

        for (const target of scrollTargets) {
          const previousScrollTop = target.scrollTop;
          target.scrollTop += deltaY;
          const nextScrollTop = target.scrollTop;

          if (Math.abs(nextScrollTop - previousScrollTop) > 0) {
            didScroll = true;
          }
          if (deltaY < 0 && nextScrollTop <= 0) {
            atTopWhilePullingDown = true;
          }
        }
        if (!didScroll) {
          const xtermRoot = container.querySelector('.xterm');
          if (xtermRoot instanceof HTMLElement) {
            const wheelEvent = new WheelEvent('wheel', {
              bubbles: true,
              cancelable: true,
              deltaMode: WheelEvent.DOM_DELTA_PIXEL,
              deltaY,
            });
            const dispatched = xtermRoot.dispatchEvent(wheelEvent);
            didScroll = wheelEvent.defaultPrevented || !dispatched;
          }
        }
      }

      if (!event.cancelable) return;
      if (didScroll || atTopWhilePullingDown) {
        event.preventDefault();
      }
    };

    const handleTouchEnd = (event: TouchEvent) => {
      if (touchId === null) return;
      const endedTouch = findTouchById(event.changedTouches);
      if (!endedTouch) return;
      touchId = null;
      pendingPixelDelta = 0;
      bypassCustomScroll = false;
    };

    container.addEventListener('touchstart', handleTouchStart, { passive: true });
    container.addEventListener('touchmove', handleTouchMove, { passive: false });
    container.addEventListener('touchend', handleTouchEnd, { passive: true });
    container.addEventListener('touchcancel', handleTouchEnd, { passive: true });

    return () => {
      isActiveRef.current = false;
      container.removeEventListener('touchstart', handleTouchStart);
      container.removeEventListener('touchmove', handleTouchMove);
      container.removeEventListener('touchend', handleTouchEnd);
      container.removeEventListener('touchcancel', handleTouchEnd);
    };
  }, [containerRef, getTerminal]);

  return isActiveRef;
}
