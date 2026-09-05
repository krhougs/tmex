import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test';
import * as realGhosttyWasm from './ghostty-wasm';
import * as realRenderState from './render-state';
// mock.module 前的导出值快照：namespace import 是 live binding，mock 生效后
// realGhosttyWasm.* 会跟着变成 fake，还原必须用 mock 前拷出的值。
const realGhosttyWasmSnapshot = { ...realGhosttyWasm };
const realRenderStateSnapshot = { ...realRenderState };
import type { GhosttyTheme } from './types';

// issue-45 bug 4-C 红测：syncTextareaPositionToCursor 路径不应消费 dirty。
// 当前 terminal.ts:1409 会调 updateRenderState → rAF 漏画；Task 9 改读 lastCursor 后转绿。

type FakeEvent = {
  type: string;
  data?: string | null;
  inputType?: string;
  isComposing?: boolean;
  keyCode?: number;
  key?: string;
  code?: string;
  button?: number;
  buttons?: number;
  clientX?: number;
  clientY?: number;
  deltaY?: number;
  deltaMode?: number;
  detail?: number;
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
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
    this.parentElement = null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  addEventListener(type: string, listener: EventListener): void {
    const arr = this.listeners.get(type) ?? [];
    arr.push(listener);
    this.listeners.set(type, arr);
  }

  removeEventListener(type: string, listener: EventListener): void {
    const arr = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      arr.filter((fn) => fn !== listener)
    );
  }

  dispatchEvent(event: FakeEvent): boolean {
    event.target ??= this as unknown as EventTarget;
    event.currentTarget = this as unknown as EventTarget;
    event.defaultPrevented ??= false;
    event.preventDefault ??= (() => {
      event.defaultPrevented = true;
    });
    for (const listener of this.listeners.get(event.type) ?? []) {
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

class FakeCanvasContext2D {
  fillStyle = '';
  strokeStyle = '';
  font = '';
  lineWidth = 1;
  textBaseline = 'top';
  imageSmoothingEnabled = false;
  globalAlpha = 1;
  operations: Array<Record<string, unknown>> = [];

  clearRect(): void {}
  fillRect(): void {}
  fillText(text: string): void {
    this.operations.push({ type: 'fillText', text });
  }
  strokeRect(): void {}
  setTransform(): void {}
  measureText(): {
    width: number;
    fontBoundingBoxAscent: number;
    fontBoundingBoxDescent: number;
    actualBoundingBoxAscent: number;
    actualBoundingBoxDescent: number;
  } {
    return {
      width: 8,
      fontBoundingBoxAscent: 10,
      fontBoundingBoxDescent: 4,
      actualBoundingBoxAscent: 9,
      actualBoundingBoxDescent: 3,
    };
  }
}

class FakeCanvasElement extends FakeElement {
  width = 0;
  height = 0;
  readonly context = new FakeCanvasContext2D();

  getContext(): FakeCanvasContext2D {
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

class FakeWindowTarget {
  document: FakeDocument;
  innerWidth = 1280;
  innerHeight = 720;
  private listeners = new Map<string, EventListener[]>();

  constructor(document: FakeDocument) {
    this.document = document;
  }

  addEventListener(type: string, listener: EventListener): void {
    const arr = this.listeners.get(type) ?? [];
    arr.push(listener);
    this.listeners.set(type, arr);
  }

  removeEventListener(type: string, listener: EventListener): void {
    const arr = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      arr.filter((fn) => fn !== listener)
    );
  }

  dispatchEvent(event: FakeEvent): boolean {
    event.target ??= this as unknown as EventTarget;
    event.currentTarget = this as unknown as EventTarget;
    event.defaultPrevented ??= false;
    event.preventDefault ??= (() => {
      event.defaultPrevented = true;
    });
    for (const listener of this.listeners.get(event.type) ?? []) {
      listener(event);
    }
    return !event.defaultPrevented;
  }
}

type FakeBindings = {
  createTerminal: (...args: any[]) => number;
  setTerminalTheme: (...args: any[]) => void;
  setDefaultCursorBlink: (...args: any[]) => void;
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
};

function createFakeBindings(): FakeBindings {
  return {
    createTerminal: () => 1,
    setTerminalTheme: () => {},
    setDefaultCursorBlink: () => {},
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
    scrollViewportDelta: () => {},
    scrollViewportTop: () => {},
    scrollViewportBottom: () => {},
    isTerminalModeEnabled: () => false,
    setTerminalMode: () => {},
    encodePaste: () => '',
    encodeKeyEvent: () => '',
    encodeMouseEvent: () => null,
    formatViewport: () => '',
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
  const prev = new Map<string, unknown>();
  const rafQueue = new Map<number, RafCallback>();
  const cancelledFrames: number[] = [];
  let nextFrameId = 1;

  const stash = (key: string): void => prev.set(key, (globalThis as any)[key]);
  stash('document');
  stash('window');
  stash('navigator');
  stash('HTMLElement');
  stash('HTMLCanvasElement');
  stash('HTMLTextAreaElement');
  stash('HTMLDivElement');
  stash('MouseEvent');
  stash('WheelEvent');
  stash('devicePixelRatio');
  prev.set('requestAnimationFrame', globalThis.requestAnimationFrame);
  prev.set('cancelAnimationFrame', globalThis.cancelAnimationFrame);

  (globalThis as any).document = document;
  (globalThis as any).window = windowTarget;
  (globalThis as any).navigator = {
    clipboard: { readText: async () => '', writeText: async () => {} },
  };
  (globalThis as any).HTMLElement = FakeElement;
  (globalThis as any).HTMLCanvasElement = FakeCanvasElement;
  (globalThis as any).HTMLTextAreaElement = FakeElement;
  (globalThis as any).HTMLDivElement = FakeElement;
  (globalThis as any).MouseEvent = class {
    constructor() {}
  };
  (globalThis as any).WheelEvent = class {
    constructor() {}
  };
  (globalThis as any).devicePixelRatio = 1;
  globalThis.requestAnimationFrame = ((cb: RafCallback) => {
    const id = nextFrameId;
    nextFrameId += 1;
    rafQueue.set(id, cb);
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
      for (const [id, cb] of queued) {
        if (!cancelledFrames.includes(id)) {
          cb(0);
        }
      }
    },
    pendingAnimationFrames(): number {
      return rafQueue.size;
    },
    cancelledFrames,
    restore(): void {
      for (const [k, v] of prev.entries()) {
        (globalThis as any)[k] = v;
      }
    },
  };
}

// mock updateRenderState 为计数 spy，靠 composition 派发前后调用增量断言 syncTextarea 路径。
interface UpdateRenderStateCall {
  state: unknown;
  terminal: unknown;
}

async function loadControllerModule(
  bindings: FakeBindings,
  version: number,
  calls: UpdateRenderStateCall[]
) {
  mock.restore();
  mock.module('./ghostty-wasm', () => ({
    ...realGhosttyWasmSnapshot,
    keyboardEventToGhosttyMods: () => 0,
    getGhosttyBindings: async () => bindings,
  }));

  const cursor = {
    style: 'block' as const,
    visible: true,
    blinking: false,
    passwordInput: false,
    x: 1,
    y: 0,
    wideTail: false,
  };

  mock.module('./render-state', () => ({
    createRenderState: () => ({
      snapshotVersion: 0,
      disposed: false,
      rowIteratorHandle: 7,
      rowCellsHandle: 8,
      renderStateHandle: 9,
      bindings,
      cachedMeta: null,
    }),
    updateRenderState: (state: { snapshotVersion: number }, terminal: unknown) => {
      state.snapshotVersion += 1;
      calls.push({ state, terminal });
    },
    readRenderDirtyState: () => 'full' as const,
    readRenderSnapshotMeta: () => ({
      cols: 80,
      rows: 24,
      dirty: 'full',
      colors: {
        background: { r: 17, g: 17, b: 17 },
        foreground: { r: 238, g: 238, b: 238 },
        cursor: { r: 255, g: 255, b: 255 },
        palette: Array.from({ length: 256 }, () => ({ r: 0, g: 0, b: 0 })),
      },
      cursor,
    }),
    iterateRows: function* () {},
    disposeRenderStateResources: (state: { disposed: boolean }) => {
      state.disposed = true;
    },
  }));

  return import(`./terminal.ts?issue45-ime-${version}`);
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

function findHelperTextarea(root: FakeElement | null): FakeElement | undefined {
  if (!root) return undefined;
  const stack = [root];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (!cur) continue;
    if (cur.className === 'xterm-helper-textarea') return cur;
    stack.push(...cur.children);
  }
  return undefined;
}

// bun 的 mock.module 是全局持久的（mock.restore 不还原），文件跑完必须显式还原，
// 否则污染同一进程中后续测试文件（如 headless.test.ts 拿到 fake bindings）。
afterAll(() => {
  mock.module('./ghostty-wasm', () => ({ ...realGhosttyWasmSnapshot }));
  mock.module('./render-state', () => ({ ...realRenderStateSnapshot }));
});

describe('issue45 bug 4-C: syncTextareaPositionToCursor should not consume dirty', () => {
  let dom: ReturnType<typeof installFakeDom> | null = null;
  let importVersion = 0;

  afterEach(() => {
    dom?.restore();
    dom = null;
    mock.restore();
  });

  test('issue45 composition updateRenderState calls during composition are zero before rAF', async () => {
    dom = installFakeDom();
    const bindings = createFakeBindings();
    importVersion += 1;

    const updateCalls: UpdateRenderStateCall[] = [];
    const { createTerminalController } = await loadControllerModule(
      bindings,
      importVersion,
      updateCalls
    );

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

    const textarea = findHelperTextarea(dom.document.body);
    expect(textarea).toBeDefined();
    if (!textarea) return;

    // 红测时序：writeVt('A') → 排队 rAF → composition 事件 → rAF 触发前断言
    terminal.write('A');
    expect(dom.pendingAnimationFrames()).toBeGreaterThan(0);

    const baseline = updateCalls.length;

    // compositionstart/update → syncTextareaPositionToCursor（terminal.ts:1057/1061），
    // bug 路径每次会调 updateRenderState 消费 dirty；Task 9 改读 lastCursor 后转绿。
    textarea.dispatchEvent({ type: 'compositionstart', data: '' });
    textarea.dispatchEvent({ type: 'compositionupdate', data: 'n' });

    const callsDuringComposition = updateCalls.length - baseline;
    expect(callsDuringComposition).toBe(0);

    await dom.flushAnimationFrames();

    const callsAfterRaf = updateCalls.length - baseline;
    expect(callsAfterRaf).toBe(1);

    terminal.dispose();
  });

  test('issue45 syncTextarea path is exercised by composition events (sanity)', async () => {
    // 卫士：证明 composition 事件确实进 syncTextareaPositionToCursor（不然上面的红测形同虚设）
    dom = installFakeDom();
    const bindings = createFakeBindings();
    importVersion += 1;

    const updateCalls: UpdateRenderStateCall[] = [];
    const { createTerminalController } = await loadControllerModule(
      bindings,
      importVersion,
      updateCalls
    );

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

    const textarea = findHelperTextarea(dom.document.body);
    expect(textarea).toBeDefined();
    if (!textarea) return;

    const leftBefore = textarea.style.left;
    textarea.dispatchEvent({ type: 'compositionstart', data: '' });

    // syncTextareaPositionToCursor 被调用的证据：style.left 被改写（cursor.x=1）。
    expect(textarea.style.left).not.toEqual(leftBefore);
    expect(textarea.style.left).toMatch(/^[0-9.]+px$/);

    terminal.dispose();
  });
});
