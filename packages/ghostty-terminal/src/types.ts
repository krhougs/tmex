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
  /** 行高倍率（cell 高 = fontSize × lineHeight）。缺省走内置默认 1.2。 */
  lineHeight?: number;
  /** 编程连字（=> -> != 等符号段整形）。缺省关闭。 */
  ligatures?: boolean;
  /**
   * 可读性兜底：调色板色与所在 cell 背景的对比度低于阈值时，把前景沿明度方向推到刚好
   * 达标。只作用于主题调色板的 16 个基础色和默认前景，256 色与 SGR 真彩色原样呈现。
   * 缺省关闭——它会改变程序指定的颜色，是否可接受由宿主决定。
   */
  minimumContrast?: boolean;
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

export interface GhosttyViewportGesture {
  source: 'wheel' | 'touch';
  deltaX?: number;
  deltaY: number;
  deltaMode?: number;
  clientX: number;
  clientY: number;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  metaKey?: boolean;
}

export interface GhosttyTerminalModeSnapshot {
  mouseX10: boolean;
  mouseNormal: boolean;
  mouseButton: boolean;
  mouseAny: boolean;
  mouseUtf8: boolean;
  mouseSgr: boolean;
  mouseSgrPixels: boolean;
  mouseUrxvt: boolean;
  altScroll: boolean;
  altScreen1047: boolean;
  altScreen1049: boolean;
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

// 光标在 client（视口）坐标系的垂直范围，供宿主做键盘避让定位（issue #27 follow 模式）。
export interface GhosttyCursorViewportRect {
  top: number;
  bottom: number;
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
  // 颜色来源：调色板色给出索引（0–255），SGR 真彩色与「未指定」都是 null。
  // fgColor/bgColor 只有解析后的 RGB，palette 196 与 38;2;255;0;0 完全同值，
  // 靠 RGB 无法区分，可读性兜底要据此把真彩色排除在外。
  fgPaletteIndex: number | null;
  bgPaletteIndex: number | null;
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
  readonly textarea: HTMLElement | null;
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
  refresh?: () => void;
  resize: (cols: number, rows: number) => void;
  scrollLines: (amount: number) => void;
  scrollToTop: () => void;
  scrollToBottom: () => void;
  handleViewportGesture?: (gesture: GhosttyViewportGesture) => boolean;
  isMouseReporting?: () => boolean;
  sendTouchMouseEvent?: (event: {
    action: 'press' | 'motion' | 'release';
    clientX: number;
    clientY: number;
  }) => boolean;
  noteTouchHandled?: () => void;
  exportModeSnapshot?: () => GhosttyTerminalModeSnapshot;
  restoreModeSnapshot?: (snapshot: GhosttyTerminalModeSnapshot) => void;
  clearMouseTrackingModes?: () => void;
  paste: (data: string) => void;
  focus: () => void;
  getCursorViewportRect?: () => GhosttyCursorViewportRect | null;
  getSelection?: () => string;
  hasSelection?: () => boolean;
  clearSelection?: () => void;
  setFocused?: (focused: boolean) => void;
  forceFullRepaint?: () => void;
  onSelectionChange?: (callback: (text: string | null) => void) => TerminalDisposable;
  onLinkActivated?: (callback: (url: string) => void) => TerminalDisposable;
  /** 回调收到的是经 cwd/授权根解析后的绝对路径 */
  onFileLinkActivated?: (callback: (path: string) => void) => TerminalDisposable;
  setFileLinkContext?: (
    context: { cwd?: string | null; rootPaths: readonly string[] } | null
  ) => void;
  startTouchSelection?: (
    clientX: number,
    clientY: number,
    mode?: 'character' | 'word' | 'line'
  ) => boolean;
  updateTouchSelection?: (clientX: number, clientY: number) => void;
  endTouchSelection?: () => void;
  onData: (callback: (data: string) => void) => TerminalDisposable;
  attachCustomKeyEventHandler: (callback: (event: KeyboardEvent) => boolean) => void;
  loadAddon: (addon: {
    activate: (terminal: CompatibleTerminalLike) => void;
    dispose: () => void;
  }) => void;
  getRendererKind?: () => string;
}
