import type { GhosttyBindings } from './ghostty-wasm';
import type {
  GhosttyCellWidthKind,
  GhosttyColorRgb,
  GhosttyCursorVisualStyle,
  GhosttyRenderCell,
  GhosttyRenderCellStyle,
  GhosttyRenderDirtyState,
  GhosttyRenderRow,
  GhosttyRenderSnapshotMeta,
} from './types';

const GHOSTTY_SUCCESS = 0;
const GHOSTTY_INVALID_VALUE = -2;

const GHOSTTY_RENDER_STATE_DATA_COLS = 1;
const GHOSTTY_RENDER_STATE_DATA_ROWS = 2;
const GHOSTTY_RENDER_STATE_DATA_DIRTY = 3;
const GHOSTTY_RENDER_STATE_DATA_CURSOR_VISUAL_STYLE = 10;
const GHOSTTY_RENDER_STATE_DATA_CURSOR_VISIBLE = 11;
const GHOSTTY_RENDER_STATE_DATA_CURSOR_BLINKING = 12;
const GHOSTTY_RENDER_STATE_DATA_CURSOR_PASSWORD_INPUT = 13;
const GHOSTTY_RENDER_STATE_DATA_CURSOR_VIEWPORT_HAS_VALUE = 14;
const GHOSTTY_RENDER_STATE_DATA_CURSOR_VIEWPORT_X = 15;
const GHOSTTY_RENDER_STATE_DATA_CURSOR_VIEWPORT_Y = 16;
const GHOSTTY_RENDER_STATE_DATA_CURSOR_VIEWPORT_WIDE_TAIL = 17;

const GHOSTTY_RENDER_STATE_ROW_DATA_DIRTY = 1;
const GHOSTTY_RENDER_STATE_ROW_DATA_RAW = 2;

const GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_RAW = 1;
const GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_STYLE = 2;
const GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_LEN = 3;
const GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_BUF = 4;
const GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_BG_COLOR = 5;
const GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_FG_COLOR = 6;

const GHOSTTY_ROW_DATA_WRAP = 1;
const GHOSTTY_ROW_DATA_WRAP_CONTINUATION = 2;

const GHOSTTY_CELL_DATA_WIDE = 3;
const GHOSTTY_CELL_DATA_HAS_TEXT = 4;

type GhosttyRenderStateResources = {
  bindings: GhosttyBindings;
  renderStateHandle: number;
  rowIteratorHandle: number;
  rowCellsHandle: number;
  snapshotVersion: number;
  disposed: boolean;
  cachedMeta: GhosttyRenderSnapshotMeta | null;
};

function ensureActive(resources: GhosttyRenderStateResources): void {
  if (resources.disposed || resources.renderStateHandle === 0) {
    throw new Error('render state resources already disposed');
  }
}

function resultToDirtyState(value: number): GhosttyRenderDirtyState {
  switch (value) {
    case 2:
      return 'full';
    case 1:
      return 'partial';
    default:
      return 'clean';
  }
}

function resultToCursorStyle(value: number): GhosttyCursorVisualStyle {
  switch (value) {
    case 0:
      return 'bar';
    case 2:
      return 'underline';
    case 3:
      return 'block-hollow';
    default:
      return 'block';
  }
}

function resultToCellWidthKind(value: number): GhosttyCellWidthKind {
  switch (value) {
    case 1:
      return 'wide';
    case 2:
      return 'spacer-tail';
    case 3:
      return 'spacer-head';
    default:
      return 'narrow';
  }
}

function readColorAt(bindings: GhosttyBindings, ptr: number): GhosttyColorRgb {
  return {
    r: bindings.view().getUint8(ptr),
    g: bindings.view().getUint8(ptr + 1),
    b: bindings.view().getUint8(ptr + 2),
  };
}

