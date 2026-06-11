import type { GhosttyRenderCell, GhosttySelectionRect } from './types';

export type SelectionMode = 'character' | 'word' | 'line';

// 选区坐标统一使用屏幕列（与 hitTest、canvas 渲染一致）。
// 行文本与屏幕列并非一一对应（宽字符占两列、grapheme 可含多个 UTF-16 unit），
// 因此选区不能基于行字符串索引工作，序列化时再经 colChars 转回文本。
export type SelectionPoint = {
  line: number;
  col: number;
};

export type SelectionLineModel = {
  /**
   * 每屏幕列一个条目；宽字符主列为完整字符，spacer-tail 列为 null（归属左侧主列），
   * spacer-head 列为空串（行尾占位，不归属任何字符）
   */
  colChars: (string | null)[];
  /** 行尾空白（空 cell、空格、spacer）裁剪后的内容列数 */
  contentCols: number;
  /** 本行软换行延续到下一行：复制时与下一行拼接且不裁剪行尾空格 */
  wrappedToNext: boolean;
};

export type GetLineModel = (line: number) => SelectionLineModel;

export type SelectionState = {
  anchor: SelectionPoint | null;
  focus: SelectionPoint | null;
  mode: SelectionMode;
};

type SelectionRange = {
  start: SelectionPoint;
  end: SelectionPoint;
};

export const EMPTY_SELECTION_LINE_MODEL: SelectionLineModel = {
  colChars: [],
  contentCols: 0,
  wrappedToNext: false,
};

function computeContentCols(colChars: (string | null)[]): number {
  for (let index = colChars.length - 1; index >= 0; index -= 1) {
    const ch = colChars[index];
    if (ch !== null && ch !== '' && ch !== ' ') {
      return index + 1;
    }
  }
  return 0;
}

export function buildLineModel(
  cells: readonly GhosttyRenderCell[],
  wrappedToNext = false
): SelectionLineModel {
  const colChars: (string | null)[] = [];
  for (const cell of cells) {
    if (cell.widthKind === 'spacer-tail') {
      colChars.push(null);
      continue;
    }
    if (cell.widthKind === 'spacer-head') {
      colChars.push('');
      continue;
    }
    colChars.push(cell.text || ' ');
  }
  return { colChars, contentCols: computeContentCols(colChars), wrappedToNext };
}

/** 把纯文本视为全窄字符行（每字符一列），供测试与简单场景使用 */
export function lineModelFromText(text: string, wrappedToNext = false): SelectionLineModel {
  const colChars = Array.from(text);
  return { colChars, contentCols: computeContentCols(colChars), wrappedToNext };
}

function clampColumn(model: SelectionLineModel, col: number): number {
  return Math.max(0, Math.min(Math.max(model.colChars.length - 1, 0), Math.floor(col)));
}

/** clamp 后向左吸附到宽字符主列，避免锚点落在 spacer-tail 列上 */
function snapColumn(model: SelectionLineModel, col: number): number {
  let safe = clampColumn(model, col);
  while (safe > 0 && model.colChars[safe] === null) {
    safe -= 1;
  }
  return safe;
}

/** 该列显示的字符；spacer-tail 列返回其左侧宽字符 */
function columnChar(model: SelectionLineModel, col: number): string {
  let index = col;
  while (index > 0 && model.colChars[index] === null) {
    index -= 1;
  }
  return model.colChars[index] || '';
}

/** 末列若为宽字符主列，向右扩展覆盖其 spacer-tail 列（用于高亮宽度） */
function expandColAcrossSpacers(model: SelectionLineModel, col: number): number {
  let expanded = col;
  while (expanded + 1 < model.colChars.length && model.colChars[expanded + 1] === null) {
    expanded += 1;
  }
  return expanded;
}

function normalizeRange(anchor: SelectionPoint, focus: SelectionPoint): SelectionRange {
  if (anchor.line < focus.line) {
    return { start: anchor, end: focus };
  }

  if (anchor.line > focus.line) {
    return { start: focus, end: anchor };
  }

  if (anchor.col <= focus.col) {
    return { start: anchor, end: focus };
  }

  return { start: focus, end: anchor };
}

function expandWord(line: number, col: number, model: SelectionLineModel): SelectionRange {
  if (model.colChars.length === 0) {
    return {
      start: { line, col: 0 },
      end: { line, col: 0 },
    };
  }

  const safeCol = snapColumn(model, col);
  const isWordChar = (value: string) => /[\p{L}\p{N}_-]/u.test(value);

  if (!isWordChar(columnChar(model, safeCol))) {
    return {
      start: { line, col: safeCol },
      end: { line, col: safeCol },
    };
  }

  let start = safeCol;
  let end = safeCol;
  while (start > 0 && isWordChar(columnChar(model, start - 1))) {
    start -= 1;
  }
  while (end + 1 < model.colChars.length && isWordChar(columnChar(model, end + 1))) {
    end += 1;
  }

  return {
    start: { line, col: start },
    end: { line, col: end },
  };
}

function expandLine(line: number, model: SelectionLineModel): SelectionRange {
  const lastCol = Math.max(model.contentCols - 1, 0);
  return {
    start: { line, col: 0 },
    end: { line, col: lastCol },
  };
}

