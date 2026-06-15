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
  clearRect(x: number, y: number, width: number, height: number): void {
    this.ops.push({ type: 'clearRect', x, y, width, height });
  }
  fillRect(x: number, y: number, width: number, height: number): void {
    this.ops.push({ type: 'fillRect', x, y, width, height });
  }
  fillText(text: string, x: number, y: number): void {
    this.fillTextOps.push({ text, x, y });
    this.ops.push({ type: 'fillText', x, y, width: 0, height: 0 });
  }
  strokeRect(): void {}
  // 模拟真实字体度量：ascent/descent 随 ctx.font 的 px 线性缩放（dpr 缩放可测），
  // 比例刻意取 0.8/0.3 使字形盒(1.1em) > em-box，复刻「降部超出 em」的真实场景。
  measureText(): {
    fontBoundingBoxAscent: number;
    fontBoundingBoxDescent: number;
    actualBoundingBoxAscent: number;
    actualBoundingBoxDescent: number;
    width: number;
  } {
    const px = Number.parseFloat(this.font) || FONT_SIZE;
    return {
      fontBoundingBoxAscent: px * 0.8,
      fontBoundingBoxDescent: px * 0.3,
      actualBoundingBoxAscent: px * 0.7,
      actualBoundingBoxDescent: px * 0.2,
      width: px * 0.6,
    };
  }
}

