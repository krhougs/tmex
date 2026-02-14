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

export const XTERM_FONT_FAMILY =
  '"JetBrains Mono", "SF Mono", Menlo, Monaco, Consolas, "Liberation Mono", "Noto Sans Mono CJK SC", "Source Han Mono SC", "Sarasa Mono SC", "Noto Color Emoji", "Apple Color Emoji", "Segoe UI Emoji", monospace';

// 别名导出，保持兼容性
export const XTERM_THEME_MIDNIGHT_AMETHYST = XTERM_THEME_DARK;
export const XTERM_THEME_DAWN_AMETHYST = XTERM_THEME_LIGHT;
