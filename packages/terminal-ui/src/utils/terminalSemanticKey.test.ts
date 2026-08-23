import { describe, expect, test } from 'bun:test';
import { wsBorsh } from '@tmex/shared';
import { keyboardEventToSemanticKey } from './terminalSemanticKey';

describe('keyboardEventToSemanticKey', () => {
  test('preserves Shift+Enter as key identity plus modifier bit', () => {
    expect(keyboardEventToSemanticKey({ key: 'Enter', code: 'Enter', shiftKey: true })).toEqual({
      key: { Enter: {} },
      modifiers: wsBorsh.TERMINAL_KEY_MOD_SHIFT,
      action: { Press: {} },
    });
  });

  test('preserves multi-modifier arrow repeat', () => {
    expect(
      keyboardEventToSemanticKey({
        key: 'ArrowUp',
        code: 'ArrowUp',
        ctrlKey: true,
        altKey: true,
        shiftKey: true,
        repeat: true,
      })
    ).toEqual({
      key: { ArrowUp: {} },
      modifiers:
        wsBorsh.TERMINAL_KEY_MOD_CTRL |
        wsBorsh.TERMINAL_KEY_MOD_ALT |
        wsBorsh.TERMINAL_KEY_MOD_SHIFT,
      action: { Repeat: 1 },
    });
  });

  test('uses the unshifted physical identity for modified ASCII', () => {
    expect(
      keyboardEventToSemanticKey({
        key: 'A',
        code: 'KeyA',
        ctrlKey: true,
        shiftKey: true,
        metaKey: true,
      })
    ).toEqual({
      key: { Unicode: 97 },
      modifiers:
        wsBorsh.TERMINAL_KEY_MOD_CTRL |
        wsBorsh.TERMINAL_KEY_MOD_SHIFT |
        wsBorsh.TERMINAL_KEY_MOD_SUPER,
      action: { Press: {} },
    });
  });

  test('maps keypad identity and lock state', () => {
    expect(
      keyboardEventToSemanticKey({
        key: '7',
        code: 'Numpad7',
        getModifierState: (key) => key === 'NumLock',
      })
    ).toEqual({
      key: { NumpadDigit: 7 },
      modifiers: wsBorsh.TERMINAL_KEY_MOD_NUM_LOCK,
      action: { Press: {} },
    });
  });

  test('leaves plain text, AltGraph, dead keys, and IME keyCode 229 on the text path', () => {
    expect(keyboardEventToSemanticKey({ key: 'a', code: 'KeyA' })).toBeNull();
    expect(
      keyboardEventToSemanticKey({
        key: '@',
        code: 'KeyQ',
        ctrlKey: true,
        altKey: true,
        getModifierState: (key) => key === 'AltGraph',
      })
    ).toBeNull();
    expect(keyboardEventToSemanticKey({ key: 'Dead', code: 'Quote' })).toBeNull();
    expect(keyboardEventToSemanticKey({ key: 'Process', keyCode: 229 })).toBeNull();
  });
});
