/**
 * seoul256.vim color scheme
 * https://github.com/junegunn/seoul256.vim
 * https://github.com/mikker/seoul256-iTerm
 *
 * Dark theme uses seoul256-iTerm colors
 * Light theme uses seoul256.vim colors
 */

// 主题色单一真源在 @tmex/shared/appearance，前端只做 re-export 保持兼容命名。
export {
  TERMINAL_THEME_DARK as XTERM_THEME_DARK,
  TERMINAL_THEME_LIGHT as XTERM_THEME_LIGHT,
  getTmuxWindowStyle,
} from '@tmex/shared';

// 别名导出，保持兼容性
import { TERMINAL_THEME_DARK, TERMINAL_THEME_LIGHT } from '@tmex/shared';
export const XTERM_THEME_MIDNIGHT_AMETHYST = TERMINAL_THEME_DARK;
export const XTERM_THEME_DAWN_AMETHYST = TERMINAL_THEME_LIGHT;

// 内嵌字体逐字形兜底：等宽打底字体在前，符号字体其后，CJK 显式兜底在 monospace 前
// （Windows 的 monospace 泛型对简中解析为宋体）。没有任何单一等宽字体能覆盖全部 TUI
// 符号，故拆层；CJK 字形按 widthKind 双格绘制，兜底字体非等宽不破坏网格。
export const TERMINAL_EMBEDDED_FONT_FAMILIES = ['GeistMonoTmex', 'NotoSansSymbols2Tmex'];
export const XTERM_FONT_FAMILY = `${TERMINAL_EMBEDDED_FONT_FAMILIES.join(', ')}, "PingFang SC", "Microsoft YaHei", monospace`;

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
