import { describe, expect, test } from 'bun:test';
import {
  buildLineModel,
  createEmptySelectionState,
  lineModelFromText,
  projectSelectionRects,
  resolvePointerSelection,
  serializeSelectionText,
  updateSelectionFocus,
} from './selection-model';
import type { GhosttyCellWidthKind, GhosttyRenderCell } from './types';

function cell(
  x: number,
  text: string,
  widthKind: GhosttyCellWidthKind = 'narrow',
  hasText = text !== ''
): GhosttyRenderCell {
  return {
    x,
    text,
    codepoints: Array.from(text).map((ch) => ch.codePointAt(0) ?? 32),
    widthKind,
    hasText,
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
    fgColor: null,
    bgColor: null,
  };
}

/** "a中b" + 行尾空 cell 填充到 8 列 */
function wideCharLineCells(): GhosttyRenderCell[] {
  return [
    cell(0, 'a'),
    cell(1, '中', 'wide'),
    cell(2, '', 'spacer-tail', false),
    cell(3, 'b'),
    cell(4, '', 'narrow', false),
    cell(5, '', 'narrow', false),
    cell(6, '', 'narrow', false),
    cell(7, '', 'narrow', false),
  ];
}

describe('buildLineModel', () => {
  test('宽字符主列保留完整字符,spacer-tail 列为 null', () => {
    const model = buildLineModel(wideCharLineCells());
    expect(model.colChars).toEqual(['a', '中', null, 'b', ' ', ' ', ' ', ' ']);
    expect(model.contentCols).toBe(4);
    expect(model.wrappedToNext).toBe(false);
  });

  test('contentCols 同时裁剪空 cell 与写入的行尾空格', () => {
    const model = buildLineModel([
      cell(0, 'x'),
      cell(1, ' ', 'narrow', true),
      cell(2, ' ', 'narrow', true),
      cell(3, '', 'narrow', false),
    ]);
    expect(model.contentCols).toBe(1);
  });
});

describe('屏幕列空间的选区', () => {
  test('宽字符行:按屏幕列选择得到正确文本与高亮宽度', () => {
    const getLine = () => buildLineModel(wideCharLineCells());

    // 从列 0 拖到列 3("a中b" 全部,屏幕列 0-3)
    let selection = resolvePointerSelection(
      createEmptySelectionState(),
      { line: 0, col: 0, mode: 'character' },
      getLine
    );
    selection = updateSelectionFocus(selection, { line: 0, col: 3 }, getLine);
    expect(serializeSelectionText(selection, getLine)).toBe('a中b');
    expect(projectSelectionRects(selection, 0, 1, getLine)).toEqual([{ row: 0, x: 0, width: 4 }]);
  });

  test('焦点落在宽字符上时高亮覆盖其两列,文本包含完整字符', () => {
    const getLine = () => buildLineModel(wideCharLineCells());

    let selection = resolvePointerSelection(
      createEmptySelectionState(),
      { line: 0, col: 0, mode: 'character' },
      getLine
    );
    // 拖到 spacer 列(列 2):焦点吸附回主列,高亮扩展覆盖 spacer
    selection = updateSelectionFocus(selection, { line: 0, col: 2 }, getLine);
    expect(serializeSelectionText(selection, getLine)).toBe('a中');
    expect(projectSelectionRects(selection, 0, 1, getLine)).toEqual([{ row: 0, x: 0, width: 3 }]);
  });

  test('双击宽字符与相邻字母组成的词整体选中', () => {
    const getLine = () => buildLineModel(wideCharLineCells());

    const selection = resolvePointerSelection(
      createEmptySelectionState(),
      { line: 0, col: 1, mode: 'word' },
      getLine
    );
    expect(serializeSelectionText(selection, getLine)).toBe('a中b');
  });

  test('行选与拖到行尾不包含行尾空白', () => {
    const getLine = () => buildLineModel(wideCharLineCells());

    const lineSelection = resolvePointerSelection(
      createEmptySelectionState(),
      { line: 0, col: 5, mode: 'line' },
      getLine
    );
    expect(serializeSelectionText(lineSelection, getLine)).toBe('a中b');

    let dragSelection = resolvePointerSelection(
      createEmptySelectionState(),
      { line: 0, col: 0, mode: 'character' },
      getLine
    );
    dragSelection = updateSelectionFocus(dragSelection, { line: 0, col: 7 }, getLine);
    expect(serializeSelectionText(dragSelection, getLine)).toBe('a中b');
  });

  test('跨行选择:中间行裁剪行尾空白,空行保留为空段', () => {
    const lines: Record<number, ReturnType<typeof lineModelFromText>> = {
      0: lineModelFromText('first   '),
      1: lineModelFromText(''),
      2: lineModelFromText('third'),
    };
    const getLine = (line: number) => lines[line] ?? lineModelFromText('');

    let selection = resolvePointerSelection(
      createEmptySelectionState(),
      { line: 0, col: 0, mode: 'character' },
      getLine
    );
    selection = updateSelectionFocus(selection, { line: 2, col: 4 }, getLine);
    expect(serializeSelectionText(selection, getLine)).toBe('first\n\nthird');
  });

  test('行内空格(非行尾)保留', () => {
    const getLine = () => lineModelFromText('ab cd  ');

    let selection = resolvePointerSelection(
      createEmptySelectionState(),
      { line: 0, col: 0, mode: 'character' },
      getLine
    );
    selection = updateSelectionFocus(selection, { line: 0, col: 4 }, getLine);
    expect(serializeSelectionText(selection, getLine)).toBe('ab cd');
  });
});

