import { afterEach, describe, expect, mock, test } from 'bun:test';
import type { GhosttyTheme } from './types';

type FakeEvent = {
  type: string;
  data?: string;
  preventDefault?: () => void;
};

type EventListener = (event: FakeEvent) => void;
type RafCallback = (timestamp: number) => void;

class FakeCanvasContext2D {
  fillStyle = '';
  strokeStyle = '';
  font = '';
  lineWidth = 1;
  textBaseline = 'top';
  imageSmoothingEnabled = false;
  globalAlpha = 1;
  operations: Array<Record<string, unknown>> = [];

  clearRect(x: number, y: number, width: number, height: number): void {
    this.operations.push({ type: 'clearRect', x, y, width, height });
  }

  fillRect(x: number, y: number, width: number, height: number): void {
    this.operations.push({
      type: 'fillRect',
      x,
      y,
      width,
      height,
      fillStyle: this.fillStyle,
      globalAlpha: this.globalAlpha,
    });
  }

  fillText(text: string, x: number, y: number): void {
    this.operations.push({
      type: 'fillText',
      text,
      x,
      y,
      fillStyle: this.fillStyle,
      font: this.font,
    });
  }

  strokeRect(x: number, y: number, width: number, height: number): void {
    this.operations.push({
      type: 'strokeRect',
      x,
      y,
      width,
      height,
      strokeStyle: this.strokeStyle,
    });
  }

  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    this.operations.push({ type: 'setTransform', a, b, c, d, e, f });
  }
}

class FakeElement {
  tagName: string;
  ownerDocument: FakeDocument;
  parentElement: FakeElement | null = null;
  children: FakeElement[] = [];
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  className = '';
  textContent = '';
  innerHTML = '';
  value = '';
  readOnly = false;
  tabIndex = 0;
  spellcheck = false;
  autocapitalize = '';
  autocomplete = '';
  attributes = new Map<string, string>();
  private rect = { width: 0, height: 0, left: 0, top: 0 };
  private listeners = new Map<string, EventListener[]>();

  constructor(tagName: string, ownerDocument: FakeDocument) {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
  }

  appendChild(child: FakeElement): FakeElement {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  remove(): void {
    if (!this.parentElement) {
      return;
    }

    this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
    this.parentElement = null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatchEvent(event: FakeEvent): void {
    const listeners = this.listeners.get(event.type) ?? [];
    for (const listener of listeners) {
      listener(event);
    }
  }

  focus(): void {
    this.ownerDocument.activeElement = this;
  }

  blur(): void {
    if (this.ownerDocument.activeElement === this) {
      this.ownerDocument.activeElement = null;
    }
  }

  getBoundingClientRect(): { width: number; height: number; left: number; top: number } {
    return this.rect;
  }

  setBoundingClientRect(rect: { width: number; height: number; left?: number; top?: number }): void {
    this.rect = {
      width: rect.width,
      height: rect.height,
      left: rect.left ?? 0,
      top: rect.top ?? 0,
    };
  }
}

class FakeCanvasElement extends FakeElement {
  width = 0;
  height = 0;
  readonly context = new FakeCanvasContext2D();

  getContext(_kind: string): Record<string, unknown> {
    return this.context;
  }
}

class FakeDocument {
  activeElement: FakeElement | null = null;
  body: FakeElement;

  constructor() {
    this.body = new FakeElement('body', this);
  }

  createElement(tagName: string): FakeElement {
    if (tagName.toLowerCase() === 'canvas') {
      return new FakeCanvasElement(tagName, this);
    }

    return new FakeElement(tagName, this);
  }
}

type FakeBindings = {
  createTerminal: (...args: any[]) => number;
  setTerminalTheme: (...args: any[]) => void;
  createKeyEncoder: () => number;
  freeKeyEncoder: (...args: any[]) => void;
  freeTerminal: (...args: any[]) => void;
  resizeTerminal: (...args: any[]) => void;
  writeVt: (...args: any[]) => void;
  resetTerminal: (...args: any[]) => void;
  readScrollbar: (...args: any[]) => { total: number; offset: number; len: number };
  scrollViewportDelta: (...args: any[]) => void;
  scrollViewportTop: (...args: any[]) => void;
  scrollViewportBottom: (...args: any[]) => void;
  encodePaste: (...args: any[]) => string;
  encodeKeyEvent: (...args: any[]) => string;
  formatViewport: (...args: any[]) => string;
  formatViewportCalls: number;
};

function findElementsByTag(root: FakeElement | null, tagName: string): FakeElement[] {
  if (!root) {
    return [];
  }

  const results: FakeElement[] = [];
  const target = tagName.toUpperCase();
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }

    if (current.tagName === target) {
      results.push(current);
    }

    stack.push(...current.children);
  }

