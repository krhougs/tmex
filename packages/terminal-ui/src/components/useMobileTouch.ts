import { useEffect, useRef } from 'react';

interface TerminalScroller {
  scrollLines: (amount: number) => void;
  handleViewportGesture?: (gesture: {
    source: 'touch';
    deltaY: number;
    clientX: number;
    clientY: number;
  }) => boolean;
  startTouchSelection?: (
    clientX: number,
    clientY: number,
    mode?: 'character' | 'word' | 'line'
  ) => boolean;
  updateTouchSelection?: (clientX: number, clientY: number) => void;
  endTouchSelection?: () => void;
  isMouseReporting?: () => boolean;
  usesNativeScrolling?: () => boolean;
  sendTouchMouseEvent?: (event: {
    action: 'press' | 'motion' | 'release';
    clientX: number;
    clientY: number;
  }) => boolean;
  noteTouchHandled?: () => void;
  focus?: () => void;
  buffer?: {
    active?: {
      viewportY?: number;
    };
  };
}

// 手势状态机（每次首指落下判定一次，全部手指抬起/取消后回 idle）：
// - idle：无手势
// - bypass：命中滚动条元素/热区，交还原生
// - scroll：非上报模式的单指滚动（原有行为）
// - pending：上报模式单指落下，尚未发出任何字节（tap/拖拽/长按/双指待定）
// - drag-pending：上报模式双指落下，等待拖拽位移
// - drag：双指拖拽，press 已发，motion 流式上报
// - wheel：单指滚动 → 鼠标滚轮上报（handleViewportGesture 编码 64/65）
// - select：长按本地 word 选择（上报/非上报共用；上报模式下是移动端的"Shift 豁免"）
type TouchGestureState =
  | 'idle'
  | 'bypass'
  | 'scroll'
  | 'pending'
  | 'drag-pending'
  | 'drag'
  | 'wheel'
  | 'select';

