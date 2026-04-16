import { CanvasRenderer } from './canvas-renderer';
import { getGhosttyKeyCode, getUnshiftedCodepoint } from './ghostty-keycodes';
import {
  createRenderState,
  disposeRenderStateResources,
  iterateRows,
  readRenderSnapshotMeta,
  updateRenderState,
  type GhosttyRenderStateResources,
} from './render-state';
import {
  clearSelection as resetSelectionData,
  createEmptySelectionState,
  hasSelection,
  projectSelectionRects,
  resolvePointerSelection,
  serializeSelectionText,
  updateSelectionFocus,
  type SelectionMode,
  type SelectionPoint,
  type SelectionState,
} from './selection-model';
import {
  isCopyShortcut,
  writeSelectionToClipboard,
  writeSelectionToCopyEvent,
} from './selection-clipboard';
import {
  getGhosttyBindings,
  keyboardEventToGhosttyMods,
  type GhosttyBindings,
} from './ghostty-wasm';
import type {
  CompatibleBufferLine,
  CompatibleTerminalBuffer,
  CompatibleTerminalLike,
  GhosttyCellDimensions,
  GhosttyRenderRow,
  GhosttyTerminalModeSnapshot,
  GhosttyTerminalInitOptions,
  GhosttyTerminalSize,
  GhosttyViewportGesture,
  TerminalDisposable,
} from './types';

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const DEFAULT_CELL_WIDTH = 9;
const DEFAULT_CELL_HEIGHT = 17;
const AUTO_SCROLL_INTERVAL_MS = 48;
const TERMINAL_ENGINE = 'ghostty-official';

const GHOSTTY_MODE_X10_MOUSE = 9;
const GHOSTTY_MODE_NORMAL_MOUSE = 1000;
const GHOSTTY_MODE_BUTTON_MOUSE = 1002;
const GHOSTTY_MODE_ANY_MOUSE = 1003;
const GHOSTTY_MODE_ALT_SCROLL = 1007;
const GHOSTTY_MODE_ALT_SCREEN = 1047;
const GHOSTTY_MODE_ALT_SCREEN_SAVE = 1049;

const MOUSE_TRACKING_MODES: readonly number[] = [
  GHOSTTY_MODE_X10_MOUSE,
  GHOSTTY_MODE_NORMAL_MOUSE,
  GHOSTTY_MODE_BUTTON_MOUSE,
  GHOSTTY_MODE_ANY_MOUSE,
];

const GHOSTTY_MOUSE_BUTTON_LEFT = 1;
const GHOSTTY_MOUSE_BUTTON_MIDDLE = 3;
const GHOSTTY_MOUSE_BUTTON_RIGHT = 2;
const GHOSTTY_MOUSE_BUTTON_FOUR = 4;
const GHOSTTY_MOUSE_BUTTON_FIVE = 5;

type PointerDragState = {
  active: boolean;
  moved: boolean;
  mode: SelectionMode;
  lastClientX: number | null;
  lastClientY: number | null;
};

type InputRoutingState = {
  mouseReporting: boolean;
  altScroll: boolean;
};

class BufferLine implements CompatibleBufferLine {
  constructor(private readonly content: string) {}

  translateToString(trimRight: boolean): string {
    return trimRight ? this.content.replace(/\s+$/u, '') : this.content;
  }
}

class TerminalBuffer implements CompatibleTerminalBuffer {
  active = {
    baseY: 0,
    viewportY: 0,
    length: DEFAULT_ROWS,
    getLine: (index: number): CompatibleBufferLine | null => {
      const relativeIndex = index - this.active.viewportY;
      const line = this.visibleLines[relativeIndex];
      return typeof line === 'string' ? new BufferLine(line) : null;
    },
  };

  private visibleLines: string[] = Array.from({ length: DEFAULT_ROWS }, () => '');

  setViewport(viewportY: number, baseY: number, length: number, lines: string[]): void {
    this.active.viewportY = viewportY;
    this.active.baseY = baseY;
    this.active.length = length;
    this.visibleLines = lines;
  }
}

function shouldEncodeOnKeyDown(event: KeyboardEvent): boolean {
  const isPlainText = event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey;
  if (isPlainText) {
    return false;
  }

  return true;
}

function normalizeVisibleLines(rows: GhosttyRenderRow[], expectedRows: number): string[] {
  const lines = rows.slice(0, expectedRows).map((row) => row.text);
  while (lines.length < expectedRows) {
    lines.push('');
  }
  return lines;
}

function pointerLikeEventToGhosttyMods(event: {
  shiftKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
}): number {
  return keyboardEventToGhosttyMods({
    shiftKey: Boolean(event.shiftKey),
    ctrlKey: Boolean(event.ctrlKey),
    altKey: Boolean(event.altKey),
    metaKey: Boolean(event.metaKey),
    getModifierState: () => false,
  } as unknown as KeyboardEvent);
}

export class FitAddon {
  private terminal: GhosttyTerminalController | null = null;

  activate(terminal: CompatibleTerminalLike): void {
    this.terminal = terminal instanceof GhosttyTerminalController ? terminal : null;
  }

  fit(): void {
    const proposed = this.proposeDimensions();
    if (!this.terminal || !proposed) {
      return;
    }

    this.terminal.resize(proposed.cols, proposed.rows);
  }

  proposeDimensions(): GhosttyTerminalSize | null {
    return this.terminal?.measureSizeFromElement() ?? null;
  }

  dispose(): void {
    this.terminal = null;
  }
}

export class GhosttyTerminalController implements CompatibleTerminalLike {
  readonly buffer = new TerminalBuffer();
  readonly _core = {
    _renderService: {
      dimensions: {
        css: {
          cell: {
            width: DEFAULT_CELL_WIDTH,
            height: DEFAULT_CELL_HEIGHT,
          },
        },
      },
    },
  };

  readonly options: GhosttyTerminalInitOptions;

  element: HTMLElement | null = null;
  textarea: HTMLElement | null = null;
  cols = DEFAULT_COLS;
  rows = DEFAULT_ROWS;

