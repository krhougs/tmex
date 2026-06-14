/**
 * seoul256.vim color scheme
 * https://github.com/junegunn/seoul256.vim
 * https://github.com/mikker/seoul256-iTerm
 *
 * Dark theme uses seoul256-iTerm colors
 * Light theme uses seoul256.vim colors
 */

/**
 * seoul256-light - Seoul Colors Light
 * From seoul256.vim: Background 253 (#E1E1E1), Foreground 239 (#616161)
 */
export const XTERM_THEME_LIGHT = {
  background: '#e1e1e1',
  foreground: '#616161',
  cursor: '#616161',
  selectionBackground: 'rgba(97, 97, 97, 0.25)',
  // ANSI colors
  black: '#171717',
  red: '#bf2172',
  green: '#009799',
  yellow: '#9a7200',
  blue: '#007299',
  magenta: '#9b1d72',
  cyan: '#007173',
  white: '#d9d9d9',
  // Bright colors
  brightBlack: '#4e4e4e',
  brightRed: '#e12672',
  brightGreen: '#00bddf',
  brightYellow: '#ffdd00',
  brightBlue: '#7299bc',
  brightMagenta: '#e17899',
  brightCyan: '#6fbcbd',
  brightWhite: '#f1f1f1',
};

/**
 * seoul256-dark - Seoul Colors Dark
 * From seoul256-iTerm: https://github.com/mikker/seoul256-iTerm
 */
export const XTERM_THEME_DARK = {
  background: '#262626',
  foreground: '#d0d0d0',
  cursor: '#c5c5c5',
  selectionBackground: 'rgba(197, 197, 197, 0.25)',
  // ANSI colors (from iTerm colors)
  black: '#000000',
  red: '#ba3c3c',
  green: '#5d876d',
  yellow: '#d5a54e',
  blue: '#887c8d',
  magenta: '#cd6d6d',
  cyan: '#618484',
  white: '#cfcdc3',
  // Bright colors (from iTerm colors)
  brightBlack: '#000000',
  brightRed: '#ea7171',
  brightGreen: '#7aab7a',
  brightYellow: '#d1d194',
  brightBlue: '#afa3b5',
  brightMagenta: '#e29f9f',
  brightCyan: '#a0aea3',
  brightWhite: '#d0d0d0',
};

// gateway 用 window-style 代答 tmux 内 OSC 10/11 颜色查询，需与 xterm 主题保持一致
export function getTmuxWindowStyle(theme: 'light' | 'dark'): string {
  const colors = theme === 'light' ? XTERM_THEME_LIGHT : XTERM_THEME_DARK;
  return `fg=${colors.foreground},bg=${colors.background}`;
}

// 内嵌字体逐字形兜底：等宽打底字体在前，符号字体其后，CJK 落到末尾 monospace 走系统。
// 没有任何单一等宽字体能覆盖全部 TUI 符号，故拆成两层。family 名刻意不带空格，免去加引号。
export const TERMINAL_EMBEDDED_FONT_FAMILIES = ['GeistMonoTmex', 'NotoSansSymbols2Tmex'];
export const XTERM_FONT_FAMILY = `${TERMINAL_EMBEDDED_FONT_FAMILIES.join(', ')}, monospace`;

// canvas/DOM 测量 cell 尺寸前必须确保内嵌字体已加载：否则首屏按 monospace 回退
// 测宽，font-display swap 生效后字形按内嵌字体度量渲染，与已定网格逐格错位。
let embeddedFontLoadPromise: Promise<void> | null = null;
export function ensureTerminalFontLoaded(): Promise<void> {
  if (embeddedFontLoadPromise) {
    return embeddedFontLoadPromise;
  }
  const fonts = (globalThis as { document?: { fonts?: FontFaceSet } }).document?.fonts;
  if (!fonts?.load) {
    embeddedFontLoadPromise = Promise.resolve();
    return embeddedFontLoadPromise;
  }
  embeddedFontLoadPromise = Promise.all(
    TERMINAL_EMBEDDED_FONT_FAMILIES.flatMap((family) => [
      fonts.load(`13px ${family}`),
      fonts.load(`bold 13px ${family}`),
    ])
  )
    .then(() => undefined)
    .catch(() => undefined);
  return embeddedFontLoadPromise;
}

// 别名导出，保持兼容性
export const XTERM_THEME_MIDNIGHT_AMETHYST = XTERM_THEME_DARK;
export const XTERM_THEME_DAWN_AMETHYST = XTERM_THEME_LIGHT;
