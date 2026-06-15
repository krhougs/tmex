import { describe, expect, test } from 'bun:test';
import { computeCursorFollowOffset, computeVirtualKeyboardOffset } from './virtualKeyboard';

describe('computeVirtualKeyboardOffset', () => {
  test('Android 键盘弹出（visual viewport 缩小且浏览器未平移）返回完整遮挡高度', () => {
    expect(
      computeVirtualKeyboardOffset({
        windowInnerHeight: 800,
        viewportHeight: 450,
        viewportOffsetTop: 0,
        viewportScale: 1,
      })
    ).toBe(350);
  });

  test('iOS Safari 已用 offsetTop 平移补偿时不再叠加偏移', () => {
    expect(
      computeVirtualKeyboardOffset({
        windowInnerHeight: 800,
        viewportHeight: 450,
        viewportOffsetTop: 350,
        viewportScale: 1,
      })
    ).toBe(0);
  });

  test('浏览器部分平移时只补偿剩余遮挡量', () => {
    expect(
      computeVirtualKeyboardOffset({
        windowInnerHeight: 800,
        viewportHeight: 450,
        viewportOffsetTop: 200,
        viewportScale: 1,
      })
    ).toBe(150);
  });

  test('地址栏收放等小幅视口变化不触发偏移', () => {
    expect(
      computeVirtualKeyboardOffset({
        windowInnerHeight: 800,
        viewportHeight: 760,
        viewportOffsetTop: 0,
        viewportScale: 1,
      })
    ).toBe(0);
  });

  test('pinch-zoom（scale ≠ 1）不视为键盘', () => {
    expect(
      computeVirtualKeyboardOffset({
        windowInnerHeight: 800,
        viewportHeight: 400,
        viewportOffsetTop: 0,
        viewportScale: 2,
      })
    ).toBe(0);
  });

  test('视口未变化（桌面）返回 0', () => {
    expect(
      computeVirtualKeyboardOffset({
        windowInnerHeight: 800,
        viewportHeight: 800,
        viewportOffsetTop: 0,
        viewportScale: 1,
      })
    ).toBe(0);
  });

  test('负的 inset（异常数据）返回 0', () => {
    expect(
      computeVirtualKeyboardOffset({
        windowInnerHeight: 800,
        viewportHeight: 820,
        viewportOffsetTop: 0,
        viewportScale: 1,
      })
    ).toBe(0);
  });
});

describe('computeCursorFollowOffset', () => {
  // innerHeight=800, inset=350 → 键盘顶 client y = 450
  const base = { windowInnerHeight: 800, inset: 350, margin: 8 };

  test('光标在终端底部（满屏 shell）退化为整页上移（= inset）', () => {
    expect(computeCursorFollowOffset({ ...base, cursorBottomClientY: 800, appliedOffset: 0 })).toBe(
      350
    );
  });

  test('光标在终端顶部（空 shell）无需上移，返回 0——修复看不见输入', () => {
    expect(computeCursorFollowOffset({ ...base, cursorBottomClientY: 17, appliedOffset: 0 })).toBe(
      0
    );
  });

  test('光标在中部时只上移到光标贴键盘顶（含 margin）', () => {
    expect(computeCursorFollowOffset({ ...base, cursorBottomClientY: 500, appliedOffset: 0 })).toBe(
      58
    );
  });

  test('对自身已应用位移收敛：加回 appliedOffset 后结果稳定不抖', () => {
    // 上一帧已上移 58px，当前 client 底沿因此为 500-58=442
    expect(
      computeCursorFollowOffset({ ...base, cursorBottomClientY: 442, appliedOffset: 58 })
    ).toBe(58);
  });

  test('封顶到 inset，绝不超额上移暴露底部空白', () => {
    expect(
      computeCursorFollowOffset({ ...base, cursorBottomClientY: 2000, appliedOffset: 0 })
    ).toBe(350);
  });

  test('光标恰在键盘顶时仍留出 margin', () => {
    expect(computeCursorFollowOffset({ ...base, cursorBottomClientY: 450, appliedOffset: 0 })).toBe(
      8
    );
  });

  // 浮动快捷键栏场景：margin 含 barHeight，maxOffset 放宽到 inset + barHeight
  const barHeight = 52;

  test('终端最底行：放宽 maxOffset 让光标抬到浮动快捷键栏之上，不被遮挡', () => {
    const offset = computeCursorFollowOffset({
      windowInnerHeight: 800,
      inset: 350,
      cursorBottomClientY: 760, // 光标在终端最底行（接近视口底）
      appliedOffset: 0,
      margin: 8 + barHeight,
      maxOffset: 350 + barHeight,
    });
    // offset 超过 inset(350)，把光标抬到快捷键栏顶上方
    expect(offset).toBe(370);
    // 光标视觉底 = 760 - 370 = 390 < 快捷键栏顶（keyboardTop 450 - barHeight 52 = 398）
    expect(760 - offset).toBeLessThan(450 - barHeight);
  });

  test('不传 maxOffset 时仍封顶到 inset（保持露白保护的默认）', () => {
    expect(
      computeCursorFollowOffset({
        windowInnerHeight: 800,
        inset: 350,
        cursorBottomClientY: 760,
        appliedOffset: 0,
        margin: 8 + barHeight,
      })
    ).toBe(350);
  });
});
