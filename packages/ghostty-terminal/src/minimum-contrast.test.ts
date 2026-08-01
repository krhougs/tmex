import { describe, expect, test } from 'bun:test';

import { scanLigatureSegments } from './ligature-segments';
import {
  DEFAULT_MINIMUM_CONTRAST_RATIO,
  contrastRatio,
  ensureMinimumContrast,
  isFallbackEligible,
} from './minimum-contrast';

const rgb = (hex: string) => ({
  r: Number.parseInt(hex.slice(1, 3), 16),
  g: Number.parseInt(hex.slice(3, 5), 16),
  b: Number.parseInt(hex.slice(5, 7), 16),
});

// seoul256-light 的终端背景，PowerShell 不可读问题的现场。
const LIGHT_BG = rgb('#e1e1e1');
const DARK_BG = rgb('#262626');

describe('contrastRatio', () => {
  test('对称且符合 WCAG 定义', () => {
    expect(contrastRatio(rgb('#000000'), rgb('#ffffff'))).toBeCloseTo(21, 5);
    expect(contrastRatio(rgb('#ffffff'), rgb('#000000'))).toBeCloseTo(21, 5);
    expect(contrastRatio(LIGHT_BG, LIGHT_BG)).toBeCloseTo(1, 5);
  });
});

describe('ensureMinimumContrast', () => {
  test('已达标的组合原样返回（主题观感不受影响）', () => {
    const fg = rgb('#616161'); // 亮色主题默认前景，4.74:1
    expect(ensureMinimumContrast(fg, LIGHT_BG)).toEqual(fg);
  });

  // PowerShell 把普通输出/PSReadLine 高亮固定打在这三色上，浅背景下全部不可读。
  test.each([
    ['white(37)', '#d9d9d9'],
    ['brightWhite(97)', '#f1f1f1'],
    ['brightYellow(93)', '#ffdd00'],
  ])('浅背景下把不可读的 %s 推到达标', (_label, hex) => {
    const fg = rgb(hex);
    expect(contrastRatio(fg, LIGHT_BG)).toBeLessThan(2);
    const adjusted = ensureMinimumContrast(fg, LIGHT_BG);
    expect(contrastRatio(adjusted, LIGHT_BG)).toBeGreaterThanOrEqual(
      DEFAULT_MINIMUM_CONTRAST_RATIO
    );
  });

  test('深背景下 brightBlack 被提亮而非压暗', () => {
    const fg = rgb('#000000'); // seoul256-dark 的 brightBlack，对 #262626 只有 1.39:1
    const adjusted = ensureMinimumContrast(fg, DARK_BG);
    expect(contrastRatio(adjusted, DARK_BG)).toBeGreaterThanOrEqual(DEFAULT_MINIMUM_CONTRAST_RATIO);
    expect(adjusted.r).toBeGreaterThan(fg.r);
  });

  test('保留色相方向：黄色压暗后仍是黄色', () => {
    const adjusted = ensureMinimumContrast(rgb('#ffdd00'), LIGHT_BG);
    expect(adjusted.r).toBeGreaterThan(adjusted.b);
    expect(adjusted.g).toBeGreaterThan(adjusted.b);
  });

  test('默认阈值 3.3 只兜住读不出来的色，不动已有层次', () => {
    // 3.3 与 4.5 的分界：yellow(33) 3.36:1 勉强可读，保持原样；white(37) 必须兜。
    expect(ensureMinimumContrast(rgb('#9a7200'), LIGHT_BG)).toEqual(rgb('#9a7200'));
    expect(ensureMinimumContrast(rgb('#d9d9d9'), LIGHT_BG)).not.toEqual(rgb('#d9d9d9'));
  });

  test('ratio <= 1 时不做任何调整', () => {
    const fg = rgb('#f1f1f1');
    expect(ensureMinimumContrast(fg, LIGHT_BG, 1)).toEqual(fg);
  });

  // 对默认的 3.3 阈值，任何背景至少有黑或白一端达标（要两端都不达标需同时满足
  // L < 0.115 与 L > 0.268）。该兜底只在调用方要求更高阈值时才可能触发。
  test('阈值高到两端都达不到时，取更可读的一端', () => {
    const mid = rgb('#767676');
    const adjusted = ensureMinimumContrast(rgb('#787878'), mid, 7);
    const best = Math.max(contrastRatio(rgb('#000000'), mid), contrastRatio(rgb('#ffffff'), mid));
    expect(best).toBeLessThan(7);
    expect(contrastRatio(adjusted, mid)).toBeCloseTo(best, 5);
  });
});

// 兜底只针对主题调色板的 16 个基础色。256 色立方体与 SGR 真彩色是程序精确指定的
// 颜色，改动它们等于篡改应用的设计意图——这条边界靠 cell 的颜色来源判定，不能靠
// RGB 值，因为 palette 196 与 \e[38;2;255;0;0m 解析出来完全同值。
describe('isFallbackEligible', () => {
  test('未指定颜色（用主题默认前景）参与兜底', () => {
    expect(isFallbackEligible(null, null)).toBe(true);
  });

  test('调色板 0–15 参与兜底', () => {
    expect(isFallbackEligible(rgb('#d9d9d9'), 7)).toBe(true);
    expect(isFallbackEligible(rgb('#f1f1f1'), 15)).toBe(true);
  });

  test('256 色立方体与灰阶不参与', () => {
    expect(isFallbackEligible(rgb('#ff0000'), 16)).toBe(false);
    expect(isFallbackEligible(rgb('#bcbcbc'), 250)).toBe(false);
  });

  test('SGR 真彩色不参与——即使与调色板色同值', () => {
    expect(isFallbackEligible(rgb('#ff0000'), null)).toBe(false);
    // brightYellow 在浅背景下只有 1.03:1，但显式写成真彩色就必须原样呈现。
    expect(isFallbackEligible(rgb('#ffdd00'), null)).toBe(false);
  });
});

// 开关本身：ghostty-terminal 默认关闭，宿主显式打开（GhosttyTerminalInitOptions
// .minimumContrast）。这里钉住「关闭时连字分段按原色比较」——两条路径必须同源，
// 否则关掉开关后分段依据仍是兜底色，会把本该同段的 cell 拆开。
describe('minimumContrast 开关与连字分段一致', () => {
  const cells = (fg: { r: number; g: number; b: number } | null, idx: number | null) =>
    ['=', '>'].map((ch, x) => ({
      x,
      text: ch,
      codepoints: [ch.codePointAt(0) as number],
      widthKind: 'narrow' as const,
      hasText: true,
      style: {
        bold: false,
        italic: false,
        faint: false,
        blink: false,
        inverse: false,
        invisible: false,
        strikethrough: false,
        overline: false,
        underline: 0,
      },
      fgColor: x === 0 ? fg : { r: 255, g: 221, b: 0 },
      bgColor: null,
      fgPaletteIndex: x === 0 ? idx : null,
      bgPaletteIndex: null,
    }));

  const colors = { foreground: rgb('#616161'), background: LIGHT_BG };

  test('开启时：调色板亮黄被兜底，与同值真彩色不能并进一段', () => {
    const segments = scanLigatureSegments(cells(rgb('#ffdd00'), 11), {
      ...colors,
      minimumContrast: true,
    });
    expect(segments).toEqual([]);
  });

  test('关闭时：两者都按原色，仍是同一段', () => {
    const segments = scanLigatureSegments(cells(rgb('#ffdd00'), 11), colors);
    expect(segments).toHaveLength(1);
    expect(segments[0].text).toBe('=>');
  });
});