  private readonly bindings: GhosttyBindings;
  private readonly terminalHandle: number;
  private readonly keyEncoderHandle: number;
  private readonly mouseEncoderHandle: number;
  private readonly renderState: GhosttyRenderStateResources;
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly addons = new Set<{ dispose: () => void }>();
  private screenElement: HTMLDivElement | null = null;
  private renderer: CanvasRenderer | null = null;
  private renderRaf: number | null = null;
  private disposed = false;
  private disableStdin: boolean;
  private customKeyEventHandler: (event: KeyboardEvent) => boolean = () => true;
  private imeIsComposing = false;
  private lastCompositionCommit: { data: string; at: number } | null = null;
  private selectionState: SelectionState = createEmptySelectionState();
  private readonly lineCache = new Map<number, string>();
  private lastViewportOffset = 0;
  private lastViewportRows = DEFAULT_ROWS;
  private lastRenderedRows: GhosttyRenderRow[] = [];
  private pointerDrag: PointerDragState = {
    active: false,
    moved: false,
    mode: 'character',
    lastClientX: null,
    lastClientY: null,
  };
  private autoScrollTimer: ReturnType<typeof setInterval> | null = null;
  private readonly domEventDisposers: Array<() => void> = [];
  private copyShortcutSuppressed = false;
  private scrollbarThumb: HTMLDivElement | null = null;
  private scrollbarFadeTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly pressedMouseButtons = new Set<number>();
  private wheelPixelDelta = 0;
  private mouseDragActive = false;

  private constructor(
    bindings: GhosttyBindings,
    terminalHandle: number,
    keyEncoderHandle: number,
    mouseEncoderHandle: number,
    renderState: GhosttyRenderStateResources,
    options: GhosttyTerminalInitOptions
  ) {
    this.bindings = bindings;
    this.terminalHandle = terminalHandle;
    this.keyEncoderHandle = keyEncoderHandle;
    this.mouseEncoderHandle = mouseEncoderHandle;
    this.renderState = renderState;
    this.options = options;
    this.disableStdin = Boolean(options.disableStdin);
  }

  static async create(options: GhosttyTerminalInitOptions): Promise<GhosttyTerminalController> {
    const bindings = await getGhosttyBindings();
    const terminalHandle = bindings.createTerminal(DEFAULT_COLS, DEFAULT_ROWS, options.scrollback);
    let keyEncoderHandle = 0;
    let mouseEncoderHandle = 0;
    let renderState: GhosttyRenderStateResources | null = null;

    try {
      bindings.setTerminalTheme(terminalHandle, options.theme);
      keyEncoderHandle = bindings.createKeyEncoder();
      mouseEncoderHandle = bindings.createMouseEncoder();
      renderState = createRenderState(bindings);

      return new GhosttyTerminalController(
          bindings,
          terminalHandle,
          keyEncoderHandle,
          mouseEncoderHandle,
          renderState,
          options
        );
    } catch (error) {
      if (renderState) {
        disposeRenderStateResources(renderState);
      }
      if (keyEncoderHandle !== 0) {
        bindings.freeKeyEncoder(keyEncoderHandle);
      }
      if (mouseEncoderHandle !== 0) {
        bindings.freeMouseEncoder(mouseEncoderHandle);
      }
      bindings.freeTerminal(terminalHandle);
      throw error;
    }
  }

  open(container: HTMLElement): void {
    if (this.disposed || this.element) {
      return;
    }

    const root = document.createElement('div');
    root.className = 'xterm';
    root.style.position = 'absolute';
    root.style.inset = '0';
    root.style.overflow = 'hidden';
    root.style.width = '100%';
    root.style.height = '100%';
    root.style.backgroundColor = this.options.theme.background;
    root.style.color = this.options.theme.foreground;
    root.style.fontFamily = this.options.fontFamily;
    root.style.fontSize = `${this.options.fontSize}px`;
    root.style.lineHeight = '1.2';

    const viewport = document.createElement('div');
    viewport.className = 'xterm-viewport';
    viewport.style.width = '100%';
    viewport.style.height = '100%';
    viewport.style.overflow = 'hidden';
    viewport.style.position = 'relative';

    const screen = document.createElement('div');
    screen.className = 'xterm-screen';
    screen.style.width = '100%';
    screen.style.height = '100%';
    screen.style.position = 'relative';
    screen.style.userSelect = 'none';
    screen.style.webkitUserSelect = 'none';
    screen.style.backgroundColor = this.options.theme.background;

    const textarea = document.createElement('div');
    textarea.className = 'xterm-helper-textarea';
    textarea.setAttribute('aria-label', 'Terminal Input');
    textarea.setAttribute('role', 'textbox');
    textarea.setAttribute('contenteditable', 'true');
    textarea.setAttribute('autocorrect', 'off');
    textarea.setAttribute('autocapitalize', 'off');
    textarea.setAttribute('spellcheck', 'false');
    textarea.style.position = 'absolute';
    textarea.style.opacity = '1';
    textarea.style.pointerEvents = 'none';
    textarea.style.left = '0';
    textarea.style.top = '0';
    textarea.style.minWidth = '1px';
    textarea.style.minHeight = '1px';
    textarea.style.whiteSpace = 'pre';
    textarea.style.border = '0';
    textarea.style.padding = '0';
    textarea.style.margin = '0';
    textarea.style.color = this.options.theme.foreground;
    textarea.style.backgroundColor = 'transparent';
    textarea.style.caretColor = 'transparent';
    textarea.style.overflow = 'visible';
    textarea.style.outline = 'none';
    textarea.style.boxShadow = 'none';
    textarea.style.fontFamily = this.options.fontFamily;
    textarea.style.fontSize = `${this.options.fontSize}px`;
    textarea.style.userSelect = 'text';
    textarea.style.webkitUserSelect = 'text';

    const scrollbarTrack = document.createElement('div');
    scrollbarTrack.className = 'xterm-scrollbar-track';
    scrollbarTrack.style.position = 'absolute';
    scrollbarTrack.style.top = '0';
    scrollbarTrack.style.right = '0';
    scrollbarTrack.style.width = '8px';
    scrollbarTrack.style.height = '100%';
    scrollbarTrack.style.backgroundColor = 'transparent';
    scrollbarTrack.style.pointerEvents = 'none';

    const scrollbarThumb = document.createElement('div');
    scrollbarThumb.className = 'xterm-scrollbar-thumb';
    scrollbarThumb.style.position = 'absolute';
    scrollbarThumb.style.top = '0';
    scrollbarThumb.style.right = '0';
    scrollbarThumb.style.width = '6px';
    scrollbarThumb.style.marginRight = '1px';
    scrollbarThumb.style.borderRadius = '3px';
    scrollbarThumb.style.backgroundColor = 'rgba(128, 128, 128, 0.5)';
    scrollbarThumb.style.pointerEvents = 'none';
    scrollbarThumb.style.transition = 'opacity 0.15s ease';
    scrollbarThumb.style.opacity = '0';

    scrollbarTrack.appendChild(scrollbarThumb);

    viewport.appendChild(screen);
    root.appendChild(viewport);
    root.appendChild(textarea);
    root.appendChild(scrollbarTrack);
    container.appendChild(root);

    this.element = root;
    this.screenElement = screen;
    this.textarea = textarea;
    this.scrollbarThumb = scrollbarThumb;
    this.renderer = new CanvasRenderer({
      screenElement: screen,
      theme: this.options.theme,
      fontFamily: this.options.fontFamily,
      fontSize: this.options.fontSize,
    });

    this.syncInputState();
    this.bindDomEvents();
    this.updateCellDimensions();

    const measured = this.measureSizeFromElement();
    if (measured) {
      this.resize(measured.cols, measured.rows);
    } else {
      this.render();
    }
  }

