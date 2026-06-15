// 终端快捷键的按键捕获 / 转义解析 / 苹果符号映射工具。
//
// keyEventToTerminalSequence：把一次键盘事件（含修饰键）转成要发往终端的控制序列
// 与人类可读的标签；parseEscapeSequence：解析高级手填的转义串；labelToSymbols：
// 图标模式下把按键名渲染成苹果风格符号。

/** 仅需要键名 + 修饰键状态，React.KeyboardEvent 结构兼容。 */
export interface KeyChord {
  key: string;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
}

export interface CapturedShortcut {
  label: string;
  payload: string;
}

// 纯修饰键 / 无意义键：捕获时忽略
const MODIFIER_ONLY = new Set([
  'Control',
  'Shift',
  'Alt',
  'Meta',
  'CapsLock',
  'NumLock',
  'ScrollLock',
  'Dead',
  'Unidentified',
  'OS',
  'ContextMenu',
  'Fn',
  'FnLock',
  'Hyper',
  'Super',
]);

type KeyDef =
  | { label: string; raw: string } // 直接序列（Enter/Tab/Esc/Backspace/Space）
  | { label: string; csiFinal: string } // \x1b[<final> 或 \x1b[1;<mod><final>（方向键/Home/End）
  | { label: string; csiNum: number }; // \x1b[<num>~ 或 \x1b[<num>;<mod>~（Delete/Page/Insert）

const NAMED_KEYS: Record<string, KeyDef> = {
  Enter: { label: 'Enter', raw: '\r' },
  Tab: { label: 'Tab', raw: '\t' },
  Escape: { label: 'ESC', raw: '\x1b' },
  // Backspace 沿用项目历史取值 \x08（与默认快捷键列表一致）
  Backspace: { label: 'Backspace', raw: '\x08' },
  ' ': { label: 'Space', raw: ' ' },
  ArrowUp: { label: '↑', csiFinal: 'A' },
  ArrowDown: { label: '↓', csiFinal: 'B' },
  ArrowRight: { label: '→', csiFinal: 'C' },
  ArrowLeft: { label: '←', csiFinal: 'D' },
  Home: { label: 'Home', csiFinal: 'H' },
  End: { label: 'End', csiFinal: 'F' },
  Delete: { label: 'Delete', csiNum: 3 },
  Insert: { label: 'Insert', csiNum: 2 },
  PageUp: { label: 'PgUp', csiNum: 5 },
  PageDown: { label: 'PgDn', csiNum: 6 },
};

const FUNCTION_KEYS: Record<string, string> = {
  F1: '\x1bOP',
  F2: '\x1bOQ',
  F3: '\x1bOR',
  F4: '\x1bOS',
  F5: '\x1b[15~',
  F6: '\x1b[17~',
  F7: '\x1b[18~',
  F8: '\x1b[19~',
  F9: '\x1b[20~',
  F10: '\x1b[21~',
  F11: '\x1b[23~',
  F12: '\x1b[24~',
};

// Ctrl + 部分符号的控制码
const CTRL_SYMBOLS: Record<string, string> = {
  '[': '\x1b',
  '\\': '\x1c',
  ']': '\x1d',
  '^': '\x1e',
  _: '\x1f',
  '@': '\x00',
  '?': '\x7f',
};

function computeModCode(e: KeyChord): number {
  return 1 + (e.shiftKey ? 1 : 0) + (e.altKey ? 2 : 0) + (e.ctrlKey ? 4 : 0) + (e.metaKey ? 8 : 0);
}

function modPrefix(e: KeyChord): string {
  const parts: string[] = [];
  if (e.ctrlKey) parts.push('CTRL');
  if (e.altKey) parts.push('ALT');
  if (e.metaKey) parts.push('CMD');
  if (e.shiftKey) parts.push('SHIFT');
  return parts.length ? `${parts.join('-')}-` : '';
}

/**
 * 把一次键盘事件转成终端控制序列 + 标签；无法识别（如纯修饰键）返回 null。
 */
