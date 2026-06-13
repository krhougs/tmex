import {
  computeVirtualKeyboardOffset,
  needsManualKeyboardAvoidance,
} from '@/utils/virtualKeyboard';
import { useEffect, useState } from 'react';

// 虚拟键盘遮挡的避让偏移（px）。只在焦点位于 [data-virtual-keyboard-avoid]
// 容器内时输出非零，供布局根做 translateY 视觉平移——绝不改变任何容器尺寸，
// 因此不会触发终端的 ResizeObserver / tmux resize。
//
// disabled 为 true 时（移动端侧边栏 Sheet 打开）只跳过 offset 计算，事件监听
// 仍然生效——Sheet 打开/关闭瞬间焦点切换可能触发 viewport 事件，需要正确
// 归零 offset 而非卡在上一次的值。
export function useVirtualKeyboardOffset(disabled?: boolean): number {
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    if (!needsManualKeyboardAvoidance()) {
      return;
    }
    const viewport = window.visualViewport;
    if (!viewport) {
      return;
    }

    let frameId: number | null = null;

    const update = () => {
      if (disabled) {
        setOffset(0);
        return;
      }

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
