import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test';
import * as realGhosttyWasm from './ghostty-wasm';
import * as realRenderState from './render-state';
// mock.module 前的导出值快照：namespace import 是 live binding，mock 生效后
// realGhosttyWasm.* 会跟着变成 fake，还原必须用 mock 前拷出的值。
const realGhosttyWasmSnapshot = { ...realGhosttyWasm };
const realRenderStateSnapshot = { ...realRenderState };
import type { GhosttyTheme } from './types';

// 跨 bug 干扰测试（issue #45 Task 12 场景 1）：bug 3（forceFullRepaint）× bug 4-C
// （syncTextareaPositionToCursor 改读 lastCursor 不消费 dirty）协同。
//
// Metis 担心：forceFullRepaint 标记被 IME composition 提前进 syncTextareaPositionToCursor
// 的路径消耗或污染，导致 forceFull 用了过时的 lastCursor / IME 位置错位。
//
// 验证点：
//   1. forceFullRepaint 标记在下一帧 render 一次性传给 renderer（forceFull=true），
//      即使 ghostty 报 dirty='clean' 也强制全画；下一帧无 forceFull 标记 → dirty='clean'
//      正常早退（一次性消费，不污染后续帧）。
//   2. forceFullRepaint 标记后触发 IME composition 事件，syncTextareaPositionToCursor
//      仍走 bug 4-C 路径（读 lastCursor，不调 updateRenderState 消费 dirty）；
//      flush rAF 后 forceFull render 正确执行 + lastCursor 被更新到新位置。
//
// 复用 terminal.canvas.test.ts / terminal.ime.issue45.test.ts 的 FakeDom 范式。

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
  fillRect(): void {
    this.operations.push({ type: 'fillRect' });
  }
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
    event.preventDefault ??= () => {
      event.defaultPrevented = true;
    };
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
    return { width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0 };
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

  private rect = { width: 0, height: 0, left: 0, top: 0 };
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
    event.preventDefault ??= () => {
      event.defaultPrevented = true;
    };
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
  restore: () => void;
} {
  const document = new FakeDocument();
  const windowTarget = new FakeWindowTarget(document);
  const prev = new Map<string, unknown>();
  const rafQueue = new Map<number, RafCallback>();
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
  (globalThis as any).MouseEvent = class {};
  (globalThis as any).WheelEvent = class {};
  (globalThis as any).devicePixelRatio = 1;
  globalThis.requestAnimationFrame = ((cb: RafCallback) => {
    const id = nextFrameId;
    nextFrameId += 1;
    rafQueue.set(id, cb);
    return id;
  }) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame;

  return {
    document,
    async flushAnimationFrames(): Promise<void> {
      const queued = [...rafQueue.entries()];
      rafQueue.clear();
      for (const [, cb] of queued) {
        cb(0);
      }
    },
    pendingAnimationFrames(): number {
      return rafQueue.size;
    },
    restore(): void {
      for (const [k, v] of prev.entries()) {
        (globalThis as any)[k] = v;
      }
    },
  };
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

// render-state mock 用可变状态，让单个测试能在 render 之间切换 dirty / cursor。
interface RenderStateMock {
  dirty: 'clean' | 'partial' | 'full';
  cursorX: number;
  cursorY: number;
  rowText: string;
}

interface UpdateRenderStateCall {
  snapshotVersion: number;
}

async function loadControllerModule(
  bindings: FakeBindings,
  version: number,
  state: RenderStateMock,
  updateCalls: UpdateRenderStateCall[]
) {
  mock.restore();

  mock.module('./ghostty-wasm', () => ({
    ...realGhosttyWasmSnapshot,
    keyboardEventToGhosttyMods: () => 0,
    getGhosttyBindings: async () => bindings,
  }));

  const buildRows = (rowText: string) => {
    const cells = Array.from(rowText).map((char, index) => ({
      x: index,
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
    }));
    return [
      {
        y: 0,
        dirty: true,
        wrap: false,
        wrapContinuation: false,
        text: rowText,
        cells,
      },
    ];
  };

  mock.module('./render-state', () => ({
    createRenderState: () => ({
      snapshotVersion: 0,
      disposed: false,
      rowIteratorHandle: 7,
      rowCellsHandle: 8,
      renderStateHandle: 9,
      bindings,
      cachedMetA: null,
    }),
    updateRenderState: (s: { snapshotVersion: number }) => {
      s.snapshotVersion += 1;
      updateCalls.push({ snapshotVersion: s.snapshotVersion });
    },
    readRenderDirtyState: () => state.dirty,
    readRenderSnapshotMeta: () => ({
      cols: 80,
      rows: 24,
      dirty: state.dirty,
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
        x: state.cursorX,
        y: state.cursorY,
        wideTail: false,
      },
    }),
    iterateRows: function* () {
      yield* buildRows(state.rowText);
    },
    disposeRenderStateResources: (s: { disposed: boolean }) => {
      s.disposed = true;
    },
  }));

  return import(`./terminal.ts?issue45-crossbug-${version}`);
}

function findElementsByTag(root: FakeElement | null, tagName: string): FakeElement[] {
  if (!root) return [];
  const results: FakeElement[] = [];
  const target = tagName.toUpperCase();
  const stack = [root];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (!cur) continue;
    if (cur.tagName === target) results.push(cur);
    stack.push(...cur.children);
  }
  return results;
}

