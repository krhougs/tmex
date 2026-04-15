import ghosttyWasmUrl from './assets/ghostty-vt.wasm?url';
import type { GhosttyCellDimensions, GhosttyTheme } from './types';

const GHOSTTY_SUCCESS = 0;
const GHOSTTY_INVALID_VALUE = -2;
const GHOSTTY_OUT_OF_SPACE = -3;

const GHOSTTY_TERMINAL_OPT_COLOR_FOREGROUND = 11;
const GHOSTTY_TERMINAL_OPT_COLOR_BACKGROUND = 12;
const GHOSTTY_TERMINAL_OPT_COLOR_CURSOR = 13;
const GHOSTTY_TERMINAL_OPT_COLOR_PALETTE = 14;

const GHOSTTY_TERMINAL_DATA_COLS = 1;
const GHOSTTY_TERMINAL_DATA_ROWS = 2;
const GHOSTTY_TERMINAL_DATA_SCROLLBAR = 9;
const GHOSTTY_POINT_TAG_VIEWPORT = 1;

const GHOSTTY_SCROLL_VIEWPORT_TOP = 0;
const GHOSTTY_SCROLL_VIEWPORT_BOTTOM = 1;
const GHOSTTY_SCROLL_VIEWPORT_DELTA = 2;

const GHOSTTY_KEY_ACTION_RELEASE = 0;
const GHOSTTY_KEY_ACTION_PRESS = 1;
const GHOSTTY_KEY_ACTION_REPEAT = 2;

const GHOSTTY_MODE_BRACKETED_PASTE = 2004;

const GHOSTTY_FORMATTER_FORMAT_PLAIN = 0;
const GHOSTTY_FORMATTER_FORMAT_HTML = 2;
const WASM_USIZE_BYTES = 4;

type LayoutField = {
  offset: number;
  size: number;
  type: string;
};

type LayoutType = {
  size: number;
  align: number;
  fields: Record<string, LayoutField>;
};

type LayoutMap = Record<string, LayoutType>;

type GhosttyExports = WebAssembly.Exports & {
  memory: WebAssembly.Memory;
  ghostty_type_json: () => number;
  ghostty_alloc: (allocatorPtr: number, size: number, alignment: number) => number;
  ghostty_free: (allocatorPtr: number, ptr: number, len: number) => void;
  ghostty_wasm_alloc_opaque: () => number;
  ghostty_wasm_free_opaque: (ptr: number) => void;
  ghostty_wasm_alloc_u8: () => number;
  ghostty_wasm_free_u8: (ptr: number) => void;
  ghostty_wasm_alloc_u8_array: (len: number) => number;
  ghostty_wasm_free_u8_array: (ptr: number, len: number) => void;
  ghostty_wasm_alloc_usize: () => number;
  ghostty_wasm_free_usize: (ptr: number) => void;
  ghostty_terminal_new: (allocatorPtr: number, outTerminalPtr: number, optionsPtr: number) => number;
  ghostty_terminal_free: (terminal: number) => void;
  ghostty_terminal_reset: (terminal: number) => void;
  ghostty_terminal_resize: (
    terminal: number,
    cols: number,
    rows: number,
    cellWidthPx: number,
    cellHeightPx: number
  ) => number;
  ghostty_terminal_vt_write: (terminal: number, dataPtr: number, len: number) => void;
  ghostty_terminal_scroll_viewport: (terminal: number, behaviorPtr: number) => void;
  ghostty_terminal_set: (terminal: number, option: number, valuePtr: number) => number;
  ghostty_terminal_get: (terminal: number, data: number, outPtr: number) => number;
  ghostty_terminal_mode_get: (terminal: number, mode: number, outValuePtr: number) => number;
  ghostty_terminal_grid_ref: (terminal: number, pointPtr: number, outRefPtr: number) => number;
  ghostty_render_state_new: (allocatorPtr: number, outStatePtr: number) => number;
  ghostty_render_state_free: (state: number) => void;
  ghostty_render_state_update: (state: number, terminal: number) => number;
  ghostty_render_state_get: (state: number, data: number, outPtr: number) => number;
  ghostty_render_state_set: (state: number, option: number, valuePtr: number) => number;
  ghostty_render_state_colors_get: (state: number, outColorsPtr: number) => number;
  ghostty_render_state_row_iterator_new: (allocatorPtr: number, outIteratorPtr: number) => number;
  ghostty_render_state_row_iterator_free: (iterator: number) => void;
  ghostty_render_state_row_iterator_next: (iterator: number) => number;
  ghostty_render_state_row_get: (iterator: number, data: number, outPtr: number) => number;
  ghostty_render_state_row_set: (iterator: number, option: number, valuePtr: number) => number;
  ghostty_render_state_row_cells_new: (allocatorPtr: number, outCellsPtr: number) => number;
  ghostty_render_state_row_cells_free: (cells: number) => void;
  ghostty_render_state_row_cells_next: (cells: number) => number;
  ghostty_render_state_row_cells_select: (cells: number, x: number) => number;
  ghostty_render_state_row_cells_get: (cells: number, data: number, outPtr: number) => number;
  ghostty_row_get: (row: bigint, data: number, outPtr: number) => number;
  ghostty_cell_get: (cell: bigint, data: number, outPtr: number) => number;
  ghostty_formatter_terminal_new: (
    allocatorPtr: number,
    outFormatterPtr: number,
    terminal: number,
    optionsPtr: number
  ) => number;
  ghostty_formatter_format_alloc: (
    formatter: number,
    allocatorPtr: number,
    outPtrPtr: number,
    outLenPtr: number
  ) => number;
  ghostty_formatter_free: (formatter: number) => void;
  ghostty_key_encoder_new: (allocatorPtr: number, outEncoderPtr: number) => number;
  ghostty_key_encoder_free: (encoder: number) => void;
  ghostty_key_encoder_setopt_from_terminal: (encoder: number, terminal: number) => void;
  ghostty_key_event_new: (allocatorPtr: number, outEventPtr: number) => number;
  ghostty_key_event_free: (event: number) => void;
  ghostty_key_event_set_action: (event: number, action: number) => void;
  ghostty_key_event_set_key: (event: number, key: number) => void;
  ghostty_key_event_set_mods: (event: number, mods: number) => void;
  ghostty_key_event_set_consumed_mods: (event: number, consumedMods: number) => void;
  ghostty_key_event_set_composing: (event: number, composing: number) => void;
  ghostty_key_event_set_utf8: (event: number, utf8Ptr: number, len: number) => void;
  ghostty_key_event_set_unshifted_codepoint: (event: number, codepoint: number) => void;
  ghostty_key_encoder_encode: (
    encoder: number,
    event: number,
    outBufPtr: number,
    outBufLen: number,
    outWrittenPtr: number
  ) => number;
  ghostty_paste_encode: (
    dataPtr: number,
    dataLen: number,
    bracketed: number,
    outBufPtr: number,
    outBufLen: number,
    outWrittenPtr: number
  ) => number;
};

