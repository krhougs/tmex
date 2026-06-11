import { describe, expect, test } from 'bun:test';
import { computeVirtualKeyboardOffset } from './virtualKeyboard';

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