export function keyEventToTerminalSequence(e: KeyChord): CapturedShortcut | null {
  const key = e.key;
  if (!key || MODIFIER_ONLY.has(key)) return null;

  const mod = computeModCode(e);
  const hasMod = mod !== 1;
  const prefix = modPrefix(e);

  // Shift+Tab → reverse tab
  if (key === 'Tab' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
    return { label: 'SHIFT-Tab', payload: '\x1b[Z' };
  }
  // Shift+Enter → CSI u
  if (key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
    return { label: 'SHIFT-Enter', payload: '\x1b[13;2u' };
  }

  // Ctrl + 字母 → 控制码 \x01..\x1a
  if (e.ctrlKey && !e.altKey && !e.metaKey && /^[a-zA-Z]$/.test(key)) {
    const upper = key.toUpperCase();
    return { label: `CTRL-${upper}`, payload: String.fromCharCode(upper.charCodeAt(0) - 64) };
  }

  // 功能键
  const fk = FUNCTION_KEYS[key];
  if (fk) {
    return { label: prefix + key, payload: fk };
  }

  // 命名特殊键
  const named = NAMED_KEYS[key];
  if (named) {
    if ('raw' in named) {
      const payload = e.altKey ? `\x1b${named.raw}` : named.raw;
      return { label: prefix + named.label, payload };
    }
    if ('csiFinal' in named) {
      const payload = hasMod ? `\x1b[1;${mod}${named.csiFinal}` : `\x1b[${named.csiFinal}`;
      return { label: prefix + named.label, payload };
    }
    const payload = hasMod ? `\x1b[${named.csiNum};${mod}~` : `\x1b[${named.csiNum}~`;
    return { label: prefix + named.label, payload };
  }

  // 单个可打印字符
  if (key.length === 1) {
    if (e.altKey && !e.ctrlKey && !e.metaKey) {
      return { label: `ALT-${key.toUpperCase()}`, payload: `\x1b${key}` };
    }
    if (e.ctrlKey) {
      const cc = CTRL_SYMBOLS[key];
      // 无对应控制码的 Ctrl+字符（如 Ctrl+1）拒绝捕获，避免标签声称 CTRL 组合但只发裸字符
      if (cc !== undefined) {
        return { label: prefix + key, payload: cc };
      }
      return null;
    }
    // 普通字符（shift 已体现在 key 上）
    return { label: key, payload: key };
  }

  return null;
}

/**
 * 解析手填的转义串：\xHH \uHHHH \r \n \t \e \0 \a \b \f \v \\ 等，
 * 其余 \X 保留 X 本身。
 */
export function parseEscapeSequence(input: string): string {
  return input.replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|.)/g, (_match, g: string) => {
    // 仅完整的 \xHH / \uHHHH 才解析为字符；非法转义（如 \xGG、行尾 \x）落到 switch 当字面，
    // 避免被兜底 `.` 吃成单字符后误入 hex 分支、parseInt('') = NaN 注入 NUL。
    if (g[0] === 'x' && g.length === 3) {
      return String.fromCharCode(Number.parseInt(g.slice(1), 16));
    }
    if (g[0] === 'u' && g.length === 5) {
      return String.fromCharCode(Number.parseInt(g.slice(1), 16));
    }
    switch (g) {
      case 'r':
        return '\r';
      case 'n':
        return '\n';
      case 't':
        return '\t';
      case 'e':
        return '\x1b';
      case '0':
        return '\x00';
      case 'a':
        return '\x07';
      case 'b':
        return '\x08';
      case 'f':
        return '\x0c';
      case 'v':
        return '\x0b';
      case '\\':
        return '\\';
      default:
        return g;
    }
  });
}

/**
 * 把控制序列转成可读转义串供输入框展示（parseEscapeSequence 的逆向，用于行内编辑）。
 */
export function escapeForDisplay(s: string): string {
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === '\\') out += '\\\\';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\x1b') out += '\\e';
    else if (code < 0x20 || (code >= 0x7f && code <= 0x9f))
      out += `\\x${code.toString(16).padStart(2, '0')}`;
    else out += ch;
  }
  return out;
}

// 苹果风格符号映射（依赖 NotoSansSymbols2 兜底字体）
const SYMBOL_MAP: Record<string, string> = {
  CTRL: '⌃',
  CONTROL: '⌃',
  SHIFT: '⇧',
  ALT: '⌥',
  OPTION: '⌥',
  OPT: '⌥',
  CMD: '⌘',
  META: '⌘',
  SUPER: '⌘',
  WIN: '⌘',
  ENTER: '⏎',
  RETURN: '⏎',
  CR: '⏎',
  ESC: '⎋',
  ESCAPE: '⎋',
  TAB: '⇥',
  BACKSPACE: '⌫',
  BS: '⌫',
  DELETE: '⌦',
  DEL: '⌦',
  SPACE: '␣',
  UP: '↑',
  DOWN: '↓',
  LEFT: '←',
  RIGHT: '→',
};

/**
 * 图标模式：把按键名（如 "CTRL-C" / "SHIFT-Enter"）渲染成苹果风格符号（"⌃C" / "⇧⏎"）。
 * 按 - / + 分词逐 token 映射，未命中的 token 原样保留。
 */
export function labelToSymbols(label: string): string {
  if (!label) return label;
  const tokens = label.split(/[-+]/);
  return tokens
    .map((tok) => {
      const up = tok.trim().toUpperCase();
      return SYMBOL_MAP[up] ?? tok;
    })
    .join('');
}
