import { useEffect, useRef } from 'react';

export function useMobileTouch(containerRef: React.RefObject<HTMLElement | null>) {
  const isActiveRef = useRef(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const isMobile = window.innerWidth < 768 || 'ontouchstart' in window;
    if (!isMobile) return;

    isActiveRef.current = true;
    let startY = 0;
    let viewport: HTMLElement | null = container.querySelector('.xterm-viewport');
    let observer: MutationObserver | null = null;

    const handleTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) return;
      startY = event.touches[0]?.clientY ?? 0;
    };

    const handleTouchMove = (event: TouchEvent) => {
      if (event.touches.length !== 1) return;
      const currentY = event.touches[0]?.clientY ?? 0;
      const deltaY = currentY - startY;
      if (deltaY <= 0) return;

      const target = event.currentTarget;
      if (!(target instanceof HTMLElement)) return;
      if (!event.cancelable) return;
      if (target.scrollTop <= 0) {
        event.preventDefault();
      }
    };

    const attach = (el: HTMLElement) => {
      el.addEventListener('touchstart', handleTouchStart, { passive: true });
      el.addEventListener('touchmove', handleTouchMove, { passive: false });
    };

    const detach = (el: HTMLElement) => {
      el.removeEventListener('touchstart', handleTouchStart);
      el.removeEventListener('touchmove', handleTouchMove);
    };

    if (viewport) {
      attach(viewport);
    } else {
      observer = new MutationObserver(() => {
        const el = container.querySelector('.xterm-viewport');
        if (!(el instanceof HTMLElement)) return;
        viewport = el;
        attach(el);
        observer?.disconnect();
        observer = null;
      });
      observer.observe(container, { childList: true });
    }

    return () => {
      isActiveRef.current = false;
      if (viewport) detach(viewport);
      observer?.disconnect();
    };
  }, [containerRef]);

  return isActiveRef;
}
