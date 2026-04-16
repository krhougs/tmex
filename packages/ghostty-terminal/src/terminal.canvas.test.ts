import { afterEach, describe, expect, mock, test } from 'bun:test';
import type { GhosttyTheme } from './types';

type FakeEvent = {
  type: string;
  data?: string;
  button?: number;
  buttons?: number;
  clientX?: number;
  clientY?: number;
  deltaY?: number;
  deltaMode?: number;
  detail?: number;
  key?: string;
  code?: string;
  repeat?: boolean;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  cancelable?: boolean;
  defaultPrevented?: boolean;
  target?: EventTarget | null;
  currentTarget?: EventTarget | null;
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

  removeEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      listeners.filter((current) => current !== listener)
    );
  }

  dispatchEvent(event: FakeEvent): boolean {
    event.target ??= this as unknown as EventTarget;
    event.currentTarget = this as unknown as EventTarget;
    event.defaultPrevented ??= false;
    event.preventDefault ??= () => {
      event.defaultPrevented = true;
    };
    const listeners = this.listeners.get(event.type) ?? [];
    for (const listener of listeners) {
      listener(event);
    }

    return !event.defaultPrevented;
  }

  focus(): void {
    this.ownerDocument.activeElement = this;
  }

  blur(): void {
    if (this.ownerDocument.activeElement === this) {
      this.ownerDocument.activeElement = null;
    }
  }

  getBoundingClientRect(): {
    width: number;
    height: number;
    left: number;
    top: number;
    right: number;
    bottom: number;
  } {
    return {
      ...this.rect,
      right: this.rect.left + this.rect.width,
      bottom: this.rect.top + this.rect.height,
    };
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

class FakeMouseEvent {
  readonly type: string;
  readonly button: number;
  readonly buttons: number;
  readonly clientX: number;
  readonly clientY: number;
  readonly detail: number;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  readonly cancelable: boolean;
  defaultPrevented = false;
  target: EventTarget | null = null;
  currentTarget: EventTarget | null = null;

  constructor(
    type: string,
    init: Partial<
      Pick<
        FakeEvent,
        'button' | 'buttons' | 'clientX' | 'clientY' | 'detail' | 'shiftKey' | 'ctrlKey' | 'altKey' | 'metaKey' | 'cancelable'
      >
    > = {}
  ) {
    this.type = type;
    this.button = init.button ?? 0;
    this.buttons = init.buttons ?? (this.button === 0 ? 1 : 0);
    this.clientX = init.clientX ?? 0;
    this.clientY = init.clientY ?? 0;
    this.detail = init.detail ?? 1;
    this.shiftKey = init.shiftKey ?? false;
    this.ctrlKey = init.ctrlKey ?? false;
    this.altKey = init.altKey ?? false;
    this.metaKey = init.metaKey ?? false;
    this.cancelable = init.cancelable ?? true;
  }

  preventDefault(): void {
    this.defaultPrevented = true;
  }
}

class FakeWheelEvent extends FakeMouseEvent {
  static readonly DOM_DELTA_PIXEL = 0;
  static readonly DOM_DELTA_LINE = 1;
  static readonly DOM_DELTA_PAGE = 2;
  readonly deltaY: number;
  readonly deltaMode: number;

  constructor(
    type: string,
    init: Partial<Pick<FakeEvent, 'deltaY' | 'deltaMode' | 'clientX' | 'clientY' | 'shiftKey' | 'ctrlKey' | 'altKey' | 'metaKey' | 'cancelable'>> = {}
  ) {
    super(type, init);
    this.deltaY = init.deltaY ?? 0;
    this.deltaMode = init.deltaMode ?? 0;
  }
}

class FakeWindowTarget {
  document: FakeDocument;
  innerWidth = 1280;
  private listeners = new Map<string, EventListener[]>();

  constructor(document: FakeDocument) {
    this.document = document;
  }

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      listeners.filter((current) => current !== listener)
    );
  }

  dispatchEvent(event: FakeEvent): boolean {
    event.target ??= this as unknown as EventTarget;
    event.currentTarget = this as unknown as EventTarget;
    event.defaultPrevented ??= false;
    event.preventDefault ??= () => {
      event.defaultPrevented = true;
    };
    const listeners = this.listeners.get(event.type) ?? [];
    for (const listener of listeners) {
      listener(event);
    }

    return !event.defaultPrevented;
  }
}