  loadAddon(addon: { activate: (terminal: CompatibleTerminalLike) => void; dispose: () => void }): void {
    addon.activate(this);
    this.addons.add(addon);
  }

  onData(callback: (data: string) => void): TerminalDisposable {
    this.dataListeners.add(callback);
    return {
      dispose: () => {
        this.dataListeners.delete(callback);
      },
    };
  }

  attachCustomKeyEventHandler(callback: (event: KeyboardEvent) => boolean): void {
    this.customKeyEventHandler = callback;
  }

  write(data: string | Uint8Array): void {
    if (this.disposed) {
      return;
    }

    const prevAltScreen = this.isAltScreenActive();
    this.bindings.writeVt(this.terminalHandle, data);
    const nextAltScreen = this.isAltScreenActive();
    if (prevAltScreen && !nextAltScreen) {
      this.clearMouseTrackingModes();
    }
    this.scheduleRender();
  }

  clearMouseTrackingModes(): void {
    if (this.disposed) {
      return;
    }
    for (const mode of MOUSE_TRACKING_MODES) {
      this.bindings.setTerminalMode(this.terminalHandle, mode, false);
    }
    this.bindings.resetMouseEncoder(this.mouseEncoderHandle);
    this.pressedMouseButtons.clear();
    this.mouseDragActive = false;
  }

  private isAltScreenActive(): boolean {
    return (
      this.isModeEnabled(GHOSTTY_MODE_ALT_SCREEN) ||
      this.isModeEnabled(GHOSTTY_MODE_ALT_SCREEN_SAVE)
    );
  }

  reset(): void {
    if (this.disposed) {
      return;
    }

    this.lineCache.clear();
    this.clearSelectionState(false);
    this.bindings.resetTerminal(this.terminalHandle);
    this.scheduleRender();
  }

  refresh(): void {
    if (this.disposed) {
      return;
    }

    this.render();
  }

  resize(cols: number, rows: number): void {
    if (this.disposed) {
      return;
    }

    const nextCols = Math.max(2, Math.floor(cols));
    const nextRows = Math.max(2, Math.floor(rows));
    this.cols = nextCols;
    this.rows = nextRows;
    this.clearSelectionState(false);
    this.bindings.resizeTerminal(this.terminalHandle, nextCols, nextRows, this.cellDimensions());
    this.bindings.resetMouseEncoder(this.mouseEncoderHandle);
    this.scheduleRender();
  }

  scrollLines(amount: number): void {
    if (this.disposed || amount === 0) {
      return;
    }

    this.bindings.scrollViewportDelta(this.terminalHandle, amount);
    this.render();
  }

  scrollToTop(): void {
    if (this.disposed) {
      return;
    }

    this.bindings.scrollViewportTop(this.terminalHandle);
    this.render();
  }

  scrollToBottom(): void {
    if (this.disposed) {
      return;
    }

    this.bindings.scrollViewportBottom(this.terminalHandle);
    this.render();
  }

  exportModeSnapshot(): GhosttyTerminalModeSnapshot {
    return {
      mouseX10: this.isModeEnabled(GHOSTTY_MODE_X10_MOUSE),
      mouseNormal: this.isModeEnabled(GHOSTTY_MODE_NORMAL_MOUSE),
      mouseButton: this.isModeEnabled(GHOSTTY_MODE_BUTTON_MOUSE),
      mouseAny: this.isModeEnabled(GHOSTTY_MODE_ANY_MOUSE),
      mouseUtf8: this.isModeEnabled(1005),
      mouseSgr: this.isModeEnabled(1006),
      mouseSgrPixels: this.isModeEnabled(1016),
      mouseUrxvt: this.isModeEnabled(1015),
      altScroll: this.isModeEnabled(GHOSTTY_MODE_ALT_SCROLL),
      altScreen1047: this.isModeEnabled(GHOSTTY_MODE_ALT_SCREEN),
      altScreen1049: this.isModeEnabled(GHOSTTY_MODE_ALT_SCREEN_SAVE),
    };
  }

