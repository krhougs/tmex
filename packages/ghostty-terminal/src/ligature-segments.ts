import type { GhosttyRenderCell } from './types';

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

function styleKey(cell: GhosttyRenderCell): string {
  const s = cell.style;
  const fg = cell.style.inverse ? cell.bgColor : cell.fgColor;
  return [
    s.bold,
    s.italic,
    s.faint,
    s.inverse,
    s.strikethrough,
    s.overline,
    s.underline,
    fg ? `${fg.r},${fg.g},${fg.b}` : 'default',
  ].join('|');
}

/** 扫描一行内可整段绘制的连字候选段（长度 ≥2，同可比样式；bg 不参与比较）。 */
function scanLigatureSegments(cells: GhosttyRenderCell[]): LigatureSegment[] {
  const segments: LigatureSegment[] = [];
  let i = 0;

  while (i < cells.length) {
    if (!isSegmentCell(cells[i])) {
      i += 1;
      continue;
    }

    const key = styleKey(cells[i]);
    let j = i + 1;
    while (
      j < cells.length &&
      j - i < MAX_SEGMENT_LENGTH &&
      isSegmentCell(cells[j]) &&
      styleKey(cells[j]) === key
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

export type { LigatureSegment };
export { LIGATURE_CHARS, MAX_SEGMENT_LENGTH, scanLigatureSegments };