class FakeCanvasElement extends FakeElement {
  width = 0;
  height = 0;
  readonly context = new FakeCanvasContext2D();

  getContext(_kind: string): FakeCanvasContext2D {
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
  createMouseEncoder: () => number;
  freeKeyEncoder: (...args: any[]) => void;
  freeMouseEncoder: (...args: any[]) => void;
  freeTerminal: (...args: any[]) => void;
  resizeTerminal: (...args: any[]) => void;
  writeVt: (...args: any[]) => void;
  resetTerminal: (...args: any[]) => void;
  resetMouseEncoder: (...args: any[]) => void;
  readScrollbar: (...args: any[]) => { total: number; offset: number; len: number };
  scrollViewportDelta: (...args: any[]) => void;
  scrollViewportTop: (...args: any[]) => void;
  scrollViewportBottom: (...args: any[]) => void;
  isTerminalModeEnabled: (...args: any[]) => boolean;
  setTerminalMode: (...args: any[]) => void;
  encodePaste: (...args: any[]) => string;
  encodeKeyEvent: (...args: any[]) => string;
  encodeMouseEvent: (...args: any[]) => string | null;
  formatViewport: (...args: any[]) => string;
  formatViewportCalls: number;
  modeState?: Set<number>;
  scrollDeltaCalls?: number[];
  mouseEventCalls?: any[];
  keyEventCalls?: any[];
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

function findElementByClass(root: FakeElement | null, className: string): FakeElement | null {
  if (!root) {
    return null;
  }

  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }

    if (current.className === className) {
      return current;
    }

    stack.push(...current.children);
  }

  return null;
}

