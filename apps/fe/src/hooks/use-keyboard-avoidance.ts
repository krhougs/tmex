import type { KeyboardBehaviorMode } from '@/stores/ui';
import { readActiveCursorRect } from '@/utils/keyboard-cursor-bridge';
import {
  computeCursorFollowOffset,
  computeVirtualKeyboardOffset,
  needsManualKeyboardAvoidance,
} from '@/utils/virtualKeyboard';
import { useEffect, useState } from 'react';

// 手机虚拟键盘避让结果，由 MainInset 应用到 <main>（issue #27）。
// transform=整页上移（lift / follow）；height=收缩可用高度触发终端 resize（resize）。
export type KeyboardAvoidance =
  | { strategy: 'none' }
  | { strategy: 'transform'; offset: number }
  | { strategy: 'height'; height: number };

const NONE: KeyboardAvoidance = { strategy: 'none' };
// 光标对齐模式下，光标底沿与键盘顶之间保留的间距（px）
const CURSOR_FOLLOW_MARGIN = 8;
// resize 模式的可用高度（innerHeight - inset）下限：低于此值时不再收缩 <main>，改为退化
// 为整页上移，避免 header + 快捷键栏等固定开销把终端压没（横屏/键盘占屏比高时）。
const MIN_RESIZE_AVAILABLE_PX = 60;
// <main>（SidebarInset）的 data-slot，用于读取其当前实际 translateY
const MAIN_SLOT_SELECTOR = '[data-slot="sidebar-inset"]';
// direct 模式终端下方的快捷键栏；follow 模式键盘弹起时让它浮到键盘正上方
const SHORTCUT_BAR_SELECTOR = '.terminal-shortcuts-strip';
// 快捷键栏额外上移量的 CSS 变量（= inset - offset）：本 hook 写、ShortcutsBar 用其做 translateY。
// 叠加 <main> 已有的 -offset 后总位移恰为 -inset，贴键盘顶。
const SHORTCUT_LIFT_VAR = '--tmex-kb-shortcut-lift';

function sameAvoidance(a: KeyboardAvoidance, b: KeyboardAvoidance): boolean {
  if (a.strategy !== b.strategy) {
    return false;
  }
  if (a.strategy === 'transform' && b.strategy === 'transform') {
    return Math.abs(a.offset - b.offset) < 1;
  }
  if (a.strategy === 'height' && b.strategy === 'height') {
    return Math.abs(a.height - b.height) < 1;
  }
  return true; // 同为 none
}