function readOptionalColor(
  resources: GhosttyRenderStateResources,
  read: (ptr: number) => number
): GhosttyColorRgb | null {
  const color = resources.bindings.allocStruct('GhosttyColorRgb');

  try {
    const result = read(color.ptr);
    if (result === GHOSTTY_INVALID_VALUE) {
      return null;
    }

    if (result !== GHOSTTY_SUCCESS) {
      throw new Error(`ghostty optional color read failed with result ${result}`);
    }

    return readColorAt(resources.bindings, color.ptr);
  } finally {
    color.free();
  }
}

function readBool(
  resources: GhosttyRenderStateResources,
  read: (ptr: number) => number | void
): boolean {
  const ptr = resources.bindings.allocU8();

  try {
    const result = read(ptr);
    if (typeof result === 'number' && result !== GHOSTTY_SUCCESS) {
      throw new Error(`ghostty bool read failed with result ${result}`);
    }

    return resources.bindings.readU8(ptr) !== 0;
  } finally {
    resources.bindings.freeU8(ptr);
  }
}

function readU16(
  resources: GhosttyRenderStateResources,
  read: (ptr: number) => number | void
): number {
  const ptr = resources.bindings.allocBytes(2);

  try {
    const result = read(ptr);
    if (typeof result === 'number' && result !== GHOSTTY_SUCCESS) {
      throw new Error(`ghostty u16 read failed with result ${result}`);
    }

    return resources.bindings.view().getUint16(ptr, true);
  } finally {
    resources.bindings.freeBytes(ptr, 2);
  }
}

function readU32(
  resources: GhosttyRenderStateResources,
  read: (ptr: number) => number | void
): number {
  const ptr = resources.bindings.allocBytes(4);

  try {
    const result = read(ptr);
    if (typeof result === 'number' && result !== GHOSTTY_SUCCESS) {
      throw new Error(`ghostty u32 read failed with result ${result}`);
    }

    return resources.bindings.view().getUint32(ptr, true);
  } finally {
    resources.bindings.freeBytes(ptr, 4);
  }
}

function readEnumI32(
  resources: GhosttyRenderStateResources,
  read: (ptr: number) => number | void
): number {
  const ptr = resources.bindings.allocBytes(4);

  try {
    const result = read(ptr);
    if (typeof result === 'number' && result !== GHOSTTY_SUCCESS) {
      throw new Error(`ghostty enum read failed with result ${result}`);
    }

    return resources.bindings.view().getInt32(ptr, true);
  } finally {
    resources.bindings.freeBytes(ptr, 4);
  }
}

function readU64(
  resources: GhosttyRenderStateResources,
  read: (ptr: number) => number | void
): bigint {
  const ptr = resources.bindings.allocBytes(8);

  try {
    const result = read(ptr);
    if (typeof result === 'number' && result !== GHOSTTY_SUCCESS) {
      throw new Error(`ghostty u64 read failed with result ${result}`);
    }

    return resources.bindings.readU64(ptr);
  } finally {
    resources.bindings.freeBytes(ptr, 8);
  }
}

function readStyle(resources: GhosttyRenderStateResources): GhosttyRenderCellStyle {
  const style = resources.bindings.allocStruct('GhosttyStyle');

  try {
    resources.bindings.setField(
      style.view,
      'GhosttyStyle',
      'size',
      resources.bindings.typeSize('GhosttyStyle')
    );
    resources.bindings.getRenderStateRowCellValue(
      resources.rowCellsHandle,
      GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_STYLE,
      style.ptr
    );

    const field = (name: string) => resources.bindings.field('GhosttyStyle', name).offset;
    return {
      bold: style.view.getUint8(field('bold')) !== 0,
      italic: style.view.getUint8(field('italic')) !== 0,
      faint: style.view.getUint8(field('faint')) !== 0,
      blink: style.view.getUint8(field('blink')) !== 0,
      inverse: style.view.getUint8(field('inverse')) !== 0,
      invisible: style.view.getUint8(field('invisible')) !== 0,
      strikethrough: style.view.getUint8(field('strikethrough')) !== 0,
      overline: style.view.getUint8(field('overline')) !== 0,
      underline: style.view.getInt32(field('underline'), true),
    };
  } finally {
    style.free();
  }
}