  restoreModeSnapshot(snapshot: GhosttyTerminalModeSnapshot): void {
    this.bindings.setTerminalMode(this.terminalHandle, GHOSTTY_MODE_X10_MOUSE, snapshot.mouseX10);
    this.bindings.setTerminalMode(this.terminalHandle, GHOSTTY_MODE_NORMAL_MOUSE, snapshot.mouseNormal);
    this.bindings.setTerminalMode(this.terminalHandle, GHOSTTY_MODE_BUTTON_MOUSE, snapshot.mouseButton);
    this.bindings.setTerminalMode(this.terminalHandle, GHOSTTY_MODE_ANY_MOUSE, snapshot.mouseAny);
    this.bindings.setTerminalMode(this.terminalHandle, 1005, snapshot.mouseUtf8);
    this.bindings.setTerminalMode(this.terminalHandle, 1006, snapshot.mouseSgr);
    this.bindings.setTerminalMode(this.terminalHandle, 1016, snapshot.mouseSgrPixels);
    this.bindings.setTerminalMode(this.terminalHandle, 1015, snapshot.mouseUrxvt);
    this.bindings.setTerminalMode(this.terminalHandle, GHOSTTY_MODE_ALT_SCROLL, snapshot.altScroll);
    this.bindings.setTerminalMode(this.terminalHandle, GHOSTTY_MODE_ALT_SCREEN, snapshot.altScreen1047);
    this.bindings.setTerminalMode(this.terminalHandle, GHOSTTY_MODE_ALT_SCREEN_SAVE, snapshot.altScreen1049);
    this.bindings.resetMouseEncoder(this.mouseEncoderHandle);
  }

  handleViewportGesture(gesture: GhosttyViewportGesture): boolean {
    if (this.disposed || gesture.deltaY === 0) {
      return false;
    }

    const lines = this.gestureToLines(gesture);
    if (lines === 0) {
      return false;
    }

    const routing = this.getInputRoutingState();
    if (routing.mouseReporting) {
      const button = lines < 0 ? GHOSTTY_MOUSE_BUTTON_FOUR : GHOSTTY_MOUSE_BUTTON_FIVE;
      let consumed = false;
      for (let index = 0; index < Math.abs(lines); index += 1) {
        consumed =
          this.emitMouseInput({
            action: 'press',
            button,
            clientX: gesture.clientX,
            clientY: gesture.clientY,
            mods: pointerLikeEventToGhosttyMods(gesture),
            anyButtonPressed: this.pressedMouseButtons.size > 0,
          }) || consumed;
      }
      return consumed;
    }

    if (routing.altScroll) {
      return this.emitAltScrollInput(lines);
    }

    this.scrollLines(lines);
    return true;
  }

  paste(data: string): void {
    if (this.disposed || this.disableStdin || !data) {
      return;
    }

    const encoded = this.bindings.encodePaste(this.terminalHandle, data);
    if (!encoded) {
      return;
    }

    this.emitData(encoded);
  }

  focus(): void {
    this.textarea?.focus({ preventScroll: true });
  }

  getRendererKind(): string {
    return this.renderer?.kind ?? 'unknown';
  }

  setTheme(theme: GhosttyTerminalInitOptions['theme']): void {
    this.bindings.setTerminalTheme(this.terminalHandle, theme);
    this.options.theme = theme;

    if (this.element) {
      this.element.style.backgroundColor = theme.background;
      this.element.style.color = theme.foreground;
    }

    if (this.screenElement) {
      this.screenElement.style.backgroundColor = theme.background;
    }

    this.renderer?.setTheme(theme);
    this.scheduleRender();
  }

  setDisableStdin(disabled: boolean): void {
    this.disableStdin = disabled;
    this.syncInputState();
  }

  measureSizeFromElement(): GhosttyTerminalSize | null {
    const element = this.element;
    if (!element) {
      return null;
    }

    const rect = element.getBoundingClientRect();
    const { width, height } = this.cellDimensions();
    if (rect.width === 0 || rect.height === 0 || width <= 0 || height <= 0) {
      return null;
    }

    return {
      cols: Math.max(2, Math.floor(rect.width / width)),
      rows: Math.max(2, Math.floor(rect.height / height)),
    };
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;

    if (this.renderRaf !== null) {
      cancelAnimationFrame(this.renderRaf);
      this.renderRaf = null;
    }

    this.stopAutoScroll();
    this.updateSelectionTextProbe(null);
    this.clearDomEventListeners();

    if (this.scrollbarFadeTimer) {
      clearTimeout(this.scrollbarFadeTimer);
      this.scrollbarFadeTimer = null;
    }

    for (const addon of this.addons) {
      addon.dispose();
    }
    this.addons.clear();

    this.renderer?.dispose();
    this.renderer = null;

    this.element?.remove();
    this.element = null;
    this.screenElement = null;
    this.textarea = null;
    this.scrollbarThumb = null;

    disposeRenderStateResources(this.renderState);
    this.bindings.freeMouseEncoder(this.mouseEncoderHandle);
    this.bindings.freeKeyEncoder(this.keyEncoderHandle);
    this.bindings.freeTerminal(this.terminalHandle);
  }

  private cellDimensions(): GhosttyCellDimensions {
    return this._core._renderService.dimensions.css.cell;
  }

  private syncInputState(): void {
    if (!this.textarea) {
      return;
    }

    (this.textarea as any).readOnly = this.disableStdin;
    this.textarea.tabIndex = this.disableStdin ? -1 : 0;
    if (this.disableStdin && document.activeElement === this.textarea) {
      this.textarea.blur();
    }
  }

