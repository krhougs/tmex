import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_TERMINAL_SHORTCUTS,
  type UpdateTerminalShortcutSettingsRequest,
} from '@tmex/shared';
import { MAX_TERMINAL_SHORTCUTS, normalizeTerminalShortcutsInput } from './terminal-shortcuts';

// 用于构造非法输入（绕过编译期类型检查）
function asBody(value: unknown): UpdateTerminalShortcutSettingsRequest {
  return value as UpdateTerminalShortcutSettingsRequest;
}

describe('normalizeTerminalShortcutsInput', () => {
  test('接受默认快捷键列表并原样返回', () => {
    const result = normalizeTerminalShortcutsInput({
      items: DEFAULT_TERMINAL_SHORTCUTS,
      useIcons: false,
    });
    expect(result.items).toHaveLength(DEFAULT_TERMINAL_SHORTCUTS.length);
    expect(result.useIcons).toBe(false);
    expect(result.items[0]).toEqual({ id: 'paste', type: 'action', action: 'paste', label: '' });
  });

  test('接受合法 send 项', () => {
    const result = normalizeTerminalShortcutsInput({
      items: [{ id: 'a', type: 'send', label: 'CTRL-C', payload: '' }],
      useIcons: true,
    });
    expect(result.items[0]).toEqual({ id: 'a', type: 'send', label: 'CTRL-C', payload: '' });
    expect(result.useIcons).toBe(true);
  });

  test('接受合法 action 项', () => {
    const result = normalizeTerminalShortcutsInput({
      items: [{ id: 'p', type: 'action', label: '', action: 'scrollToBottom' }],
      useIcons: false,
    });
    expect(result.items[0]).toEqual({
      id: 'p',
      type: 'action',
      label: '',
      action: 'scrollToBottom',
    });
  });

  test('useIcons 非 boolean 抛错', () => {
    expect(() => normalizeTerminalShortcutsInput(asBody({ items: [], useIcons: 'yes' }))).toThrow();
  });

  test('items 非数组抛错', () => {
    expect(() =>
      normalizeTerminalShortcutsInput(asBody({ items: 'nope', useIcons: false }))
    ).toThrow();
  });

  test('超过数量上限抛错', () => {
    const many = Array.from({ length: MAX_TERMINAL_SHORTCUTS + 1 }, (_, i) => ({
      id: `k${i}`,
      type: 'send' as const,
      label: 'x',
      payload: 'x',
    }));
    expect(() => normalizeTerminalShortcutsInput({ items: many, useIcons: false })).toThrow();
  });

  test('重复 id 抛错', () => {
    expect(() =>
      normalizeTerminalShortcutsInput({
        items: [
          { id: 'dup', type: 'send', label: 'a', payload: 'a' },
          { id: 'dup', type: 'send', label: 'b', payload: 'b' },
        ],
        useIcons: false,
      })
    ).toThrow();
  });

  test('空 id 抛错', () => {
    expect(() =>
      normalizeTerminalShortcutsInput({
        items: [{ id: '  ', type: 'send', label: 'a', payload: 'a' }],
        useIcons: false,
      })
    ).toThrow();
  });

  test('send 缺 payload 抛错', () => {
    expect(() =>
      normalizeTerminalShortcutsInput(
        asBody({ items: [{ id: 'a', type: 'send', label: 'a' }], useIcons: false })
      )
    ).toThrow();
  });

  test('action 非法枚举抛错', () => {
    expect(() =>
      normalizeTerminalShortcutsInput(
        asBody({
          items: [{ id: 'a', type: 'action', label: '', action: 'explode' }],
          useIcons: false,
        })
      )
    ).toThrow();
  });

  test('未知 type 抛错', () => {
    expect(() =>
      normalizeTerminalShortcutsInput(
        asBody({ items: [{ id: 'a', type: 'weird', label: 'x' }], useIcons: false })
      )
    ).toThrow();
  });

  test('label 超长抛错', () => {
    expect(() =>
      normalizeTerminalShortcutsInput({
        items: [{ id: 'a', type: 'send', label: 'x'.repeat(100), payload: 'a' }],
        useIcons: false,
      })
    ).toThrow();
  });
});