  return results;
}

function findCanvasByLayer(root: FakeElement | null, layer: string): FakeCanvasElement | null {
  return (
    findElementsByTag(root, 'canvas').find(
      (element) => (element as FakeCanvasElement).dataset.layer === layer
    ) as FakeCanvasElement | undefined
  ) ?? null;
}

function createFakeBindings(): FakeBindings {
  let formatViewportCalls = 0;

  return {
    createTerminal: () => 1,
    setTerminalTheme: () => {},
    createKeyEncoder: () => 2,
    freeKeyEncoder: () => {},
    freeTerminal: () => {},
    resizeTerminal: () => {},
    writeVt: () => {},
    resetTerminal: () => {},
    readScrollbar: () => ({ total: 24, offset: 0, len: 24 }),
    scrollViewportDelta: () => {},
    scrollViewportTop: () => {},
    scrollViewportBottom: () => {},
    encodePaste: () => '',
    encodeKeyEvent: () => '',
    formatViewport: () => {
      formatViewportCalls += 1;
      return '';
    },
    get formatViewportCalls() {
      return formatViewportCalls;
    },
  };
}

function installFakeDom(): {
  document: FakeDocument;
  flushAnimationFrames: () => Promise<void>;
  pendingAnimationFrames: () => number;
  cancelledFrames: number[];
  restore: () => void;
} {
  const document = new FakeDocument();
  const previousDocument = (globalThis as any).document;
  const previousWindow = (globalThis as any).window;
  const previousNavigator = (globalThis as any).navigator;
  const previousHTMLElement = (globalThis as any).HTMLElement;
  const previousHTMLCanvasElement = (globalThis as any).HTMLCanvasElement;
  const previousHTMLTextAreaElement = (globalThis as any).HTMLTextAreaElement;
  const previousHTMLDivElement = (globalThis as any).HTMLDivElement;
  const previousRequestAnimationFrame = globalThis.requestAnimationFrame;
  const previousCancelAnimationFrame = globalThis.cancelAnimationFrame;

  const rafQueue = new Map<number, RafCallback>();
  const cancelledFrames: number[] = [];
  let nextAnimationFrameId = 1;

  (globalThis as any).document = document;
  (globalThis as any).window = globalThis;
  (globalThis as any).navigator = {
    clipboard: {
      readText: async () => '',
      writeText: async () => {},
    },
  };
  (globalThis as any).HTMLElement = FakeElement;
  (globalThis as any).HTMLCanvasElement = FakeCanvasElement;
  (globalThis as any).HTMLTextAreaElement = FakeElement;
  (globalThis as any).HTMLDivElement = FakeElement;
  globalThis.requestAnimationFrame = ((callback: RafCallback) => {
    const id = nextAnimationFrameId;
    nextAnimationFrameId += 1;
    rafQueue.set(id, callback);
    return id;
  }) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((id: number) => {
    cancelledFrames.push(id);
    rafQueue.delete(id);
  }) as typeof cancelAnimationFrame;

  return {
    document,
    async flushAnimationFrames(): Promise<void> {
      const queued = [...rafQueue.entries()];
      rafQueue.clear();
      for (const [id, callback] of queued) {
        if (!cancelledFrames.includes(id)) {
          callback(0);
        }
      }
    },
    pendingAnimationFrames(): number {
      return rafQueue.size;
    },
    cancelledFrames,
    restore(): void {
      (globalThis as any).document = previousDocument;
      (globalThis as any).window = previousWindow;
      (globalThis as any).navigator = previousNavigator;
      (globalThis as any).HTMLElement = previousHTMLElement;
      (globalThis as any).HTMLCanvasElement = previousHTMLCanvasElement;
      (globalThis as any).HTMLTextAreaElement = previousHTMLTextAreaElement;
      (globalThis as any).HTMLDivElement = previousHTMLDivElement;
      globalThis.requestAnimationFrame = previousRequestAnimationFrame;
      globalThis.cancelAnimationFrame = previousCancelAnimationFrame;
    },
  };
}