  private bindDomEvents(): void {
    const root = this.element;
    const textarea = this.textarea;
    if (!root || !textarea) {
      return;
    }

    root.addEventListener('click', () => {
      if (!this.disableStdin) {
        this.focus();
      }
    });

    const selectSurface = this.screenElement ?? root;
    selectSurface.addEventListener('mousedown', (event) => {
      if (!(event instanceof MouseEvent)) {
        return;
      }

      if (!this.disableStdin) {
        this.focus();
      }

      if (this.getInputRoutingState().mouseReporting) {
        const button = this.mouseButtonFromEvent(event);
        if (button === null) {
          return;
        }
        this.clearSelectionState();
        this.pressedMouseButtons.add(button);
        this.mouseDragActive = true;
        this.emitMouseInput({
          action: 'press',
          button,
          clientX: event.clientX,
          clientY: event.clientY,
          mods: pointerLikeEventToGhosttyMods(event),
          anyButtonPressed: true,
        });
        event.preventDefault();
        return;
      }

      if (event.button !== 0) {
        return;
      }

      this.mouseDragActive = true;
      this.beginPointerSelection(event);
      event.preventDefault();
    });

    root.addEventListener(
      'wheel',
      (event) => {
        if (
          this.handleViewportGesture({
            source: 'wheel',
            deltaY: event.deltaY,
            deltaMode: event.deltaMode,
            clientX: event.clientX,
            clientY: event.clientY,
            shiftKey: event.shiftKey,
            ctrlKey: event.ctrlKey,
            altKey: event.altKey,
            metaKey: event.metaKey,
          })
        ) {
          event.preventDefault();
        }
      },
      { passive: false }
    );

    const dragEventTarget =
      typeof window !== 'undefined' && typeof window.addEventListener === 'function'
        ? window
        : null;
    if (dragEventTarget) {
      const moveListener = (event: MouseEvent) => {
        if (!this.mouseDragActive) {
          return;
        }
        if (this.getInputRoutingState().mouseReporting) {
          this.emitMouseInput({
            action: 'motion',
            button: this.mouseButtonFromButtons(event.buttons),
            clientX: event.clientX,
            clientY: event.clientY,
            mods: pointerLikeEventToGhosttyMods(event),
            anyButtonPressed: this.pressedMouseButtons.size > 0 || event.buttons > 0,
          });
          return;
        }
        this.updatePointerSelection(event);
      };
      const upListener = (event: MouseEvent) => {
        if (!this.mouseDragActive) {
          return;
        }
        this.mouseDragActive = false;
        if (this.getInputRoutingState().mouseReporting) {
          const button = this.mouseButtonFromEvent(event);
          if (button !== null) {
            this.pressedMouseButtons.delete(button);
          }
          this.emitMouseInput({
            action: 'release',
            button,
            clientX: event.clientX,
            clientY: event.clientY,
            mods: pointerLikeEventToGhosttyMods(event),
            anyButtonPressed: this.pressedMouseButtons.size > 0,
          });
          return;
        }
        this.finishPointerSelection(event);
      };
      dragEventTarget.addEventListener('mousemove', moveListener);
      dragEventTarget.addEventListener('mouseup', upListener);
      this.domEventDisposers.push(() => {
        dragEventTarget.removeEventListener('mousemove', moveListener);
        dragEventTarget.removeEventListener('mouseup', upListener);
      });
    }

    textarea.addEventListener('keydown', (event) => {
      const selectionText = this.getSelectionText();
      if (selectionText && isCopyShortcut(event)) {
        this.copyShortcutSuppressed = true;
        event.preventDefault();
        void writeSelectionToClipboard(selectionText).catch(() => {});
        this.clearTextarea();
        return;
      }

      if (!this.customKeyEventHandler(event)) {
        return;
      }

      if (this.disableStdin || this.imeIsComposing) {
        return;
      }

      if (event.keyCode === 229) {
        return;
      }

      if (!shouldEncodeOnKeyDown(event)) {
        return;
      }

      const payload = this.encodeKeyboardEvent(event, event.repeat ? 'repeat' : 'press');
      if (!payload) {
        return;
      }

      event.preventDefault();
      this.emitData(payload);
      this.clearTextarea();
    });

    textarea.addEventListener('keyup', (event) => {
      if (this.copyShortcutSuppressed) {
        const key = event.key.toLowerCase();
        if (key === 'c') {
          event.preventDefault();
          return;
        }

        if (key === 'control' || key === 'meta' || key === 'os') {
          this.copyShortcutSuppressed = false;
          event.preventDefault();
          return;
        }
      }

      if (this.disableStdin || this.imeIsComposing) {
        return;
      }

      const payload = this.encodeKeyboardEvent(event, 'release');
      if (!payload) {
        return;
      }

      event.preventDefault();
      this.emitData(payload);
      this.clearTextarea();
    });

    textarea.addEventListener('compositionstart', () => {
      this.imeIsComposing = true;
      this.lastCompositionCommit = null;
      this.syncTextareaPositionToCursor();
    });

    textarea.addEventListener('compositionupdate', () => {
      this.syncTextareaPositionToCursor();
    });

    textarea.addEventListener('compositionend', (event) => {
      this.imeIsComposing = false;
      const finalData = event.data ?? '';
      if (finalData) {
        this.lastCompositionCommit = { data: finalData, at: Date.now() };
        this.emitData(finalData);
        this.clearTextarea();
      }
    });

    textarea.addEventListener('beforeinput', (event) => {
      if (this.disableStdin) {
        return;
      }

      if (event.inputType === 'insertFromPaste') {
        return;
      }

      const data = event.data ?? '';
      if (!data) {
        return;
      }

      if (event.isComposing || this.imeIsComposing) {
        return;
      }

      const recentCompositionCommit = this.lastCompositionCommit;
      if (
        recentCompositionCommit &&
        recentCompositionCommit.data === data &&
        Date.now() - recentCompositionCommit.at < 40
      ) {
        this.lastCompositionCommit = null;
        event.preventDefault();
        this.clearTextarea();
        return;
      }

      this.lastCompositionCommit = null;

      event.preventDefault();
      this.emitData(data);
      this.clearTextarea();
    });

    textarea.addEventListener('paste', (event) => {
      if (this.disableStdin) {
        return;
      }

      const text = event.clipboardData?.getData('text/plain') ?? '';
      if (!text) {
        return;
      }

      event.preventDefault();
      this.paste(text);
      this.clearTextarea();
    });

    textarea.addEventListener('copy', (event) => {
      const selectionText = this.getSelectionText();
      if (!selectionText) {
        return;
      }

      writeSelectionToCopyEvent(event, selectionText);
    });

    textarea.addEventListener('input', () => {
      if (this.disableStdin || this.imeIsComposing) {
        return;
      }

      const data = textarea.textContent ?? '';
      if (!data) {
        this.clearTextarea();
        return;
      }

      const recentCompositionCommit = this.lastCompositionCommit;
      if (
        recentCompositionCommit &&
        recentCompositionCommit.data === data &&
        Date.now() - recentCompositionCommit.at < 40
      ) {
        this.lastCompositionCommit = null;
        this.clearTextarea();
        return;
      }

      this.lastCompositionCommit = null;
      this.emitData(data);
      this.clearTextarea();
    });
  }

