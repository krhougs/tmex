export interface GhosttyTheme {
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export interface GhosttyTerminalInitOptions {
  theme: GhosttyTheme;
  fontFamily: string;
  fontSize: number;
  scrollback: number;
  disableStdin?: boolean;
}

export interface GhosttyTerminalSize {
  cols: number;
  rows: number;
}

export interface GhosttyCellDimensions {
  width: number;
  height: number;
}

export interface GhosttyColorRgb {
  r: number;
  g: number;
  b: number;
}

export type GhosttyRenderDirtyState = 'clean' | 'partial' | 'full';
export type GhosttyCursorVisualStyle = 'bar' | 'block' | 'underline' | 'block-hollow';
export type GhosttyCellWidthKind = 'narrow' | 'wide' | 'spacer-tail' | 'spacer-head';

export interface GhosttyRenderColors {
  background: GhosttyColorRgb;
  foreground: GhosttyColorRgb;
  cursor: GhosttyColorRgb | null;
  palette: GhosttyColorRgb[];
}

export interface GhosttyRenderCursor {
  style: GhosttyCursorVisualStyle;
  visible: boolean;
  blinking: boolean;
  passwordInput: boolean;
  x: number | null;
  y: number | null;
  wideTail: boolean;
}

export interface GhosttyRenderCellStyle {
  bold: boolean;
  italic: boolean;
  faint: boolean;
  blink: boolean;
  inverse: boolean;
  invisible: boolean;
  strikethrough: boolean;
  overline: boolean;
  underline: number;
}

export interface GhosttyRenderCell {
  x: number;
  text: string;
  codepoints: number[];
  widthKind: GhosttyCellWidthKind;
  hasText: boolean;
  style: GhosttyRenderCellStyle;
  fgColor: GhosttyColorRgb | null;
  bgColor: GhosttyColorRgb | null;
}

export interface GhosttyRenderRow {
  y: number;
  dirty: boolean;
  wrap: boolean;
  wrapContinuation: boolean;
  text: string;
  cells: GhosttyRenderCell[];
}

export interface GhosttySelectionRect {
  row: number;
  x: number;
  width: number;
}

export interface GhosttyRenderSnapshotMeta {
  cols: number;
  rows: number;
  dirty: GhosttyRenderDirtyState;
  colors: GhosttyRenderColors;
  cursor: GhosttyRenderCursor;
}

export interface TerminalDisposable {
  dispose: () => void;
}

export interface CompatibleBufferLine {
  translateToString: (trimRight: boolean) => string;
}

export interface CompatibleTerminalBuffer {
  active: {
    baseY: number;
    viewportY: number;
    length: number;
    getLine: (index: number) => CompatibleBufferLine | null;
  };
}

export interface CompatibleTerminalLike {
  readonly cols: number;
  readonly rows: number;
  readonly element: HTMLElement | null;
  readonly textarea: HTMLTextAreaElement | null;
  readonly buffer: CompatibleTerminalBuffer;
  readonly _core: {
    _renderService: {
      dimensions: {
        css: {
          cell: GhosttyCellDimensions;
        };
      };
    };
  };
  write: (data: string | Uint8Array) => void;
  reset: () => void;
  resize: (cols: number, rows: number) => void;
  scrollLines: (amount: number) => void;
  scrollToTop: () => void;
  scrollToBottom: () => void;
  paste: (data: string) => void;
  focus: () => void;
  onData: (callback: (data: string) => void) => TerminalDisposable;
  attachCustomKeyEventHandler: (
    callback: (event: KeyboardEvent) => boolean
  ) => void;
  loadAddon: (addon: { activate: (terminal: CompatibleTerminalLike) => void; dispose: () => void }) => void;
  getRendererKind?: () => string;
}
