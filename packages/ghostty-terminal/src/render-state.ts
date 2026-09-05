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

// GhosttyStyleColor.tag：0=none（未指定，用默认前景/背景）1=palette 2=rgb（SGR 真彩色）。
// 实测自 ghostty-vt.wasm：\e[31m→1、\e[38;5;196m→1、\e[38;2;255;0;0m→2、无 SGR→0。
const GHOSTTY_STYLE_COLOR_PALETTE = 1;
const GHOSTTY_STYLE_COLOR_RGB = 2;

const GHOSTTY_CELL_DATA_WIDE = 3;
const GHOSTTY_CELL_DATA_HAS_TEXT = 4;

// 调色板兜底刷新间隔（帧）：dirty 为 full 时立即刷新，其余情况最迟此间隔后刷新一次，
// 覆盖动态改调色板（OSC 4）但未触发 full 重建的场景。
const PALETTE_REFRESH_FRAME_INTERVAL = 30;

// 按类型复用的 WASM 内存 scratch 槽。单线程渲染无重入：readX 系列 helper 每次调用
// 借用对应槽，调用返回后槽内容即失效；dispose 时统一释放。view 经 slotView() 获取：
// WASM memory grow 会 detach 旧 ArrayBuffer（ptr 不变、ArrayBuffer 对象更换），必须
// 按 buffer 身份重建，否则读 detached view 抛错。
type ScratchSlot = {
  ptr: number;
  len: number;
  kind: 'u8' | 'bytes';
  view: DataView | null;
  viewBuffer: ArrayBuffer | null;
};

type GhosttyRenderStateResources = {
  bindings: GhosttyBindings;
  renderStateHandle: number;
  rowIteratorHandle: number;
  rowCellsHandle: number;
  snapshotVersion: number;
  disposed: boolean;
  cachedMeta: GhosttyRenderSnapshotMeta | null;
  scratch: {
    u8: ScratchSlot | null;
    u16: ScratchSlot | null;
    u32: ScratchSlot | null;
    u64: ScratchSlot | null;
    colorRgb: ScratchSlot | null;
    style: ScratchSlot | null;
    colors: ScratchSlot | null;
    // 动态大小（grapheme buffer），按需扩容
    codepoints: ScratchSlot | null;
  };
  cachedPalette: GhosttyColorRgb[] | null;
  paletteReadVersion: number;
  paletteReadDirtyWasFull: boolean;
};

function ensureActive(resources: GhosttyRenderStateResources): void {
  if (resources.disposed || resources.renderStateHandle === 0) {
    throw new Error('render state resources already disposed');
  }
}

// 懒分配 scratch 槽并缓存 DataView；重复申请同一类型的槽直接复用。
function scratchSlot(
  resources: GhosttyRenderStateResources,
  kind: 'u8' | 'u16' | 'u32' | 'u64' | 'colorRgb' | 'style' | 'colors' | 'codepoints',
  len: number
): ScratchSlot {
  const existing = resources.scratch[kind];
  if (existing) {
    return existing;
  }

  const isU8 = kind === 'u8';
  const slot: ScratchSlot = {
    ptr: isU8 ? resources.bindings.allocU8() : resources.bindings.allocBytes(len),
    len,
    kind: isU8 ? 'u8' : 'bytes',
    view: null,
    viewBuffer: null,
  };
  resources.scratch[kind] = slot;
  return slot;
}

// 槽位 DataView：按当前 WASM buffer 身份缓存，grow 后自动重建。
function slotView(resources: GhosttyRenderStateResources, slot: ScratchSlot): DataView {
  const buffer = resources.bindings.buffer();
  if (slot.view === null || slot.viewBuffer !== buffer) {
    slot.view = new DataView(buffer, slot.ptr, slot.len);
    slot.viewBuffer = buffer;
  }
  return slot.view;
}

// codepoints 槽动态扩容：请求长度超过槽容量时释放旧槽重新分配。
function scratchCodepoints(resources: GhosttyRenderStateResources, len: number): ScratchSlot {
  const existing = resources.scratch.codepoints;
  if (existing && existing.len >= len) {
    return existing;
  }
  if (existing) {
    resources.bindings.freeBytes(existing.ptr, existing.len);
    resources.scratch.codepoints = null;
  }
  return scratchSlot(resources, 'codepoints', len);
}