  private encodeKeyboardEvent(
    event: KeyboardEvent,
    action: 'press' | 'repeat' | 'release'
  ): string | null {
    const keyCode = getGhosttyKeyCode(event.code);
    if (keyCode === 0) {
      return null;
    }

    const utf8 =
      event.key.length === 1 && !event.ctrlKey && !event.metaKey ? event.key : null;

    return this.bindings.encodeKeyEvent(this.keyEncoderHandle, this.terminalHandle, {
      action,
      keyCode,
      mods: keyboardEventToGhosttyMods(event),
      composing: event.isComposing,
      utf8,
      unshiftedCodepoint: getUnshiftedCodepoint(event.code),
    });
  }

  private getInputRoutingState(): InputRoutingState {
    const mouseReporting =
      this.isModeEnabled(GHOSTTY_MODE_X10_MOUSE) ||
      this.isModeEnabled(GHOSTTY_MODE_NORMAL_MOUSE) ||
      this.isModeEnabled(GHOSTTY_MODE_BUTTON_MOUSE) ||
      this.isModeEnabled(GHOSTTY_MODE_ANY_MOUSE);
    const altScreen =
      this.isModeEnabled(GHOSTTY_MODE_ALT_SCREEN) ||
      this.isModeEnabled(GHOSTTY_MODE_ALT_SCREEN_SAVE);

    return {
      mouseReporting,
      altScroll: !mouseReporting && altScreen && this.isModeEnabled(GHOSTTY_MODE_ALT_SCROLL),
    };
  }

  private gestureToLines(gesture: GhosttyViewportGesture): number {
    const cellHeight = this.cellDimensions().height || DEFAULT_CELL_HEIGHT;

    if (gesture.source === 'wheel') {
      if (gesture.deltaMode === 1) {
        this.wheelPixelDelta = 0;
        return gesture.deltaY > 0 ? Math.ceil(gesture.deltaY) : Math.floor(gesture.deltaY);
      }

      if (gesture.deltaMode === 2) {
        this.wheelPixelDelta = 0;
        const pageLines = Math.max(1, this.rows);
        const scaled = gesture.deltaY * pageLines;
        return scaled > 0 ? Math.ceil(scaled) : Math.floor(scaled);
      }

      this.wheelPixelDelta += gesture.deltaY;
      const lines =
        this.wheelPixelDelta > 0
          ? Math.floor(this.wheelPixelDelta / cellHeight)
          : Math.ceil(this.wheelPixelDelta / cellHeight);
      if (lines !== 0) {
        this.wheelPixelDelta -= lines * cellHeight;
      }
      return lines;
    }

    return gesture.deltaY > 0
      ? Math.ceil(gesture.deltaY / cellHeight)
      : Math.floor(gesture.deltaY / cellHeight);
  }

  private isModeEnabled(mode: number): boolean {
    return this.bindings.isTerminalModeEnabled(this.terminalHandle, mode);
  }

  private mouseButtonFromEvent(event: MouseEvent): number | null {
    switch (event.button) {
      case 0:
        return GHOSTTY_MOUSE_BUTTON_LEFT;
      case 1:
        return GHOSTTY_MOUSE_BUTTON_MIDDLE;
      case 2:
        return GHOSTTY_MOUSE_BUTTON_RIGHT;
      default:
        return null;
    }
  }

  private mouseButtonFromButtons(buttons: number): number | null {
    if (buttons & 1) {
      return GHOSTTY_MOUSE_BUTTON_LEFT;
    }
    if (buttons & 4) {
      return GHOSTTY_MOUSE_BUTTON_MIDDLE;
    }
    if (buttons & 2) {
      return GHOSTTY_MOUSE_BUTTON_RIGHT;
    }

    return null;
  }

