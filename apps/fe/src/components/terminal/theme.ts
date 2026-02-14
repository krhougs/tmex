/**
 * seoul256.vim color scheme
 * https://github.com/junegunn/seoul256.vim
 *
 * rgb_map from seoul256.vim (non-sRGB version for macOS/iTerm2)
 */

/**
 * seoul256-light - Seoul Colors Light
 * Background: 253 (#E1E1E1), Foreground: 239 (#616161)
 */
export const XTERM_THEME_LIGHT = {
  background: '#e1e1e1',
  foreground: '#616161',
  cursor: '#616161',
  selectionBackground: 'rgba(97, 97, 97, 0.25)',
  // ANSI colors for light theme
  black: '#171717',      // 233
  red: '#bf2172',        // 125 (magenta-red)
  green: '#009799',      // 30
  yellow: '#9a7200',     // 94
  blue: '#007299',       // 24
  magenta: '#9b1d72',    // 89
  cyan: '#007173',       // 23
  white: '#d9d9d9',      // 252
  // Bright colors
  brightBlack: '#4e4e4e',     // 239
  brightRed: '#e12672',       // 161
  brightGreen: '#00bddf',     // 38
  brightYellow: '#ffdd00',    // 220
  brightBlue: '#7299bc',      // 67
  brightMagenta: '#e17899',   // 168
  brightCyan: '#6fbcbd',      // 73
  brightWhite: '#f1f1f1',     // 255
};

/**
 * seoul256 - Seoul Colors Dark
 * Background: 237 (#4B4B4B), Foreground: 252 (#D9D9D9)
 */
export const XTERM_THEME_DARK = {
  background: '#4b4b4b',
  foreground: '#d9d9d9',
  cursor: '#d9d9d9',
  selectionBackground: 'rgba(217, 217, 217, 0.25)',
  // ANSI colors for dark theme
  black: '#171717',      // 233
  red: '#9b1300',        // 88
  green: '#006f00',      // 22
  yellow: '#9a7200',     // 94
  blue: '#007299',       // 24
  magenta: '#9b1d72',    // 89
  cyan: '#007173',       // 23
  white: '#d9d9d9',      // 252
  // Bright colors
  brightBlack: '#565656',     // 238
  brightRed: '#e12672',       // 161
  brightGreen: '#719872',     // 65
  brightYellow: '#ffdd00',    // 220
  brightBlue: '#70bddf',      // 74
  brightMagenta: '#e17899',   // 168
  brightCyan: '#97dddf',      // 116
  brightWhite: '#f1f1f1',     // 255
};

export const XTERM_FONT_FAMILY =
  '"JetBrains Mono", "SF Mono", Menlo, Monaco, Consolas, "Liberation Mono", "Noto Sans Mono CJK SC", "Source Han Mono SC", "Sarasa Mono SC", "Noto Color Emoji", "Apple Color Emoji", "Segoe UI Emoji", monospace';

// 别名导出，保持兼容性
export const XTERM_THEME_MIDNIGHT_AMETHYST = XTERM_THEME_DARK;
export const XTERM_THEME_DAWN_AMETHYST = XTERM_THEME_LIGHT;