const TOUCH_SCROLL_GAIN = 1.3;
const SCROLLBAR_TOUCH_HOTZONE_PX = 36;
const LONG_PRESS_SELECT_MS = 500;
// 拖拽启动阈值必须与长按位移容差同值：首次越阈的 move 同时清长按定时器并发 press，
// 否则会出现 press 已发但长按定时器仍在武装的竞态窗口
const LONG_PRESS_MOVE_TOLERANCE_PX = 12;

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
    let state: TouchGestureState = 'idle';
    let lastTouchY = 0;
    let touchId: number | null = null;
    let pendingPixelDelta = 0;
    let touchStartX = 0;
    let touchStartY = 0;
    let lastDragX = 0;
    let lastDragY = 0;
    let wheelCentroidY = 0;
    let longPressTimer: ReturnType<typeof setTimeout> | null = null;

    const clearLongPressTimer = () => {
      if (longPressTimer !== null) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
      }
    };

    const isScrollbarElement = (target: Element | null): boolean => {
      if (!target) return false;
      return Boolean(
        target.closest('.scrollbar') ||
          target.closest('.slider') ||
          target.closest('.xterm-scrollbar-track')
      );
    };

    const hitsScrollbarElement = (
      clientX: number,
      clientY: number,
      eventTarget: EventTarget | null
    ): boolean => {
      const directTarget = eventTarget instanceof Element ? eventTarget : null;
      if (isScrollbarElement(directTarget)) {
        return true;
      }
      return isScrollbarElement(document.elementFromPoint(clientX, clientY));
    };

    const shouldBypassCustomScroll = (
      clientX: number,
      clientY: number,
      eventTarget: EventTarget | null
    ): boolean => {
      if (hitsScrollbarElement(clientX, clientY, eventTarget)) {
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

    const touchCentroidY = (touchList: TouchList): number => {
      let sum = 0;
      let count = 0;
      for (let i = 0; i < touchList.length; i += 1) {
        const touch = touchList.item(i);
        if (touch) {
          sum += touch.clientY;
          count += 1;
        }
      }
      return count > 0 ? sum / count : 0;
    };

    const terminalLineHeight = (terminal: TerminalScroller | null): number => {
      const core = (terminal as any)?._core;
      return core?._renderService?.dimensions?.css?.cell?.height ?? 18;
    };

    // 累积像素 → 整行喂给 handleViewportGesture（上报模式下由终端编码为滚轮 64/65，
    // 非上报模式走本地滚动/altScroll——touch 分支的 gestureToLines 无亚行累积，必须传整行像素）
    const feedScrollDelta = (
      terminal: TerminalScroller,
      deltaY: number,
      clientX: number,
      clientY: number
    ): boolean => {
      const lineHeight = terminalLineHeight(terminal);
      pendingPixelDelta += deltaY * TOUCH_SCROLL_GAIN;
      const linesToScroll =
        pendingPixelDelta > 0
          ? Math.floor(pendingPixelDelta / lineHeight)
          : Math.ceil(pendingPixelDelta / lineHeight);
      if (linesToScroll === 0 || typeof terminal.handleViewportGesture !== 'function') {
        return false;
      }
      const didScroll = terminal.handleViewportGesture({
        source: 'touch',
        deltaY: linesToScroll * lineHeight,
        clientX,
        clientY,
      });
      pendingPixelDelta -= linesToScroll * lineHeight;
      return didScroll;
    };

    const resetGesture = () => {
      clearLongPressTimer();
      state = 'idle';
      touchId = null;
      pendingPixelDelta = 0;
    };

    const handleTouchStart = (event: TouchEvent) => {
      if (event.touches.length === 1) {
        clearLongPressTimer();
        const touch = event.touches.item(0);
        if (!touch) return;

        touchId = touch.identifier;
        lastTouchY = touch.clientY;
        pendingPixelDelta = 0;
        touchStartX = touch.clientX;
        touchStartY = touch.clientY;

        const terminal = getTerminal?.() ?? null;
        const reporting = Boolean(terminal?.isMouseReporting?.());

        // 上报模式（alt-screen TUI）下本地滚动条无意义，右缘 36px 热区会变成 TUI 死区：
        // 仅在直接命中滚动条元素时才 bypass
        const bypass = reporting
          ? hitsScrollbarElement(touch.clientX, touch.clientY, event.target)
          : terminal?.usesNativeScrolling?.()
            ? hitsScrollbarElement(touch.clientX, touch.clientY, event.target)
            : shouldBypassCustomScroll(touch.clientX, touch.clientY, event.target);

        if (bypass) {
          state = 'bypass';
          return;
        }

        state = reporting ? 'pending' : 'scroll';
        longPressTimer = setTimeout(() => {
          longPressTimer = null;
          const activeTerminal = getTerminal?.() ?? null;
          if (activeTerminal?.startTouchSelection?.(touchStartX, touchStartY, 'word')) {
            state = 'select';
          }
        }, LONG_PRESS_SELECT_MS);
        return;
      }

      // 上报模式第二指加入后转为鼠标拖拽，非上报模式保持原有手势。
      if (state === 'pending' || state === 'wheel') {
        clearLongPressTimer();
        const touch = findTouchById(event.touches) ?? event.touches.item(0);
        if (!touch) return;
        touchId = touch.identifier;
        touchStartX = touch.clientX;
        touchStartY = touch.clientY;
        state = 'drag-pending';
        pendingPixelDelta = 0;
      }
    };

    const handleTouchMove = (event: TouchEvent) => {
      if (state === 'idle' || state === 'bypass') return;

      if (state === 'select') {
        const touch = findTouchById(event.touches) ?? event.touches.item(0);
        if (!touch) return;
        const terminal = getTerminal?.() ?? null;
        terminal?.updateTouchSelection?.(touch.clientX, touch.clientY);
        if (event.cancelable) {
          event.preventDefault();
        }
        return;
      }

      if (state === 'wheel') {
        const terminal = getTerminal?.() ?? null;
        const centroidY = touchCentroidY(event.touches);
        const deltaY = wheelCentroidY - centroidY;
        wheelCentroidY = centroidY;
        if (terminal && deltaY !== 0) {
          const anchor = event.touches.item(0);
          feedScrollDelta(terminal, deltaY, anchor?.clientX ?? touchStartX, centroidY);
        }
        if (event.cancelable) {
          event.preventDefault();
        }
        return;
      }

      const touch = findTouchById(event.touches) ?? event.touches.item(0);
      if (!touch) return;

      if (state === 'pending') {
        const moved = Math.hypot(touch.clientX - touchStartX, touch.clientY - touchStartY);
        if (moved <= LONG_PRESS_MOVE_TOLERANCE_PX) return;
        clearLongPressTimer();
        state = 'wheel';
        wheelCentroidY = touch.clientY;
        const terminal = getTerminal?.() ?? null;
        if (terminal) {
          feedScrollDelta(terminal, touchStartY - touch.clientY, touch.clientX, touch.clientY);
        }
        if (event.cancelable) event.preventDefault();
        return;
      }

      if (state === 'drag-pending') {
        const moved = Math.hypot(touch.clientX - touchStartX, touch.clientY - touchStartY);
        if (moved <= LONG_PRESS_MOVE_TOLERANCE_PX) {
          return;
        }
        clearLongPressTimer();
        const terminal = getTerminal?.() ?? null;
        // press 用起点坐标（拖拽语义的锚点）；发送失败（模式中途关闭）则静默放弃本次手势
        if (
          !terminal?.sendTouchMouseEvent?.({
            action: 'press',
            clientX: touchStartX,
            clientY: touchStartY,
          })
        ) {
          state = 'idle';
          return;
        }
        state = 'drag';
        lastDragX = touch.clientX;
        lastDragY = touch.clientY;
        terminal.sendTouchMouseEvent?.({
          action: 'motion',
          clientX: touch.clientX,
          clientY: touch.clientY,
        });
        if (event.cancelable) {
          event.preventDefault();
        }
        return;
      }

      if (state === 'drag') {
        const terminal = getTerminal?.() ?? null;
        lastDragX = touch.clientX;
        lastDragY = touch.clientY;
        terminal?.sendTouchMouseEvent?.({
          action: 'motion',
          clientX: touch.clientX,
          clientY: touch.clientY,
        });
        if (event.cancelable) {
          event.preventDefault();
        }
        return;
      }

      // state === 'scroll'：原有单指滚动路径
      if (longPressTimer !== null) {
        const moved = Math.hypot(touch.clientX - touchStartX, touch.clientY - touchStartY);
        if (moved > LONG_PRESS_MOVE_TOLERANCE_PX) {
          clearLongPressTimer();
        }
      }

      if (getTerminal?.()?.usesNativeScrolling?.()) return;

      // 滚动途中划入滚动条热区：交还原生（拖拽/上报态不做此升级，避免吞 motion 卡键）
      if (shouldBypassCustomScroll(touch.clientX, touch.clientY, event.target)) {
        state = 'bypass';
        pendingPixelDelta = 0;
        return;
      }

      const currentY = touch.clientY;
      const deltaY = lastTouchY - currentY;
      lastTouchY = currentY;

      if (deltaY === 0) return;

      let didScroll = false;
      let atTopWhilePullingDown = false;
      const terminal = getTerminal?.() ?? null;

      if (terminal) {
        if (typeof terminal.handleViewportGesture === 'function') {
          didScroll = feedScrollDelta(terminal, deltaY, touch.clientX, touch.clientY);
        } else {
          const lineHeight = terminalLineHeight(terminal);
          pendingPixelDelta += deltaY * TOUCH_SCROLL_GAIN;
          const linesToScroll =
            pendingPixelDelta > 0
              ? Math.floor(pendingPixelDelta / lineHeight)
              : Math.ceil(pendingPixelDelta / lineHeight);
          if (linesToScroll !== 0) {
            const beforeViewportY = terminal.buffer?.active?.viewportY ?? 0;
            terminal.scrollLines(linesToScroll);
            const afterViewportY = terminal.buffer?.active?.viewportY ?? 0;
            didScroll = beforeViewportY !== afterViewportY;
            atTopWhilePullingDown =
              linesToScroll < 0 && beforeViewportY <= 0 && afterViewportY <= 0;
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
      // wheel 态触点减少但未清零：重锚质心继续
      if (state === 'wheel' && event.touches.length > 0) {
        wheelCentroidY = touchCentroidY(event.touches);
        return;
      }

      if (state === 'drag') {
        // 不足两指或主指抬起时释放鼠标。
        if (event.touches.length >= 2 && !findTouchById(event.changedTouches)) {
          return;
        }
        const terminal = getTerminal?.() ?? null;
        const endedTouch = findTouchById(event.changedTouches);
        terminal?.sendTouchMouseEvent?.({
          action: 'release',
          clientX: endedTouch?.clientX ?? lastDragX,
          clientY: endedTouch?.clientY ?? lastDragY,
        });
        terminal?.noteTouchHandled?.();
        if (event.cancelable) {
          event.preventDefault();
        }
        resetGesture();
        if (event.touches.length > 0) state = 'bypass';
        return;
      }

      if (state === 'drag-pending') {
        if (event.touches.length >= 2 && !findTouchById(event.changedTouches)) return;
        resetGesture();
        if (event.touches.length > 0) state = 'bypass';
        return;
      }

      if (state === 'pending') {
        // tap：press/release 都用起点坐标（阈值内的抖动不应改变点击 cell）。
        // preventDefault 抑制 compat mouse 序列（规范保证），软键盘由显式 focus 唤起。
        const terminal = getTerminal?.() ?? null;
        if (
          terminal?.sendTouchMouseEvent?.({
            action: 'press',
            clientX: touchStartX,
            clientY: touchStartY,
          })
        ) {
          terminal.sendTouchMouseEvent?.({
            action: 'release',
            clientX: touchStartX,
            clientY: touchStartY,
          });
        }
        terminal?.noteTouchHandled?.();
        terminal?.focus?.();
        if (event.cancelable) {
          event.preventDefault();
        }
        resetGesture();
        return;
      }

      if (state === 'select') {
        const terminal = getTerminal?.() ?? null;
        terminal?.endTouchSelection?.();
        const ended = findTouchById(event.changedTouches);
        container.dispatchEvent(
          new MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            shiftKey: true,
            clientX: ended?.clientX ?? touchStartX,
            clientY: ended?.clientY ?? touchStartY,
          })
        );
        // 抑制合成 mousedown：否则它会命中鼠标上报/本地选择分支，清掉刚建立的选择
        terminal?.noteTouchHandled?.();
        if (event.cancelable) {
          event.preventDefault();
        }
        resetGesture();
        return;
      }

      if (state === 'scroll' || state === 'bypass' || state === 'wheel') {
        if (event.touches.length === 0) {
          resetGesture();
        }
        return;
      }

      resetGesture();
    };

    const handleTouchCancel = (event: TouchEvent) => {
      if (state === 'drag') {
        // 丢 release 会让 TUI 卡在"左键按住"状态（且触摸设备上没有后续真实 mouseup 解救）
        const terminal = getTerminal?.() ?? null;
        terminal?.sendTouchMouseEvent?.({
          action: 'release',
          clientX: lastDragX,
          clientY: lastDragY,
        });
        terminal?.noteTouchHandled?.();
        resetGesture();
        if (event.touches.length > 0) state = 'bypass';
      } else if (state === 'drag-pending') {
        resetGesture();
        if (event.touches.length > 0) state = 'bypass';
      } else if (state === 'select') {
        const terminal = getTerminal?.() ?? null;
        terminal?.endTouchSelection?.();
        terminal?.noteTouchHandled?.();
      }
      if (event.touches.length === 0) {
        resetGesture();
      }
    };

    const handleContextMenu = (event: Event) => {
      if (state === 'select') {
        event.preventDefault();
      }
    };

    container.addEventListener('touchstart', handleTouchStart, { passive: true });
    container.addEventListener('touchmove', handleTouchMove, { passive: false });
    // touchend 需要 preventDefault（抑制 compat mouse 序列），不能 passive
    container.addEventListener('touchend', handleTouchEnd, { passive: false });
    container.addEventListener('touchcancel', handleTouchCancel, { passive: true });
    container.addEventListener('contextmenu', handleContextMenu);

    return () => {
      isActiveRef.current = false;
      clearLongPressTimer();
      container.removeEventListener('touchstart', handleTouchStart);
      container.removeEventListener('touchmove', handleTouchMove);
      container.removeEventListener('touchend', handleTouchEnd);
      container.removeEventListener('touchcancel', handleTouchCancel);
      container.removeEventListener('contextmenu', handleContextMenu);
    };
  }, [containerRef, getTerminal]);

  return isActiveRef;
}
