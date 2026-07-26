import { describe, expect, test } from 'bun:test';
import { MAX_SEGMENT_LENGTH, scanLigatureSegments as scan } from './ligature-segments';
import type { GhosttyRenderCell, GhosttyRenderCellStyle } from './types';

const COLORS = {
  foreground: { r: 232, g: 232, b: 240 },
  background: { r: 16, g: 16, b: 24 },
};

function scanLigatureSegments(cells: GhosttyRenderCell[]) {
  return scan(cells, COLORS);
}

const BASE_STYLE: GhosttyRenderCellStyle = {
  bold: false,
  italic: false,
  faint: false,
  blink: false,
  inverse: false,
  invisible: false,
  strikethrough: false,
  overline: false,
  underline: 0,
};

function makeCells(
  text: string,
  overrides: Partial<GhosttyRenderCell>[] = []
): GhosttyRenderCell[] {
  return [...text].map((ch, x) => ({
    x,
    text: ch === ' ' ? '' : ch,
    codepoints: ch === ' ' ? [] : [ch.codePointAt(0) as number],
    widthKind: 'narrow',
    hasText: ch !== ' ',
    style: { ...BASE_STYLE },
    fgColor: null,
    bgColor: null,
    ...(overrides[x] ?? {}),
  }));
}

describe('scanLigatureSegments', () => {
  test('识别常见连字序列', () => {
    const segments = scanLigatureSegments(makeCells('a=>b'));
    expect(segments).toEqual([{ startIndex: 1, endIndex: 3, startX: 1, text: '=>' }]);
  });

  test('多段互不干扰', () => {
    const segments = scanLigatureSegments(makeCells('x -> y != z'));
    expect(segments.map((s) => s.text)).toEqual(['->', '!=']);
  });

  test('单个符号不成段', () => {
    expect(scanLigatureSegments(makeCells('a=b'))).toEqual([]);
  });

  test('字母与空格不进段', () => {
    expect(scanLigatureSegments(makeCells('www abc'))).toEqual([]);
  });

  test('样式变化处断段', () => {
    const cells = makeCells('===>');
    cells[2].style = { ...BASE_STYLE, bold: true };
    cells[3].style = { ...BASE_STYLE, bold: true };
    const segments = scanLigatureSegments(cells);
    expect(segments.map((s) => s.text)).toEqual(['==', '=>']);
  });

  test('前景色变化处断段', () => {
    const cells = makeCells('->->');
    cells[2].fgColor = { r: 255, g: 0, b: 0 };
    cells[3].fgColor = { r: 255, g: 0, b: 0 };
    const segments = scanLigatureSegments(cells);
    expect(segments.map((s) => s.text)).toEqual(['->', '->']);
  });

  test('背景色变化不断段', () => {
    const cells = makeCells('=>');
    cells[1].bgColor = { r: 30, g: 30, b: 60 };
    expect(scanLigatureSegments(cells).map((s) => s.text)).toEqual(['=>']);
  });

  test('inverse cell 与普通 cell 断段', () => {
    const cells = makeCells('=>');
    cells[1].style = { ...BASE_STYLE, inverse: true };
    expect(scanLigatureSegments(cells)).toEqual([]);
  });

  test('invisible cell 不进段', () => {
    const cells = makeCells('=>');
    cells[1].style = { ...BASE_STYLE, invisible: true };
    expect(scanLigatureSegments(cells)).toEqual([]);
  });

  test('宽字符与 grapheme 不进段', () => {
    const cells = makeCells('==');
    cells[1].widthKind = 'wide';
    expect(scanLigatureSegments(cells)).toEqual([]);
  });

  test('显式 RGB 与默认前景色相同时不断段', () => {
    const cells = makeCells('=>');
    cells[1].fgColor = { ...COLORS.foreground };
    expect(scanLigatureSegments(cells).map((s) => s.text)).toEqual(['=>']);
  });

  test('超长符号串按上限切窗', () => {
    const line = '='.repeat(MAX_SEGMENT_LENGTH * 2 + 3);
    const segments = scanLigatureSegments(makeCells(line));
    expect(segments.map((s) => s.text.length)).toEqual([MAX_SEGMENT_LENGTH, MAX_SEGMENT_LENGTH, 3]);
    expect(segments[1].startX).toBe(MAX_SEGMENT_LENGTH);
  });
});