function readCodepoints(resources: GhosttyRenderStateResources): number[] {
  const graphemeLen = readU32(resources, (ptr) =>
    resources.bindings.getRenderStateRowCellValueResult(
      resources.rowCellsHandle,
      GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_LEN,
      ptr
    )
  );

  if (graphemeLen === 0) {
    return [];
  }

  const bufPtr = resources.bindings.allocBytes(graphemeLen * 4);

  try {
    resources.bindings.getRenderStateRowCellValue(
      resources.rowCellsHandle,
      GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_BUF,
      bufPtr
    );

    const codepoints: number[] = [];
    for (let index = 0; index < graphemeLen; index += 1) {
      codepoints.push(resources.bindings.view().getUint32(bufPtr + index * 4, true));
    }

    return codepoints;
  } finally {
    resources.bindings.freeBytes(bufPtr, graphemeLen * 4);
  }
}

function codepointsToText(codepoints: number[]): string {
  if (codepoints.length === 0) {
    return '';
  }

  try {
    return String.fromCodePoint(...codepoints);
  } catch {
    return '';
  }
}

function buildRowText(cells: GhosttyRenderCell[]): string {
  let text = '';

  for (const cell of cells) {
    if (cell.widthKind === 'spacer-tail' || cell.widthKind === 'spacer-head') {
      continue;
    }

    if (cell.text) {
      text += cell.text;
      continue;
    }

    if (cell.widthKind === 'narrow') {
      text += ' ';
    }
  }

  return text;
}

