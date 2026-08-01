import { ensureMinimumContrast, isFallbackEligible } from './minimum-contrast';
import type { GhosttyColorRgb, GhosttyRenderCell } from './types';

/**
 * 编程连字候选段扫描。
 *
 * 逐 cell 绘制下浏览器 shaping 没有上下文，calt 连字（=> -> != 等）永远不会
 * 出现。把同样式的连续 ASCII 符号 cell 合并成段、整段一次 fillText，浏览器
 * 即可正常连字。段起点按段首 cell 网格定位；段内字符落点由字体 advance 决定，
 * 与网格的偏差 = |cell宽 − advance|×位置，主流等宽字体为 0 或亚像素级，段长
 * 上限进一步压住最坏情况（也避免整行分隔线之类的病态长段）。
 */

/** 主流编程连字（Fira/JetBrains/Iosevka/Geist 系）的全部组成字符。 */
const LIGATURE_CHARS = new Set<number>(
  [...'!#$%&*+-./:;<=>?@\\^_|~'].map((ch) => ch.codePointAt(0) as number)
);

const MAX_SEGMENT_LENGTH = 8;

type LigatureSegment = {
  /** row.cells 中的起始下标（含） */
  startIndex: number;
  /** row.cells 中的结束下标（不含） */
  endIndex: number;
  /** 段首 cell 的列号 */
  startX: number;
  text: string;
};

function isSegmentCell(cell: GhosttyRenderCell): boolean {
  return (
    cell.widthKind === 'narrow' &&
    cell.codepoints.length === 1 &&
    LIGATURE_CHARS.has(cell.codepoints[0]) &&
    cell.text.length > 0 &&
    !cell.style.invisible
  );
}

type SegmentColors = {
  foreground: GhosttyColorRgb;
  background: GhosttyColorRgb;
  /** 与渲染器同一个开关：关闭时按原色比较，否则分段依据会和实际绘制色对不上。 */
  minimumContrast?: boolean;
};

// 前景色按「绘制时实际使用的解析值」比较（默认色落到主题色），显式 RGB 与
// 默认色恰好相同时不再误断段。
function styleKey(cell: GhosttyRenderCell, colors: SegmentColors): string {
  const s = cell.style;
  const fg = s.inverse ? (cell.bgColor ?? colors.background) : (cell.fgColor ?? colors.foreground);
  const bg = s.inverse ? (cell.fgColor ?? colors.foreground) : (cell.bgColor ?? colors.background);
  // 段首的颜色决定整段，所以比较的必须是「最终画上去的颜色」而不是原始色：同一个
  // RGB，来自调色板时会被可读性兜底、来自 SGR 真彩色时原样保留，两者不能并进一段。
  const drawn =
    colors.minimumContrast &&
    isFallbackEligible(
      s.inverse ? cell.bgColor : cell.fgColor,
      s.inverse ? cell.bgPaletteIndex : cell.fgPaletteIndex
    )
      ? ensureMinimumContrast(fg, bg)
      : fg;
  return [
    s.bold,
    s.italic,
    s.faint,
    s.inverse,
    s.strikethrough,
    s.overline,
    s.underline,
    `${drawn.r},${drawn.g},${drawn.b}`,
  ].join('|');
}

/** 扫描一行内可整段绘制的连字候选段（长度 ≥2，同可比样式；bg 不参与比较）。 */
function scanLigatureSegments(
  cells: GhosttyRenderCell[],
  colors: SegmentColors
): LigatureSegment[] {
  const segments: LigatureSegment[] = [];
  let i = 0;

  while (i < cells.length) {
    if (!isSegmentCell(cells[i])) {
      i += 1;
      continue;
    }

    const key = styleKey(cells[i], colors);
    let j = i + 1;
    while (
      j < cells.length &&
      j - i < MAX_SEGMENT_LENGTH &&
      isSegmentCell(cells[j]) &&
      styleKey(cells[j], colors) === key
    ) {
      j += 1;
    }

    if (j - i >= 2) {
      let text = '';
      for (let k = i; k < j; k += 1) {
        text += cells[k].text;
      }
      segments.push({ startIndex: i, endIndex: j, startX: cells[i].x, text });
    }
    i = j;
  }

  return segments;
}

export type { LigatureSegment, SegmentColors };
export { LIGATURE_CHARS, MAX_SEGMENT_LENGTH, scanLigatureSegments };