function installLocalFileFetch(): () => void {
  const previousFetch = globalThis.fetch;
  (globalThis as any).fetch = async (input: RequestInfo | URL) => {
    return new Response(Bun.file(String(input)));
  };

  return () => {
    (globalThis as any).fetch = previousFetch;
  };
}

async function loadControllerModule(bindings: FakeBindings, version: number) {
  mock.restore();
  mock.module('./ghostty-wasm', () => {
    return {
      keyboardEventToGhosttyMods: () => 0,
      getGhosttyBindings: async () => bindings,
    };
  });
  mock.module('./render-state', () => {
    const rows = Array.from({ length: 24 }, (_, index) => ({
      y: index,
      dirty: true,
      wrap: false,
      wrapContinuation: false,
      text: index === 0 ? 'mock-canvas-line' : '',
      cells: index === 0
        ? [
            {
              x: 0,
              text: 'mock-canvas-line',
              codepoints: Array.from('mock-canvas-line').map((char) => char.codePointAt(0) ?? 32),
              widthKind: 'narrow',
              hasText: true,
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
            },
          ]
        : [],
    }));

    return {
      createRenderState: () => ({
        snapshotVersion: 0,
        disposed: false,
      }),
      updateRenderState: (state: { snapshotVersion: number }) => {
        state.snapshotVersion += 1;
      },
      readRenderSnapshotMeta: () => ({
        cols: 80,
        rows: 24,
        dirty: 'full',
        colors: {
          background: { r: 17, g: 17, b: 17 },
          foreground: { r: 238, g: 238, b: 238 },
          cursor: null,
          palette: Array.from({ length: 256 }, () => ({ r: 0, g: 0, b: 0 })),
        },
        cursor: {
          style: 'block',
          visible: false,
          blinking: false,
          passwordInput: false,
          x: null,
          y: null,
          wideTail: false,
        },
      }),
      iterateRows: function* () {
        yield* rows;
      },
      disposeRenderStateResources: (state: { disposed: boolean }) => {
        state.disposed = true;
      },
    };
  });

  return import(`./terminal.ts?controller=${version}`);
}

const TEST_THEME: GhosttyTheme = {
  background: '#111111',
  foreground: '#eeeeee',
  cursor: '#ffffff',
  selectionBackground: '#334455',
  black: '#000000',
  red: '#aa0000',
  green: '#00aa00',
  yellow: '#aa5500',
  blue: '#0000aa',
  magenta: '#aa00aa',
  cyan: '#00aaaa',
  white: '#aaaaaa',
  brightBlack: '#555555',
  brightRed: '#ff5555',
  brightGreen: '#55ff55',
  brightYellow: '#ffff55',
  brightBlue: '#5555ff',
  brightMagenta: '#ff55ff',
  brightCyan: '#55ffff',
  brightWhite: '#ffffff',
};