// 按 mode 计算手机虚拟键盘的页面避让策略。
// - lift：整页上移键盘高度（0.12.0 现状）。
// - resize：把 <main> 高度收到键盘上方可用高度，触发终端既有 ResizeObserver → resize。
// - follow：按光标位置上移使光标贴键盘顶；键盘打开期间 RAF 轮询（光标移动不发 viewport
//   事件）。拿不到光标（终端未聚焦/编辑器/光标隐藏）时回退到整页上移。
export function useKeyboardAvoidance(
  disabled: boolean,
  mode: KeyboardBehaviorMode
): KeyboardAvoidance {
  const [avoidance, setAvoidance] = useState<KeyboardAvoidance>(NONE);

  useEffect(() => {
    if (!needsManualKeyboardAvoidance()) {
      return;
    }
    const viewport = window.visualViewport;
    if (!viewport) {
      return;
    }

    let eventRaf: number | null = null;
    let followRaf: number | null = null;
    let current: KeyboardAvoidance = NONE;
    let mainEl: Element | null = null;
    let appliedShortcutLift = 0;

    const commit = (next: KeyboardAvoidance) => {
      // 仅在实质变化时 setState，避免 follow RAF 每帧 re-render
      if (sameAvoidance(current, next)) {
        return;
      }
      current = next;
      setAvoidance(next);
    };

    // 读取 <main> 当前实际应用的 translateY 位移（px，正数）。读 DOM 实测而非追踪目标值，
    // 使光标对齐的自然坐标回算对 CSS 过渡/React 提交时序都稳定收敛、不抖动。
    const readAppliedOffset = (): number => {
      if (!mainEl || !mainEl.isConnected) {
        mainEl = document.querySelector(MAIN_SLOT_SELECTOR);
      }
      if (!mainEl) {
        return 0;
      }
      const transform = window.getComputedStyle(mainEl).transform;
      if (!transform || transform === 'none') {
        return 0;
      }
      try {
        return -new DOMMatrix(transform).m42; // 我们应用 translateY(-offset)，m42 = -offset
      } catch {
        return 0;
      }
    };

    // 设置快捷键栏额外位移量（px）。0 表示不浮动；正=相对 <main> 上移，负=下移。
    const setShortcutLift = (px: number) => {
      appliedShortcutLift = Math.round(px);
      document.documentElement.style.setProperty(SHORTCUT_LIFT_VAR, `${appliedShortcutLift}px`);
    };

    // 把快捷键栏底沿对齐到键盘顶：量它当前底沿、把到键盘顶的差值补进 lift（测量驱动，
    // 自动含终端底部 padding，避免靠推导留下偏差）。RAF 每帧调用，迭代收敛——稳态下
    // strip 底沿恰为键盘顶，光标据 margin 停在它上方。
    const alignShortcutToKeyboardTop = (inset: number) => {
      const stripEl = document.querySelector(SHORTCUT_BAR_SELECTOR) as HTMLElement | null;
      if (!stripEl) {
        setShortcutLift(0);
        return;
      }
      const stripBottom = stripEl.getBoundingClientRect().bottom;
      const keyboardTop = window.innerHeight - inset;
      setShortcutLift(appliedShortcutLift + (stripBottom - keyboardTop));
    };

    // 量 direct 模式快捷键栏高度，用于把光标目标线抬到浮动快捷键栏之上，避免被其遮挡。
    const readShortcutBarHeight = (): number => {
      const el = document.querySelector(SHORTCUT_BAR_SELECTOR);
      return el ? (el as HTMLElement).offsetHeight : 0;
    };

    // 当前键盘遮挡高度；不在避让容器内 / 被 disabled 时为 0
    const readInset = (): number => {
      if (disabled) {
        return 0;
      }
      const active = document.activeElement;
      const shouldAvoid =
        active instanceof Element && active.closest('[data-virtual-keyboard-avoid]') !== null;
      if (!shouldAvoid) {
        return 0;
      }
      return computeVirtualKeyboardOffset({
        windowInnerHeight: window.innerHeight,
        viewportHeight: viewport.height,
        viewportOffsetTop: viewport.offsetTop,
        viewportScale: viewport.scale,
      });
    };

    const compute = () => {
      const inset = readInset();
      if (inset <= 0) {
        setShortcutLift(0);
        commit(NONE);
        stopFollowLoop();
        return;
      }

      if (mode === 'resize') {
        setShortcutLift(0);
        const available = window.innerHeight - inset;
        if (available >= MIN_RESIZE_AVAILABLE_PX) {
          commit({ strategy: 'height', height: available });
        } else {
          // 键盘过高，收缩到该高度会把终端压没——退化为整页上移，保住终端可用高度
          commit({ strategy: 'transform', offset: inset });
        }
        stopFollowLoop();
        return;
      }

      if (mode === 'follow') {
        const rect = readActiveCursorRect();
        if (rect) {
          // 终端聚焦（direct 输入）：快捷键栏浮到键盘正上方，光标预留其高度停在浮条之上
          const barHeight = readShortcutBarHeight();
          const offset = computeCursorFollowOffset({
            cursorBottomClientY: rect.bottom,
            appliedOffset: readAppliedOffset(),
            windowInnerHeight: window.innerHeight,
            inset,
            margin: CURSOR_FOLLOW_MARGIN + barHeight,
            // 允许多抬一个快捷键栏高度，使光标即便在终端最底行也能停到浮条之上；
            // 多抬露出的空白被浮动快捷键栏盖住，不露白。
            maxOffset: inset + barHeight,
          });
          commit(offset > 0 ? { strategy: 'transform', offset } : NONE);
          // 快捷键栏底沿对齐到真实键盘顶（测量驱动，自动含终端底部 padding）
          alignShortcutToKeyboardTop(inset);
        } else {
          // 非终端聚焦（编辑器等）：整页上移键盘高度，快捷键栏不单独浮动
          setShortcutLift(0);
          commit({ strategy: 'transform', offset: inset });
        }
        startFollowLoop();
        return;
      }

      // lift（默认/兜底）
      setShortcutLift(0);
      commit({ strategy: 'transform', offset: inset });
      stopFollowLoop();
    };

    const followTick = () => {
      followRaf = null;
      compute(); // 命中 follow 分支会再次 startFollowLoop
    };
    const startFollowLoop = () => {
      if (followRaf === null) {
        followRaf = window.requestAnimationFrame(followTick);
      }
    };
    const stopFollowLoop = () => {
      if (followRaf !== null) {
        window.cancelAnimationFrame(followRaf);
        followRaf = null;
      }
    };

    const scheduleCompute = () => {
      if (eventRaf === null) {
        eventRaf = window.requestAnimationFrame(() => {
          eventRaf = null;
          compute();
        });
      }
    };

    compute();

    viewport.addEventListener('resize', scheduleCompute);
    viewport.addEventListener('scroll', scheduleCompute);
    window.addEventListener('resize', scheduleCompute);
    document.addEventListener('focusin', scheduleCompute);
    document.addEventListener('focusout', scheduleCompute);

    return () => {
      viewport.removeEventListener('resize', scheduleCompute);
      viewport.removeEventListener('scroll', scheduleCompute);
      window.removeEventListener('resize', scheduleCompute);
      document.removeEventListener('focusin', scheduleCompute);
      document.removeEventListener('focusout', scheduleCompute);
      if (eventRaf !== null) {
        window.cancelAnimationFrame(eventRaf);
      }
      stopFollowLoop();
      document.documentElement.style.removeProperty(SHORTCUT_LIFT_VAR);
    };
  }, [disabled, mode]);

  return avoidance;
}
