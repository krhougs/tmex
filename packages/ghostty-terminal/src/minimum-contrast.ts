import type { GhosttyColorRgb } from './types';

// 最小对比度保底：前景色与其所在 cell 背景的 WCAG 对比度低于阈值时，把前景沿明度方向
// 推到刚好达标。达标的组合原样返回，所以主题观感不受影响。
//
// 存在的理由：PowerShell 把普通输出和 PSReadLine 语法高亮固定打在 white(37)/
// brightWhite(97)/brightYellow(93) 上（它假设 cmd.exe 传统的深色背景），这三色在浅色
// 主题下对背景的对比度只有 1.03–1.16:1，整屏不可辨认。这不是某套配色配错了，而是
// "程序硬编码前景色" 与 "浅背景" 的组合问题，所以在渲染层兜底而不是改调色板。
//
// 阈值取 3.3：4.5（WCAG AA 正文标准，也是 VS Code 集成终端
// terminal.integrated.minimumContrastRatio 的默认值）会把深色主题里 8 个色一起改掉，
// 观感偏离过大；3.3 只兜住真正读不出来的那几个，保留调色板原有的色彩层次。
export const DEFAULT_MINIMUM_CONTRAST_RATIO = 3.3;

// 只有主题调色板的 16 个基础色参与兜底。256 色立方体（16–255）与 SGR 真彩色
// （\e[38;2;R;G;Bm）是程序精确指定的颜色，改动它们等于篡改应用的设计意图。
const THEME_PALETTE_SIZE = 16;

/**
 * 判断某个前景色是否该参与可读性兜底。
 *
 * `color` 为 null 表示 cell 没指定颜色、要用主题默认前景（同样参与兜底）；
 * `paletteIndex` 为 null 而 `color` 有值，说明这是 SGR 真彩色，必须原样呈现。
 */
export function isFallbackEligible(
  color: { r: number; g: number; b: number } | null,
  paletteIndex: number | null
): boolean {
  if (color === null) {
    return true;
  }
  return paletteIndex !== null && paletteIndex < THEME_PALETTE_SIZE;
}

function channelLuminance(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(color: GhosttyColorRgb): number {
  return (
    0.2126 * channelLuminance(color.r) +
    0.7152 * channelLuminance(color.g) +
    0.0722 * channelLuminance(color.b)
  );
}

export function contrastRatio(a: GhosttyColorRgb, b: GhosttyColorRgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function mix(from: GhosttyColorRgb, to: GhosttyColorRgb, amount: number): GhosttyColorRgb {
  return {
    r: Math.round(from.r + (to.r - from.r) * amount),
    g: Math.round(from.g + (to.g - from.g) * amount),
    b: Math.round(from.b + (to.b - from.b) * amount),
  };
}

const BLACK: GhosttyColorRgb = { r: 0, g: 0, b: 0 };
const WHITE: GhosttyColorRgb = { r: 255, g: 255, b: 255 };

/**
 * 返回与 `background` 至少有 `ratio` 对比度的前景色。
 *
 * 已达标则原样返回（多数 cell 走这条路径）。否则朝黑或白二分插值：背景偏亮时压暗前景、
 * 偏暗时提亮，取最小改动量以尽量保留原色相。若推到极值仍不达标（背景本身处于中间灰
 * 时可能发生），返回对比度较高的那个极值，保证可读优先。
 */
export function ensureMinimumContrast(
  foreground: GhosttyColorRgb,
  background: GhosttyColorRgb,
  ratio: number = DEFAULT_MINIMUM_CONTRAST_RATIO
): GhosttyColorRgb {
  if (ratio <= 1 || contrastRatio(foreground, background) >= ratio) {
    return foreground;
  }

  const target = relativeLuminance(background) > 0.18 ? BLACK : WHITE;
  if (contrastRatio(target, background) < ratio) {
    // 中间灰背景：两端都达不到阈值，选更可读的一端。
    return contrastRatio(BLACK, background) >= contrastRatio(WHITE, background) ? BLACK : WHITE;
  }

  let low = 0;
  let high = 1;
  for (let i = 0; i < 12; i += 1) {
    const mid = (low + high) / 2;
    if (contrastRatio(mix(foreground, target, mid), background) >= ratio) {
      high = mid;
    } else {
      low = mid;
    }
  }
  return mix(foreground, target, high);
}