function createFakeBindings(): FakeBindings {
  let formatViewportCalls = 0;
  const modeState = new Set<number>();
  const scrollDeltaCalls: number[] = [];
  const mouseEventCalls: any[] = [];
  const keyEventCalls: any[] = [];

  return {
    createTerminal: () => 1,
    setTerminalTheme: () => {},
    createKeyEncoder: () => 2,
    createMouseEncoder: () => 3,
    freeKeyEncoder: () => {},
    freeMouseEncoder: () => {},
    freeTerminal: () => {},
    resizeTerminal: () => {},
    writeVt: () => {},
    resetTerminal: () => {},
    resetMouseEncoder: () => {},
    readScrollbar: () => ({ total: 24, offset: 0, len: 24 }),
    scrollViewportDelta: (_terminal: number, amount: number) => {
      scrollDeltaCalls.push(amount);
    },
    scrollViewportTop: () => {},
    scrollViewportBottom: () => {},
    isTerminalModeEnabled: (_terminal: number, mode: number) => modeState.has(mode),
    setTerminalMode: (_terminal: number, mode: number, enabled: boolean) => {
      if (enabled) modeState.add(mode);
      else modeState.delete(mode);
    },
    encodePaste: () => '',
    encodeKeyEvent: (
      _encoder: number,
      _terminal: number,
      options: { action: string; keyCode: number; mods: number }
    ) => {
      keyEventCalls.push(options);
      return `key:${options.action}:${options.keyCode}:${options.mods}`;
    },
    encodeMouseEvent: (_encoder: number, _terminal: number, options: Record<string, unknown>) => {
      mouseEventCalls.push(options);
      return `mouse:${String(options.action)}:${String(options.button ?? 'none')}`;
    },
    formatViewport: () => {
      formatViewportCalls += 1;
      return '';
    },
    get formatViewportCalls() {
      return formatViewportCalls;
    },
    modeState,
    scrollDeltaCalls,
    mouseEventCalls,
    keyEventCalls,
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
  const windowTarget = new FakeWindowTarget(document);
  const previousDocument = (globalThis as any).document;
  const previousWindow = (globalThis as any).window;
  const previousNavigator = (globalThis as any).navigator;
  const previousHTMLElement = (globalThis as any).HTMLElement;
  const previousHTMLCanvasElement = (globalThis as any).HTMLCanvasElement;
  const previousHTMLTextAreaElement = (globalThis as any).HTMLTextAreaElement;
  const previousHTMLDivElement = (globalThis as any).HTMLDivElement;
  const previousMouseEvent = (globalThis as any).MouseEvent;
  const previousWheelEvent = (globalThis as any).WheelEvent;
  const previousRequestAnimationFrame = globalThis.requestAnimationFrame;
  const previousCancelAnimationFrame = globalThis.cancelAnimationFrame;

  const rafQueue = new Map<number, RafCallback>();
  const cancelledFrames: number[] = [];
  let nextAnimationFrameId = 1;

  (globalThis as any).document = document;
  (globalThis as any).window = windowTarget;
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
  (globalThis as any).MouseEvent = FakeMouseEvent;
  (globalThis as any).WheelEvent = FakeWheelEvent;
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
      (globalThis as any).MouseEvent = previousMouseEvent;
      (globalThis as any).WheelEvent = previousWheelEvent;
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

  test('wheel should keep local viewport scrolling when mouse and alt-scroll modes are disabled', async () => {
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

    (terminal.element as unknown as FakeElement).dispatchEvent(
      new FakeWheelEvent('wheel', { deltaY: 48 }) as unknown as FakeEvent
    );

    expect(received).toEqual([]);
    expect(bindings.scrollDeltaCalls).toHaveLength(1);
    disposable.dispose();
  });

  test('pixel wheel should accumulate before local viewport scrolling', async () => {
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

    const root = terminal.element as unknown as FakeElement;
    root.dispatchEvent(new FakeWheelEvent('wheel', { deltaY: 8 }) as unknown as FakeEvent);
    root.dispatchEvent(new FakeWheelEvent('wheel', { deltaY: 8 }) as unknown as FakeEvent);

    expect(bindings.scrollDeltaCalls).toEqual([]);

    root.dispatchEvent(new FakeWheelEvent('wheel', { deltaY: 8 }) as unknown as FakeEvent);
    expect(bindings.scrollDeltaCalls).toEqual([1]);
  });

  test('line wheel delta should be used directly for viewport scrolling', async () => {
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

    (terminal.element as unknown as FakeElement).dispatchEvent(
      new FakeWheelEvent('wheel', { deltaY: 3, deltaMode: FakeWheelEvent.DOM_DELTA_LINE }) as unknown as FakeEvent
    );

    expect(bindings.scrollDeltaCalls).toEqual([3]);
  });

  test('wheel should emit mouse input when mouse reporting is enabled', async () => {
    dom = installFakeDom();
    const bindings = createFakeBindings();
    bindings.modeState?.add(1000);
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

    const screen = findElementByClass(terminal.element as unknown as FakeElement, 'xterm-screen');
    screen?.setBoundingClientRect({ width: 960, height: 480, left: 0, top: 0 });

    const received: string[] = [];
    const disposable = terminal.onData((data: string) => {
      received.push(data);
    });

    (terminal.element as unknown as FakeElement).dispatchEvent(
      new FakeWheelEvent('wheel', { deltaY: 48, clientX: 40, clientY: 30 }) as unknown as FakeEvent
    );

    expect(received.some((item) => item.startsWith('mouse:'))).toBeTrue();
    expect(bindings.scrollDeltaCalls).toEqual([]);
    disposable.dispose();
  });

  test('wheel should emit app scroll input when alt-screen and alt-scroll are enabled without mouse reporting', async () => {
    dom = installFakeDom();
    const bindings = createFakeBindings();
    bindings.modeState?.add(1007);
    bindings.modeState?.add(1049);
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

    (terminal.element as unknown as FakeElement).dispatchEvent(
      new FakeWheelEvent('wheel', { deltaY: -48, clientX: 40, clientY: 30 }) as unknown as FakeEvent
    );

    expect(received.some((item) => item.startsWith('key:'))).toBeTrue();
    expect(bindings.scrollDeltaCalls).toEqual([]);
    disposable.dispose();
  });

  test('mouse reporting should win over alt-scroll for wheel routing', async () => {
    dom = installFakeDom();
    const bindings = createFakeBindings();
    bindings.modeState?.add(1000);
    bindings.modeState?.add(1007);
    bindings.modeState?.add(1049);
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

    const screen = findElementByClass(terminal.element as unknown as FakeElement, 'xterm-screen');
    screen?.setBoundingClientRect({ width: 960, height: 480, left: 0, top: 0 });

    const received: string[] = [];
    const disposable = terminal.onData((data: string) => {
      received.push(data);
    });

    (terminal.element as unknown as FakeElement).dispatchEvent(
      new FakeWheelEvent('wheel', { deltaY: 48, clientX: 40, clientY: 30 }) as unknown as FakeEvent
    );

    expect(received.some((item) => item.startsWith('mouse:'))).toBeTrue();
    expect(received.some((item) => item.startsWith('key:'))).toBeFalse();
    expect(bindings.scrollDeltaCalls).toEqual([]);
    disposable.dispose();
  });

  test('mouse drag should emit app mouse input instead of local selection when mouse reporting is enabled', async () => {
    dom = installFakeDom();
    const bindings = createFakeBindings();
    bindings.modeState?.add(1000);
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
    await dom.flushAnimationFrames();

    const screen = findElementByClass(terminal.element as unknown as FakeElement, 'xterm-screen');
    expect(screen).toBeTruthy();
    screen?.setBoundingClientRect({ width: 960, height: 480, left: 0, top: 0 });

    const received: string[] = [];
    const disposable = terminal.onData((data: string) => {
      received.push(data);
    });

    screen?.dispatchEvent(
      new FakeMouseEvent('mousedown', { clientX: 10, clientY: 10, button: 0, buttons: 1 }) as unknown as FakeEvent
    );
    ((globalThis as any).window as FakeWindowTarget).dispatchEvent(
      new FakeMouseEvent('mousemove', { clientX: 80, clientY: 10, button: 0, buttons: 1 }) as unknown as FakeEvent
    );
    ((globalThis as any).window as FakeWindowTarget).dispatchEvent(
      new FakeMouseEvent('mouseup', { clientX: 80, clientY: 10, button: 0, buttons: 0 }) as unknown as FakeEvent
    );

    expect(received.some((item) => item.startsWith('mouse:'))).toBeTrue();
    expect((globalThis as any).__tmexE2eTerminalSelectionText ?? null).toBeNull();
    disposable.dispose();
  });

  test('middle and right mouse press should emit app mouse input when mouse reporting is enabled', async () => {
    dom = installFakeDom();
    const bindings = createFakeBindings();
    bindings.modeState?.add(1000);
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
    await dom.flushAnimationFrames();

    const screen = findElementByClass(terminal.element as unknown as FakeElement, 'xterm-screen');
    screen?.setBoundingClientRect({ width: 960, height: 480, left: 0, top: 0 });

    screen?.dispatchEvent(
      new FakeMouseEvent('mousedown', { clientX: 10, clientY: 10, button: 1, buttons: 4 }) as unknown as FakeEvent
    );
    screen?.dispatchEvent(
      new FakeMouseEvent('mousedown', { clientX: 20, clientY: 20, button: 2, buttons: 2 }) as unknown as FakeEvent
    );

    expect(bindings.mouseEventCalls?.map((item) => item.button)).toEqual([3, 2]);
  });

  test('exported terminal modes can be restored after reset', async () => {
    dom = installFakeDom();
    const bindings = createFakeBindings();
    bindings.modeState?.add(1000);
    bindings.modeState?.add(1006);
    bindings.modeState?.add(1049);
    importVersion += 1;
    const { createTerminalController } = await loadControllerModule(bindings, importVersion);
    const terminal = await createTerminalController({
      theme: TEST_THEME,
      fontFamily: 'monospace',
      fontSize: 13,
      scrollback: 1000,
    });
    const snapshot = terminal.exportModeSnapshot?.();

    expect(snapshot).toBeTruthy();
    if (!snapshot) {
      return;
    }

    bindings.modeState?.clear();
    terminal.restoreModeSnapshot?.(snapshot);

    expect(bindings.modeState?.has(1000)).toBeTrue();
    expect(bindings.modeState?.has(1006)).toBeTrue();
    expect(bindings.modeState?.has(1049)).toBeTrue();
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

describe('ghostty mouse protocol bindings', () => {
  afterEach(() => {
    mock.restore();
  });

  test('encodes middle press and right release with correct sgr button codes', async () => {
    const restoreFetch = installLocalFileFetch();

    try {
      const { getGhosttyBindings } = await import(`./ghostty-wasm.ts?mouse-sgr=${Date.now()}`);
      const bindings = await getGhosttyBindings();
      const terminal = bindings.createTerminal(80, 24, 1000);
      const mouseEncoder = bindings.createMouseEncoder();

      try {
        bindings.exports.ghostty_terminal_mode_set(terminal, 1000, 1);
        bindings.exports.ghostty_terminal_mode_set(terminal, 1006, 1);

        const middlePress = bindings.encodeMouseEvent(mouseEncoder, terminal, {
          action: 'press',
          button: 3,
          mods: 0,
          x: 50,
          y: 40,
          anyButtonPressed: true,
          screenWidth: 800,
          screenHeight: 600,
          cellWidth: 10,
          cellHeight: 20,
        });
        const rightRelease = bindings.encodeMouseEvent(mouseEncoder, terminal, {
          action: 'release',
          button: 2,
          mods: 0,
          x: 50,
          y: 40,
          anyButtonPressed: false,
          screenWidth: 800,
          screenHeight: 600,
          cellWidth: 10,
          cellHeight: 20,
        });

        expect(middlePress).toBe('\u001b[<1;6;3M'.replace('\\u001b', ''));
        expect(rightRelease).toBe('\u001b[<2;6;3m'.replace('\\u001b', ''));
      } finally {
        bindings.freeMouseEncoder(mouseEncoder);
        bindings.freeTerminal(terminal);
      }
    } finally {
      restoreFetch();
    }
  });

  test('encodes sgr pixels using pixel coordinates instead of cell coordinates', async () => {
    const restoreFetch = installLocalFileFetch();

    try {
      const { getGhosttyBindings } = await import(`./ghostty-wasm.ts?mouse-pixels=${Date.now()}`);
      const bindings = await getGhosttyBindings();
      const terminal = bindings.createTerminal(80, 24, 1000);
      const mouseEncoder = bindings.createMouseEncoder();

      try {
        bindings.exports.ghostty_terminal_mode_set(terminal, 1000, 1);
        bindings.exports.ghostty_terminal_mode_set(terminal, 1016, 1);

        const encoded = bindings.encodeMouseEvent(mouseEncoder, terminal, {
          action: 'press',
          button: 1,
          mods: 0,
          x: 50,
          y: 40,
          anyButtonPressed: true,
          screenWidth: 800,
          screenHeight: 600,
          cellWidth: 10,
          cellHeight: 20,
        });

        expect(encoded).toBe('\u001b[<0;51;41M'.replace('\\u001b', ''));
      } finally {
        bindings.freeMouseEncoder(mouseEncoder);
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
