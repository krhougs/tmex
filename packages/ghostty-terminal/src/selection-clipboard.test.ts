import { afterEach, describe, expect, test } from 'bun:test';
import { isCopyShortcut, isMacPlatform, isPasteShortcut } from './selection-clipboard';

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

function setNavigator(value: unknown): void {
  Object.defineProperty(globalThis, 'navigator', {
    value,
    configurable: true,
    writable: true,
  });
}

function key(init: Partial<KeyboardEvent>): KeyboardEvent {
  return init as KeyboardEvent;
}

afterEach(() => {
  if (originalNavigator) {
    Object.defineProperty(globalThis, 'navigator', originalNavigator);
  } else {
    delete (globalThis as { navigator?: unknown }).navigator;
  }
});

describe('selection clipboard shortcuts on mac', () => {
  test('copy uses Cmd+C and Ctrl+C stays terminal-bound', () => {
    setNavigator({
      platform: 'MacIntel',
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
    });

    expect(isMacPlatform()).toBeTrue();
    expect(isCopyShortcut(key({ key: 'c', metaKey: true }))).toBeTrue();
    expect(isCopyShortcut(key({ key: 'c', ctrlKey: true }))).toBeFalse();
    expect(isPasteShortcut(key({ key: 'v', metaKey: true }))).toBeTrue();
    expect(isPasteShortcut(key({ key: 'v', ctrlKey: true }))).toBeFalse();
  });
});

describe('selection clipboard shortcuts on non-mac', () => {
  test('copy/paste use Ctrl combinations plus Shift+Insert', () => {
    setNavigator({ platform: 'Win32', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' });

    expect(isMacPlatform()).toBeFalse();
    expect(isCopyShortcut(key({ key: 'c', ctrlKey: true }))).toBeTrue();
    expect(isCopyShortcut(key({ key: 'C', ctrlKey: true, shiftKey: true }))).toBeTrue();
    expect(isCopyShortcut(key({ key: 'c', ctrlKey: true, altKey: true }))).toBeFalse();
    expect(isCopyShortcut(key({ key: 'c', metaKey: true }))).toBeFalse();
    expect(isPasteShortcut(key({ key: 'v', ctrlKey: true }))).toBeTrue();
    expect(isPasteShortcut(key({ key: 'V', ctrlKey: true, shiftKey: true }))).toBeTrue();
    expect(isPasteShortcut(key({ key: 'Insert', shiftKey: true }))).toBeTrue();
    expect(isPasteShortcut(key({ key: 'v', metaKey: true }))).toBeFalse();
    expect(isPasteShortcut(key({ key: 'v', ctrlKey: true, altKey: true }))).toBeFalse();
  });
});