describe('GhosttyTerminalController canvas baseline', () => {
  let dom: ReturnType<typeof installFakeDom> | null = null;
  let importVersion = 0;

  afterEach(() => {
    dom?.restore();
    dom = null;
    mock.restore();
  });

  test('open should render through canvas without formatter fallback', async () => {
    dom = installFakeDom();
    const bindings = createFakeBindings();
    importVersion += 1;
    const { createTerminalController } = await loadControllerModule(bindings, importVersion);
    const terminal = await createTerminalController({
      theme: TEST_THEME,
      fontFamily: 'monospace',
      fontSize: 13,
      scrollback: 1000,
    });
    const container = dom.document.createElement('div');
    container.setBoundingClientRect({ width: 960, height: 480 });
    dom.document.body.appendChild(container);

    terminal.open(container as unknown as HTMLElement);
    terminal.write('printf "hello"');
    await dom.flushAnimationFrames();

    expect(findElementsByTag(terminal.element as unknown as FakeElement, 'canvas').length).toBeGreaterThan(0);
    expect(bindings.formatViewportCalls).toBe(0);
  });

  test('dispose should cancel queued render frames and remove helper textarea', async () => {
    dom = installFakeDom();
    const bindings = createFakeBindings();
    importVersion += 1;
    const { createTerminalController } = await loadControllerModule(bindings, importVersion);
    const terminal = await createTerminalController({
      theme: TEST_THEME,
      fontFamily: 'monospace',
      fontSize: 13,
      scrollback: 1000,
    });
    const container = dom.document.createElement('div');
    container.setBoundingClientRect({ width: 960, height: 480 });
    dom.document.body.appendChild(container);

    terminal.open(container as unknown as HTMLElement);
    terminal.write('queued render');

    expect(dom.pendingAnimationFrames()).toBeGreaterThan(0);

    terminal.dispose();

    expect(dom.cancelledFrames.length).toBeGreaterThan(0);
    expect(findElementsByTag(dom.document.body, 'div').some((el) => el.className === 'xterm-helper-textarea')).toBeFalse();
  });

  test('input event should emit committed text when compositionend data is empty', async () => {
    dom = installFakeDom();
    const bindings = createFakeBindings();
    importVersion += 1;
    const { createTerminalController } = await loadControllerModule(bindings, importVersion);
    const terminal = await createTerminalController({
      theme: TEST_THEME,
      fontFamily: 'monospace',
      fontSize: 13,
      scrollback: 1000,
    });
    const container = dom.document.createElement('div');
    container.setBoundingClientRect({ width: 960, height: 480 });
    dom.document.body.appendChild(container);

    terminal.open(container as unknown as HTMLElement);

    const received: string[] = [];
    const disposable = terminal.onData((data: string) => {
      received.push(data);
    });

    const textarea = findElementsByTag(dom.document.body, 'div').find(
      (el) => el.className === 'xterm-helper-textarea'
    );
    expect(textarea).toBeDefined();

    if (textarea) {
      textarea.dispatchEvent({ type: 'compositionstart' });
      textarea.textContent = '你';
      textarea.dispatchEvent({ type: 'compositionend', data: '' });
      textarea.dispatchEvent({ type: 'input' });
    }

    expect(received).toEqual(['你']);

    disposable.dispose();
  });
});

describe('ghostty render-state bindings', () => {
  afterEach(() => {
    mock.restore();
  });

  test('create, update and dispose render-state resources with reusable iterators', async () => {
    const restoreFetch = installLocalFileFetch();

    try {
      const { getGhosttyBindings } = await import(`./ghostty-wasm.ts?real=${Date.now()}`);
      const {
        createRenderState,
        disposeRenderStateResources,
        iterateRows,
        readRenderSnapshotMeta,
        updateRenderState,
      } = await import(`./render-state.ts?real=${Date.now()}`);

      const bindings = await getGhosttyBindings();
      const terminal = bindings.createTerminal(80, 24, 1000);
      bindings.setTerminalTheme(terminal, TEST_THEME);

      try {
        const renderState = createRenderState(bindings);
        try {
          bindings.writeVt(
            terminal,
            'plain line\r\n\x1b[31mred line\x1b[0m\r\ncursor line\r\n'
          );

          updateRenderState(renderState, terminal);
          const meta = readRenderSnapshotMeta(renderState);
          expect(meta.cols).toBe(80);
          expect(meta.rows).toBe(24);
          expect(meta.dirty).not.toBe('clean');
          expect(meta.colors.background).toEqual({ r: 17, g: 17, b: 17 });
          expect(meta.colors.foreground).toEqual({ r: 238, g: 238, b: 238 });
          expect(meta.cursor.visible).toBeBoolean();

          const firstIteratorHandle = (renderState as any).rowIteratorHandle;
          const firstCellsHandle = (renderState as any).rowCellsHandle;

          const rows = Array.from(iterateRows(renderState));
          expect(rows.length).toBe(24);
          expect(rows.some((row: any) => row.text.includes('plain line'))).toBeTrue();
          expect(rows.some((row: any) => row.text.includes('red line'))).toBeTrue();

          updateRenderState(renderState, terminal);
          expect((renderState as any).rowIteratorHandle).toBe(firstIteratorHandle);
          expect((renderState as any).rowCellsHandle).toBe(firstCellsHandle);
          expect((renderState as any).snapshotVersion).toBeGreaterThan(1);
        } finally {
          disposeRenderStateResources(renderState);
          disposeRenderStateResources(renderState);
        }
      } finally {
        bindings.freeTerminal(terminal);
      }
    } finally {
      restoreFetch();
    }
  });
});

