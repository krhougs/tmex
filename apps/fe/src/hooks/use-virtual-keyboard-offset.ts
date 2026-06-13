import {
  computeVirtualKeyboardOffset,
  needsManualKeyboardAvoidance,
} from '@/utils/virtualKeyboard';
import { useEffect, useState } from 'react';

// 虚拟键盘遮挡的避让偏移（px）。只在焦点位于 [data-virtual-keyboard-avoid]
// 容器内时输出非零，供布局根做 translateY 视觉平移——绝不改变任何容器尺寸，
// 因此不会触发终端的 ResizeObserver / tmux resize。
//
// iOS Safari 不识别 interactive-widget=resizes-visual，键盘弹出时会隐式 scroll
// layout viewport 让聚焦元素可见。即使 html/body 声明了 overflow:hidden，
// 收键盘后 scrollY 也不一定归零，表现为页面底部多出一块空白。每次 update
// 都会检查并复位 document scroll——对 Android 无副作用（scrollY 恒 0）。
//
// disabled 为 true 时（移动端侧边栏 Sheet 打开）只跳过 offset 计算，事件监听
// 和 scroll 复位仍然生效——agent 聊天 textarea 虽在 Sheet portal 内，但 iOS
// 的隐式 scroll 同样会偏移 Sheet 下方的终端布局。
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
      if (window.scrollY !== 0 || window.scrollX !== 0) {
        window.scrollTo(0, 0);
      }

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