describe('软换行(wrap)的复制', () => {
  function selectAcross(
    getLine: (line: number) => ReturnType<typeof lineModelFromText>,
    from: { line: number; col: number },
    to: { line: number; col: number }
  ): string | null {
    let selection = resolvePointerSelection(
      createEmptySelectionState(),
      { ...from, mode: 'character' },
      getLine
    );
    selection = updateSelectionFocus(selection, to, getLine);
    return serializeSelectionText(selection, getLine);
  }

  test('被软换行的逻辑行复制时不插入换行符', () => {
    const lines: Record<number, ReturnType<typeof lineModelFromText>> = {
      0: lineModelFromText('aaaa', true),
      1: lineModelFromText('bbbb', true),
      2: lineModelFromText('cc'),
      3: lineModelFromText('next'),
    };
    const getLine = (line: number) => lines[line] ?? lineModelFromText('');

    expect(selectAcross(getLine, { line: 0, col: 0 }, { line: 2, col: 1 })).toBe('aaaabbbbcc');
    expect(selectAcross(getLine, { line: 0, col: 0 }, { line: 3, col: 3 })).toBe(
      'aaaabbbbcc\nnext'
    );
  });

  test('软换行行的行尾空格保留(wrap 落在单词间空格处)', () => {
    const lines: Record<number, ReturnType<typeof lineModelFromText>> = {
      0: lineModelFromText('foo ', true),
      1: lineModelFromText('bar'),
    };
    const getLine = (line: number) => lines[line] ?? lineModelFromText('');

    expect(selectAcross(getLine, { line: 0, col: 0 }, { line: 1, col: 2 })).toBe('foo bar');
  });

  test('宽字符跨行 wrap:行尾 spacer-head 不产生多余字符', () => {
    // 行 0:"ab" + 行尾 spacer-head(宽字符放不下移到下一行),行 1:"中"
    const line0 = buildLineModel(
      [cell(0, 'a'), cell(1, 'b'), cell(2, '', 'spacer-head', false)],
      true
    );
    const line1 = buildLineModel([
      cell(0, '中', 'wide'),
      cell(1, '', 'spacer-tail', false),
      cell(2, '', 'narrow', false),
    ]);
    const lines: Record<number, ReturnType<typeof buildLineModel>> = { 0: line0, 1: line1 };
    const getLine = (line: number) => lines[line] ?? lineModelFromText('');

    expect(selectAcross(getLine, { line: 0, col: 0 }, { line: 1, col: 1 })).toBe('ab中');
  });

  test('非 wrap 行维持换行与行尾裁剪', () => {
    const lines: Record<number, ReturnType<typeof lineModelFromText>> = {
      0: lineModelFromText('one   '),
      1: lineModelFromText('two'),
    };
    const getLine = (line: number) => lines[line] ?? lineModelFromText('');

    expect(selectAcross(getLine, { line: 0, col: 0 }, { line: 1, col: 2 })).toBe('one\ntwo');
  });
});