describe('CanvasRenderer', () => {
  let dom: ReturnType<typeof installFakeDom> | null = null;

  afterEach(() => {
    dom?.restore();
    dom = null;
  });

  test('renders full frames, skips clean frames and tracks dirty rows', async () => {
    dom = installFakeDom();
    const { CanvasRenderer } = await import(`./canvas-renderer.ts?renderer=${Date.now()}`);
    const screen = dom.document.createElement('div');
    dom.document.body.appendChild(screen);

    const renderer = new CanvasRenderer({
      screenElement: screen as unknown as HTMLElement,
      theme: TEST_THEME,
      fontFamily: 'monospace',
      fontSize: 13,
    });

    const frame = {
      meta: {
        cols: 4,
        rows: 2,
        dirty: 'full' as const,
        colors: {
          background: { r: 17, g: 17, b: 17 },
          foreground: { r: 238, g: 238, b: 238 },
          cursor: { r: 255, g: 255, b: 255 },
          palette: Array.from({ length: 256 }, () => ({ r: 0, g: 0, b: 0 })),
        },
        cursor: {
          style: 'block' as const,
          visible: true,
          blinking: false,
          passwordInput: false,
          x: 1,
          y: 1,
          wideTail: false,
        },
      },
      rows: [
        {
          y: 0,
          dirty: true,
          wrap: false,
          wrapContinuation: false,
          text: 'AB',
          cells: [
            {
              x: 0,
              text: 'A',
              codepoints: [65],
              widthKind: 'narrow' as const,
              hasText: true,
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
            },
            {
              x: 1,
              text: 'B',
              codepoints: [66],
              widthKind: 'narrow' as const,
              hasText: true,
              style: {
                bold: true,
                italic: false,
                faint: false,
                blink: false,
                inverse: false,
                invisible: false,
                strikethrough: false,
                overline: false,
                underline: 1,
              },
              fgColor: { r: 255, g: 0, b: 0 },
              bgColor: null,
            },
          ],
        },
        {
          y: 1,
          dirty: true,
          wrap: false,
          wrapContinuation: false,
          text: 'CD',
          cells: [
            {
              x: 0,
              text: 'C',
              codepoints: [67],
              widthKind: 'narrow' as const,
              hasText: true,
              style: {
                bold: false,
                italic: true,
                faint: false,
                blink: false,
                inverse: false,
                invisible: false,
                strikethrough: true,
                overline: false,
                underline: 0,
              },
              fgColor: null,
              bgColor: null,
            },
            {
              x: 1,
              text: 'D',
              codepoints: [68],
              widthKind: 'narrow' as const,
              hasText: true,
              style: {
                bold: false,
                italic: false,
                faint: false,
                blink: false,
                inverse: false,
                invisible: false,
                strikethrough: false,
                overline: true,
                underline: 0,
              },
              fgColor: null,
              bgColor: { r: 0, g: 128, b: 0 },
            },
          ],
        },
      ],
      cellDimensions: { width: 10, height: 20 },
    };

    renderer.render(frame);
    expect(findElementsByTag(screen, 'canvas').length).toBe(3);
    expect(renderer.getDebugState().lastDrawnRows).toEqual([0, 1]);

    const mainCanvas = findCanvasByLayer(screen, 'main');
    const cursorCanvas = findCanvasByLayer(screen, 'cursor');
    expect(mainCanvas).toBeTruthy();
    expect(cursorCanvas).toBeTruthy();
    expect(
      mainCanvas?.context.operations.some(
        (operation) =>
          operation.type === 'fillText' &&
          (operation.text === 'A' || operation.text === 'B' || operation.text === 'C' || operation.text === 'D')
      )
    ).toBeTruthy();
    expect(
      cursorCanvas?.context.operations.some((operation) => operation.type === 'fillRect')
    ).toBeTruthy();

    renderer.render({
      ...frame,
      meta: {
        ...frame.meta,
        dirty: 'clean',
      },
      rows: frame.rows.map((row) => ({ ...row, dirty: false })),
    });
    expect(renderer.getDebugState().lastDrawnRows).toEqual([]);

    renderer.render({
      ...frame,
      meta: {
        ...frame.meta,
        dirty: 'partial',
      },
      rows: frame.rows.map((row, index) => ({ ...row, dirty: index === 1 })),
    });
    expect(renderer.getDebugState().lastDrawnRows).toEqual([1]);

    renderer.setTheme({
      ...TEST_THEME,
      background: '#222222',
      foreground: '#fafafa',
    });
    renderer.render({
      ...frame,
      meta: {
        ...frame.meta,
        dirty: 'full',
        colors: {
          ...frame.meta.colors,
          background: { r: 34, g: 34, b: 34 },
          foreground: { r: 250, g: 250, b: 250 },
        },
      },
    });
    expect(
      mainCanvas?.context.operations.some(
        (operation) =>
          operation.type === 'fillRect' && operation.fillStyle === 'rgb(34 34 34)'
      )
    ).toBeTruthy();

    renderer.dispose();
    expect(findElementsByTag(screen, 'canvas').length).toBe(0);
  });
});