function readMeta(resources: GhosttyRenderStateResources): GhosttyRenderSnapshotMeta {
  const colors = resources.bindings.allocStruct('GhosttyRenderStateColors');

  try {
    resources.bindings.setField(
      colors.view,
      'GhosttyRenderStateColors',
      'size',
      resources.bindings.typeSize('GhosttyRenderStateColors')
    );
    resources.bindings.getRenderStateColors(resources.renderStateHandle, colors.ptr);

    const paletteOffset = resources.bindings.field('GhosttyRenderStateColors', 'palette').offset;
    const palette: GhosttyColorRgb[] = [];
    for (let index = 0; index < 256; index += 1) {
      const colorOffset = colors.ptr + paletteOffset + index * 3;
      palette.push(readColorAt(resources.bindings, colorOffset));
    }

    const cursorHasValue =
      colors.view.getUint8(
        resources.bindings.field('GhosttyRenderStateColors', 'cursor_has_value').offset
      ) !== 0;

    const cursorViewportHasValue = readBool(resources, (ptr) =>
      resources.bindings.getRenderStateValueResult(
        resources.renderStateHandle,
        GHOSTTY_RENDER_STATE_DATA_CURSOR_VIEWPORT_HAS_VALUE,
        ptr
      )
    );

    return {
      cols: readU16(resources, (ptr) =>
        resources.bindings.getRenderStateValueResult(
          resources.renderStateHandle,
          GHOSTTY_RENDER_STATE_DATA_COLS,
          ptr
        )
      ),
      rows: readU16(resources, (ptr) =>
        resources.bindings.getRenderStateValueResult(
          resources.renderStateHandle,
          GHOSTTY_RENDER_STATE_DATA_ROWS,
          ptr
        )
      ),
      dirty: resultToDirtyState(
        readEnumI32(resources, (ptr) =>
          resources.bindings.getRenderStateValueResult(
            resources.renderStateHandle,
            GHOSTTY_RENDER_STATE_DATA_DIRTY,
            ptr
          )
        )
      ),
      colors: {
        background: readColorAt(
          resources.bindings,
          colors.ptr + resources.bindings.field('GhosttyRenderStateColors', 'background').offset
        ),
        foreground: readColorAt(
          resources.bindings,
          colors.ptr + resources.bindings.field('GhosttyRenderStateColors', 'foreground').offset
        ),
        cursor: cursorHasValue
          ? readColorAt(
              resources.bindings,
              colors.ptr + resources.bindings.field('GhosttyRenderStateColors', 'cursor').offset
            )
          : null,
        palette,
      },
      cursor: {
        style: resultToCursorStyle(
          readEnumI32(resources, (ptr) =>
            resources.bindings.getRenderStateValueResult(
              resources.renderStateHandle,
              GHOSTTY_RENDER_STATE_DATA_CURSOR_VISUAL_STYLE,
              ptr
            )
          )
        ),
        visible: readBool(resources, (ptr) =>
          resources.bindings.getRenderStateValueResult(
            resources.renderStateHandle,
            GHOSTTY_RENDER_STATE_DATA_CURSOR_VISIBLE,
            ptr
          )
        ),
        blinking: readBool(resources, (ptr) =>
          resources.bindings.getRenderStateValueResult(
            resources.renderStateHandle,
            GHOSTTY_RENDER_STATE_DATA_CURSOR_BLINKING,
            ptr
          )
        ),
        passwordInput: readBool(resources, (ptr) =>
          resources.bindings.getRenderStateValueResult(
            resources.renderStateHandle,
            GHOSTTY_RENDER_STATE_DATA_CURSOR_PASSWORD_INPUT,
            ptr
          )
        ),
        x: cursorViewportHasValue
          ? readU16(resources, (ptr) =>
              resources.bindings.getRenderStateValueResult(
                resources.renderStateHandle,
                GHOSTTY_RENDER_STATE_DATA_CURSOR_VIEWPORT_X,
                ptr
              )
            )
          : null,
        y: cursorViewportHasValue
          ? readU16(resources, (ptr) =>
              resources.bindings.getRenderStateValueResult(
                resources.renderStateHandle,
                GHOSTTY_RENDER_STATE_DATA_CURSOR_VIEWPORT_Y,
                ptr
              )
            )
          : null,
        wideTail: cursorViewportHasValue
          ? readBool(resources, (ptr) =>
              resources.bindings.getRenderStateValueResult(
                resources.renderStateHandle,
                GHOSTTY_RENDER_STATE_DATA_CURSOR_VIEWPORT_WIDE_TAIL,
                ptr
              )
            )
          : false,
      },
    };
  } finally {
    colors.free();
  }
}