function findHelperTextarea(root: FakeElement | null): FakeElement | undefined {
  const stack = [root];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (!cur) continue;
    if (cur.className === 'xterm-helper-textarea') return cur;
    stack.push(...cur.children);
  }
  return undefined;
}

function findMainCanvas(root: FakeElement | null): FakeCanvasElement | null {
  return (
    (findElementsByTag(root, 'canvas').find(
      (el) => (el as FakeCanvasElement).dataset.layer === 'main'
    ) as FakeCanvasElement | undefined) ?? null
  );
}

function countFillText(canvas: FakeCanvasElement | null): number {
  if (!canvas) return 0;
  return canvas.context.operations.filter((op) => op.type === 'fillText').length;
}

// bun 的 mock.module 是全局持久的（mock.restore 不还原），文件跑完必须显式还原，
// 否则污染同一进程中后续测试文件（如 headless.test.ts 拿到 fake bindings）。
afterAll(() => {
  mock.module('./ghostty-wasm', () => ({ ...realGhosttyWasmSnapshot }));
  mock.module('./render-state', () => ({ ...realRenderStateSnapshot }));
});

describe('issue45 cross-bug: bug 3 (forceFullRepaint) x bug 4-C (syncTextarea reads lastCursor)', () => {
  let dom: ReturnType<typeof installFakeDom> | null = null;
  let importVersion = 0;

  afterEach(() => {
    dom?.restore();
    dom = null;
    mock.restore();
  });

  test('forceFullRepaint forces full draw even when ghostty reports dirty=clean (bug 3) and is consumed once', async () => {
    dom = installFakeDom();
    const bindings = createFakeBindings();
    importVersion += 1;
    const state: RenderStateMock = {
      dirty: 'full',
      cursorX: 1,
      cursorY: 0,
      rowText: 'A',
    };
    const updateCalls: UpdateRenderStateCall[] = [];
    const { createTerminalController } = await loadControllerModule(
      bindings,
      importVersion,
      state,
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
    terminal.write('A');
    await dom.flushAnimationFrames();

    const mainCanvas = findMainCanvas(dom.document.body);
    expect(mainCanvas).not.toBeNull();
    if (!mainCanvas) return;
    const initialFillText = countFillText(mainCanvas);
    expect(initialFillText).toBeGreaterThan(0);

    // bug 3 触发条件：canvas 位图被 resize 清空但 ghostty 报 dirty='clean'。
    state.dirty = 'clean';
    mainCanvas.context.operations = [];

    // forceFullRepaint 同步执行 render（不等 rAF）：dirty='clean' 仍强制全画。
    terminal.forceFullRepaint();
    expect(countFillText(mainCanvas)).toBeGreaterThan(0);

    // forceFullNext 必须一次性消费：后续普通 render 在 dirty='clean' 下不再全画。
    mainCanvas.context.operations = [];
    terminal.write('B');
    await dom.flushAnimationFrames();

    expect(countFillText(mainCanvas)).toBe(0);

    terminal.dispose();
  });

  test('IME composition during pending forceFull does not consume dirty (bug 4-C) and forceFull render still fires', async () => {
    dom = installFakeDom();
    const bindings = createFakeBindings();
    importVersion += 1;
    const state: RenderStateMock = {
      dirty: 'full',
      cursorX: 1,
      cursorY: 0,
      rowText: 'A',
    };
    const updateCalls: UpdateRenderStateCall[] = [];
    const { createTerminalController } = await loadControllerModule(
      bindings,
      importVersion,
      state,
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
    terminal.write('A');
    await dom.flushAnimationFrames();

    const textarea = findHelperTextarea(dom.document.body);
    expect(textarea).toBeDefined();
    if (!textarea) return;

    const mainCanvas = findMainCanvas(dom.document.body);
    expect(mainCanvas).not.toBeNull();
    if (!mainCanvas) return;

    // 切到 bug 3 触发态：ghostty 报 clean，但 canvas 已被 resize 清空。
    state.dirty = 'clean';
    // 同时移动光标位置——验证 forceFull render 会更新 lastCursor 到新位置。
    state.cursorX = 5;
    state.cursorY = 2;

    const leftAfterInit = textarea.style.left;

    // 同步语义：forceFullRepaint 立即执行 render（bug 3：dirty='clean' 仍全画），
    // 并把 lastCursor 更新到 (5, 2)。
    const baseline = updateCalls.length;
    mainCanvas.context.operations = [];
    terminal.forceFullRepaint();
    expect(countFillText(mainCanvas)).toBeGreaterThan(0);
    expect(updateCalls.length - baseline).toBe(1);

    textarea.dispatchEvent({ type: 'compositionstart', data: '' });
    textarea.dispatchEvent({ type: 'compositionupdate', data: '你' });

    // bug 4-C：composition 期间 syncTextareaPositionToCursor 不调 updateRenderState
    //（不消费 dirty），只读 forceFull render 缓存的 lastCursor。
    expect(updateCalls.length - baseline).toBe(1);

    // lastCursor 已更新到 (5, 2)：composition 定位用最新光标而非过时缓存。
    textarea.dispatchEvent({ type: 'compositionupdate', data: '你好' });
    expect(textarea.style.left).not.toEqual(leftAfterInit);

    terminal.dispose();
  });
});
