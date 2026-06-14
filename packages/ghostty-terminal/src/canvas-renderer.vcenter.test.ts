// issue #17 回归测试：文字应垂直居中于 cell，而非贴 cell 顶端；下划线/上划线/
// 删除线随居中后的字形盒走。用记录绘制坐标的假 canvas context 做确定性断言。
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { CanvasRenderer } from './canvas-renderer';
import type {
  GhosttyCellDimensions,
  GhosttyRenderCell,
  GhosttyRenderCellStyle,
  GhosttyRenderRow,
  GhosttyRenderSnapshotMeta,
  GhosttyTheme,
} from './types';

type DrawOp = { type: string; x: number; y: number; width: number; height: number };

class FakeCtx {
  fillStyle = '';
  strokeStyle = '';
  font = '';
  textBaseline = 'top';
  imageSmoothingEnabled = false;
  globalAlpha = 1;
  ops: DrawOp[] = [];
  fillTextOps: Array<{ text: string; x: number; y: number }> = [];
  setTransform(): void {}
  clearRect(): void {}
  fillRect(x: number, y: number, width: number, height: number): void {
    this.ops.push({ type: 'fillRect', x, y, width, height });
  }
  fillText(text: string, x: number, y: number): void {
    this.fillTextOps.push({ text, x, y });
  }
  strokeRect(): void {}
}

class FakeCanvas {
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  width = 0;
  height = 0;
  readonly ctx = new FakeCtx();
  getContext(): FakeCtx {
    return this.ctx;
  }
  remove(): void {}
}

class FakeScreen {
  style: Record<string, string> = {};
  children: FakeCanvas[] = [];
  appendChild(child: FakeCanvas): void {
    this.children.push(child);
  }
}