function readRow(resources: GhosttyRenderStateResources, rowIndex: number): GhosttyRenderRow {
  const rawRow = readU64(resources, (ptr) =>
    resources.bindings.getRenderStateRowValueResult(
      resources.rowIteratorHandle,
      GHOSTTY_RENDER_STATE_ROW_DATA_RAW,
      ptr
    )
  );
  resources.bindings.bindRenderStateRowCells(resources.rowIteratorHandle, resources.rowCellsHandle);

  const cells: GhosttyRenderCell[] = [];
  let x = 0;
  while (resources.bindings.nextRenderStateRowCell(resources.rowCellsHandle)) {
    const rawCell = readU64(resources, (ptr) =>
      resources.bindings.getRenderStateRowCellValueResult(
        resources.rowCellsHandle,
        GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_RAW,
        ptr
      )
    );
    const codepoints = readCodepoints(resources);
    const widthKind = resultToCellWidthKind(
      readEnumI32(resources, (ptr) =>
        resources.bindings.getRawCellValueResult(rawCell, GHOSTTY_CELL_DATA_WIDE, ptr)
      )
    );
    const cell: GhosttyRenderCell = {
      x,
      text: codepointsToText(codepoints),
      codepoints,
      widthKind,
      hasText: readBool(resources, (ptr) =>
        resources.bindings.getRawCellValueResult(rawCell, GHOSTTY_CELL_DATA_HAS_TEXT, ptr)
      ),
      style: readStyle(resources),
      fgColor: readOptionalColor(resources, (ptr) =>
        resources.bindings.getRenderStateRowCellValueResult(
          resources.rowCellsHandle,
          GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_FG_COLOR,
          ptr
        )
      ),
      bgColor: readOptionalColor(resources, (ptr) =>
        resources.bindings.getRenderStateRowCellValueResult(
          resources.rowCellsHandle,
          GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_BG_COLOR,
          ptr
        )
      ),
    };
    cells.push(cell);
    x += 1;
  }

  return {
    y: rowIndex,
    dirty: readBool(resources, (ptr) =>
      resources.bindings.getRenderStateRowValueResult(
        resources.rowIteratorHandle,
        GHOSTTY_RENDER_STATE_ROW_DATA_DIRTY,
        ptr
      )
    ),
    wrap: readBool(resources, (ptr) =>
      resources.bindings.getRawRowValueResult(rawRow, GHOSTTY_ROW_DATA_WRAP, ptr)
    ),
    wrapContinuation: readBool(resources, (ptr) =>
      resources.bindings.getRawRowValueResult(rawRow, GHOSTTY_ROW_DATA_WRAP_CONTINUATION, ptr)
    ),
    text: buildRowText(cells),
    cells,
  };
}

export function createRenderState(bindings: GhosttyBindings): GhosttyRenderStateResources {
  return {
    bindings,
    renderStateHandle: bindings.createRenderState(),
    rowIteratorHandle: bindings.createRenderStateRowIterator(),
    rowCellsHandle: bindings.createRenderStateRowCells(),
    snapshotVersion: 0,
    disposed: false,
    cachedMeta: null,
  };
}

export function updateRenderState(
  resources: GhosttyRenderStateResources,
  terminalHandle: number
): void {
  ensureActive(resources);
  resources.bindings.updateRenderState(resources.renderStateHandle, terminalHandle);
  resources.bindings.bindRenderStateRowIterator(
    resources.renderStateHandle,
    resources.rowIteratorHandle
  );
  resources.snapshotVersion += 1;
  resources.cachedMeta = null;
}

export function readRenderSnapshotMeta(
  resources: GhosttyRenderStateResources
): GhosttyRenderSnapshotMeta {
  ensureActive(resources);
  if (!resources.cachedMeta) {
    resources.cachedMeta = readMeta(resources);
  }

  return resources.cachedMeta;
}

export function* iterateRows(
  resources: GhosttyRenderStateResources
): Generator<GhosttyRenderRow, void, undefined> {
  ensureActive(resources);
  const meta = readRenderSnapshotMeta(resources);
  resources.bindings.bindRenderStateRowIterator(
    resources.renderStateHandle,
    resources.rowIteratorHandle
  );

  let rowIndex = 0;
  while (
    rowIndex < meta.rows &&
    resources.bindings.nextRenderStateRowIterator(resources.rowIteratorHandle)
  ) {
    yield readRow(resources, rowIndex);
    rowIndex += 1;
  }
}

export function disposeRenderStateResources(resources: GhosttyRenderStateResources): void {
  if (resources.disposed) {
    return;
  }

  resources.disposed = true;
  if (resources.rowCellsHandle !== 0) {
    resources.bindings.freeRenderStateRowCells(resources.rowCellsHandle);
    resources.rowCellsHandle = 0;
  }
  if (resources.rowIteratorHandle !== 0) {
    resources.bindings.freeRenderStateRowIterator(resources.rowIteratorHandle);
    resources.rowIteratorHandle = 0;
  }
  if (resources.renderStateHandle !== 0) {
    resources.bindings.freeRenderState(resources.renderStateHandle);
    resources.renderStateHandle = 0;
  }
  resources.cachedMeta = null;
}

export type { GhosttyRenderStateResources };
