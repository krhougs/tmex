import { type TerminalShortcutItem, wsBorsh } from '@tmex/shared';

export interface TerminalKeyboardEventLike {
  key: string;
  code?: string;
  repeat?: boolean;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
  getModifierState?(key: string): boolean;
}

export interface TerminalSemanticKeyInput {
  key: wsBorsh.TerminalKey;
  modifiers: number;
  action: wsBorsh.TerminalKeyAction;
}

interface SemanticShortcut {
  payload: string;
  input: TerminalSemanticKeyInput;
}

const SEMANTIC_SHORTCUT_BY_ID: Readonly<Record<string, SemanticShortcut>> = {
  enter: {
    payload: '\r',
    input: { key: { Enter: {} }, modifiers: 0, action: { Press: {} } },
  },
  'shift-tab': {
    payload: '\x1b[Z',
    input: {
      key: { Tab: {} },
      modifiers: wsBorsh.TERMINAL_KEY_MOD_SHIFT,
      action: { Press: {} },
    },
  },
  esc: {
    payload: '\x1b',
    input: { key: { Escape: {} }, modifiers: 0, action: { Press: {} } },
  },
  'ctrl-c': {
    payload: '\x03',
    input: {
      key: { Unicode: 99 },
      modifiers: wsBorsh.TERMINAL_KEY_MOD_CTRL,
      action: { Press: {} },
    },
  },
  'ctrl-d': {
    payload: '\x04',
    input: {
      key: { Unicode: 100 },
      modifiers: wsBorsh.TERMINAL_KEY_MOD_CTRL,
      action: { Press: {} },
    },
  },
  'arrow-up': {
    payload: '\x1b[A',
    input: { key: { ArrowUp: {} }, modifiers: 0, action: { Press: {} } },
  },
  'arrow-down': {
    payload: '\x1b[B',
    input: { key: { ArrowDown: {} }, modifiers: 0, action: { Press: {} } },
  },
  'arrow-left': {
    payload: '\x1b[D',
    input: { key: { ArrowLeft: {} }, modifiers: 0, action: { Press: {} } },
  },
  'arrow-right': {
    payload: '\x1b[C',
    input: { key: { ArrowRight: {} }, modifiers: 0, action: { Press: {} } },
  },
  'shift-enter': {
    payload: '\x1b[13;2u',
    input: {
      key: { Enter: {} },
      modifiers: wsBorsh.TERMINAL_KEY_MOD_SHIFT,
      action: { Press: {} },
    },
  },
};

export function terminalShortcutToSemanticKey(
  item: TerminalShortcutItem
): TerminalSemanticKeyInput | null {
  if (item.type !== 'send') return null;
  const shortcut = SEMANTIC_SHORTCUT_BY_ID[item.id];
  return shortcut && shortcut.payload === item.payload ? shortcut.input : null;
}

const MODIFIER_ONLY: Readonly<Record<string, true>> = {
  Shift: true,
  Control: true,
  Alt: true,
  Meta: true,
  AltGraph: true,
  CapsLock: true,
  NumLock: true,
  ScrollLock: true,
  Fn: true,
  FnLock: true,
  Hyper: true,
  Super: true,
  Symbol: true,
  SymbolLock: true,
};

const PHYSICAL_PRINTABLE: Readonly<Record<string, string>> = {
  Digit0: '0',
  Digit1: '1',
  Digit2: '2',
  Digit3: '3',
  Digit4: '4',
  Digit5: '5',
  Digit6: '6',
  Digit7: '7',
  Digit8: '8',
  Digit9: '9',
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Space: ' ',
};

function modifierState(event: TerminalKeyboardEventLike, key: string): boolean {
  try {
    return event.getModifierState?.(key) ?? false;
  } catch {
    return false;
  }
}