function pointForMode(
  point: SelectionPoint,
  mode: SelectionMode,
  getLine: GetLineModel
): SelectionRange {
  const model = getLine(point.line);

  switch (mode) {
    case 'word':
      return expandWord(point.line, point.col, model);
    case 'line':
      return expandLine(point.line, model);
    default: {
      const safeCol = snapColumn(model, point.col);
      return {
        start: { line: point.line, col: safeCol },
        end: { line: point.line, col: safeCol },
      };
    }
  }
}

export function createEmptySelectionState(): SelectionState {
  return {
    anchor: null,
    focus: null,
    mode: 'character',
  };
}

export function hasSelection(state: SelectionState): boolean {
  return Boolean(state.anchor && state.focus);
}

export function clearSelection(): SelectionState {
  return createEmptySelectionState();
}

export function resolvePointerSelection(
  _previous: SelectionState,
  point: SelectionPoint & { mode: SelectionMode },
  getLine: GetLineModel
): SelectionState {
  const expanded = pointForMode(point, point.mode, getLine);
  return {
    anchor: expanded.start,
    focus: expanded.end,
    mode: point.mode,
  };
}

export function updateSelectionFocus(
  state: SelectionState,
  point: SelectionPoint,
  getLine: GetLineModel
): SelectionState {
  if (!state.anchor) {
    return state;
  }

  if (state.mode === 'line') {
    return {
      ...state,
      focus: expandLine(point.line, getLine(point.line)).end,
    };
  }

  if (state.mode === 'word') {
    return {
      ...state,
      focus: pointForMode(point, 'word', getLine).end,
    };
  }

  return {
    ...state,
    focus: {
      line: point.line,
      col: snapColumn(getLine(point.line), point.col),
    },
  };
}

export function getSelectionRange(state: SelectionState): SelectionRange | null {
  if (!state.anchor || !state.focus) {
    return null;
  }

  return normalizeRange(state.anchor, state.focus);
}

function sliceColumns(
  model: SelectionLineModel,
  startCol: number,
  endColInclusive: number
): string {
  // 行尾空白（padding 空格、capture -N 保留的空格）对复制无意义，裁剪到内容列；
  // 软换行行的行尾空格属于逻辑行内容，不裁剪（spacer 在 join 时自然消失）
  const lastCol = model.wrappedToNext ? model.colChars.length - 1 : model.contentCols - 1;
  const effectiveEnd = Math.min(endColInclusive, lastCol);
  let start = Math.max(0, startCol);
  // 起点落在宽字符的 spacer-tail 列时，包含整个宽字符
  while (start > 0 && model.colChars[start] === null) {
    start -= 1;
  }
  if (start > effectiveEnd) {
    return '';
  }
  let text = '';
  for (let col = start; col <= effectiveEnd; col += 1) {
    text += model.colChars[col] ?? '';
  }
  return text;
}

export function serializeSelectionText(
  state: SelectionState,
  getLine: GetLineModel
): string | null {
  const range = getSelectionRange(state);
  if (!range) {
    return null;
  }

  let text = '';
  for (let line = range.start.line; line <= range.end.line; line += 1) {
    const model = getLine(line);
    const startCol = line === range.start.line ? range.start.col : 0;
    const endCol = line === range.end.line ? range.end.col : model.colChars.length - 1;
    text += sliceColumns(model, startCol, endCol);
    // 软换行的行与下一行是同一逻辑行，复制时不插入换行
    if (line < range.end.line && !model.wrappedToNext) {
      text += '\n';
    }
  }

  return text;
}

export function projectSelectionRects(
  state: SelectionState,
  viewportStartLine: number,
  viewportRows: number,
  getLine?: GetLineModel
): GhosttySelectionRect[] {
  const range = getSelectionRange(state);
  if (!range) {
    return [];
  }

  const viewportEndLine = viewportStartLine + viewportRows - 1;
  const rects: GhosttySelectionRect[] = [];
  for (
    let line = Math.max(range.start.line, viewportStartLine);
    line <= Math.min(range.end.line, viewportEndLine);
    line += 1
  ) {
    const row = line - viewportStartLine;
    if (line === range.start.line && line === range.end.line) {
      const model = getLine?.(line);
      const endCol = model ? expandColAcrossSpacers(model, range.end.col) : range.end.col;
      rects.push({
        row,
        x: range.start.col,
        width: endCol - range.start.col + 1,
      });
      continue;
    }

    if (line === range.start.line) {
      const lineWidth = getLine
        ? Math.max(getLine(line).colChars.length - range.start.col, 0)
        : Number.MAX_SAFE_INTEGER;
      rects.push({
        row,
        x: range.start.col,
        width: lineWidth,
      });
      continue;
    }

    if (line === range.end.line) {
      const model = getLine?.(line);
      const endCol = model ? expandColAcrossSpacers(model, range.end.col) : range.end.col;
      rects.push({
        row,
        x: 0,
        width: endCol + 1,
      });
      continue;
    }

    const middleWidth = getLine ? getLine(line).colChars.length : Number.MAX_SAFE_INTEGER;
    rects.push({
      row,
      x: 0,
      width: middleWidth,
    });
  }

  return rects;
}