// 与 FakeCtx.measureText 同源的期望几何（renderer 内部算法的对照实现）。
function expectGeom(deviceCellHeight: number, deviceFontSize: number) {
  const ascent = deviceFontSize * 0.8;
  const descent = deviceFontSize * 0.3;
  const glyphBox = ascent + descent;
  const topGap = Math.round((deviceCellHeight - glyphBox) / 2);
  const baselineY = Math.round(topGap + ascent);
  return { ascent, descent, glyphBox, topGap, baselineY };
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

describe('canvas-renderer 垂直定位（真实字体度量，issue #17 + 降部裁切）', () => {
  test('正文按真实字形盒 alphabetic baseline 居中，整盒落在 cell 内（不裁升/降部）', () => {
    const { renderer, mainCtx, cellDimensions } = setup(1, 15.6);
    renderer.render({ meta: makeMeta(1), rows: [makeRow(0, {})], cellDimensions });

    const deviceCellHeight = Math.round(15.6); // 16
    const { glyphBox, topGap, baselineY } = expectGeom(deviceCellHeight, FONT_SIZE);

    const draw = mainCtx.fillTextOps.find((op) => op.text === 'M');
    expect(draw).toBeDefined();
    // baseline 落在真实 ascent 处，而非贴顶（y=0 是旧 bug）
    expect(draw?.y).toBe(baselineY);
    expect(draw?.y).toBeGreaterThan(0);
    // 关键不变量：字形盒 [topGap, topGap+glyphBox] 完整含于 [0, cellH] —— 升/降部都不溢出被裁
    expect(topGap).toBeGreaterThanOrEqual(0);
    expect(topGap + glyphBox).toBeLessThanOrEqual(deviceCellHeight);
    // 上下边距近似对称（居中）
    const topMargin = topGap;
    const bottomMargin = deviceCellHeight - (topGap + glyphBox);
    expect(Math.abs(topMargin - bottomMargin)).toBeLessThanOrEqual(1);
  });

  test('高 DPI（dpr=2）下度量按设备像素缩放，字形盒仍完整含于 cell', () => {
    const { renderer, mainCtx, cellDimensions } = setup(2, 15.6);
    renderer.render({ meta: makeMeta(1), rows: [makeRow(0, {})], cellDimensions });

    const deviceCellHeight = Math.round(15.6 * 2); // 31
    const deviceFontSize = FONT_SIZE * 2; // 26
    const { glyphBox, topGap, baselineY } = expectGeom(deviceCellHeight, deviceFontSize);

    const draw = mainCtx.fillTextOps.find((op) => op.text === 'M');
    expect(draw?.y).toBe(baselineY);
    expect(draw?.y).toBeGreaterThan(0);
    expect(topGap).toBeGreaterThanOrEqual(0);
    expect(topGap + glyphBox).toBeLessThanOrEqual(deviceCellHeight);
  });

  test('baseline 叠加到 cell 顶边（第 2 行）而非绝对 0', () => {
    const { renderer, mainCtx, cellDimensions } = setup(1, 15.6);
    renderer.render({ meta: makeMeta(2), rows: [makeRow(0, {}), makeRow(1, {})], cellDimensions });

    const deviceCellHeight = Math.round(15.6); // 16
    const { baselineY } = expectGeom(deviceCellHeight, FONT_SIZE);
    const secondRow = mainCtx.fillTextOps.find((op) => op.y >= deviceCellHeight);
    expect(secondRow?.y).toBe(deviceCellHeight + baselineY);
  });

  test('装饰线随真实字形盒走：下划线贴字底、上划线贴字顶、删除线穿字中', () => {
    const deviceCellHeight = Math.round(15.6); // 16
    const lineThickness = 1;
    const { glyphBox, topGap } = expectGeom(deviceCellHeight, FONT_SIZE);
    const glyphTop = topGap;
    const glyphBottom = topGap + glyphBox;
    const glyphCenter = topGap + glyphBox / 2;

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

    // 下划线在字形底附近，且仍落在 cell 内
    expect(underline).toBeDefined();
    expect((underline?.y ?? 0) + lineThickness).toBeLessThanOrEqual(deviceCellHeight);
    expect((underline?.y ?? 0) - 0).toBe(
      Math.min(Math.round(glyphBottom - lineThickness), deviceCellHeight - lineThickness)
    );

    // 上划线贴字形顶
    expect((overline?.y ?? 0) - deviceCellHeight).toBe(Math.max(0, Math.round(glyphTop)));

    // 删除线穿字形几何中线
    expect((strike?.y ?? 0) - deviceCellHeight * 2).toBe(Math.round(glyphCenter));
  });
});

describe('canvas-renderer 允许字形溢出相邻 cell（兼容奇怪 Unicode）', () => {
  test('两遍渲染：所有行背景（clearRect/band-fillRect）先于任一 fillText', () => {
    const { renderer, mainCtx, cellDimensions } = setup(1, 15.6);
    renderer.render({
      meta: makeMeta(3),
      rows: [makeRow(0, {}), makeRow(1, {}), makeRow(2, {})],
      cellDimensions,
    });

    const firstFillText = mainCtx.ops.findIndex((op) => op.type === 'fillText');
    expect(firstFillText).toBeGreaterThan(0);
    // 背景遍的 clearRect 必须全部排在前景遍首个 fillText 之前：
    // 否则后画的相邻 cell 背景会擦掉先画字形溢出的墨迹。
    const lastClearRect = mainCtx.ops.reduce(
      (acc, op, i) => (op.type === 'clearRect' ? i : acc),
      -1
    );
    expect(lastClearRect).toBeGreaterThanOrEqual(0);
    expect(lastClearRect).toBeLessThan(firstFillText);
  });

  test('部分重绘：脏行连带重绘上下邻行（恢复溢入墨迹）', () => {
    const { renderer, mainCtx, cellDimensions } = setup(1, 15.6);
    const deviceCellHeight = Math.round(15.6);

    // 先做一次 full 渲染铺底，再只把中间行（y=1）标脏做 partial。
    renderer.render({
      meta: makeMeta(3),
      rows: [makeRow(0, {}), makeRow(1, {}), makeRow(2, {})],
      cellDimensions,
    });
    mainCtx.ops = [];

    const partialMeta = { ...makeMeta(3), dirty: 'partial' as const };
    renderer.render({
      meta: partialMeta,
      rows: [
        { ...makeRow(0, {}), dirty: false },
        { ...makeRow(1, {}), dirty: true },
        { ...makeRow(2, {}), dirty: false },
      ],
      cellDimensions,
    });

    // 邻行 y=0/2 的 band 也被 clearRect（重绘），而非只清 y=1。
    const clearedBands = new Set(
      mainCtx.ops.filter((op) => op.type === 'clearRect').map((op) => op.y)
    );
    expect(clearedBands.has(0)).toBeTrue();
    expect(clearedBands.has(deviceCellHeight)).toBeTrue();
    expect(clearedBands.has(deviceCellHeight * 2)).toBeTrue();

    // 但 lastDrawnRows 仍只记真正脏的行
    expect(renderer.getDebugState().lastDrawnRows).toEqual([1]);
  });
});
