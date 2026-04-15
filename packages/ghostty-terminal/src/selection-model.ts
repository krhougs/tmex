import type { GhosttySelectionRect } from './types';

export type SelectionMode = 'character' | 'word' | 'line';

export type SelectionPoint = {
  line: number;
  col: number;
};

export type SelectionState = {
  anchor: SelectionPoint | null;
  focus: SelectionPoint | null;
  mode: SelectionMode;
};

type SelectionRange = {
  start: SelectionPoint;
  end: SelectionPoint;
};

function clampColumn(lineText: string, col: number): number {
  return Math.max(0, Math.min(Math.max(lineText.length - 1, 0), Math.floor(col)));
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

function expandWord(line: number, col: number, lineText: string): SelectionRange {
  if (!lineText) {
    return {
      start: { line, col: 0 },
      end: { line, col: 0 },
    };
  }

  const safeCol = clampColumn(lineText, col);
  const isWordChar = (value: string) => /[\p{L}\p{N}_-]/u.test(value);
  const cursorChar = lineText[safeCol] ?? '';

  if (!isWordChar(cursorChar)) {
    return {
      start: { line, col: safeCol },
      end: { line, col: safeCol },
    };
  }

  let start = safeCol;
  let end = safeCol;
  while (start > 0 && isWordChar(lineText[start - 1] ?? '')) {
    start -= 1;
  }
  while (end + 1 < lineText.length && isWordChar(lineText[end + 1] ?? '')) {
    end += 1;
  }

  return {
    start: { line, col: start },
    end: { line, col: end },
  };
}

function expandLine(line: number, lineText: string): SelectionRange {
  const lastCol = Math.max(lineText.length - 1, 0);
  return {
    start: { line, col: 0 },
    end: { line, col: lastCol },
  };
}

function pointForMode(
  point: SelectionPoint,
  mode: SelectionMode,
  getLineText: (line: number) => string
): SelectionRange {
  const lineText = getLineText(point.line);

  switch (mode) {
    case 'word':
      return expandWord(point.line, point.col, lineText);
    case 'line':
      return expandLine(point.line, lineText);
    default: {
      const safeCol = clampColumn(lineText, point.col);
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
  getLineText: (line: number) => string
): SelectionState {
  const expanded = pointForMode(point, point.mode, getLineText);
  return {
    anchor: expanded.start,
    focus: expanded.end,
    mode: point.mode,
  };
}

export function updateSelectionFocus(
  state: SelectionState,
  point: SelectionPoint,
  getLineText: (line: number) => string
): SelectionState {
  if (!state.anchor) {
    return state;
  }

  if (state.mode === 'line') {
    return {
      ...state,
      focus: expandLine(point.line, getLineText(point.line)).end,
    };
  }

  if (state.mode === 'word') {
    return {
      ...state,
      focus: pointForMode(point, 'word', getLineText).end,
    };
  }

  return {
    ...state,
    focus: {
      line: point.line,
      col: clampColumn(getLineText(point.line), point.col),
    },
  };
}

export function getSelectionRange(state: SelectionState): SelectionRange | null {
  if (!state.anchor || !state.focus) {
    return null;
  }

  return normalizeRange(state.anchor, state.focus);
}

export function serializeSelectionText(
  state: SelectionState,
  getLineText: (line: number) => string
): string | null {
  const range = getSelectionRange(state);
  if (!range) {
    return null;
  }

  const segments: string[] = [];
  for (let line = range.start.line; line <= range.end.line; line += 1) {
    const text = getLineText(line);
    if (line === range.start.line && line === range.end.line) {
      segments.push(text.slice(range.start.col, range.end.col + 1));
      continue;
    }

    if (line === range.start.line) {
      segments.push(text.slice(range.start.col));
      continue;
    }

    if (line === range.end.line) {
      segments.push(text.slice(0, range.end.col + 1));
      continue;
    }

    segments.push(text);
  }

  return segments.join('\n');
}

export function projectSelectionRects(
  state: SelectionState,
  viewportStartLine: number,
  viewportRows: number,
  getLineText?: (line: number) => string
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
      rects.push({
        row,
        x: range.start.col,
        width: range.end.col - range.start.col + 1,
      });
      continue;
    }

    if (line === range.start.line) {
      const lineWidth = getLineText ? Math.max(getLineText(line).length - range.start.col, 0) : Number.MAX_SAFE_INTEGER;
      rects.push({
        row,
        x: range.start.col,
        width: lineWidth,
      });
      continue;
    }

    if (line === range.end.line) {
      rects.push({
        row,
        x: 0,
        width: range.end.col + 1,
      });
      continue;
    }

    const middleWidth = getLineText ? getLineText(line).length : Number.MAX_SAFE_INTEGER;
    rects.push({
      row,
      x: 0,
      width: middleWidth,
    });
  }

  return rects;
}