let bindingsPromise: Promise<GhosttyBindings> | null = null;

function assertResult(result: number, action: string): void {
  if (result === GHOSTTY_SUCCESS) {
    return;
  }

  throw new Error(`${action} failed with result ${result}`);
}

function parseHexRgb(hex: string): [number, number, number] {
  const normalized = hex.trim().replace(/^#/, '');
  if (normalized.length !== 6) {
    throw new Error(`expected #RRGGBB color, received: ${hex}`);
  }

  return [
    Number.parseInt(normalized.slice(0, 2), 16),
    Number.parseInt(normalized.slice(2, 4), 16),
    Number.parseInt(normalized.slice(4, 6), 16),
  ];
}

function createAnsi256Palette(theme: GhosttyTheme): Array<[number, number, number]> {
  const base16 = [
    theme.black,
    theme.red,
    theme.green,
    theme.yellow,
    theme.blue,
    theme.magenta,
    theme.cyan,
    theme.white,
    theme.brightBlack,
    theme.brightRed,
    theme.brightGreen,
    theme.brightYellow,
    theme.brightBlue,
    theme.brightMagenta,
    theme.brightCyan,
    theme.brightWhite,
  ].map(parseHexRgb);

  const palette = [...base16];
  const cube = [0, 95, 135, 175, 215, 255];

  for (const red of cube) {
    for (const green of cube) {
      for (const blue of cube) {
        palette.push([red, green, blue]);
      }
    }
  }

  for (let index = 0; index < 24; index += 1) {
    const value = 8 + index * 10;
    palette.push([value, value, value]);
  }

  return palette;
}

export function keyboardEventToGhosttyMods(event: KeyboardEvent): number {
  let mods = 0;

  if (event.shiftKey) mods |= 1 << 0;
  if (event.ctrlKey) mods |= 1 << 1;
  if (event.altKey) mods |= 1 << 2;
  if (event.metaKey) mods |= 1 << 3;
  if (event.getModifierState?.('CapsLock')) mods |= 1 << 4;
  if (event.getModifierState?.('NumLock')) mods |= 1 << 5;

  return mods;
}

class StructAllocation {
  constructor(
    private readonly bindings: GhosttyBindings,
    readonly typeName: string,
    readonly ptr: number
  ) {}

  get view(): DataView {
    return this.bindings.view(this.ptr, this.bindings.typeSize(this.typeName));
  }

  free(): void {
    this.bindings.freeBytes(this.ptr, this.bindings.typeSize(this.typeName));
  }
}

export class GhosttyBindings {
  readonly exports: GhosttyExports;
  readonly layout: LayoutMap;

  private readonly decoder = new TextDecoder();
  private readonly encoder = new TextEncoder();

  constructor(exports: GhosttyExports, layout: LayoutMap) {
    this.exports = exports;
    this.layout = layout;
  }

  buffer(): ArrayBuffer {
    return this.exports.memory.buffer;
  }

  bytes(ptr = 0, len = this.buffer().byteLength - ptr): Uint8Array {
    return new Uint8Array(this.buffer(), ptr, len);
  }

  view(ptr = 0, len = this.buffer().byteLength - ptr): DataView {
    return new DataView(this.buffer(), ptr, len);
  }

  typeSize(typeName: string): number {
    const type = this.layout[typeName];
    if (!type) {
      throw new Error(`unknown ghostty type: ${typeName}`);
    }

    return type.size;
  }

  field(typeName: string, fieldName: string): LayoutField {
    const type = this.layout[typeName];
    const field = type?.fields[fieldName];
    if (!type || !field) {
      throw new Error(`unknown ghostty field: ${typeName}.${fieldName}`);
    }

    return field;
  }

  allocStruct(typeName: string): StructAllocation {
    const ptr = this.allocBytes(this.typeSize(typeName));
    this.bytes(ptr, this.typeSize(typeName)).fill(0);
    return new StructAllocation(this, typeName, ptr);
  }

  allocBytes(len: number): number {
    return this.exports.ghostty_wasm_alloc_u8_array(len);
  }

  freeBytes(ptr: number, len: number): void {
    this.exports.ghostty_wasm_free_u8_array(ptr, len);
  }

  allocOpaque(): number {
    return this.exports.ghostty_wasm_alloc_opaque();
  }

  freeOpaque(ptr: number): void {
    this.exports.ghostty_wasm_free_opaque(ptr);
  }

  allocU8(): number {
    return this.exports.ghostty_wasm_alloc_u8();
  }

  freeU8(ptr: number): void {
    this.exports.ghostty_wasm_free_u8(ptr);
  }

  allocUsize(): number {
    return this.exports.ghostty_wasm_alloc_usize();
  }

  freeUsize(ptr: number): void {
    this.exports.ghostty_wasm_free_usize(ptr);
  }

  readPointer(ptr: number): number {
    return this.view().getUint32(ptr, true);
  }

  readU8(ptr: number): number {
    return this.view().getUint8(ptr);
  }

  readUsize(ptr: number): number {
    if (WASM_USIZE_BYTES === 4) {
      return this.view().getUint32(ptr, true);
    }

    return Number(this.view().getBigUint64(ptr, true));
  }

  readU64(ptr: number): bigint {
    return this.view().getBigUint64(ptr, true);
  }

  setField(target: DataView, typeName: string, fieldName: string, value: number | boolean): void {
    const field = this.field(typeName, fieldName);
    const offset = field.offset;

    switch (field.type) {
      case 'u8':
      case 'bool':
        target.setUint8(offset, Number(value));
        return;
      case 'u16':
        target.setUint16(offset, Number(value), true);
        return;
      case 'u32':
        target.setUint32(offset, Number(value), true);
        return;
      case 'u64':
        target.setBigUint64(offset, BigInt(value), true);
        return;
      case 'usize':
        if (WASM_USIZE_BYTES === 4) {
          target.setUint32(offset, Number(value), true);
          return;
        }

        target.setBigUint64(offset, BigInt(value), true);
        return;
      case 'i32':
      case 'enum':
        target.setInt32(offset, Number(value), true);
        return;
      default:
        throw new Error(`unsupported field type ${typeName}.${fieldName}: ${field.type}`);
    }
  }

  writeString(data: string): { ptr: number; len: number; free: () => void } {
    const encoded = this.encoder.encode(data);
    const ptr = this.allocBytes(encoded.length);
    this.bytes(ptr, encoded.length).set(encoded);

    return {
      ptr,
      len: encoded.length,
      free: () => this.freeBytes(ptr, encoded.length),
    };
  }

  writeBytes(data: Uint8Array): { ptr: number; len: number; free: () => void } {
    const ptr = this.allocBytes(data.length);
    this.bytes(ptr, data.length).set(data);

    return {
      ptr,
      len: data.length,
      free: () => this.freeBytes(ptr, data.length),
    };
  }

  readOwnedUtf8(ptr: number, len: number): string {
    return this.decoder.decode(this.bytes(ptr, len));
  }

  createTerminal(cols: number, rows: number, scrollback: number): number {
    const options = this.allocStruct('GhosttyTerminalOptions');
    this.setField(options.view, 'GhosttyTerminalOptions', 'cols', cols);
    this.setField(options.view, 'GhosttyTerminalOptions', 'rows', rows);
    this.setField(options.view, 'GhosttyTerminalOptions', 'max_scrollback', scrollback);

    const termPtrPtr = this.allocOpaque();

    try {
      assertResult(
        this.exports.ghostty_terminal_new(0, termPtrPtr, options.ptr),
        'ghostty_terminal_new'
      );
      return this.readPointer(termPtrPtr);
    } finally {
      options.free();
      this.freeOpaque(termPtrPtr);
    }
  }

  freeTerminal(terminal: number): void {
    this.exports.ghostty_terminal_free(terminal);
  }

  writeVt(terminal: number, data: string | Uint8Array): void {
    const bytes = typeof data === 'string' ? this.encoder.encode(data) : data;
    const allocation = this.writeBytes(bytes);

    try {
      this.exports.ghostty_terminal_vt_write(terminal, allocation.ptr, allocation.len);
    } finally {
      allocation.free();
    }
  }

  resetTerminal(terminal: number): void {
    this.exports.ghostty_terminal_reset(terminal);
  }

  resizeTerminal(
    terminal: number,
    cols: number,
    rows: number,
    cell: GhosttyCellDimensions
  ): void {
    assertResult(
      this.exports.ghostty_terminal_resize(
        terminal,
        cols,
        rows,
        Math.max(1, Math.round(cell.width)),
        Math.max(1, Math.round(cell.height))
      ),
      'ghostty_terminal_resize'
    );
  }

  scrollViewportDelta(terminal: number, delta: number): void {
    const behavior = this.allocStruct('GhosttyTerminalScrollViewport');

    try {
      this.setField(
        behavior.view,
        'GhosttyTerminalScrollViewport',
        'tag',
        GHOSTTY_SCROLL_VIEWPORT_DELTA
      );
      behavior.view.setBigInt64(
        this.field('GhosttyTerminalScrollViewport', 'value').offset,
        BigInt(delta),
        true
      );
      this.exports.ghostty_terminal_scroll_viewport(terminal, behavior.ptr);
    } finally {
      behavior.free();
    }
  }

  scrollViewportTop(terminal: number): void {
    const behavior = this.allocStruct('GhosttyTerminalScrollViewport');

    try {
      this.setField(
        behavior.view,
        'GhosttyTerminalScrollViewport',
        'tag',
        GHOSTTY_SCROLL_VIEWPORT_TOP
      );
      this.exports.ghostty_terminal_scroll_viewport(terminal, behavior.ptr);
    } finally {
      behavior.free();
    }
  }

  scrollViewportBottom(terminal: number): void {
    const behavior = this.allocStruct('GhosttyTerminalScrollViewport');

    try {
      this.setField(
        behavior.view,
        'GhosttyTerminalScrollViewport',
        'tag',
        GHOSTTY_SCROLL_VIEWPORT_BOTTOM
      );
      this.exports.ghostty_terminal_scroll_viewport(terminal, behavior.ptr);
    } finally {
      behavior.free();
    }
  }

  setTerminalTheme(terminal: number, theme: GhosttyTheme): void {
    const foreground = this.allocStruct('GhosttyColorRgb');
    const background = this.allocStruct('GhosttyColorRgb');
    const cursor = this.allocStruct('GhosttyColorRgb');
    const paletteColors = createAnsi256Palette(theme);
    const palettePtr = this.allocBytes(paletteColors.length * 3);

    const assignRgb = (target: StructAllocation, value: string) => {
      const [red, green, blue] = parseHexRgb(value);
      this.setField(target.view, 'GhosttyColorRgb', 'r', red);
      this.setField(target.view, 'GhosttyColorRgb', 'g', green);
      this.setField(target.view, 'GhosttyColorRgb', 'b', blue);
    };

    assignRgb(foreground, theme.foreground);
    assignRgb(background, theme.background);
    assignRgb(cursor, theme.cursor);

    const paletteBytes = this.bytes(palettePtr, paletteColors.length * 3);
    paletteColors.forEach(([red, green, blue], index) => {
      const offset = index * 3;
      paletteBytes[offset] = red;
      paletteBytes[offset + 1] = green;
      paletteBytes[offset + 2] = blue;
    });

    try {
      assertResult(
        this.exports.ghostty_terminal_set(
          terminal,
          GHOSTTY_TERMINAL_OPT_COLOR_FOREGROUND,
          foreground.ptr
        ),
        'ghostty_terminal_set(foreground)'
      );
      assertResult(
        this.exports.ghostty_terminal_set(
          terminal,
          GHOSTTY_TERMINAL_OPT_COLOR_BACKGROUND,
          background.ptr
        ),
        'ghostty_terminal_set(background)'
      );
      assertResult(
        this.exports.ghostty_terminal_set(terminal, GHOSTTY_TERMINAL_OPT_COLOR_CURSOR, cursor.ptr),
        'ghostty_terminal_set(cursor)'
      );
      assertResult(
        this.exports.ghostty_terminal_set(
          terminal,
          GHOSTTY_TERMINAL_OPT_COLOR_PALETTE,
          palettePtr
        ),
        'ghostty_terminal_set(palette)'
      );
    } finally {
      foreground.free();
      background.free();
      cursor.free();
      this.freeBytes(palettePtr, paletteColors.length * 3);
    }
  }

  readTerminalSize(terminal: number): { cols: number; rows: number } {
    const colsPtr = this.allocBytes(2);
    const rowsPtr = this.allocBytes(2);

    try {
      assertResult(
        this.exports.ghostty_terminal_get(terminal, GHOSTTY_TERMINAL_DATA_COLS, colsPtr),
        'ghostty_terminal_get(cols)'
      );
      assertResult(
        this.exports.ghostty_terminal_get(terminal, GHOSTTY_TERMINAL_DATA_ROWS, rowsPtr),
        'ghostty_terminal_get(rows)'
      );
      return {
        cols: this.view().getUint16(colsPtr, true),
        rows: this.view().getUint16(rowsPtr, true),
      };
    } finally {
      this.freeBytes(colsPtr, 2);
      this.freeBytes(rowsPtr, 2);
    }
  }

  readScrollbar(terminal: number): { total: number; offset: number; len: number } {
    const scrollbar = this.allocStruct('GhosttyTerminalScrollbar');

    try {
      assertResult(
        this.exports.ghostty_terminal_get(terminal, GHOSTTY_TERMINAL_DATA_SCROLLBAR, scrollbar.ptr),
        'ghostty_terminal_get(scrollbar)'
      );

      return {
        total: Number(
          scrollbar.view.getBigUint64(
            this.field('GhosttyTerminalScrollbar', 'total').offset,
            true
          )
        ),
        offset: Number(
          scrollbar.view.getBigUint64(
            this.field('GhosttyTerminalScrollbar', 'offset').offset,
            true
          )
        ),
        len: Number(
          scrollbar.view.getBigUint64(this.field('GhosttyTerminalScrollbar', 'len').offset, true)
        ),
      };
    } finally {
      scrollbar.free();
    }
  }

  isTerminalModeEnabled(terminal: number, mode: number): boolean {
    const valuePtr = this.allocU8();

    try {
      assertResult(
        this.exports.ghostty_terminal_mode_get(terminal, mode, valuePtr),
        'ghostty_terminal_mode_get'
      );
      return this.readU8(valuePtr) !== 0;
    } finally {
      this.freeU8(valuePtr);
    }
  }

  createFormatter(
    terminal: number,
    emit: number,
    options: { trim: boolean; unwrap: boolean; includePalette: boolean; selectionPtr?: number | null }
  ): number {
    const formatterOptions = this.allocStruct('GhosttyFormatterTerminalOptions');
    const extraOffset = this.field('GhosttyFormatterTerminalOptions', 'extra').offset;
    const extraView = this.view(
      formatterOptions.ptr + extraOffset,
      this.typeSize('GhosttyFormatterTerminalExtra')
    );
    const screenOffset = this.field('GhosttyFormatterTerminalExtra', 'screen').offset;
    const screenView = this.view(
      formatterOptions.ptr + extraOffset + screenOffset,
      this.typeSize('GhosttyFormatterScreenExtra')
    );
    const outFormatterPtr = this.allocOpaque();

    try {
      this.setField(
        formatterOptions.view,
        'GhosttyFormatterTerminalOptions',
        'size',
        this.typeSize('GhosttyFormatterTerminalOptions')
      );
      this.setField(formatterOptions.view, 'GhosttyFormatterTerminalOptions', 'emit', emit);
      this.setField(
        formatterOptions.view,
        'GhosttyFormatterTerminalOptions',
        'unwrap',
        options.unwrap
      );
      this.setField(
        formatterOptions.view,
        'GhosttyFormatterTerminalOptions',
        'trim',
        options.trim
      );
      this.setField(
        extraView,
        'GhosttyFormatterTerminalExtra',
        'size',
        this.typeSize('GhosttyFormatterTerminalExtra')
      );
      this.setField(
        extraView,
        'GhosttyFormatterTerminalExtra',
        'palette',
        options.includePalette
      );
      this.setField(
        screenView,
        'GhosttyFormatterScreenExtra',
        'size',
        this.typeSize('GhosttyFormatterScreenExtra')
      );
      const selectionOffset = this.field('GhosttyFormatterTerminalOptions', 'selection').offset;
      formatterOptions.view.setUint32(selectionOffset, options.selectionPtr ?? 0, true);

      assertResult(
        this.exports.ghostty_formatter_terminal_new(
          0,
          outFormatterPtr,
          terminal,
          formatterOptions.ptr
        ),
        'ghostty_formatter_terminal_new'
      );

      return this.readPointer(outFormatterPtr);
    } finally {
      formatterOptions.free();
      this.freeOpaque(outFormatterPtr);
    }
  }

  freeFormatter(formatter: number): void {
    this.exports.ghostty_formatter_free(formatter);
  }

  private resolveViewportGridRef(
    terminal: number,
    x: number,
    y: number
  ): StructAllocation | null {
    const point = this.allocStruct('GhosttyPoint');
    const outRef = this.allocStruct('GhosttyGridRef');

    try {
      this.setField(point.view, 'GhosttyPoint', 'tag', GHOSTTY_POINT_TAG_VIEWPORT);
      const coordOffset = this.field('GhosttyPoint', 'value').offset;
      const coordView = this.view(
        point.ptr + coordOffset,
        this.typeSize('GhosttyPointCoordinate')
      );
      this.setField(coordView, 'GhosttyPointCoordinate', 'x', x);
      this.setField(coordView, 'GhosttyPointCoordinate', 'y', y);

      const result = this.exports.ghostty_terminal_grid_ref(terminal, point.ptr, outRef.ptr);
      if (result !== GHOSTTY_SUCCESS) {
        outRef.free();
        return null;
      }

      return outRef;
    } finally {
      point.free();
    }
  }

  private createViewportSelection(
    terminal: number,
    cols: number,
    rows: number
  ): StructAllocation | null {
    const safeCols = Math.max(1, Math.floor(cols));
    const safeRows = Math.max(1, Math.floor(rows));
    const start = this.resolveViewportGridRef(terminal, 0, 0);
    if (!start) {
      return null;
    }

    let end: StructAllocation | null = null;
    for (let row = safeRows - 1; row >= 0; row -= 1) {
      end = this.resolveViewportGridRef(terminal, safeCols - 1, row);
      if (end) {
        break;
      }
    }

    if (!end) {
      start.free();
      return null;
    }

    const selection = this.allocStruct('GhosttySelection');
    try {
      this.setField(selection.view, 'GhosttySelection', 'size', this.typeSize('GhosttySelection'));
      this.setField(selection.view, 'GhosttySelection', 'rectangle', false);

      const startOffset = this.field('GhosttySelection', 'start').offset;
      const endOffset = this.field('GhosttySelection', 'end').offset;
      this.bytes(selection.ptr + startOffset, this.typeSize('GhosttyGridRef')).set(
        this.bytes(start.ptr, this.typeSize('GhosttyGridRef'))
      );
      this.bytes(selection.ptr + endOffset, this.typeSize('GhosttyGridRef')).set(
        this.bytes(end.ptr, this.typeSize('GhosttyGridRef'))
      );

      return selection;
    } finally {
      start.free();
      end.free();
    }
  }

  formatViewport(
    terminal: number,
    emit: number,
    options: { trim: boolean; unwrap: boolean; includePalette: boolean },
    viewport: { cols: number; rows: number }
  ): string {
    const terminalSize = this.readTerminalSize(terminal);
    const selection = this.createViewportSelection(
      terminal,
      Math.max(1, Math.min(terminalSize.cols, viewport.cols)),
      Math.max(1, Math.min(terminalSize.rows, viewport.rows))
    );
    const formatter = this.createFormatter(terminal, emit, {
      ...options,
      selectionPtr: selection?.ptr ?? null,
    });

    try {
      return this.formatFormatter(formatter);
    } finally {
      this.freeFormatter(formatter);
      selection?.free();
    }
  }

  formatFormatter(formatter: number): string {
    const outPtrPtr = this.allocOpaque();
    const outLenPtr = this.allocUsize();

    try {
      assertResult(
        this.exports.ghostty_formatter_format_alloc(formatter, 0, outPtrPtr, outLenPtr),
        'ghostty_formatter_format_alloc'
      );

      const outPtr = this.readPointer(outPtrPtr);
      const outLen = this.readUsize(outLenPtr);
      const memoryByteLength = this.buffer().byteLength;

      try {
        if (outLen === 0 || outPtr === 0) {
          return '';
        }

        if (outPtr < 0 || outPtr > memoryByteLength || outLen > memoryByteLength - outPtr) {
          throw new Error(
            `ghostty_formatter_format_alloc returned invalid slice ptr=${outPtr} len=${outLen} mem=${memoryByteLength}`
          );
        }

        return this.readOwnedUtf8(outPtr, outLen);
      } finally {
        if (outLen > 0 && outPtr !== 0) {
          this.exports.ghostty_free(0, outPtr, outLen);
        }
      }
    } finally {
      this.freeOpaque(outPtrPtr);
      this.freeUsize(outLenPtr);
    }
  }

  createRenderState(): number {
    const outStatePtr = this.allocOpaque();

    try {
      assertResult(this.exports.ghostty_render_state_new(0, outStatePtr), 'ghostty_render_state_new');
      return this.readPointer(outStatePtr);
    } finally {
      this.freeOpaque(outStatePtr);
    }
  }

  freeRenderState(state: number): void {
    this.exports.ghostty_render_state_free(state);
  }

  updateRenderState(state: number, terminal: number): void {
    assertResult(
      this.exports.ghostty_render_state_update(state, terminal),
      'ghostty_render_state_update'
    );
  }

  getRenderStateValueResult(state: number, data: number, outPtr: number): number {
    return this.exports.ghostty_render_state_get(state, data, outPtr);
  }

  getRenderStateValue(state: number, data: number, outPtr: number): void {
    assertResult(this.getRenderStateValueResult(state, data, outPtr), 'ghostty_render_state_get');
  }

  setRenderStateValue(state: number, option: number, valuePtr: number): void {
    assertResult(this.exports.ghostty_render_state_set(state, option, valuePtr), 'ghostty_render_state_set');
  }

  getRenderStateColors(state: number, outColorsPtr: number): void {
    assertResult(
      this.exports.ghostty_render_state_colors_get(state, outColorsPtr),
      'ghostty_render_state_colors_get'
    );
  }

  createRenderStateRowIterator(): number {
    const outIteratorPtr = this.allocOpaque();

    try {
      assertResult(
        this.exports.ghostty_render_state_row_iterator_new(0, outIteratorPtr),
        'ghostty_render_state_row_iterator_new'
      );
      return this.readPointer(outIteratorPtr);
    } finally {
      this.freeOpaque(outIteratorPtr);
    }
  }

  freeRenderStateRowIterator(iterator: number): void {
    this.exports.ghostty_render_state_row_iterator_free(iterator);
  }

  bindRenderStateRowIterator(state: number, iterator: number): void {
    const outPtr = this.allocOpaque();

    try {
      this.view(outPtr, 4).setUint32(0, iterator, true);
      this.getRenderStateValue(state, 4, outPtr);
    } finally {
      this.freeOpaque(outPtr);
    }
  }

  nextRenderStateRowIterator(iterator: number): boolean {
    return this.exports.ghostty_render_state_row_iterator_next(iterator) !== 0;
  }

  getRenderStateRowValueResult(iterator: number, data: number, outPtr: number): number {
    return this.exports.ghostty_render_state_row_get(iterator, data, outPtr);
  }

  getRenderStateRowValue(iterator: number, data: number, outPtr: number): void {
    assertResult(this.getRenderStateRowValueResult(iterator, data, outPtr), 'ghostty_render_state_row_get');
  }

  setRenderStateRowValue(iterator: number, option: number, valuePtr: number): void {
    assertResult(
      this.exports.ghostty_render_state_row_set(iterator, option, valuePtr),
      'ghostty_render_state_row_set'
    );
  }

  createRenderStateRowCells(): number {
    const outCellsPtr = this.allocOpaque();

    try {
      assertResult(
        this.exports.ghostty_render_state_row_cells_new(0, outCellsPtr),
        'ghostty_render_state_row_cells_new'
      );
      return this.readPointer(outCellsPtr);
    } finally {
      this.freeOpaque(outCellsPtr);
    }
  }

  freeRenderStateRowCells(cells: number): void {
    this.exports.ghostty_render_state_row_cells_free(cells);
  }

  bindRenderStateRowCells(iterator: number, cells: number): void {
    const outPtr = this.allocOpaque();

    try {
      this.view(outPtr, 4).setUint32(0, cells, true);
      this.getRenderStateRowValue(iterator, 3, outPtr);
    } finally {
      this.freeOpaque(outPtr);
    }
  }

  nextRenderStateRowCell(cells: number): boolean {
    return this.exports.ghostty_render_state_row_cells_next(cells) !== 0;
  }

  selectRenderStateRowCell(cells: number, x: number): void {
    assertResult(
      this.exports.ghostty_render_state_row_cells_select(cells, x),
      'ghostty_render_state_row_cells_select'
    );
  }

  getRenderStateRowCellValueResult(cells: number, data: number, outPtr: number): number {
    return this.exports.ghostty_render_state_row_cells_get(cells, data, outPtr);
  }

  getRenderStateRowCellValue(cells: number, data: number, outPtr: number): void {
    assertResult(
      this.getRenderStateRowCellValueResult(cells, data, outPtr),
      'ghostty_render_state_row_cells_get'
    );
  }

  getRawRowValueResult(row: bigint, data: number, outPtr: number): number {
    return this.exports.ghostty_row_get(row, data, outPtr);
  }

  getRawRowValue(row: bigint, data: number, outPtr: number): void {
    assertResult(this.getRawRowValueResult(row, data, outPtr), 'ghostty_row_get');
  }

  getRawCellValueResult(cell: bigint, data: number, outPtr: number): number {
    return this.exports.ghostty_cell_get(cell, data, outPtr);
  }

  getRawCellValue(cell: bigint, data: number, outPtr: number): void {
    assertResult(this.getRawCellValueResult(cell, data, outPtr), 'ghostty_cell_get');
  }

  createKeyEncoder(): number {
    const outEncoderPtr = this.allocOpaque();

    try {
      assertResult(this.exports.ghostty_key_encoder_new(0, outEncoderPtr), 'ghostty_key_encoder_new');
      return this.readPointer(outEncoderPtr);
    } finally {
      this.freeOpaque(outEncoderPtr);
    }
  }

  freeKeyEncoder(encoder: number): void {
    this.exports.ghostty_key_encoder_free(encoder);
  }

  encodeKeyEvent(
    encoder: number,
    terminal: number,
    options: {
      action: 'press' | 'repeat' | 'release';
      keyCode: number;
      mods: number;
      composing: boolean;
      utf8?: string | null;
      unshiftedCodepoint?: number | null;
    }
  ): string | null {
    if (options.keyCode <= 0) {
      return null;
    }

    const eventPtrPtr = this.allocOpaque();
    let eventHandle = 0;
    let utf8Allocation: { ptr: number; len: number; free: () => void } | null = null;

    try {
      assertResult(this.exports.ghostty_key_event_new(0, eventPtrPtr), 'ghostty_key_event_new');
      eventHandle = this.readPointer(eventPtrPtr);
      this.exports.ghostty_key_encoder_setopt_from_terminal(encoder, terminal);
      this.exports.ghostty_key_event_set_action(
        eventHandle,
        options.action === 'release'
          ? GHOSTTY_KEY_ACTION_RELEASE
          : options.action === 'repeat'
            ? GHOSTTY_KEY_ACTION_REPEAT
            : GHOSTTY_KEY_ACTION_PRESS
      );
      this.exports.ghostty_key_event_set_key(eventHandle, options.keyCode);
      this.exports.ghostty_key_event_set_mods(eventHandle, options.mods);
      this.exports.ghostty_key_event_set_consumed_mods(eventHandle, 0);
      this.exports.ghostty_key_event_set_composing(eventHandle, options.composing ? 1 : 0);

      if (options.utf8) {
        utf8Allocation = this.writeString(options.utf8);
        this.exports.ghostty_key_event_set_utf8(
          eventHandle,
          utf8Allocation.ptr,
          utf8Allocation.len
        );
      }

      if (typeof options.unshiftedCodepoint === 'number') {
        this.exports.ghostty_key_event_set_unshifted_codepoint(
          eventHandle,
          options.unshiftedCodepoint
        );
      }

      return this.encodeKeyHandle(encoder, eventHandle);
    } finally {
      utf8Allocation?.free();
      if (eventHandle !== 0) {
        this.exports.ghostty_key_event_free(eventHandle);
      }
      this.freeOpaque(eventPtrPtr);
    }
  }

  private encodeKeyHandle(encoder: number, eventHandle: number): string | null {
    const requiredPtr = this.allocUsize();

    try {
      const sizeResult = this.exports.ghostty_key_encoder_encode(encoder, eventHandle, 0, 0, requiredPtr);
      if (sizeResult !== GHOSTTY_OUT_OF_SPACE && sizeResult !== GHOSTTY_SUCCESS) {
        assertResult(sizeResult, 'ghostty_key_encoder_encode(size)');
      }

      const required = Math.max(0, this.readUsize(requiredPtr));
      if (required === 0) {
        return null;
      }

      const bufferPtr = this.allocBytes(required);
      const writtenPtr = this.allocUsize();

      try {
        assertResult(
          this.exports.ghostty_key_encoder_encode(
            encoder,
            eventHandle,
            bufferPtr,
            required,
            writtenPtr
          ),
          'ghostty_key_encoder_encode'
        );

        const written = this.readUsize(writtenPtr);
        if (written === 0) {
          return null;
        }

        return this.readOwnedUtf8(bufferPtr, written);
      } finally {
        this.freeBytes(bufferPtr, required);
        this.freeUsize(writtenPtr);
      }
    } finally {
      this.freeUsize(requiredPtr);
    }
  }

  encodePaste(terminal: number, data: string): string {
    const input = this.writeString(data);
    const requiredPtr = this.allocUsize();

    try {
      const bracketed = this.isTerminalModeEnabled(terminal, GHOSTTY_MODE_BRACKETED_PASTE);
      const sizeResult = this.exports.ghostty_paste_encode(
        input.ptr,
        input.len,
        bracketed ? 1 : 0,
        0,
        0,
        requiredPtr
      );
      if (sizeResult !== GHOSTTY_OUT_OF_SPACE && sizeResult !== GHOSTTY_SUCCESS) {
        assertResult(sizeResult, 'ghostty_paste_encode(size)');
      }

      const required = Math.max(0, this.readUsize(requiredPtr));
      if (required === 0) {
        return '';
      }

      const outputPtr = this.allocBytes(required);
      const writtenPtr = this.allocUsize();

      try {
        assertResult(
          this.exports.ghostty_paste_encode(
            input.ptr,
            input.len,
            bracketed ? 1 : 0,
            outputPtr,
            required,
            writtenPtr
          ),
          'ghostty_paste_encode'
        );

        return this.readOwnedUtf8(outputPtr, this.readUsize(writtenPtr));
      } finally {
        this.freeBytes(outputPtr, required);
        this.freeUsize(writtenPtr);
      }
    } finally {
      input.free();
      this.freeUsize(requiredPtr);
    }
  }
}

async function loadGhosttyWasmBytes(source: string): Promise<ArrayBuffer> {
  const isFilePath =
    source.startsWith('/') ||
    source.startsWith('./') ||
    source.startsWith('../') ||
    /^[A-Za-z]:[\\/]/.test(source);

  if (isFilePath && typeof Bun !== 'undefined') {
    return Bun.file(source).arrayBuffer();
  }

  const response = await fetch(source);
  if (!response.ok) {
    throw new Error(`failed to load ghostty wasm: ${response.status} ${response.statusText}`);
  }

  return response.arrayBuffer();
}

export async function getGhosttyBindings(): Promise<GhosttyBindings> {
  if (!bindingsPromise) {
    bindingsPromise = (async () => {
      const wasmBytes = await loadGhosttyWasmBytes(ghosttyWasmUrl);
      const wasmModule = await WebAssembly.instantiate(wasmBytes, {
        env: {
          log() {
            // ignore wasm logs in production usage
          },
        },
      });

      const exports = wasmModule.instance.exports as GhosttyExports;
      const bytes = new Uint8Array(exports.memory.buffer);
      const typeJsonPtr = exports.ghostty_type_json();
      let end = typeJsonPtr;

      while (bytes[end] !== 0) {
        end += 1;
      }

      const layout = JSON.parse(
        new TextDecoder().decode(bytes.subarray(typeJsonPtr, end))
      ) as LayoutMap;

      return new GhosttyBindings(exports, layout);
    })();
  }

  return bindingsPromise;
}

export {
  GHOSTTY_FORMATTER_FORMAT_HTML,
  GHOSTTY_FORMATTER_FORMAT_PLAIN,
  GHOSTTY_KEY_ACTION_PRESS,
  GHOSTTY_KEY_ACTION_RELEASE,
  GHOSTTY_KEY_ACTION_REPEAT,
};