describe('SelectionModel', () => {
  test('supports character drag, word double click, line triple click and serialization', async () => {
    const {
      createEmptySelectionState,
      projectSelectionRects,
      resolvePointerSelection,
      serializeSelectionText,
      updateSelectionFocus,
    } = await import(`./selection-model.ts?selection=${Date.now()}`);

    const lineProvider = (line: number) =>
      (
        {
          10: 'dragtarget',
          11: 'dbltoken keep',
          12: 'tripline',
        } as Record<number, string>
      )[line] ?? '';

    let selection = resolvePointerSelection(createEmptySelectionState(), {
      line: 10,
      col: 0,
      mode: 'character',
    }, lineProvider);
    selection = updateSelectionFocus(selection, { line: 10, col: 9 }, lineProvider);
    expect(serializeSelectionText(selection, lineProvider)).toBe('dragtarget');

    const wordSelection = resolvePointerSelection(createEmptySelectionState(), {
      line: 11,
      col: 2,
      mode: 'word',
    }, lineProvider);
    expect(serializeSelectionText(wordSelection, lineProvider)).toBe('dbltoken');

    const lineSelection = resolvePointerSelection(createEmptySelectionState(), {
      line: 12,
      col: 3,
      mode: 'line',
    }, lineProvider);
    expect(serializeSelectionText(lineSelection, lineProvider)).toBe('tripline');

    const multiLine = updateSelectionFocus(
      resolvePointerSelection(createEmptySelectionState(), {
        line: 10,
        col: 4,
        mode: 'character',
      }, lineProvider),
      { line: 12, col: 3 },
      lineProvider
    );
    expect(serializeSelectionText(multiLine, lineProvider)).toBe('target\ndbltoken keep\ntrip');
    expect(projectSelectionRects(multiLine, 10, 3, lineProvider)).toEqual([
      { row: 0, x: 4, width: 6 },
      { row: 1, x: 0, width: 13 },
      { row: 2, x: 0, width: 4 },
    ]);
  });
});
