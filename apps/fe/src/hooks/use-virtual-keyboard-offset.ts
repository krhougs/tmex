import {
  computeVirtualKeyboardOffset,
  needsManualKeyboardAvoidance,
} from '@/utils/virtualKeyboard';
import { useEffect, useState } from 'react';

// 虚拟键盘遮挡的避让偏移（px）。只在焦点位于 [data-virtual-keyboard-avoid]
// 容器内时输出非零，供布局根做 translateY 视觉平移——绝不改变任何容器尺寸，
// 因此不会触发终端的 ResizeObserver / tmux resize。
//
// disabled 为 true 时（如移动端侧边栏 Sheet 打开）直接返回 0 并摘除所有监听：
// 此时终端在遮罩之下不可见，避让平移无意义，且焦点在 portal 内的切换容易
// 导致 viewport 事件时序竞态、offset 卡在非零值。
export function useVirtualKeyboardOffset(disabled?: boolean): number {
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    if (disabled) {
      setOffset(0);
      return;
    }
    if (!needsManualKeyboardAvoidance()) {
      return;
    }
    const viewport = window.visualViewport;
    if (!viewport) {
      return;
    }

    let frameId: number | null = null;

    const update = () => {
      const active = document.activeElement;
      const shouldAvoid =
        active instanceof Element && active.closest('[data-virtual-keyboard-avoid]') !== null;
      if (!shouldAvoid) {
        setOffset(0);
        return;
      }
      setOffset(
        computeVirtualKeyboardOffset({
          windowInnerHeight: window.innerHeight,
          viewportHeight: viewport.height,
          viewportOffsetTop: viewport.offsetTop,
          viewportScale: viewport.scale,
        })
      );
    };

    const scheduleUpdate = () => {
      if (frameId !== null) {
        return;
      }
      frameId = window.requestAnimationFrame(() => {
        frameId = null;
        update();
      });
    };

    update();

    viewport.addEventListener('resize', scheduleUpdate);
    viewport.addEventListener('scroll', scheduleUpdate);
    window.addEventListener('resize', scheduleUpdate);
    document.addEventListener('focusin', scheduleUpdate);
    document.addEventListener('focusout', scheduleUpdate);

    return () => {
      viewport.removeEventListener('resize', scheduleUpdate);
      viewport.removeEventListener('scroll', scheduleUpdate);
      window.removeEventListener('resize', scheduleUpdate);
      document.removeEventListener('focusin', scheduleUpdate);
      document.removeEventListener('focusout', scheduleUpdate);
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
    };
  }, [disabled]);

  return offset;
}
