import { describe, expect, test } from 'bun:test';
import { appendCursorRestore, parsePaneScreenInfo } from './capture-history';

describe('parsePaneScreenInfo', () => {
  test('解析 display-message 输出', () => {
    expect(parsePaneScreenInfo('1 8 3 40\n')).toEqual({
      alternateScreen: true,
      cursorX: 8,
      cursorY: 3,
      paneHeight: 40,
    });
  });

  test('主屏输出 alternate_on=0', () => {
    expect(parsePaneScreenInfo('0 0 39 40\n')).toEqual({
      alternateScreen: false,
      cursorX: 0,
      cursorY: 39,
      paneHeight: 40,
    });
  });

  test('字段缺失或非数字时返回 null 字段', () => {
    expect(parsePaneScreenInfo('0\n')).toEqual({
      alternateScreen: false,
      cursorX: null,
      cursorY: null,
      paneHeight: null,
    });
    expect(parsePaneScreenInfo('')).toEqual({
      alternateScreen: false,
      cursorX: null,
      cursorY: null,
      paneHeight: null,
    });
    expect(parsePaneScreenInfo('0 x y z\n').cursorX).toBeNull();
  });
});

describe('appendCursorRestore', () => {
  test('主屏：从可见区域底行相对上移到光标行并定位列', () => {
    const history = 'line1\nline2\nline3\n';
    const restored = appendCursorRestore(history, {
      alternateScreen: false,
      cursorX: 4,
      cursorY: 1,
      paneHeight: 3,
    });
    expect(restored).toBe('line1\nline2\nline3\x1b[1A\x1b[5G');
  });

  test('主屏：光标在底行时只定位列', () => {
    const restored = appendCursorRestore('a\nb\n', {
      alternateScreen: false,
      cursorX: 0,
      cursorY: 1,
      paneHeight: 2,
    });
    expect(restored).toBe('a\nb\x1b[1G');
  });

  test('alt 屏：绝对定位', () => {
    const restored = appendCursorRestore('TUI SCREEN\n', {
      alternateScreen: true,
      cursorX: 8,
      cursorY: 3,
      paneHeight: 40,
    });
    expect(restored).toBe('TUI SCREEN\x1b[4;9H');
  });

  test('光标信息缺失时保持原数据（含结尾换行）', () => {
    const history = 'line1\nline2\n';
    expect(
      appendCursorRestore(history, {
        alternateScreen: false,
        cursorX: null,
        cursorY: null,
        paneHeight: null,
      })
    ).toBe(history);
  });

  test('输入不以换行结尾时不额外裁剪', () => {
    const restored = appendCursorRestore('abc', {
      alternateScreen: false,
      cursorX: 2,
      cursorY: 0,
      paneHeight: 1,
    });
    expect(restored).toBe('abc\x1b[3G');
  });

  test('cursorY 越界时上移量被钳制在屏幕高度内', () => {
    const restored = appendCursorRestore('a\n', {
      alternateScreen: false,
      cursorX: 0,
      cursorY: 0,
      paneHeight: 100,
    });
    expect(restored).toBe('a\x1b[99A\x1b[1G');
  });
});