function freeScratchSlots(resources: GhosttyRenderStateResources): void {
  for (const [kind, slot] of Object.entries(resources.scratch)) {
    if (!slot) {
      continue;
    }
    if (slot.kind === 'u8') {
      resources.bindings.freeU8(slot.ptr);
    } else {
      resources.bindings.freeBytes(slot.ptr, slot.len);
    }
    resources.scratch[kind as keyof GhosttyRenderStateResources['scratch']] = null;
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
  const slot = scratchSlot(resources, 'colorRgb', resources.bindings.typeSize('GhosttyColorRgb'));

  const result = read(slot.ptr);
  if (result === GHOSTTY_INVALID_VALUE) {
    return null;
  }

  if (result !== GHOSTTY_SUCCESS) {
    throw new Error(`ghostty optional color read failed with result ${result}`);
  }

  return readColorAt(resources.bindings, slot.ptr);
}

function readBool(
  resources: GhosttyRenderStateResources,
  read: (ptr: number) => number | void
): boolean {
  const slot = scratchSlot(resources, 'u8', 1);

  const result = read(slot.ptr);
  if (typeof result === 'number' && result !== GHOSTTY_SUCCESS) {
    throw new Error(`ghostty bool read failed with result ${result}`);
  }

  return resources.bindings.readU8(slot.ptr) !== 0;
}

function readU16(
  resources: GhosttyRenderStateResources,
  read: (ptr: number) => number | void
): number {
  const slot = scratchSlot(resources, 'u16', 2);

  const result = read(slot.ptr);
  if (typeof result === 'number' && result !== GHOSTTY_SUCCESS) {
    throw new Error(`ghostty u16 read failed with result ${result}`);
  }

  return resources.bindings.view().getUint16(slot.ptr, true);
}

function readU32(
  resources: GhosttyRenderStateResources,
  read: (ptr: number) => number | void
): number {
  const slot = scratchSlot(resources, 'u32', 4);

  const result = read(slot.ptr);
  if (typeof result === 'number' && result !== GHOSTTY_SUCCESS) {
    throw new Error(`ghostty u32 read failed with result ${result}`);
  }

  return resources.bindings.view().getUint32(slot.ptr, true);
}

function readEnumI32(
  resources: GhosttyRenderStateResources,
  read: (ptr: number) => number | void
): number {
  const slot = scratchSlot(resources, 'u32', 4);

  const result = read(slot.ptr);
  if (typeof result === 'number' && result !== GHOSTTY_SUCCESS) {
    throw new Error(`ghostty enum read failed with result ${result}`);
  }

  return resources.bindings.view().getInt32(slot.ptr, true);
}

function readU64(
  resources: GhosttyRenderStateResources,
  read: (ptr: number) => number | void
): bigint {
  const slot = scratchSlot(resources, 'u64', 8);

  const result = read(slot.ptr);
  if (typeof result === 'number' && result !== GHOSTTY_SUCCESS) {
    throw new Error(`ghostty u64 read failed with result ${result}`);
  }

  return resources.bindings.readU64(slot.ptr);
}

function readStyle(resources: GhosttyRenderStateResources): {
  style: GhosttyRenderCellStyle;
  fgPaletteIndex: number | null;
  bgPaletteIndex: number | null;
  underlineColor: GhosttyColorRgb | null;
} {
  const slot = scratchSlot(resources, 'style', resources.bindings.typeSize('GhosttyStyle'));
  const style = slotView(resources, slot);

  resources.bindings.setField(
    style,
    'GhosttyStyle',
    'size',
    resources.bindings.typeSize('GhosttyStyle')
  );
  resources.bindings.getRenderStateRowCellValue(
    resources.rowCellsHandle,
    GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_STYLE,
    slot.ptr
  );

  const field = (name: string) => resources.bindings.field('GhosttyStyle', name).offset;
  const colorField = (name: string) => resources.bindings.field('GhosttyStyleColor', name).offset;

  // GhosttyStyleColor 是 tagged union：tag 区分 none/palette/rgb，palette 变体的
  // value 首字节是调色板索引。渲染层据此区分「调色板色」与「SGR 真彩色」。
  const paletteIndexAt = (base: number): number | null => {
    const tag = style.getInt32(base + colorField('tag'), true);
    if (tag !== GHOSTTY_STYLE_COLOR_PALETTE) {
      return null;
    }
    return style.getUint8(base + colorField('value'));
  };

  const rgbAt = (base: number): GhosttyColorRgb | null => {
    const tag = style.getInt32(base + colorField('tag'), true);
    if (tag !== GHOSTTY_STYLE_COLOR_RGB) return null;
    const value = base + colorField('value');
    return {
      r: style.getUint8(value),
      g: style.getUint8(value + 1),
      b: style.getUint8(value + 2),
    };
  };

  return {
    style: {
      bold: style.getUint8(field('bold')) !== 0,
      italic: style.getUint8(field('italic')) !== 0,
      faint: style.getUint8(field('faint')) !== 0,
      blink: style.getUint8(field('blink')) !== 0,
      inverse: style.getUint8(field('inverse')) !== 0,
      invisible: style.getUint8(field('invisible')) !== 0,
      strikethrough: style.getUint8(field('strikethrough')) !== 0,
      overline: style.getUint8(field('overline')) !== 0,
      underline: style.getInt32(field('underline'), true),
    },
    fgPaletteIndex: paletteIndexAt(field('fg_color')),
    bgPaletteIndex: paletteIndexAt(field('bg_color')),
    underlineColor: rgbAt(field('underline_color')),
  };
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

  const slot = scratchCodepoints(resources, graphemeLen * 4);
  resources.bindings.getRenderStateRowCellValue(
    resources.rowCellsHandle,
    GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_BUF,
    slot.ptr
  );

  const codepoints: number[] = [];
  for (let index = 0; index < graphemeLen; index += 1) {
    codepoints.push(resources.bindings.view().getUint32(slot.ptr + index * 4, true));
  }

  return codepoints;
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

function readPalette(
  resources: GhosttyRenderStateResources,
  colorsPtr: number,
  paletteOffset: number
): GhosttyColorRgb[] {
  const palette: GhosttyColorRgb[] = [];
  for (let index = 0; index < 256; index += 1) {
    palette.push(readColorAt(resources.bindings, colorsPtr + paletteOffset + index * 3));
  }
  return palette;
}

function readMeta(resources: GhosttyRenderStateResources): GhosttyRenderSnapshotMeta {
  const slot = scratchSlot(
    resources,
    'colors',
    resources.bindings.typeSize('GhosttyRenderStateColors')
  );
  const colors = slotView(resources, slot);
  const colorsPtr = slot.ptr;

  resources.bindings.setField(
    colors,
    'GhosttyRenderStateColors',
    'size',
    resources.bindings.typeSize('GhosttyRenderStateColors')
  );
  resources.bindings.getRenderStateColors(resources.renderStateHandle, colorsPtr);

  const dirty = resultToDirtyState(
    readEnumI32(resources, (ptr) =>
      resources.bindings.getRenderStateValueResult(
        resources.renderStateHandle,
        GHOSTTY_RENDER_STATE_DATA_DIRTY,
        ptr
      )
    )
  );

  const paletteOffset = resources.bindings.field('GhosttyRenderStateColors', 'palette').offset;
  // 刷新时机：未缓存 / 距上次读取满 30 帧（OSC 4 动态改色兜底）/ dirty 从非 full 转为
  // full（全量重建可能含调色板变化）。当前 wasm 的 dirty 恒为 full（latch），
  // "从非 full 转为 full"永不成立，实际由 30 帧兜底驱动。
  let palette = resources.cachedPalette;
  const fullSinceLastRead = dirty === 'full' && !resources.paletteReadDirtyWasFull;
  if (
    !palette ||
    resources.snapshotVersion - resources.paletteReadVersion >= PALETTE_REFRESH_FRAME_INTERVAL ||
    fullSinceLastRead
  ) {
    palette = readPalette(resources, colorsPtr, paletteOffset);
    resources.cachedPalette = palette;
    resources.paletteReadVersion = resources.snapshotVersion;
    resources.paletteReadDirtyWasFull = dirty === 'full';
  }

  const cursorHasValue =
    colors.getUint8(
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
    dirty,
    colors: {
      background: readColorAt(
        resources.bindings,
        colorsPtr + resources.bindings.field('GhosttyRenderStateColors', 'background').offset
      ),
      foreground: readColorAt(
        resources.bindings,
        colorsPtr + resources.bindings.field('GhosttyRenderStateColors', 'foreground').offset
      ),
      cursor: cursorHasValue
        ? readColorAt(
            resources.bindings,
            colorsPtr + resources.bindings.field('GhosttyRenderStateColors', 'cursor').offset
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
}

function readRow(
  resources: GhosttyRenderStateResources,
  rowIndex: number,
  rowDirtyOverride?: boolean
): GhosttyRenderRow {
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
    const { style, fgPaletteIndex, bgPaletteIndex, underlineColor } = readStyle(resources);
    const cell: GhosttyRenderCell = {
      x,
      text: codepointsToText(codepoints),
      codepoints,
      widthKind,
      hasText: readBool(resources, (ptr) =>
        resources.bindings.getRawCellValueResult(rawCell, GHOSTTY_CELL_DATA_HAS_TEXT, ptr)
      ),
      style,
      fgPaletteIndex,
      bgPaletteIndex,
      underlineColor,
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
    dirty:
      rowDirtyOverride ??
      readBool(resources, (ptr) =>
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
    scratch: {
      u8: null,
      u16: null,
      u32: null,
      u64: null,
      colorRgb: null,
      style: null,
      colors: null,
      codepoints: null,
    },
    cachedPalette: null,
    paletteReadVersion: 0,
    paletteReadDirtyWasFull: false,
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

// 轻量 dirty 读取：不读调色板、不读行。供渲染调度在整帧读取前判定早退。
export function readRenderDirtyState(
  resources: GhosttyRenderStateResources
): GhosttyRenderDirtyState {
  ensureActive(resources);
  return resultToDirtyState(
    readEnumI32(resources, (ptr) =>
      resources.bindings.getRenderStateValueResult(
        resources.renderStateHandle,
        GHOSTTY_RENDER_STATE_DATA_DIRTY,
        ptr
      )
    )
  );
}

export function readScrollbackRows(
  resources: GhosttyRenderStateResources,
  terminal: number,
  start: number,
  count: number
): GhosttyRenderRow[] {
  ensureActive(resources);
  const bindings = resources.bindings;
  const original = bindings.readScrollbar(terminal);
  const end = Math.min(original.total, start + count);
  const rows: GhosttyRenderRow[] = [];
  let offset = original.offset;
  try {
    for (let first = Math.max(0, start); first < end; ) {
      const target = Math.min(first, Math.max(0, original.total - original.len));
      if (target !== offset) {
        bindings.scrollViewportDelta(terminal, target - offset);
        offset = target;
      }
      updateRenderState(resources, terminal);
      const chunk = Array.from(iterateRows(resources));
      const next = Math.min(end, target + chunk.length);
      if (next <= first) break;
      rows.push(...chunk.slice(first - target, next - target));
      first = next;
    }
    return rows;
  } finally {
    if (offset !== original.offset) {
      bindings.scrollViewportDelta(terminal, original.offset - offset);
      updateRenderState(resources, terminal);
    }
  }
}

export function* iterateRows(
  resources: GhosttyRenderStateResources,
  reuse?: (rowIndex: number, dirty: boolean) => GhosttyRenderRow | null
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
    const dirty = readBool(resources, (ptr) =>
      resources.bindings.getRenderStateRowValueResult(
        resources.rowIteratorHandle,
        GHOSTTY_RENDER_STATE_ROW_DATA_DIRTY,
        ptr
      )
    );
    if (reuse) {
      const reusedRow = reuse(rowIndex, dirty);
      if (reusedRow) {
        yield reusedRow;
        rowIndex += 1;
        continue;
      }
    }
    yield readRow(resources, rowIndex, dirty);
    rowIndex += 1;
  }
}

export function disposeRenderStateResources(resources: GhosttyRenderStateResources): void {
  if (resources.disposed) {
    return;
  }

  resources.disposed = true;
  freeScratchSlots(resources);
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
  resources.cachedPalette = null;
}

export type { GhosttyRenderStateResources };