function modifiersFromEvent(event: TerminalKeyboardEventLike): number {
  let modifiers = 0;
  if (event.shiftKey) modifiers |= wsBorsh.TERMINAL_KEY_MOD_SHIFT;
  if (event.altKey) modifiers |= wsBorsh.TERMINAL_KEY_MOD_ALT;
  if (event.ctrlKey) modifiers |= wsBorsh.TERMINAL_KEY_MOD_CTRL;
  if (event.metaKey) modifiers |= wsBorsh.TERMINAL_KEY_MOD_SUPER;
  if (modifierState(event, 'CapsLock')) modifiers |= wsBorsh.TERMINAL_KEY_MOD_CAPS_LOCK;
  if (modifierState(event, 'NumLock')) modifiers |= wsBorsh.TERMINAL_KEY_MOD_NUM_LOCK;
  return modifiers;
}

function specialKey(event: TerminalKeyboardEventLike): wsBorsh.TerminalKey | null {
  const code = event.code ?? '';
  if (code === 'NumpadEnter') return { NumpadEnter: {} };
  const numpadDigit = /^Numpad([0-9])$/.exec(code);
  if (numpadDigit) return { NumpadDigit: Number(numpadDigit[1]) };
  switch (code) {
    case 'NumpadDecimal':
      return { NumpadDecimal: {} };
    case 'NumpadAdd':
      return { NumpadAdd: {} };
    case 'NumpadSubtract':
      return { NumpadSubtract: {} };
    case 'NumpadMultiply':
      return { NumpadMultiply: {} };
    case 'NumpadDivide':
      return { NumpadDivide: {} };
    case 'NumpadEqual':
      return { NumpadEqual: {} };
    default:
      break;
  }

  switch (event.key) {
    case 'Enter':
      return { Enter: {} };
    case 'Tab':
      return { Tab: {} };
    case 'Escape':
    case 'Esc':
      return { Escape: {} };
    case 'Backspace':
      return { Backspace: {} };
    case 'Insert':
      return { Insert: {} };
    case 'Delete':
      return { Delete: {} };
    case 'Home':
      return { Home: {} };
    case 'End':
      return { End: {} };
    case 'PageUp':
      return { PageUp: {} };
    case 'PageDown':
      return { PageDown: {} };
    case 'ArrowUp':
      return { ArrowUp: {} };
    case 'ArrowDown':
      return { ArrowDown: {} };
    case 'ArrowLeft':
      return { ArrowLeft: {} };
    case 'ArrowRight':
      return { ArrowRight: {} };
    default:
      break;
  }

  const functionKey = /^F([1-9]|[12][0-9]|3[0-5])$/.exec(event.key);
  return functionKey ? { Function: Number(functionKey[1]) } : null;
}

function unshiftedPrintable(event: TerminalKeyboardEventLike): string | null {
  const code = event.code ?? '';
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  const physical = PHYSICAL_PRINTABLE[code];
  if (physical !== undefined) return physical;
  const characters = Array.from(event.key);
  if (characters.length !== 1) return null;
  return event.key.length === 1 ? event.key.toLowerCase() : event.key;
}

export function keyboardEventToSemanticKey(
  event: TerminalKeyboardEventLike
): TerminalSemanticKeyInput | null {
  if (
    event.isComposing ||
    event.keyCode === 229 ||
    event.key === 'Dead' ||
    event.key === 'Process' ||
    event.key === 'Unidentified' ||
    MODIFIER_ONLY[event.key] === true ||
    modifierState(event, 'AltGraph')
  ) {
    return null;
  }

  const modifiers = modifiersFromEvent(event);
  const key = specialKey(event);
  if (key) {
    return {
      key,
      modifiers,
      action: event.repeat ? { Repeat: 1 } : { Press: {} },
    };
  }

  const shortcutModifiers =
    modifiers &
    (wsBorsh.TERMINAL_KEY_MOD_ALT |
      wsBorsh.TERMINAL_KEY_MOD_CTRL |
      wsBorsh.TERMINAL_KEY_MOD_SUPER |
      wsBorsh.TERMINAL_KEY_MOD_HYPER |
      wsBorsh.TERMINAL_KEY_MOD_META);
  if (shortcutModifiers === 0) return null;

  const character = unshiftedPrintable(event);
  const codepoint = character?.codePointAt(0);
  if (codepoint === undefined || codepoint < 0x20 || codepoint === 0x7f) return null;
  return {
    key: { Unicode: codepoint },
    modifiers,
    action: event.repeat ? { Repeat: 1 } : { Press: {} },
  };
}