  private pointerPositionFromClient(clientX: number, clientY: number): { x: number; y: number } | null {
    const rect = this.screenElement?.getBoundingClientRect();
    if (!rect) {
      return null;
    }

    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);
    return {
      x: Math.max(0, Math.min(width - 1, clientX - rect.left)),
      y: Math.max(0, Math.min(height - 1, clientY - rect.top)),
    };
  }

  private emitMouseInput(options: {
    action: 'press' | 'release' | 'motion';
    button?: number | null;
    clientX: number;
    clientY: number;
    mods: number;
    anyButtonPressed: boolean;
  }): boolean {
    if (this.disableStdin) {
      return false;
    }

    const position = this.pointerPositionFromClient(options.clientX, options.clientY);
    if (!position) {
      return false;
    }

    const cell = this.cellDimensions();
    const rect = this.screenElement?.getBoundingClientRect();
    if (!rect) {
      return false;
    }

    const payload = this.bindings.encodeMouseEvent(this.mouseEncoderHandle, this.terminalHandle, {
      action: options.action,
      button: options.button,
      mods: options.mods,
      x: position.x,
      y: position.y,
      anyButtonPressed: options.anyButtonPressed,
      screenWidth: Math.max(1, Math.round(rect.width)),
      screenHeight: Math.max(1, Math.round(rect.height)),
      cellWidth: Math.max(1, Math.round(cell.width || DEFAULT_CELL_WIDTH)),
      cellHeight: Math.max(1, Math.round(cell.height || DEFAULT_CELL_HEIGHT)),
    });
    if (!payload) {
      return false;
    }

    this.emitData(payload);
    return true;
  }

  private emitAltScrollInput(lines: number): boolean {
    const keyCode = getGhosttyKeyCode(lines < 0 ? 'ArrowUp' : 'ArrowDown');
    if (keyCode === 0) {
      return false;
    }

    let consumed = false;
    for (let index = 0; index < Math.abs(lines); index += 1) {
      const payload = this.bindings.encodeKeyEvent(this.keyEncoderHandle, this.terminalHandle, {
        action: 'press',
        keyCode,
        mods: 0,
        composing: false,
        utf8: null,
        unshiftedCodepoint: null,
      });
      if (!payload) {
        continue;
      }
      this.emitData(payload);
      consumed = true;
    }

    return consumed;
  }

  private emitData(data: string): void {
    for (const listener of this.dataListeners) {
      listener(data);
    }
  }

  private clearTextarea(): void {
    if (this.textarea) {
      this.textarea.textContent = '';
    }
  }

  private syncTextareaPositionToCursor(): void {
    const textarea = this.textarea;
    const screen = this.screenElement;
    if (!textarea || !screen) {
      return;
    }

    const { width, height } = this.cellDimensions();
    if (width <= 0 || height <= 0) {
      return;
    }

    const renderState = createRenderState(this.bindings);
    let cursorX = 0;
    let cursorY = 0;
    try {
      updateRenderState(renderState, this.terminalHandle);
      const meta = readRenderSnapshotMeta(renderState);
      if (meta.cursor.x !== null && meta.cursor.y !== null) {
        cursorX = meta.cursor.x;
        cursorY = meta.cursor.y;
      }
    } finally {
      disposeRenderStateResources(renderState);
    }

    const left = cursorX * width;
    const top = cursorY * height;

    textarea.style.left = `${left}px`;
    textarea.style.top = `${top}px`;
    textarea.style.width = `${Math.max(1, width)}px`;
    textarea.style.height = `${Math.max(1, height)}px`;
    textarea.style.lineHeight = `${height}px`;
    textarea.style.fontFamily = this.options.fontFamily;
    textarea.style.fontSize = `${this.options.fontSize}px`;
  }

  private scheduleRender(): void {
    if (this.renderRaf !== null) {
      return;
    }

    this.renderRaf = requestAnimationFrame(() => {
      this.renderRaf = null;
      this.render();
    });
  }

  private render(): void {
    if (this.disposed || !this.screenElement || !this.renderer) {
      return;
    }

    const scrollbar = this.bindings.readScrollbar(this.terminalHandle);
    const viewportRows = Math.max(1, scrollbar.len || this.rows);

    updateRenderState(this.renderState, this.terminalHandle);
    const meta = readRenderSnapshotMeta(this.renderState);
    const rows = Array.from(iterateRows(this.renderState));

    this.cols = Math.max(2, meta.cols);
    this.rows = Math.max(2, meta.rows || viewportRows);
    this.lastViewportOffset = scrollbar.offset;
    this.lastViewportRows = this.rows;
    this.lastRenderedRows = rows;

    for (const row of rows) {
      this.lineCache.set(scrollbar.offset + row.y, row.text);
    }

    const selectionRects = projectSelectionRects(
      this.selectionState,
      this.lastViewportOffset,
      this.lastViewportRows,
      (line) => this.getLineText(line)
    );
    const selectionText = this.getSelectionText();

    this.renderer.render({
      meta,
      rows,
      cellDimensions: this.cellDimensions(),
      selectionRects,
      selectionColor: this.options.theme.selectionBackground,
    });

    const visibleLines = normalizeVisibleLines(rows, this.rows);
    const baseY = Math.max(0, scrollbar.total - scrollbar.len);
    this.buffer.setViewport(scrollbar.offset, baseY, scrollbar.total, visibleLines);
    this.updateSelectionTextProbe(selectionText);
    this.updateScrollbar(scrollbar);
  }

  private updateScrollbar(scrollbar: { total: number; offset: number; len: number }): void {
    const thumb = this.scrollbarThumb;
    if (!thumb) {
      return;
    }

    const trackHeight = this.screenElement?.clientHeight ?? 0;
    if (trackHeight === 0 || scrollbar.total <= scrollbar.len) {
      thumb.style.opacity = '0';
      return;
    }

    const ratio = scrollbar.len / scrollbar.total;
    const thumbHeight = Math.max(20, ratio * trackHeight);
    const scrollRatio = scrollbar.offset / Math.max(1, scrollbar.total - scrollbar.len);
    const thumbTop = scrollRatio * (trackHeight - thumbHeight);

    thumb.style.height = `${thumbHeight}px`;
    thumb.style.transform = `translateY(${thumbTop}px)`;
    thumb.style.opacity = '1';

    if (this.scrollbarFadeTimer) {
      clearTimeout(this.scrollbarFadeTimer);
    }
    this.scrollbarFadeTimer = setTimeout(() => {
      thumb.style.opacity = '0';
    }, 800);
  }

  private updateCellDimensions(): void {
    if (!this.element) {
      return;
    }

    const probe = document.createElement('span');
    probe.textContent = 'WWWWWWWWWW';
    probe.style.position = 'absolute';
    probe.style.visibility = 'hidden';
    probe.style.whiteSpace = 'pre';
    probe.style.fontFamily = this.options.fontFamily;
    probe.style.fontSize = `${this.options.fontSize}px`;
    probe.style.lineHeight = '1.2';

    this.element.appendChild(probe);
    const rect = probe.getBoundingClientRect();
    probe.remove();

    this._core._renderService.dimensions.css.cell.width =
      rect.width > 0 ? rect.width / 10 : DEFAULT_CELL_WIDTH;
    this._core._renderService.dimensions.css.cell.height =
      rect.height > 0 ? rect.height : DEFAULT_CELL_HEIGHT;
  }

  private clearSelectionState(repaint = true): void {
    this.selectionState = resetSelectionData();
    this.pressedMouseButtons.clear();
    this.wheelPixelDelta = 0;
    this.pointerDrag = {
      active: false,
      moved: false,
      mode: 'character',
      lastClientX: null,
      lastClientY: null,
    };
    this.copyShortcutSuppressed = false;
    this.stopAutoScroll();
    this.updateSelectionTextProbe(null);

    if (repaint && this.screenElement && this.renderer) {
      this.render();
    }
  }

  private beginPointerSelection(event: MouseEvent): void {
    const point = this.hitTest(event.clientX, event.clientY);
    if (!point) {
      return;
    }

    const mode = this.selectionModeFromClickDetail(event.detail);
    this.pointerDrag = {
      active: true,
      moved: false,
      mode,
      lastClientX: event.clientX,
      lastClientY: event.clientY,
    };
    this.selectionState = resolvePointerSelection(
      this.selectionState,
      {
        ...point,
        mode,
      },
      (line) => this.getLineText(line)
    );
    this.updateAutoScroll();
    this.render();
  }

  private updatePointerSelection(event: MouseEvent): void {
    if (!this.pointerDrag.active) {
      return;
    }

    const point = this.hitTest(event.clientX, event.clientY);
    this.pointerDrag.lastClientX = event.clientX;
    this.pointerDrag.lastClientY = event.clientY;

    if (point) {
      this.pointerDrag.moved = true;
      this.selectionState = updateSelectionFocus(this.selectionState, point, (line) =>
        this.getLineText(line)
      );
      this.render();
    }

    this.updateAutoScroll();
  }

  private finishPointerSelection(event: MouseEvent): void {
    if (!this.pointerDrag.active || event.button !== 0) {
      return;
    }

    this.pointerDrag.lastClientX = event.clientX;
    this.pointerDrag.lastClientY = event.clientY;
    this.stopAutoScroll();

    const shouldClear =
      this.pointerDrag.mode === 'character' &&
      !this.pointerDrag.moved &&
      this.selectionState.anchor?.line === this.selectionState.focus?.line &&
      this.selectionState.anchor?.col === this.selectionState.focus?.col;
    this.pointerDrag.active = false;

    if (shouldClear) {
      this.clearSelectionState();
      return;
    }

    this.render();
  }

  private selectionModeFromClickDetail(detail: number): SelectionMode {
    if (detail >= 3) {
      return 'line';
    }
    if (detail === 2) {
      return 'word';
    }
    return 'character';
  }

  private hitTest(clientX: number, clientY: number): SelectionPoint | null {
    const rect = this.screenElement?.getBoundingClientRect();
    if (!rect) {
      return null;
    }

    const { width, height } = this.cellDimensions();
    if (width <= 0 || height <= 0) {
      return null;
    }

    const relativeX = clientX - rect.left;
    const relativeY = clientY - rect.top;
    const maxCol = Math.max(this.cols - 1, 0);
    const maxRow = Math.max(this.lastViewportRows - 1, 0);
    const col = Math.max(0, Math.min(maxCol, Math.floor(relativeX / width)));
    const row = Math.max(0, Math.min(maxRow, Math.floor(relativeY / height)));

    return {
      line: this.lastViewportOffset + row,
      col,
    };
  }

  private getLineText(line: number): string {
    const cached = this.lineCache.get(line);
    if (typeof cached === 'string') {
      return cached;
    }

    const visibleIndex = line - this.lastViewportOffset;
    const visibleRow = this.lastRenderedRows[visibleIndex];
    return visibleRow?.text ?? '';
  }

  private getSelectionText(): string | null {
    if (!hasSelection(this.selectionState)) {
      return null;
    }

    return serializeSelectionText(this.selectionState, (line) => this.getLineText(line));
  }

  private updateSelectionTextProbe(value: string | null): void {
    (globalThis as { __tmexE2eTerminalSelectionText?: string | null }).__tmexE2eTerminalSelectionText =
      value;
  }

  private updateAutoScroll(): void {
    if (!this.pointerDrag.active || this.pointerDrag.lastClientY === null) {
      this.stopAutoScroll();
      return;
    }

    const rect = this.screenElement?.getBoundingClientRect();
    if (!rect) {
      this.stopAutoScroll();
      return;
    }

    const outsideViewport =
      this.pointerDrag.lastClientY < rect.top || this.pointerDrag.lastClientY > rect.bottom;
    if (!outsideViewport) {
      this.stopAutoScroll();
      return;
    }

    if (this.autoScrollTimer !== null) {
      return;
    }

    this.autoScrollTimer = setInterval(() => {
      this.stepAutoScroll();
    }, AUTO_SCROLL_INTERVAL_MS);
  }

  private stepAutoScroll(): void {
    if (!this.pointerDrag.active || this.pointerDrag.lastClientX === null || this.pointerDrag.lastClientY === null) {
      this.stopAutoScroll();
      return;
    }

    const rect = this.screenElement?.getBoundingClientRect();
    if (!rect) {
      this.stopAutoScroll();
      return;
    }

    let delta = 0;
    if (this.pointerDrag.lastClientY < rect.top) {
      delta = -1;
    } else if (this.pointerDrag.lastClientY > rect.bottom) {
      delta = 1;
    }

    if (delta === 0) {
      this.stopAutoScroll();
      return;
    }

    this.bindings.scrollViewportDelta(this.terminalHandle, delta);
    this.render();

    const point = this.hitTest(this.pointerDrag.lastClientX, this.pointerDrag.lastClientY);
    if (!point) {
      return;
    }

    this.selectionState = updateSelectionFocus(this.selectionState, point, (line) =>
      this.getLineText(line)
    );
    this.pointerDrag.moved = true;
    this.render();
  }

  private stopAutoScroll(): void {
    if (this.autoScrollTimer === null) {
      return;
    }

    clearInterval(this.autoScrollTimer);
    this.autoScrollTimer = null;
  }

  private clearDomEventListeners(): void {
    while (this.domEventDisposers.length > 0) {
      const dispose = this.domEventDisposers.pop();
      dispose?.();
    }
  }
}

export async function createTerminalController(
  options: GhosttyTerminalInitOptions
): Promise<GhosttyTerminalController> {
  return GhosttyTerminalController.create(options);
}

export { TERMINAL_ENGINE };
