// 终端/等宽字体的运行时接线：选字体 → 派生 CSS 字体栈 + 懒加载 woff2。
// 字号/行高仅作用于终端；字体族经 --font-mono 全应用统一（见 useAppMonoFont）。

import { DEFAULT_FONT_ID, FONT_MANIFEST } from './manifest.generated';
import type { FontManifestEntry } from './types';

export { DEFAULT_FONT_ID, FONT_MANIFEST };
export type { FontManifestEntry };

// 符号兜底字体（媒体控制/Braille/勾选等），恒定挂在主字体之后，CJK 落系统 monospace。
const SYMBOL_FALLBACK = 'NotoSansSymbols2Tmex';

export function getFontEntry(fontId: string): FontManifestEntry {
  return (
    FONT_MANIFEST.find((f) => f.id === fontId) ??
    FONT_MANIFEST.find((f) => f.id === DEFAULT_FONT_ID) ??
    FONT_MANIFEST[0]
  );
}

/** 由 fontId 派生完整 CSS font-family 栈：主字体 → 符号兜底 → 系统等宽。 */
export function resolveFontStack(fontId: string): string {
  return `${getFontEntry(fontId).cssFamily}, ${SYMBOL_FALLBACK}, monospace`;
}

const injectedFamilies = new Set<string>();

// 非默认字体在选中时才注入 @font-face（默认 Geist 已在 index.css 静态声明）。
function injectFontFace(entry: FontManifestEntry): void {
  const doc = (globalThis as { document?: Document }).document;
  if (!doc || !entry.files || injectedFamilies.has(entry.cssFamily)) {
    return;
  }
  const style = doc.createElement('style');
  style.dataset.tmexFont = entry.id;
  style.textContent =
    `@font-face{font-family:${entry.cssFamily};` +
    `src:url("${entry.files.regular}") format("woff2");font-weight:400;font-style:normal;font-display:swap}` +
    `@font-face{font-family:${entry.cssFamily};` +
    `src:url("${entry.files.bold}") format("woff2");font-weight:700;font-style:normal;font-display:swap}`;
  doc.head.appendChild(style);
  injectedFamilies.add(entry.cssFamily);
}

// 确保指定字体（主字体 + 符号兜底）的 Regular/Bold 已加载，再交给 canvas 测宽渲染。
// 非默认字体先注入 @font-face；幂等（注入有 Set 去重，fonts.load 自带缓存）。
export async function loadTerminalFonts(fontId: string, fontSize: number): Promise<void> {
  const fonts = (globalThis as { document?: { fonts?: FontFaceSet } }).document?.fonts;
  if (!fonts?.load) {
    return;
  }
  const entry = getFontEntry(fontId);
  if (!entry.isDefault) {
    injectFontFace(entry);
  }
  try {
    await Promise.all(
      [entry.cssFamily, SYMBOL_FALLBACK].flatMap((family) => [
        fonts.load(`${fontSize}px ${family}`),
        fonts.load(`bold ${fontSize}px ${family}`),
      ])
    );
  } catch {
    // 字体加载失败静默降级到 monospace，不阻塞渲染
  }
}