const FONT_SIZE = 13;
const DEFAULT_STYLE: GhosttyRenderCellStyle = {
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

function makeCell(overrides: Partial<GhosttyRenderCellStyle>): GhosttyRenderCell {
  return {
    x: 0,
    text: 'M',
    codepoints: [0x4d], // 'M'——非块元素，走 fillText 分支
    widthKind: 'narrow',
    hasText: true,
    style: { ...DEFAULT_STYLE, ...overrides },
    fgColor: null,
    bgColor: null,
  };
}

function makeRow(y: number, style: Partial<GhosttyRenderCellStyle>): GhosttyRenderRow {
  return {
    y,
    dirty: true,
    wrap: false,
    wrapContinuation: false,
    text: 'M',
    cells: [makeCell(style)],
  };
}

function makeMeta(rows: number): GhosttyRenderSnapshotMeta {
  return {
    cols: 1,
    rows,
    dirty: 'full',
    colors: {
      background: { r: 0, g: 0, b: 0 },
      foreground: { r: 255, g: 255, b: 255 },
      cursor: null,
      palette: [],
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
  };
}

let previousDpr: unknown;
let previousDocument: unknown;

function setup(dpr: number, cellHeight: number) {
  (globalThis as { devicePixelRatio?: number }).devicePixelRatio = dpr;
  const created: FakeCanvas[] = [];
  (globalThis as { document?: unknown }).document = {
    createElement: () => {
      const canvas = new FakeCanvas();
      created.push(canvas);
      return canvas;
    },
  };
  const screen = new FakeScreen();
  const renderer = new CanvasRenderer({
    screenElement: screen as unknown as HTMLElement,
    theme: { selectionBackground: 'rgba(0,0,0,0.3)' } as unknown as GhosttyTheme,
    fontFamily: 'monospace',
    fontSize: FONT_SIZE,
  });
  const cellDimensions: GhosttyCellDimensions = { width: 8, height: cellHeight };
  // created[0] = mainCanvas（构造顺序 main/selection/cursor）
  return { renderer, mainCtx: created[0].ctx, cellDimensions };
}

beforeEach(() => {
  previousDpr = (globalThis as { devicePixelRatio?: unknown }).devicePixelRatio;
  previousDocument = (globalThis as { document?: unknown }).document;
});

afterEach(() => {
  (globalThis as { devicePixelRatio?: unknown }).devicePixelRatio = previousDpr;
  (globalThis as { document?: unknown }).document = previousDocument;
});

describe('canvas-renderer 垂直居中 (issue #17)', () => {
  test('正文 fillText 垂直居中于 cell，不贴顶', () => {
    const { renderer, mainCtx, cellDimensions } = setup(1, 15.6);
    renderer.render({ meta: makeMeta(1), rows: [makeRow(0, {})], cellDimensions });

    const deviceCellHeight = Math.round(15.6); // 16
    const deviceFontSize = FONT_SIZE; // dpr=1
    const expectedOffset = Math.round((deviceCellHeight - deviceFontSize) / 2); // 2

    const draw = mainCtx.fillTextOps.find((op) => op.text === 'M');
    expect(draw).toBeDefined();
    // 居中后的偏移：既不为 0（贴顶 = 旧 bug），又把多余 leading 上下基本均分
    expect(draw?.y).toBe(expectedOffset);
    expect(draw?.y).toBeGreaterThan(0);
    const topMargin = expectedOffset;
    const bottomMargin = deviceCellHeight - expectedOffset - deviceFontSize;
    expect(Math.abs(topMargin - bottomMargin)).toBeLessThanOrEqual(1);
  });

  test('高 DPI（dpr=2）下偏移按设备像素缩放', () => {
    const { renderer, mainCtx, cellDimensions } = setup(2, 15.6);
    renderer.render({ meta: makeMeta(1), rows: [makeRow(0, {})], cellDimensions });

    const deviceCellHeight = Math.round(15.6 * 2); // 31
    const deviceFontSize = FONT_SIZE * 2; // 26
    const expectedOffset = Math.round((deviceCellHeight - deviceFontSize) / 2); // 3

    const draw = mainCtx.fillTextOps.find((op) => op.text === 'M');
    expect(draw?.y).toBe(expectedOffset);
    expect(draw?.y).toBeGreaterThan(0);
  });

  test('偏移叠加到 cell 顶边（第 2 行）而非绝对 0', () => {
    const { renderer, mainCtx, cellDimensions } = setup(1, 15.6);
    renderer.render({ meta: makeMeta(2), rows: [makeRow(0, {}), makeRow(1, {})], cellDimensions });

    const deviceCellHeight = Math.round(15.6); // 16
    const expectedOffset = Math.round((deviceCellHeight - FONT_SIZE) / 2); // 2
    const secondRow = mainCtx.fillTextOps.find((op) => op.y >= deviceCellHeight);
    expect(secondRow?.y).toBe(deviceCellHeight + expectedOffset); // 18
  });

  test('装饰线随字形盒走：下划线贴字底、上划线贴字顶、删除线穿字中', () => {
    const deviceCellHeight = Math.round(15.6); // 16
    const deviceFontSize = FONT_SIZE; // 13
    const offset = Math.round((deviceCellHeight - deviceFontSize) / 2); // 2
    const lineThickness = 1;
    const glyphTop = offset; // 2
    const glyphBottom = offset + deviceFontSize; // 15
    const glyphCenter = offset + deviceFontSize / 2; // 8.5

    // 每条装饰各占一行，便于按行段定位其 fillRect（高 = lineThickness）。
    const { renderer, mainCtx, cellDimensions } = setup(1, 15.6);
    renderer.render({
      meta: makeMeta(3),
      rows: [
        makeRow(0, { underline: 1 }),
        makeRow(1, { overline: true }),
        makeRow(2, { strikethrough: true }),
      ],
      cellDimensions,
    });

    const decoLine = (rowTop: number): DrawOp | undefined =>
      mainCtx.ops.find(
        (op) =>
          op.type === 'fillRect' &&
          op.height === lineThickness &&
          op.y >= rowTop &&
          op.y < rowTop + deviceCellHeight
      );

    const underline = decoLine(0);
    const overline = decoLine(deviceCellHeight);
    const strike = decoLine(deviceCellHeight * 2);

    // 下划线在字形底附近（≥ 字中线），且仍落在 cell 内
    expect(underline).toBeDefined();
    expect((underline?.y ?? 0) - 0).toBeGreaterThanOrEqual(Math.floor(glyphCenter));
    expect((underline?.y ?? 0) + lineThickness).toBeLessThanOrEqual(deviceCellHeight);
    expect((underline?.y ?? 0) - 0).toBe(
      Math.min(glyphBottom - lineThickness, deviceCellHeight - lineThickness)
    );

    // 上划线贴字形顶
    expect((overline?.y ?? 0) - deviceCellHeight).toBe(glyphTop);

    // 删除线穿字形几何中线
    expect((strike?.y ?? 0) - deviceCellHeight * 2).toBe(Math.round(glyphCenter));
  });
});
