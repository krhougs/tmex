import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test';
import * as realGhosttyWasm from './ghostty-wasm';
import * as realRenderState from './render-state';
// mock.module 前的导出值快照：namespace import 是 live binding，mock 生效后
// realGhosttyWasm.* 会跟着变成 fake，还原必须用 mock 前拷出的值。
const realGhosttyWasmSnapshot = { ...realGhosttyWasm };
const realRenderStateSnapshot = { ...realRenderState };
import type {
  GhosttyCursorVisualStyle,
  GhosttyRenderCursor,
  GhosttyRenderRow,
  GhosttyTheme,
} from './types';
import type { SelectionLineModel } from './selection-model';

type FakeEvent = {
  type: string;
  data?: string | null;
  inputType?: string;
  isComposing?: boolean;
  keyCode?: number;
  button?: number;
  buttons?: number;
  clientX?: number;
  clientY?: number;
  deltaX?: number;
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
  clipboardData?: { getData: (type: string) => string };
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

  measureText(): {
    fontBoundingBoxAscent: number;
    fontBoundingBoxDescent: number;
    actualBoundingBoxAscent: number;
    actualBoundingBoxDescent: number;
    width: number;
  } {
    const px = Number.parseFloat(this.font) || 13;
    return {
      fontBoundingBoxAscent: px * 0.8,
      fontBoundingBoxDescent: px * 0.3,
      actualBoundingBoxAscent: px * 0.7,
      actualBoundingBoxDescent: px * 0.2,
      width: px * 0.6,
    };
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

  setBoundingClientRect(rect: {
    width: number;
    height: number;
    left?: number;
    top?: number;
  }): void {
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
        | 'button'
        | 'buttons'
        | 'clientX'
        | 'clientY'
        | 'detail'
        | 'shiftKey'
        | 'ctrlKey'
        | 'altKey'
        | 'metaKey'
        | 'cancelable'
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
  readonly deltaX: number;
  readonly deltaY: number;
  readonly deltaMode: number;

  constructor(
    type: string,
    init: Partial<
      Pick<
        FakeEvent,
        | 'deltaX'
        | 'deltaY'
        | 'deltaMode'
        | 'clientX'
        | 'clientY'
        | 'shiftKey'
        | 'ctrlKey'
        | 'altKey'
        | 'metaKey'
        | 'cancelable'
      >
    > = {}
  ) {
    super(type, init);
    this.deltaX = init.deltaX ?? 0;
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
    (findElementsByTag(root, 'canvas').find(
      (element) => (element as FakeCanvasElement).dataset.layer === layer
    ) as FakeCanvasElement | undefined) ?? null
  );
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
      ...realGhosttyWasmSnapshot,
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
      cells:
        index === 0
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
      readRenderDirtyState: () => 'full' as const,
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

// bun 的 mock.module 是全局持久的（mock.restore 不还原），文件跑完必须显式还原，
// 否则污染同一进程中后续测试文件（如 headless.test.ts 拿到 fake bindings）。
afterAll(() => {
  mock.module('./ghostty-wasm', () => ({ ...realGhosttyWasmSnapshot }));
  mock.module('./render-state', () => ({ ...realRenderStateSnapshot }));
});

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

    expect(
      findElementsByTag(terminal.element as unknown as FakeElement, 'canvas').length
    ).toBeGreaterThan(0);
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
    expect(
      findElementsByTag(dom.document.body, 'div').some(
        (el) => el.className === 'xterm-helper-textarea'
      )
    ).toBeFalse();
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

  // Android Gboard 在 contenteditable 上不发 Backspace 的 keydown（报 keyCode 229），
  // 删除一律走 beforeinput 的 deleteContent* inputType 且 data 为空；必须按等价
  // 按键编码补发，否则退格被丢弃。keyCode：Backspace=53，Delete=68。
  test('beforeinput deleteContentBackward should emit Backspace key (Android)', async () => {
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
      // 模拟 Android：keydown 报 229（无操作），随后 beforeinput 携带删除意图
      textarea.dispatchEvent({ type: 'keydown', keyCode: 229, key: 'Unidentified', code: '' });
      textarea.dispatchEvent({
        type: 'beforeinput',
        inputType: 'deleteContentBackward',
        data: null,
      });
    }

    expect(received).toEqual(['key:press:53:0']);

    disposable.dispose();
  });

  test('beforeinput deleteContentForward should emit Delete key (Android)', async () => {
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

    if (textarea) {
      textarea.dispatchEvent({
        type: 'beforeinput',
        inputType: 'deleteContentForward',
        data: null,
      });
    }

    expect(received).toEqual(['key:press:68:0']);

    disposable.dispose();
  });

  // Android 的 Enter 同样不发 keydown，换行走 beforeinput 的 insertLineBreak/
  // insertParagraph 且 data 为空。keyCode：Enter=58。
  test('beforeinput insertLineBreak should emit Enter key (Android)', async () => {
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

    if (textarea) {
      textarea.dispatchEvent({ type: 'keydown', keyCode: 229, key: 'Unidentified', code: '' });
      textarea.dispatchEvent({ type: 'beforeinput', inputType: 'insertParagraph', data: null });
    }

    expect(received).toEqual(['key:press:58:0']);

    disposable.dispose();
  });

  // 组字过程中的删除（autocorrect 删除待选区）不应发到终端，等 compositionend 统一提交
  test('beforeinput delete during composition should be ignored', async () => {
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

    if (textarea) {
      textarea.dispatchEvent({ type: 'compositionstart' });
      textarea.dispatchEvent({
        type: 'beforeinput',
        inputType: 'deleteContentBackward',
        data: null,
        isComposing: true,
      });
    }

    expect(received).toEqual([]);

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

    // cell 高 = round(13 × 1.2) = 16px：每次 6px 像素滚动，累计未满 1 cell 不触发本地滚动。
    const root = terminal.element as unknown as FakeElement;
    root.dispatchEvent(new FakeWheelEvent('wheel', { deltaY: 6 }) as unknown as FakeEvent);
    root.dispatchEvent(new FakeWheelEvent('wheel', { deltaY: 6 }) as unknown as FakeEvent);

    expect(bindings.scrollDeltaCalls).toEqual([]);

    root.dispatchEvent(new FakeWheelEvent('wheel', { deltaY: 6 }) as unknown as FakeEvent);
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
      new FakeWheelEvent('wheel', {
        deltaY: 3,
        deltaMode: FakeWheelEvent.DOM_DELTA_LINE,
      }) as unknown as FakeEvent
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
      new FakeMouseEvent('mousedown', {
        clientX: 10,
        clientY: 10,
        button: 0,
        buttons: 1,
      }) as unknown as FakeEvent
    );
    ((globalThis as any).window as FakeWindowTarget).dispatchEvent(
      new FakeMouseEvent('mousemove', {
        clientX: 80,
        clientY: 10,
        button: 0,
        buttons: 1,
      }) as unknown as FakeEvent
    );
    ((globalThis as any).window as FakeWindowTarget).dispatchEvent(
      new FakeMouseEvent('mouseup', {
        clientX: 80,
        clientY: 10,
        button: 0,
        buttons: 0,
      }) as unknown as FakeEvent
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
      new FakeMouseEvent('mousedown', {
        clientX: 10,
        clientY: 10,
        button: 1,
        buttons: 4,
      }) as unknown as FakeEvent
    );
    screen?.dispatchEvent(
      new FakeMouseEvent('mousedown', {
        clientX: 20,
        clientY: 20,
        button: 2,
        buttons: 2,
      }) as unknown as FakeEvent
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

  // Retina（dpr=2）下 cssCell 高按物理像素网格对齐可为 .5 步进（13 × 1.2 = 15.6 →
  // round(31.2)/2 = 15.5）。鼠标上报必须与渲染 / hitTest 用同一未取整 cell 尺寸：
  // 取整成 16 后 floor(y/16)+1 从视觉第 ~17 行起行号少 1（opencode 下半屏点击/拖拽偏一行）。
  test('mouse input should pass unrounded cell dimensions to the encoder (dpr=2 half-pixel cell)', async () => {
    dom = installFakeDom();
    const previousDpr = (globalThis as any).devicePixelRatio;
    (globalThis as any).devicePixelRatio = 2;

    try {
      const bindings = createFakeBindings();
      bindings.modeState?.add(1002);
      bindings.modeState?.add(1006);
      importVersion += 1;
      const { createTerminalController } = await loadControllerModule(bindings, importVersion);
      const terminal = await createTerminalController({
        theme: TEST_THEME,
        fontFamily: 'monospace',
        fontSize: 13,
        scrollback: 1000,
      });
      const container = dom.document.createElement('div');
      container.setBoundingClientRect({ width: 960, height: 640 });
      dom.document.body.appendChild(container);

      terminal.open(container as unknown as HTMLElement);
      await dom.flushAnimationFrames();

      const screen = findElementByClass(terminal.element as unknown as FakeElement, 'xterm-screen');
      expect(screen).toBeTruthy();
      screen?.setBoundingClientRect({ width: 960, height: 640, left: 0, top: 0 });

      // 视觉第 21 行（0-based 20）中部：y = 20.5 × 15.5 = 317.75
      screen?.dispatchEvent(
        new FakeMouseEvent('mousedown', {
          clientX: 5,
          clientY: 317,
          button: 0,
          buttons: 1,
        }) as unknown as FakeEvent
      );

      const call = bindings.mouseEventCalls?.[0] as { y: number; cellHeight: number } | undefined;
      expect(call).toBeDefined();
      if (!call) {
        return;
      }
      expect(call.cellHeight).toBe(15.5);
      // 编码器按 floor(y / cellHeight) + 1 计算 SGR 行号，传入值必须能还原出第 21 行
      expect(Math.floor(call.y / call.cellHeight) + 1).toBe(21);

      terminal.dispose();
    } finally {
      (globalThis as any).devicePixelRatio = previousDpr;
    }
  });

  // 共用装配：开启指定模式、打开终端、定位 screen rect，返回操作句柄
  async function setupMouseTerminal(modes: number[]): Promise<{
    bindings: FakeBindings;
    terminal: any;
    screen: FakeElement | null;
    windowTarget: FakeWindowTarget;
  }> {
    const bindings = createFakeBindings();
    for (const mode of modes) {
      bindings.modeState?.add(mode);
    }
    importVersion += 1;
    const { createTerminalController } = await loadControllerModule(bindings, importVersion);
    const terminal = await createTerminalController({
      theme: TEST_THEME,
      fontFamily: 'monospace',
      fontSize: 13,
      scrollback: 1000,
    });
    const container = dom?.document.createElement('div');
    if (container && dom) {
      container.setBoundingClientRect({ width: 960, height: 480 });
      dom.document.body.appendChild(container);
      terminal.open(container as unknown as HTMLElement);
      await dom.flushAnimationFrames();
    }
    const screen = findElementByClass(terminal.element as unknown as FakeElement, 'xterm-screen');
    screen?.setBoundingClientRect({ width: 960, height: 480, left: 0, top: 0 });
    return {
      bindings,
      terminal,
      screen,
      windowTarget: (globalThis as any).window as FakeWindowTarget,
    };
  }

  // xterm 约定：鼠标上报模式下 Shift+左键拖拽绕过上报、走本地文本选择（唯一的复制入口）
  test('shift+left drag bypasses mouse reporting into local selection', async () => {
    dom = installFakeDom();
    const { bindings, terminal, screen, windowTarget } = await setupMouseTerminal([1000, 1006]);

    screen?.dispatchEvent(
      new FakeMouseEvent('mousedown', {
        clientX: 10,
        clientY: 8,
        button: 0,
        buttons: 1,
        shiftKey: true,
      }) as unknown as FakeEvent
    );
    windowTarget.dispatchEvent(
      new FakeMouseEvent('mousemove', {
        clientX: 100,
        clientY: 8,
        buttons: 1,
        shiftKey: true,
      }) as unknown as FakeEvent
    );
    windowTarget.dispatchEvent(
      new FakeMouseEvent('mouseup', {
        clientX: 100,
        clientY: 8,
        button: 0,
        buttons: 0,
        shiftKey: true,
      }) as unknown as FakeEvent
    );

    expect(bindings.mouseEventCalls?.length ?? 0).toBe(0);
    expect(terminal.getSelection?.() ?? '').not.toBe('');

    // 无 Shift 的后续拖拽仍走上报（bypass 状态不得泄漏到下一次会话）
    screen?.dispatchEvent(
      new FakeMouseEvent('mousedown', {
        clientX: 10,
        clientY: 8,
        button: 0,
        buttons: 1,
      }) as unknown as FakeEvent
    );
    windowTarget.dispatchEvent(
      new FakeMouseEvent('mouseup', {
        clientX: 10,
        clientY: 8,
        button: 0,
        buttons: 0,
      }) as unknown as FakeEvent
    );
    expect(bindings.mouseEventCalls?.length ?? 0).toBeGreaterThan(0);
  });

  // 真实终端只在跨 cell 时发 motion：同 cell 的 mousemove 必须去重
  test('drag motion within one cell is deduplicated until crossing cells', async () => {
    dom = installFakeDom();
    const { bindings, screen, windowTarget } = await setupMouseTerminal([1002, 1006]);

    screen?.dispatchEvent(
      new FakeMouseEvent('mousedown', {
        clientX: 10,
        clientY: 8,
        button: 0,
        buttons: 1,
      }) as unknown as FakeEvent
    );
    // 同 cell 内抖动（cell 宽 9 / 高 16）：不得产生新事件
    windowTarget.dispatchEvent(
      new FakeMouseEvent('mousemove', {
        clientX: 12,
        clientY: 9,
        buttons: 1,
      }) as unknown as FakeEvent
    );
    windowTarget.dispatchEvent(
      new FakeMouseEvent('mousemove', {
        clientX: 13,
        clientY: 10,
        buttons: 1,
      }) as unknown as FakeEvent
    );
    // 跨列：产生一条 motion
    windowTarget.dispatchEvent(
      new FakeMouseEvent('mousemove', {
        clientX: 100,
        clientY: 8,
        buttons: 1,
      }) as unknown as FakeEvent
    );
    // 又回到同 cell：不产生
    windowTarget.dispatchEvent(
      new FakeMouseEvent('mousemove', {
        clientX: 103,
        clientY: 9,
        buttons: 1,
      }) as unknown as FakeEvent
    );
    windowTarget.dispatchEvent(
      new FakeMouseEvent('mouseup', {
        clientX: 103,
        clientY: 9,
        button: 0,
        buttons: 0,
      }) as unknown as FakeEvent
    );

    expect(bindings.mouseEventCalls?.map((call) => call.action)).toEqual([
      'press',
      'motion',
      'release',
    ]);
  });

  // 1016（SGR-pixels）语义是像素粒度，同 cell 去重必须停用
  test('sgr-pixels mode (1016) disables motion dedupe', async () => {
    dom = installFakeDom();
    const { bindings, screen, windowTarget } = await setupMouseTerminal([1002, 1006, 1016]);

    screen?.dispatchEvent(
      new FakeMouseEvent('mousedown', {
        clientX: 10,
        clientY: 8,
        button: 0,
        buttons: 1,
      }) as unknown as FakeEvent
    );
    windowTarget.dispatchEvent(
      new FakeMouseEvent('mousemove', {
        clientX: 12,
        clientY: 9,
        buttons: 1,
      }) as unknown as FakeEvent
    );
    windowTarget.dispatchEvent(
      new FakeMouseEvent('mousemove', {
        clientX: 13,
        clientY: 10,
        buttons: 1,
      }) as unknown as FakeEvent
    );

    expect(bindings.mouseEventCalls?.map((call) => call.action)).toEqual([
      'press',
      'motion',
      'motion',
    ]);
  });

  // 1003 any-event tracking：裸悬停（无按钮）也要上报 motion，且受同 cell 去重约束
  test('hover motion is reported under any-event tracking (1003)', async () => {
    dom = installFakeDom();
    const { bindings, screen } = await setupMouseTerminal([1003, 1006]);

    screen?.dispatchEvent(
      new FakeMouseEvent('mousemove', {
        clientX: 50,
        clientY: 20,
        buttons: 0,
      }) as unknown as FakeEvent
    );
    screen?.dispatchEvent(
      new FakeMouseEvent('mousemove', {
        clientX: 52,
        clientY: 21,
        buttons: 0,
      }) as unknown as FakeEvent
    );
    screen?.dispatchEvent(
      new FakeMouseEvent('mousemove', {
        clientX: 150,
        clientY: 20,
        buttons: 0,
      }) as unknown as FakeEvent
    );

    const calls = bindings.mouseEventCalls ?? [];
    expect(calls.map((call) => call.action)).toEqual(['motion', 'motion']);
    expect(calls.every((call) => call.anyButtonPressed === false)).toBeTrue();
  });

  test('hover motion with shift held is not reported (local override)', async () => {
    dom = installFakeDom();
    const { bindings, screen } = await setupMouseTerminal([1003, 1006]);

    screen?.dispatchEvent(
      new FakeMouseEvent('mousemove', {
        clientX: 50,
        clientY: 20,
        buttons: 0,
        shiftKey: true,
      }) as unknown as FakeEvent
    );

    expect(bindings.mouseEventCalls?.length ?? 0).toBe(0);
  });

  test('hover motion is not reported under button-event tracking (1002)', async () => {
    dom = installFakeDom();
    const { bindings, screen } = await setupMouseTerminal([1002, 1006]);

    screen?.dispatchEvent(
      new FakeMouseEvent('mousemove', {
        clientX: 50,
        clientY: 20,
        buttons: 0,
      }) as unknown as FakeEvent
    );

    expect(bindings.mouseEventCalls?.length ?? 0).toBe(0);
  });

  // 水平滚轮：SGR 按钮 6/7（66/67），仅上报模式消费 deltaX
  test('horizontal wheel emits buttons 6/7 when mouse reporting is enabled', async () => {
    dom = installFakeDom();
    const { bindings, terminal } = await setupMouseTerminal([1000, 1006]);

    (terminal.element as unknown as FakeElement).dispatchEvent(
      new FakeWheelEvent('wheel', {
        deltaX: 27,
        deltaY: 0,
        clientX: 40,
        clientY: 30,
      }) as unknown as FakeEvent
    );
    // 27px / 9px cell = 3 列 → 3 个按钮 7（向右）
    expect(bindings.mouseEventCalls?.map((call) => call.button)).toEqual([7, 7, 7]);

    (terminal.element as unknown as FakeElement).dispatchEvent(
      new FakeWheelEvent('wheel', {
        deltaX: -9,
        deltaY: 0,
        clientX: 40,
        clientY: 30,
      }) as unknown as FakeEvent
    );
    expect(bindings.mouseEventCalls?.map((call) => call.button)).toEqual([7, 7, 7, 6]);
  });

  test('horizontal wheel is ignored without mouse reporting', async () => {
    dom = installFakeDom();
    const { bindings, terminal } = await setupMouseTerminal([]);

    (terminal.element as unknown as FakeElement).dispatchEvent(
      new FakeWheelEvent('wheel', {
        deltaX: 48,
        deltaY: 0,
        clientX: 40,
        clientY: 30,
      }) as unknown as FakeEvent
    );

    expect(bindings.mouseEventCalls?.length ?? 0).toBe(0);
    expect(bindings.scrollDeltaCalls).toEqual([]);
  });

  // 触摸手势 API：press/motion/release 三态上报；返回 false = 上报模式未开启
  test('sendTouchMouseEvent reports press/motion/release with left button', async () => {
    dom = installFakeDom();
    const { bindings, terminal } = await setupMouseTerminal([1002, 1006]);

    expect(terminal.isMouseReporting?.()).toBeTrue();
    expect(terminal.sendTouchMouseEvent?.({ action: 'press', clientX: 10, clientY: 8 })).toBeTrue();
    expect(
      terminal.sendTouchMouseEvent?.({ action: 'motion', clientX: 100, clientY: 8 })
    ).toBeTrue();
    expect(
      terminal.sendTouchMouseEvent?.({ action: 'release', clientX: 100, clientY: 8 })
    ).toBeTrue();

    const calls = bindings.mouseEventCalls ?? [];
    expect(calls.map((call) => call.action)).toEqual(['press', 'motion', 'release']);
    expect(calls.every((call) => call.button === 1)).toBeTrue();
    expect(calls[2]?.anyButtonPressed).toBeFalse();
  });

  test('sendTouchMouseEvent returns false when mouse reporting is off', async () => {
    dom = installFakeDom();
    const { bindings, terminal } = await setupMouseTerminal([]);

    expect(terminal.isMouseReporting?.()).toBeFalse();
    expect(
      terminal.sendTouchMouseEvent?.({ action: 'press', clientX: 10, clientY: 8 })
    ).toBeFalse();
    expect(bindings.mouseEventCalls?.length ?? 0).toBe(0);
  });

  // 触摸手势被消费后，浏览器随后的 compat 鼠标事件必须被忽略（防 tap 双触发/清掉长按选择）
  test('noteTouchHandled suppresses synthetic mouse events within the window', async () => {
    dom = installFakeDom();
    const { bindings, terminal, screen } = await setupMouseTerminal([1000, 1006]);

    terminal.noteTouchHandled?.();
    screen?.dispatchEvent(
      new FakeMouseEvent('mousedown', {
        clientX: 10,
        clientY: 8,
        button: 0,
        buttons: 1,
      }) as unknown as FakeEvent
    );
    expect(bindings.mouseEventCalls?.length ?? 0).toBe(0);
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
          bindings.writeVt(terminal, 'plain line\r\n\x1b[31mred line\x1b[0m\r\ncursor line\r\n');

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

  test('SGR 背景色只在带色写路径进入 cell;文本快照(reset+无 SGR 纯文本)重建后背景属性在数据层即丢失', async () => {
    const restoreFetch = installLocalFileFetch();

    try {
      // 带查询串的动态 import 绕过 mock.module 后的模块缓存,取真实 wasm 实现(本文件既有约定)
      const { getGhosttyBindings } = await import(`./ghostty-wasm.ts?bgdata=${Date.now()}`);
      const {
        createRenderState,
        disposeRenderStateResources,
        iterateRows,
        updateRenderState,
      } = await import(`./render-state.ts?bgdata=${Date.now()}`);

      const bindings = await getGhosttyBindings();
      const terminal = bindings.createTerminal(80, 24, 1000);
      bindings.setTerminalTheme(terminal, TEST_THEME);

      try {
        const renderState = createRenderState(bindings);
        try {
          // alt screen 应用:整屏 SGR 真彩色背景(SGR 48;2 是应用精确指定色,渲染层必须原样呈现)
          bindings.writeVt(
            terminal,
            '\x1b[?1049h\x1b[48;2;20;30;80m' +
              'A'.repeat(80) +
              '\r\n' +
              'B'.repeat(80) +
              '\x1b[0m\r\nplain\r\n'
          );

          updateRenderState(renderState, terminal);
          const rows = Array.from(iterateRows(renderState));
          const bgCells = rows
            .flatMap((row) => row.cells)
            .filter((cell) => cell.bgColor !== null);
          expect(bgCells.length).toBeGreaterThan(0);
          expect(bgCells[0].bgColor).toEqual({ r: 20, g: 30, b: 80 });

          // 快照/首屏恢复路径:reset() + 纯文本正文(capture-pane 文本不含 SGR 序列)。
          // 背景属性在这一步就丢了——cell 的 bgColor 全部为 null,渲染器只能铺默认背景,
          // 与渲染管线(字形缓存/脏区重绘)无关。
          bindings.resetTerminal(terminal);
          bindings.writeVt(terminal, 'restored plain line\r\n');
          updateRenderState(renderState, terminal);
          const restoredRows = Array.from(iterateRows(renderState));
          const restoredBgCells = restoredRows
            .flatMap((row) => row.cells)
            .filter((cell) => cell.bgColor !== null);
          expect(restoredBgCells).toHaveLength(0);
        } finally {
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

  // cell 尺寸是 float（物理像素网格对齐可产生 .5 步进），编码器必须按精确值换算行列
  test('encodes sgr coordinates from fractional cell dimensions', async () => {
    const restoreFetch = installLocalFileFetch();

    try {
      const { getGhosttyBindings } = await import(`./ghostty-wasm.ts?mouse-frac=${Date.now()}`);
      const bindings = await getGhosttyBindings();
      const terminal = bindings.createTerminal(80, 40, 1000);
      const mouseEncoder = bindings.createMouseEncoder();

      try {
        bindings.exports.ghostty_terminal_mode_set(terminal, 1002, 1);
        bindings.exports.ghostty_terminal_mode_set(terminal, 1006, 1);

        // 视觉第 21 行（0-based 20）中部：y = 20.5 × 15.5 = 317.75；cell 高取整成 16 会算出第 20 行
        const encoded = bindings.encodeMouseEvent(mouseEncoder, terminal, {
          action: 'press',
          button: 1,
          mods: 0,
          x: 5,
          y: 317.75,
          anyButtonPressed: true,
          screenWidth: 960,
          screenHeight: 640,
          cellWidth: 7.5,
          cellHeight: 15.5,
        });

        expect(encoded).toBe('\x1b[<0;1;21M');
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
    expect(findElementsByTag(screen, 'canvas').length).toBe(4);
    expect(renderer.getDebugState().lastDrawnRows).toEqual([0, 1]);

    const mainCanvas = findCanvasByLayer(screen, 'main');
    const cursorCanvas = findCanvasByLayer(screen, 'cursor');
    expect(mainCanvas).toBeTruthy();
    expect(cursorCanvas).toBeTruthy();
    expect(
      mainCanvas?.context.operations.some(
        (operation) =>
          operation.type === 'fillText' &&
          (operation.text === 'A' ||
            operation.text === 'B' ||
            operation.text === 'C' ||
            operation.text === 'D')
      )
    ).toBeTruthy();
    expect(
      cursorCanvas?.context.operations.some((operation) => operation.type === 'fillRect')
    ).toBeTruthy();
    expect(
      cursorCanvas?.context.operations.some(
        (operation) =>
          operation.type === 'fillText' &&
          operation.text === 'D' &&
          operation.fillStyle === 'rgb(0 128 0)'
      )
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
        (operation) => operation.type === 'fillRect' && operation.fillStyle === 'rgb(34 34 34)'
      )
    ).toBeTruthy();

    renderer.dispose();
    expect(findElementsByTag(screen, 'canvas').length).toBe(0);
  });

  test('renders all cursor styles and honors blinking metadata', async () => {
    dom = installFakeDom();
    // Test files intentionally reload CanvasRenderer because module-level canvas state is isolated
    // per fake DOM instance; static import would share the prior test's constructors.
    const { CanvasRenderer } = await import(`./canvas-renderer.ts?cursor=${Date.now()}`);
    const screen = dom.document.createElement('div');
    dom.document.body.appendChild(screen);
    const renderer = new CanvasRenderer({
      screenElement: screen as unknown as HTMLElement,
      theme: TEST_THEME,
      fontFamily: 'monospace',
      fontSize: 13,
    });
    const cursorCanvas = findCanvasByLayer(screen, 'cursor');
    expect(cursorCanvas).toBeTruthy();
    const renderStyle = (
      style: GhosttyCursorVisualStyle,
      blinking = false,
      wideTail = false
    ) => {
      cursorCanvas?.context.operations.splice(0);
      renderer.render({
        meta: {
          cols: wideTail ? 2 : 1,
          rows: 1,
          dirty: 'full',
          colors: {
            background: { r: 17, g: 17, b: 17 },
            foreground: { r: 238, g: 238, b: 238 },
            cursor: { r: 255, g: 255, b: 255 },
            palette: Array.from({ length: 256 }, () => ({ r: 0, g: 0, b: 0 })),
          },
          cursor: {
            style,
            visible: true,
            blinking,
            passwordInput: false,
            x: wideTail ? 1 : 0,
            y: 0,
            wideTail,
          },
        },
        rows: [
          {
            y: 0,
            dirty: true,
            wrap: false,
            wrapContinuation: false,
            text: wideTail ? '界' : '',
            cells: wideTail
              ? [
                  {
                    x: 0,
                    text: '界',
                    codepoints: [0x754c],
                    widthKind: 'wide' as const,
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
                    text: '',
                    codepoints: [],
                    widthKind: 'spacer-tail' as const,
                    hasText: false,
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
          },
        ],
        cellDimensions: { width: 10, height: 20 },
      });
      return cursorCanvas?.context.operations ?? [];
    };
    const lastOperation = (operations: Array<Record<string, unknown>>, type: string) =>
      [...operations].reverse().find((operation) => operation.type === type);


    expect(lastOperation(renderStyle('block'), 'fillRect')).toMatchObject({
      x: 0,
      y: 0,
      width: 10,
      height: 20,
      globalAlpha: 1,
    });
    expect(
      (renderer as unknown as { cursorBlinkTimer: unknown }).cursorBlinkTimer
    ).toBeNull();
    expect(cursorCanvas?.style.opacity).toBe('1');

    expect(lastOperation(renderStyle('underline'), 'fillRect')).toMatchObject({
      x: 0,
      y: 18,
      width: 10,
      height: 2,
    });
    expect(lastOperation(renderStyle('bar'), 'fillRect')).toMatchObject({
      x: 0,
      y: 0,
      width: 2,
      height: 20,
    });
    expect(lastOperation(renderStyle('block-hollow'), 'strokeRect')).toMatchObject({
      x: 0.5,
      y: 0.5,
      width: 9,
      height: 19,
    });

    const wideOperations = renderStyle('block', false, true);
    expect(lastOperation(wideOperations, 'fillRect')).toMatchObject({
      x: 0,
      y: 0,
      width: 20,
      height: 20,
    });
    expect(lastOperation(wideOperations, 'fillText')).toMatchObject({
      text: '界',
      x: 0,
    });

    renderStyle('block', true);
    expect(
      (renderer as unknown as { cursorBlinkTimer: unknown }).cursorBlinkTimer
    ).not.toBeNull();
    renderer.dispose();
    expect(
      (renderer as unknown as { cursorBlinkTimer: unknown }).cursorBlinkTimer
    ).toBeNull();
  });

  test('draws on integer device pixels with fractional cell size and dpr', async () => {
    dom = installFakeDom();
    const previousDpr = (globalThis as any).devicePixelRatio;
    (globalThis as any).devicePixelRatio = 2;

    try {
      const { CanvasRenderer } = await import(`./canvas-renderer.ts?renderer-dpr=${Date.now()}`);
      const screen = dom.document.createElement('div');
      dom.document.body.appendChild(screen);

      const renderer = new CanvasRenderer({
        screenElement: screen as unknown as HTMLElement,
        theme: TEST_THEME,
        fontFamily: 'monospace',
        fontSize: 13,
      });

      const cellStyle = {
        bold: false,
        italic: false,
        faint: false,
        blink: false,
        inverse: false,
        invisible: false,
        strikethrough: false,
        overline: false,
        underline: 0,
      };
      renderer.render({
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
            y: 1,
            dirty: true,
            wrap: false,
            wrapContinuation: false,
            text: 'AB',
            cells: [
              {
                x: 1,
                text: 'A',
                codepoints: [65],
                widthKind: 'narrow' as const,
                hasText: true,
                style: cellStyle,
                fgColor: null,
                bgColor: { r: 0, g: 128, b: 0 },
              },
              {
                x: 2,
                text: 'B',
                codepoints: [66],
                widthKind: 'narrow' as const,
                hasText: true,
                style: { ...cellStyle, underline: 1, strikethrough: true },
                fgColor: null,
                bgColor: null,
              },
            ],
          },
        ],
        // 模拟真实度量：13px * 1.2 行高 = 15.6，等宽字符 advance 带小数
        cellDimensions: { width: 9.55, height: 15.6 },
        selectionRects: [{ row: 0, x: 1, width: 2 }],
      });

      // deviceCell = round(9.55 * 2) x round(15.6 * 2) = 19 x 31
      const mainCanvas = findCanvasByLayer(screen, 'main');
      expect(mainCanvas?.width).toBe(4 * 19);
      expect(mainCanvas?.height).toBe(2 * 31);
      expect(mainCanvas?.style.width).toBe(`${(4 * 19) / 2}px`);

      const layers = ['main', 'selection', 'cursor'] as const;
      for (const layer of layers) {
        const canvas = findCanvasByLayer(screen, layer);
        const drawOps =
          canvas?.context.operations.filter(
            (operation) => operation.type === 'fillRect' || operation.type === 'fillText'
          ) ?? [];
        if (layer !== 'cursor') {
          expect(drawOps.length).toBeGreaterThan(0);
        }
        for (const operation of drawOps) {
          expect(Number.isInteger(operation.x)).toBeTrue();
          expect(Number.isInteger(operation.y)).toBeTrue();
          if (operation.type === 'fillRect') {
            expect(Number.isInteger(operation.width)).toBeTrue();
            expect(Number.isInteger(operation.height)).toBeTrue();
          }
        }
      }

      // 字号按 dpr 放大，与物理坐标系匹配
      const textOp = mainCanvas?.context.operations.find(
        (operation) => operation.type === 'fillText'
      );
      expect(String(textOp?.font)).toContain('26px');

      renderer.dispose();
    } finally {
      (globalThis as any).devicePixelRatio = previousDpr;
    }
  });

  test('block elements are drawn as exact cell rects instead of font glyphs', async () => {
    dom = installFakeDom();
    const { CanvasRenderer } = await import(`./canvas-renderer.ts?renderer-block=${Date.now()}`);
    const screen = dom.document.createElement('div');
    dom.document.body.appendChild(screen);

    const renderer = new CanvasRenderer({
      screenElement: screen as unknown as HTMLElement,
      theme: TEST_THEME,
      fontFamily: 'monospace',
      fontSize: 13,
    });

    const cellStyle = {
      bold: false,
      italic: false,
      faint: false,
      blink: false,
      inverse: false,
      invisible: false,
      strikethrough: false,
      overline: false,
      underline: 0,
    };
    const blockCell = (x: number, codepoint: number) => ({
      x,
      text: String.fromCodePoint(codepoint),
      codepoints: [codepoint],
      widthKind: 'narrow' as const,
      hasText: true,
      style: cellStyle,
      fgColor: { r: 255, g: 255, b: 255 },
      bgColor: null,
    });

    renderer.render({
      meta: {
        cols: 4,
        rows: 1,
        dirty: 'full' as const,
        colors: {
          background: { r: 17, g: 17, b: 17 },
          foreground: { r: 238, g: 238, b: 238 },
          cursor: null,
          palette: Array.from({ length: 256 }, () => ({ r: 0, g: 0, b: 0 })),
        },
        cursor: {
          style: 'block' as const,
          visible: false,
          blinking: false,
          passwordInput: false,
          x: null,
          y: null,
          wideTail: false,
        },
      },
      rows: [
        {
          y: 0,
          dirty: true,
          wrap: false,
          wrapContinuation: false,
          text: '▀█▐░',
          cells: [
            blockCell(0, 0x2580),
            blockCell(1, 0x2588),
            blockCell(2, 0x2590),
            blockCell(3, 0x2591),
          ],
        },
      ],
      cellDimensions: { width: 10, height: 20 },
    });

    const operations = findCanvasByLayer(screen, 'main')?.context.operations ?? [];
    expect(operations.filter((operation) => operation.type === 'fillText')).toEqual([]);

    const white = operations.filter(
      (operation) => operation.type === 'fillRect' && operation.fillStyle === 'rgb(255 255 255)'
    );
    const whiteRect = (x: number, y: number, width: number, height: number, globalAlpha = 1) => ({
      type: 'fillRect',
      x,
      y,
      width,
      height,
      fillStyle: 'rgb(255 255 255)',
      globalAlpha,
    });
    expect(white).toEqual([
      whiteRect(0, 0, 10, 10), // ▀ 上半块
      whiteRect(10, 0, 10, 20), // █ 全块
      whiteRect(25, 0, 5, 20), // ▐ 右半块
      whiteRect(30, 0, 10, 20, 0.25), // ░ 前景色 25% alpha 全块
    ]);

    renderer.dispose();
  });

  // issue45 bug 3 红测：dpr 变化 → resize() canvas.width=width 清空 bitmap（HTML5 标准）
  // + dirty='clean' 早退 return（canvas-renderer.ts:158-161）→ 终端空白。
  // 根因见 .sisyphus/evidence/task-1-bug3-trigger-report.md，修复在 Task 8 GREEN。

  test('issue45 bug3 (RED): dpr change + dirty=clean should still redraw all rows', async () => {
    const previousDpr = (globalThis as any).devicePixelRatio;
    (globalThis as any).devicePixelRatio = 1;
    try {
      dom = installFakeDom();
      const { CanvasRenderer } = await import(
        `./canvas-renderer.ts?issue45-red-clean=${Date.now()}`
      );
      const screen = dom.document.createElement('div');
      dom.document.body.appendChild(screen);

      const renderer = new CanvasRenderer({
        screenElement: screen as unknown as HTMLElement,
        theme: TEST_THEME,
        fontFamily: 'monospace',
        fontSize: 13,
      });

      const cellStyle = {
        bold: false,
        italic: false,
        faint: false,
        blink: false,
        inverse: false,
        invisible: false,
        strikethrough: false,
        overline: false,
        underline: 0,
      };
      const buildRow = (y: number, chars: string, dirty: boolean) => ({
        y,
        dirty,
        wrap: false,
        wrapContinuation: false,
        text: chars,
        cells: chars.split('').map((ch, i) => ({
          x: i,
          text: ch,
          codepoints: [ch.codePointAt(0) ?? 32],
          widthKind: 'narrow' as const,
          hasText: true,
          style: cellStyle,
          fgColor: null,
          bgColor: null,
        })),
      });
      const buildFrame = (dirty: 'full' | 'partial' | 'clean') => ({
        meta: {
          cols: 2,
          rows: 2,
          dirty,
          colors: {
            background: { r: 17, g: 17, b: 17 },
            foreground: { r: 238, g: 238, b: 238 },
            cursor: null,
            palette: Array.from({ length: 256 }, () => ({ r: 0, g: 0, b: 0 })),
          },
          cursor: {
            style: 'block' as const,
            visible: false,
            blinking: false,
            passwordInput: false,
            x: null,
            y: null,
            wideTail: false,
          },
        },
        rows: [buildRow(0, 'AB', dirty !== 'clean'), buildRow(1, 'CD', dirty !== 'clean')],
        cellDimensions: { width: 10, height: 20 },
      });

      renderer.render(buildFrame('full'));
      expect(renderer.getDebugState().lastDrawnRows).toEqual([0, 1]);

      // 模拟 dpr 变化：下次 render 时 resize() 会清空 canvas bitmap
      (globalThis as any).devicePixelRatio = 2;

      // dpr 变化不通知 ghostty 内核 → dirty='clean'；当前实现早退不重画（red）
      renderer.render(buildFrame('clean'));
      const drawnAfterWipe = renderer.getDebugState().lastDrawnRows;
      expect(drawnAfterWipe).toContain(0);
      expect(drawnAfterWipe).toContain(1);

      renderer.dispose();
    } finally {
      (globalThis as any).devicePixelRatio = previousDpr;
    }
  });

  test('issue45 bug3 (GUARD): dpr unchanged + dirty=partial should only redraw the dirty row', async () => {
    // 反向验证：dpr 不变（resize 早退）+ dirty='partial' → 只画脏行。应通过，
    // 证明 Task 8 GREEN 修复不破坏 partial 重绘优化。
    const previousDpr = (globalThis as any).devicePixelRatio;
    (globalThis as any).devicePixelRatio = 1;
    try {
      dom = installFakeDom();
      const { CanvasRenderer } = await import(
        `./canvas-renderer.ts?issue45-guard-partial=${Date.now()}`
      );
      const screen = dom.document.createElement('div');
      dom.document.body.appendChild(screen);

      const renderer = new CanvasRenderer({
        screenElement: screen as unknown as HTMLElement,
        theme: TEST_THEME,
        fontFamily: 'monospace',
        fontSize: 13,
      });

      const cellStyle = {
        bold: false,
        italic: false,
        faint: false,
        blink: false,
        inverse: false,
        invisible: false,
        strikethrough: false,
        overline: false,
        underline: 0,
      };
      const buildRow = (y: number, chars: string, dirty: boolean) => ({
        y,
        dirty,
        wrap: false,
        wrapContinuation: false,
        text: chars,
        cells: chars.split('').map((ch, i) => ({
          x: i,
          text: ch,
          codepoints: [ch.codePointAt(0) ?? 32],
          widthKind: 'narrow' as const,
          hasText: true,
          style: cellStyle,
          fgColor: null,
          bgColor: null,
        })),
      });
      const baseMeta = {
        cols: 2,
        rows: 2,
        colors: {
          background: { r: 17, g: 17, b: 17 },
          foreground: { r: 238, g: 238, b: 238 },
          cursor: null,
          palette: Array.from({ length: 256 }, () => ({ r: 0, g: 0, b: 0 })),
        },
        cursor: {
          style: 'block' as const,
          visible: false,
          blinking: false,
          passwordInput: false,
          x: null,
          y: null,
          wideTail: false,
        },
      };

      renderer.render({
        meta: { ...baseMeta, dirty: 'full' as const },
        rows: [buildRow(0, 'AB', true), buildRow(1, 'CD', true)],
        cellDimensions: { width: 10, height: 20 },
      });
      expect(renderer.getDebugState().lastDrawnRows).toEqual([0, 1]);

      renderer.render({
        meta: { ...baseMeta, dirty: 'partial' as const },
        rows: [buildRow(0, 'AB', false), buildRow(1, 'CD', true)],
        cellDimensions: { width: 10, height: 20 },
      });
      expect(renderer.getDebugState().lastDrawnRows).toEqual([1]);

      renderer.dispose();
    } finally {
      (globalThis as any).devicePixelRatio = previousDpr;
    }
  });
});

describe('SelectionModel', () => {
  test('supports character drag, word double click, line triple click and serialization', async () => {
    const {
      createEmptySelectionState,
      lineModelFromText,
      projectSelectionRects,
      resolvePointerSelection,
      serializeSelectionText,
      updateSelectionFocus,
    } = await import(`./selection-model.ts?selection=${Date.now()}`);

    const lineProvider = (line: number) =>
      lineModelFromText(
        (
          {
            10: 'dragtarget',
            11: 'dbltoken keep',
            12: 'tripline',
          } as Record<number, string>
        )[line] ?? ''
      );

    let selection = resolvePointerSelection(
      createEmptySelectionState(),
      {
        line: 10,
        col: 0,
        mode: 'character',
      },
      lineProvider
    );
    selection = updateSelectionFocus(selection, { line: 10, col: 9 }, lineProvider);
    expect(serializeSelectionText(selection, lineProvider)).toBe('dragtarget');

    const wordSelection = resolvePointerSelection(
      createEmptySelectionState(),
      {
        line: 11,
        col: 2,
        mode: 'word',
      },
      lineProvider
    );
    expect(serializeSelectionText(wordSelection, lineProvider)).toBe('dbltoken');

    const lineSelection = resolvePointerSelection(
      createEmptySelectionState(),
      {
        line: 12,
        col: 3,
        mode: 'line',
      },
      lineProvider
    );
    expect(serializeSelectionText(lineSelection, lineProvider)).toBe('tripline');

    const multiLine = updateSelectionFocus(
      resolvePointerSelection(
        createEmptySelectionState(),
        {
          line: 10,
          col: 4,
          mode: 'character',
        },
        lineProvider
      ),
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

describe('GhosttyTerminalController clipboard and selection API', () => {
  let dom: ReturnType<typeof installFakeDom> | null = null;
  let importVersion = 1000;

  afterEach(() => {
    dom?.restore();
    dom = null;
    mock.restore();
  });

  async function setupTerminal(bindings: FakeBindings) {
    importVersion += 1;
    const { createTerminalController } = await loadControllerModule(bindings, importVersion);
    const terminal = await createTerminalController({
      theme: TEST_THEME,
      fontFamily: 'monospace',
      fontSize: 13,
      scrollback: 1000,
    });
    const container = dom!.document.createElement('div');
    container.setBoundingClientRect({ width: 960, height: 480 });
    dom!.document.body.appendChild(container);
    terminal.open(container as unknown as HTMLElement);

    const textarea = findElementsByTag(dom!.document.body, 'div').find(
      (el) => el.className === 'xterm-helper-textarea'
    );
    expect(textarea).toBeDefined();

    const received: string[] = [];
    terminal.onData((data: string) => {
      received.push(data);
    });

    return { terminal, textarea: textarea as FakeElement, received };
  }

  test('copy shortcut should copy once, clear selection, then let Ctrl+C reach the terminal', async () => {
    dom = installFakeDom();
    const bindings = createFakeBindings();
    const writes: string[] = [];
    (
      (globalThis as any).navigator.clipboard as { writeText: (text: string) => Promise<void> }
    ).writeText = async (text: string) => {
      writes.push(text);
    };

    const { terminal, textarea, received } = await setupTerminal(bindings);

    expect(terminal.startTouchSelection(4, 4, 'word')).toBeTrue();
    expect(terminal.getSelection()).toBe('mock-canvas-line');

    const firstCtrlC: FakeEvent = { type: 'keydown', key: 'c', code: 'KeyC', ctrlKey: true };
    textarea.dispatchEvent(firstCtrlC);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(firstCtrlC.defaultPrevented).toBeTrue();
    expect(writes).toEqual(['mock-canvas-line']);
    expect(terminal.hasSelection()).toBeFalse();
    expect(received).toEqual([]);

    const secondCtrlC: FakeEvent = { type: 'keydown', key: 'c', code: 'KeyC', ctrlKey: true };
    textarea.dispatchEvent(secondCtrlC);

    expect(secondCtrlC.defaultPrevented).toBeTrue();
    expect(received).toEqual(['key:press:22:0']);
  });

  test('paste shortcuts should bypass key encoding so the browser paste event flows through', async () => {
    dom = installFakeDom();
    const bindings = createFakeBindings();
    bindings.encodePaste = (_terminal: number, data: string) => `paste:${data}`;

    const { textarea, received } = await setupTerminal(bindings);

    const ctrlV: FakeEvent = { type: 'keydown', key: 'v', code: 'KeyV', ctrlKey: true };
    textarea.dispatchEvent(ctrlV);
    expect(ctrlV.defaultPrevented).toBeFalse();

    const shiftInsert: FakeEvent = {
      type: 'keydown',
      key: 'Insert',
      code: 'Insert',
      shiftKey: true,
    };
    textarea.dispatchEvent(shiftInsert);
    expect(shiftInsert.defaultPrevented).toBeFalse();

    expect(received).toEqual([]);

    const pasteEvent: FakeEvent = {
      type: 'paste',
      clipboardData: { getData: () => 'hello world' },
    };
    textarea.dispatchEvent(pasteEvent);

    expect(pasteEvent.defaultPrevented).toBeTrue();
    expect(received).toEqual(['paste:hello world']);
  });

  test('touch selection API should drive selection state and notify listeners', async () => {
    dom = installFakeDom();
    const bindings = createFakeBindings();
    const { terminal } = await setupTerminal(bindings);

    const notifications: Array<string | null> = [];
    const disposable = terminal.onSelectionChange((text: string | null) => {
      notifications.push(text);
    });

    expect(terminal.startTouchSelection(4, 4, 'word')).toBeTrue();
    terminal.updateTouchSelection(40, 4);
    terminal.endTouchSelection();
    // 选区渲染已改 rAF 调度：probe/通知在下一帧落地
    await dom?.flushAnimationFrames();

    expect(terminal.hasSelection()).toBeTrue();
    expect(terminal.getSelection()).toBe('mock-canvas-line');
    expect(notifications).toEqual(['mock-canvas-line']);

    terminal.clearSelection();

    expect(terminal.hasSelection()).toBeFalse();
    expect(terminal.getSelection()).toBe('');
    expect(notifications).toEqual(['mock-canvas-line', null]);

    disposable.dispose();
  });

  // Bug 1: resize cols/rows 未变时不应清 selection（geometry effect 抖动导致无效 resize）
  test('resize with unchanged cols/rows should preserve selection', async () => {
    dom = installFakeDom();
    const bindings = createFakeBindings();
    const { terminal } = await setupTerminal(bindings);

    expect(terminal.startTouchSelection(4, 4, 'word')).toBeTrue();
    expect(terminal.hasSelection()).toBeTrue();

    const colsBefore = (terminal as any).cols;
    const rowsBefore = (terminal as any).rows;

    terminal.resize(colsBefore, rowsBefore);

    expect(terminal.hasSelection()).toBeTrue();
  });

  test('resize with changed cols/rows should clear selection', async () => {
    dom = installFakeDom();
    const bindings = createFakeBindings();
    const { terminal } = await setupTerminal(bindings);

    expect(terminal.startTouchSelection(4, 4, 'word')).toBeTrue();
    expect(terminal.hasSelection()).toBeTrue();

    const colsBefore = (terminal as any).cols;
    const rowsBefore = (terminal as any).rows;

    terminal.resize(colsBefore + 10, rowsBefore + 5);

    expect(terminal.hasSelection()).toBeFalse();
  });
});

describe('GhosttyTerminalController virtual history prepend', () => {
  let dom: ReturnType<typeof installFakeDom> | null = null;
  let importVersion = 3000;

  type ControllerInternals = {
    historyRows: GhosttyRenderRow[];
    virtualScroll: number;
    lastCursor: GhosttyRenderCursor;
    getLineModel(line: number): SelectionLineModel;
  };

  // 测试观察私有状态：结构已知、运行时检查无意义（unchecked cast）
  function internals(terminal: unknown): ControllerInternals {
    return terminal as ControllerInternals;
  }

  function makeHistoryRow(text: string, index: number): GhosttyRenderRow {
    return {
      y: index,
      dirty: true,
      wrap: false,
      wrapContinuation: false,
      text,
      cells: Array.from(text).map((char, x) => ({
        x,
        text: char,
        codepoints: [char.codePointAt(0) ?? 32],
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
        fgPaletteIndex: null,
        bgPaletteIndex: null,
      })),
    };
  }

  type ScrollCalls = {
    scrollTop: number;
    scrollBottom: number;
    deltas: number[];
    resets: number;
  };

  function createScrollableBindings(): {
    bindings: FakeBindings;
    scrollbar: { total: number; offset: number; len: number };
    calls: ScrollCalls;
  } {
    const scrollbar = { total: 60, offset: 0, len: 24 };
    const calls: ScrollCalls = { scrollTop: 0, scrollBottom: 0, deltas: [], resets: 0 };
    const bindings = createFakeBindings();
    bindings.readScrollbar = () => ({ ...scrollbar });
    bindings.scrollViewportDelta = (_terminal: number, amount: number) => {
      calls.deltas.push(amount);
      scrollbar.offset = Math.max(
        0,
        Math.min(scrollbar.total - scrollbar.len, scrollbar.offset + amount)
      );
    };
    bindings.scrollViewportTop = () => {
      calls.scrollTop += 1;
      scrollbar.offset = 0;
    };
    bindings.scrollViewportBottom = () => {
      calls.scrollBottom += 1;
      scrollbar.offset = Math.max(0, scrollbar.total - scrollbar.len);
    };
    bindings.resetTerminal = () => {
      calls.resets += 1;
      scrollbar.offset = 0;
      scrollbar.total = 24;
    };
    return { bindings, scrollbar, calls };
  }

  async function loadVirtualModule(bindings: FakeBindings, cursorY: number | null) {
    mock.restore();
    mock.module('./ghostty-wasm', () => {
      return {
        ...realGhosttyWasmSnapshot,
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
        cells:
          index === 0
            ? [
                {
                  x: 0,
                  text: 'mock-canvas-line',
                  codepoints: Array.from('mock-canvas-line').map(
                    (char) => char.codePointAt(0) ?? 32
                  ),
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
        readRenderDirtyState: () => 'full' as const,
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
            visible: cursorY !== null,
            blinking: false,
            passwordInput: false,
            x: cursorY === null ? null : 3,
            y: cursorY,
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

    return import(`./terminal.ts?virtual=${importVersion}`);
  }

  async function setup(cursorY: number | null = null) {
    dom = installFakeDom();
    const { bindings, scrollbar, calls } = createScrollableBindings();
    importVersion += 1;
    const { createTerminalController } = await loadVirtualModule(bindings, cursorY);
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
    return { terminal, scrollbar, calls };
  }

  test('prepend 后合成 scrollbar 数值（total/offset 加 H），不触发重建', async () => {
    const { terminal, calls } = await setup();
    terminal.prependHistoryRows([makeHistoryRow('hist-A', 0), makeHistoryRow('hist-B', 1)]);
    await dom?.flushAnimationFrames();

    expect(terminal.buffer.active.viewportY).toBe(2); // offset' = H + wasmOffset
    expect(terminal.buffer.active.length).toBe(62); // total' = total + H
    expect(terminal.buffer.active.baseY).toBe(38); // total' - len'
    expect(calls.resets).toBe(0);
  });

  test('向上滚跨界进入历史区：先 WASM 内滚动，到顶后增 virtualScroll，行号与视口拼接正确', async () => {
    const { terminal, scrollbar, calls } = await setup();
    terminal.prependHistoryRows([makeHistoryRow('hist-A', 0), makeHistoryRow('hist-B', 1)]);
    await dom?.flushAnimationFrames();

    scrollbar.offset = 36; // 最大 offset = total - len
    terminal.scrollLines(-5);
    await dom?.flushAnimationFrames();
    expect(terminal.buffer.active.viewportY).toBe(2 + 31); // H + wasmOffset，未进历史区

    terminal.scrollLines(-31); // offset 归零
    await dom?.flushAnimationFrames();
    terminal.scrollLines(-3); // 跨界：v = min(H=2, 3) = 2
    await dom?.flushAnimationFrames();

    expect(terminal.buffer.active.viewportY).toBe(0); // 合成顶
    expect(terminal.buffer.active.length).toBe(62); // total' = 60 + H
    // 视口拼接：前 v 行历史，其后 WASM 行
    expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe('hist-A');
    expect(terminal.buffer.active.getLine(1)?.translateToString(true)).toBe('hist-B');
    expect(terminal.buffer.active.getLine(2)?.translateToString(true)).toBe('mock-canvas-line');
    // getLineModel 负行号取历史行；越界为 EMPTY
    expect(internals(terminal).getLineModel(-1).colChars.join('')).toBe('hist-B');
    expect(internals(terminal).getLineModel(-2).colChars.join('')).toBe('hist-A');
    expect(internals(terminal).getLineModel(-3).colChars.length).toBe(0);
    expect(calls.deltas.slice(0, 2)).toEqual([-5, -31]);
    expect(calls.resets).toBe(0);
  });

  test('向下滚先消耗 virtualScroll，再进 WASM viewport；scrollToTop/scrollToBottom 复位', async () => {
    const { terminal, scrollbar, calls } = await setup();
    terminal.prependHistoryRows([makeHistoryRow('hist-A', 0), makeHistoryRow('hist-B', 1)]);
    await dom?.flushAnimationFrames();

    terminal.scrollToTop();
    expect(internals(terminal).virtualScroll).toBe(2);
    await dom?.flushAnimationFrames();

    terminal.scrollLines(1); // 全部消耗在虚拟区
    expect(internals(terminal).virtualScroll).toBe(1);
    const deltasBefore = calls.deltas.length;
    terminal.scrollLines(3); // 消耗 1 + WASM 滚 2
    expect(internals(terminal).virtualScroll).toBe(0);
    expect(calls.deltas.length).toBe(deltasBefore + 1);
    expect(calls.deltas[deltasBefore]).toBe(2);
    expect(scrollbar.offset).toBe(2);

    terminal.scrollToBottom();
    expect(internals(terminal).virtualScroll).toBe(0);
    expect(calls.scrollBottom).toBe(1);
    expect(scrollbar.offset).toBe(36); // total - len
    await dom?.flushAnimationFrames();

    terminal.scrollToTop();
    expect(internals(terminal).virtualScroll).toBe(2);
    expect(calls.scrollTop).toBe(2); // 本测试开头已调过一次
    await dom?.flushAnimationFrames();
    expect(terminal.buffer.active.viewportY).toBe(0);
    expect(calls.resets).toBe(0);
  });

  test('reset 清空前插历史与 virtualScroll', async () => {
    const { terminal, calls } = await setup();
    terminal.prependHistoryRows([makeHistoryRow('hist-A', 0), makeHistoryRow('hist-B', 1)]);
    terminal.scrollToTop();
    await dom?.flushAnimationFrames();
    expect(internals(terminal).historyRows.length).toBe(2);

    terminal.reset();
    expect(calls.resets).toBe(1);
    await dom?.flushAnimationFrames();

    expect(internals(terminal).historyRows.length).toBe(0);
    expect(internals(terminal).virtualScroll).toBe(0);
    expect(internals(terminal).getLineModel(-1).colChars.length).toBe(0);
    expect(terminal.buffer.active.viewportY).toBe(0);
    expect(terminal.buffer.active.length).toBe(24);
  });

  test('cols 变化 resize 清空前插历史并复位 virtualScroll', async () => {
    const { terminal } = await setup();
    terminal.prependHistoryRows([makeHistoryRow('hist-A', 0)]);
    terminal.scrollToTop();
    await dom?.flushAnimationFrames();
    expect(internals(terminal).historyRows.length).toBe(1);

    terminal.resize(90, 24); // cols 变化
    await dom?.flushAnimationFrames();
    expect(internals(terminal).historyRows.length).toBe(0);
    expect(internals(terminal).virtualScroll).toBe(0);
    expect(internals(terminal).getLineModel(-1).colChars.length).toBe(0);
    expect(terminal.buffer.active.viewportY).toBe(0);
  });

  test('混合视口光标合成：y + v，超出视口隐藏', async () => {
    const visible = await setup(0);
    visible.terminal.prependHistoryRows([makeHistoryRow('hist-A', 0), makeHistoryRow('hist-B', 1)]);
    visible.terminal.scrollToTop(); // v = 2
    await dom?.flushAnimationFrames();
    expect(internals(visible.terminal).lastCursor).toMatchObject({ visible: true, y: 2 });

    const hidden = await setup(23);
    hidden.terminal.prependHistoryRows([makeHistoryRow('hist-A', 0), makeHistoryRow('hist-B', 1)]);
    hidden.terminal.scrollToTop(); // v = 2，cursorY = 23 + 2 >= 24
    await dom?.flushAnimationFrames();
    expect(internals(hidden.terminal).lastCursor).toMatchObject({ visible: false, y: null });
  });
});
