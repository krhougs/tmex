// 字形 run 位图缓存(glyph-run-cache)像素等价回归:同一帧场景分别在缓存启用/禁用下
// 渲染,主画布像素逐字节比对,容差 0。保护长期渲染正确性——atlas 位图 padding、落位
// 偏移、失效点、LRU 回收都不能引入与直绘的像素差异。
//
// 测试画布是确定性的软件光栅化器(与仓库既有 FakeCtx 一脉相承):fillText 按内嵌字形
// 图案合成像素、drawImage 逐像素复制、两者共用同一 source-over 公式,因此缓存命中
// (atlas fillText + drawImage)与直绘(fillText)在数学上必然逐字节一致——任何不一致
// 都指向缓存自身的 bug(错 key、错偏移、位图裁剪、页回收错乱等),而非宿主光栅化细节。
// 字形图案刻意覆盖:宽墨迹符号(触发宽度约束的 normal 溢出与 scale 两条路径)、左溢
// 符号、多字符单 cell(触发位图右扩展)、CJK 宽字符、连字段。
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { type Canvas as NapiCanvas, createCanvas } from '@napi-rs/canvas';
import { CanvasRenderer } from './canvas-renderer';
import { GlyphRunCache } from './glyph-run-cache';
import type {
  GhosttyCellDimensions,
  GhosttyColorRgb,
  GhosttyRenderCell,
  GhosttyRenderCellStyle,
  GhosttyRenderRow,
  GhosttyRenderSnapshotMeta,
  GhosttyTheme,
} from './types';

const CELL_WIDTH = 8;
const CELL_HEIGHT = 16;
const FONT_SIZE = 13;
const COLS = 80;
const ROWS = 8;

const BACKGROUND: GhosttyColorRgb = { r: 232, g: 232, b: 232 };
const FOREGROUND: GhosttyColorRgb = { r: 10, g: 10, b: 10 };

const PALETTE: GhosttyColorRgb[] = Array.from({ length: 16 }, (_, i) => ({
  r: (i * 37) % 256,
  g: (i * 91) % 256,
  b: (i * 173) % 256,
}));

const TEST_THEME: GhosttyTheme = {
  background: '#e8e8e8',
  foreground: '#0a0a0a',
  cursor: '#0a0a0a',
  selectionBackground: 'rgba(0,0,0,0.3)',
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

// ---------------------------------------------------------------------------
// 软件光栅化 canvas(确定性像素)
// ---------------------------------------------------------------------------

type Rgba = { r: number; g: number; b: number; a: number };

// 字形图案:基线相对坐标(x0,y0,x1,y1 含端点),13px 字号下定义,其他字号按比例缩放。
// 图案刻意制造宽墨迹:→ 右缘 15px(> cellW 8 + 5% 容差,右邻空时放行溢出、右邻有字时
// scale)、⇒ 右缘 14、˄ 右缘 11、※ 左溢 1px(恒触发 scale)。
const GLYPH_RECTS: Record<string, Array<[number, number, number, number]>> = {
  '→': [
    [0, -1, 14, -1],
    [9, -3, 14, 1],
  ],
  '⇒': [
    [0, -3, 12, -3],
    [0, 1, 12, 1],
    [9, -1, 12, -1],
  ],
  '˄': [
    [0, 1, 10, 1],
    [4, -3, 6, 1],
  ],
  '※': [
    [-1, -3, 11, -3],
    [-1, 1, 11, 1],
    [4, -3, 6, 1],
  ],
  // 左溢超 1 cell(-12 < -cellW):触发 atlas 位图 leftExtra 左扩展路径
  '⟸': [
    [-12, -2, 6, -2],
    [-12, 1, -9, 1],
  ],
  你: [[0, -6, 7, 5]],
  好: [[0, -6, 7, 5]],
  世: [[0, -6, 7, 5]],
  界: [[0, -6, 7, 5]],
  中: [[0, -6, 7, 5]],
  文: [[0, -6, 7, 5]],
};

// 常规 ASCII:5×7 实心块,advance 6
const GENERIC_RECTS: Array<[number, number, number, number]> = [[1, -6, 5, 0]];
const GENERIC_ADVANCE = 6;

function glyphRects(ch: string): Array<[number, number, number, number]> | null {
  if (ch === ' ') {
    return [];
  }
  return GLYPH_RECTS[ch] ?? GENERIC_RECTS;
}

function parseCssColor(css: string): Rgba {
  const m = /^rgba?\(\s*(\d+)\s+(\d+)\s+(\d+)(?:\s*\/\s*([\d.]+))?\s*\)$/.exec(css);
  if (!m) {
    throw new Error(`unexpected color: ${css}`);
  }
  return {
    r: Number(m[1]),
    g: Number(m[2]),
    b: Number(m[3]),
    a: m[4] === undefined ? 255 : Math.round(Number(m[4]) * 255),
  };
}

function blend(dst: Uint8ClampedArray, offset: number, src: Rgba, alpha: number): void {
  if (alpha <= 0) {
    return;
  }
  if (alpha >= 255) {
    dst[offset] = src.r;
    dst[offset + 1] = src.g;
    dst[offset + 2] = src.b;
    dst[offset + 3] = 255;
    return;
  }
  const inv = 255 - alpha;
  dst[offset] = Math.round((src.r * alpha + dst[offset] * inv) / 255);
  dst[offset + 1] = Math.round((src.g * alpha + dst[offset + 1] * inv) / 255);
  dst[offset + 2] = Math.round((src.b * alpha + dst[offset + 2] * inv) / 255);
  dst[offset + 3] = Math.round((src.a * alpha + dst[offset + 3] * inv) / 255);
}

class SoftwareCtx {
  fillStyle = 'rgb(0 0 0)';
  font = '13px monospace';
  textBaseline = 'alphabetic';
  globalAlpha = 1;
  imageSmoothingEnabled = false;
  private pixels: Uint8ClampedArray;
  private width: number;
  private height: number;
  private tx = 0;
  private ty = 0;
  private sx = 1;
  private sy = 1;
  private readonly stateStack: Array<[number, number, number, number]> = [];

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.pixels = new Uint8ClampedArray(width * height * 4);
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.pixels = new Uint8ClampedArray(width * height * 4);
    this.tx = 0;
    this.ty = 0;
    this.sx = 1;
    this.sy = 1;
  }

  setTransform(): void {}

  save(): void {
    this.stateStack.push([this.tx, this.ty, this.sx, this.sy]);
  }

  restore(): void {
    const state = this.stateStack.pop();
    if (!state) {
      return;
    }
    [this.tx, this.ty, this.sx, this.sy] = state;
  }

  translate(x: number, y: number): void {
    this.tx += x * this.sx;
    this.ty += y * this.sy;
  }

  scale(x: number, y: number): void {
    this.sx *= x;
    this.sy *= y;
  }

  clearRect(x: number, y: number, width: number, height: number): void {
    const x0 = Math.max(0, Math.round(x));
    const y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(this.width, Math.round(x + width));
    const y1 = Math.min(this.height, Math.round(y + height));
    for (let yy = y0; yy < y1; yy += 1) {
      this.pixels.fill(0, (yy * this.width + x0) * 4, (yy * this.width + x1) * 4);
    }
  }

  fillRect(x: number, y: number, width: number, height: number): void {
    const src = parseCssColor(this.fillStyle);
    const alpha = Math.round(this.globalAlpha * 255);
    const x0 = Math.max(0, Math.round(x * this.sx + this.tx));
    const y0 = Math.max(0, Math.round(y * this.sy + this.ty));
    const x1 = Math.min(this.width, Math.round((x + width) * this.sx + this.tx));
    const y1 = Math.min(this.height, Math.round((y + height) * this.sy + this.ty));
    for (let yy = y0; yy < y1; yy += 1) {
      for (let xx = x0; xx < x1; xx += 1) {
        blend(this.pixels, (yy * this.width + xx) * 4, src, alpha);
      }
    }
  }

  // 与 measureText 同一份字形数据:墨迹 = 图案矩形经 (scale, translate) 变换后的整数像素。
  private fillGlyph(ch: string, baselineX: number, baselineY: number, color: Rgba): void {
    const rects = glyphRects(ch);
    if (rects === null || rects.length === 0) {
      return;
    }
    const alpha = Math.round(this.globalAlpha * 255);
    for (const [x0, y0, x1, y1] of rects) {
      const px0 = Math.max(0, Math.round((baselineX + x0) * this.sx + this.tx));
      const py0 = Math.max(0, Math.round((baselineY + y0) * this.sy + this.ty));
      const px1 = Math.min(this.width, Math.round((baselineX + x1 + 1) * this.sx + this.tx));
      const py1 = Math.min(this.height, Math.round((baselineY + y1 + 1) * this.sy + this.ty));
      for (let yy = py0; yy < py1; yy += 1) {
        for (let xx = px0; xx < px1; xx += 1) {
          blend(this.pixels, (yy * this.width + xx) * 4, color, alpha);
        }
      }
    }
  }

  fillText(text: string, x: number, y: number): void {
    const color = parseCssColor(this.fillStyle);
    let cursor = x;
    for (const ch of text) {
      this.fillGlyph(ch, cursor, y, color);
      cursor += this.advance(ch);
    }
  }

  private advance(ch: string): number {
    return GLYPH_RECTS[ch] !== undefined ? 8 : GENERIC_ADVANCE;
  }

  measureText(text: string): {
    fontBoundingBoxAscent: number;
    fontBoundingBoxDescent: number;
    actualBoundingBoxAscent: number;
    actualBoundingBoxDescent: number;
    actualBoundingBoxLeft: number;
    actualBoundingBoxRight: number;
    width: number;
  } {
    const px = Number.parseFloat(this.font) || FONT_SIZE;
    const scale = px / FONT_SIZE;
    let width = 0;
    let left = 0;
    let right = 0;
    for (const ch of text) {
      const rects = glyphRects(ch);
      if (rects !== null && rects.length > 0) {
        for (const [x0, , x1] of rects) {
          left = Math.min(left, width + x0);
          right = Math.max(right, width + x1 + 1);
        }
      }
      width += this.advance(ch);
    }
    // 墨迹以整串为单位:左溢为负(墨迹在原点左侧),右缘为正
    return {
      fontBoundingBoxAscent: px * 0.8,
      fontBoundingBoxDescent: px * 0.3,
      actualBoundingBoxAscent: px * 0.7,
      actualBoundingBoxDescent: px * 0.2,
      actualBoundingBoxLeft: left * scale,
      actualBoundingBoxRight: right * scale,
      width: width * scale,
    };
  }

  drawImage(
    source: { width: number; height: number; getPixels: () => Uint8ClampedArray },
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    dx: number,
    dy: number,
    dw: number,
    sh2: number
  ): void {
    void sh2;
    const sourcePixels = source.getPixels();
    const x0 = Math.max(0, Math.round(dx));
    const y0 = Math.max(0, Math.round(dy));
    const x1 = Math.min(this.width, Math.round(dx + dw));
    const y1 = Math.min(this.height, Math.round(dy + sh));
    for (let yy = y0; yy < y1; yy += 1) {
      const srcY = Math.round((yy - dy) * (sh2 / sh) + sy); // 1:1 缩放,整数采样
      for (let xx = x0; xx < x1; xx += 1) {
        const srcX = Math.round((xx - dx) * (dw / sw) + sx);
        const srcOffset = (srcY * source.width + srcX) * 4;
        const dstOffset = (yy * this.width + xx) * 4;
        const src = {
          r: sourcePixels[srcOffset],
          g: sourcePixels[srcOffset + 1],
          b: sourcePixels[srcOffset + 2],
          a: sourcePixels[srcOffset + 3],
        };
        // 与 fillText/fillRect 同一 source-over 公式 → 逐字节等价
        blend(this.pixels, dstOffset, src, src.a);
      }
    }
  }

  getImageData(
    x: number,
    y: number,
    width: number,
    height: number
  ): {
    data: Uint8ClampedArray;
  } {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let yy = 0; yy < height; yy += 1) {
      const srcOffset = ((y + yy) * this.width + x) * 4;
      data.set(this.pixels.subarray(srcOffset, srcOffset + width * 4), yy * width * 4);
    }
    return { data };
  }
}

class SoftwareCanvas {
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  private widthValue = 1;
  private heightValue = 1;
  private readonly ctx: SoftwareCtx;
  constructor() {
    this.ctx = new SoftwareCtx(this.widthValue, this.heightValue);
  }
  get width(): number {
    return this.widthValue;
  }
  set width(value: number) {
    this.widthValue = value;
    this.ctx.resize(value, this.heightValue);
  }
  get height(): number {
    return this.heightValue;
  }
  set height(value: number) {
    this.heightValue = value;
    this.ctx.resize(this.widthValue, value);
  }
  getContext(type: string): SoftwareCtx | null {
    return type === '2d' ? this.ctx : null;
  }
  remove(): void {}
  getPixels(): Uint8ClampedArray {
    return this.ctx.getImageData(0, 0, this.widthValue, this.heightValue).data;
  }
}

// ---------------------------------------------------------------------------
// 场景与渲染器装配
// ---------------------------------------------------------------------------

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

type CellSeed = {
  text: string;
  wide?: boolean;
  style?: Partial<GhosttyRenderCellStyle>;
  fgColor?: GhosttyColorRgb | null;
  bgColor?: GhosttyColorRgb | null;
  fgPaletteIndex?: number | null;
  bgPaletteIndex?: number | null;
};

function cellFromSeed(x: number, seed: CellSeed): GhosttyRenderCell {
  return {
    x,
    text: seed.text,
    codepoints: [...seed.text].map((ch) => ch.codePointAt(0) as number),
    widthKind: seed.wide ? 'wide' : 'narrow',
    hasText: seed.text.length > 0,
    style: { ...DEFAULT_STYLE, ...seed.style },
    fgColor: seed.fgColor ?? null,
    bgColor: seed.bgColor ?? null,
    fgPaletteIndex: seed.fgPaletteIndex ?? null,
    bgPaletteIndex: seed.bgPaletteIndex ?? null,
  };
}

function rowCells(seeds: CellSeed[]): GhosttyRenderCell[] {
  const cells: GhosttyRenderCell[] = [];
  let x = 0;
  for (const seed of seeds) {
    cells.push(cellFromSeed(x, seed));
    x += seed.wide ? 2 : 1;
    if (seed.wide) {
      cells.push({
        x: x - 1,
        text: '',
        codepoints: [],
        widthKind: 'spacer-tail',
        hasText: false,
        style: { ...DEFAULT_STYLE },
        fgColor: null,
        bgColor: null,
        fgPaletteIndex: null,
        bgPaletteIndex: null,
      });
    }
  }
  return cells;
}

/** 按码点拆成单字符 seed(连字/块元素行需要逐 cell 渲染)。 */
function chars(text: string, seed?: Omit<CellSeed, 'text'>): CellSeed[] {
  return [...text].map((ch) => ({ text: ch, ...seed }));
}

function makeScene(): GhosttyRenderRow[] {
  const rows: GhosttyRenderRow[] = [];
  const push = (y: number, seeds: CellSeed[]) => {
    rows.push({
      y,
      dirty: true,
      wrap: false,
      wrapContinuation: false,
      text: seeds.map((s) => s.text).join(''),
      cells: rowCells(seeds),
    });
  };

  // ASCII 正文 + 粗/斜体 + 多字符单 cell(触发位图右扩展)
  push(0, [
    { text: 'The quick brown fox ' },
    { text: 'bold', style: { bold: true } },
    { text: ' ' },
    { text: 'italic', style: { italic: true } },
    { text: ' ' },
    { text: 'both', style: { bold: true, italic: true } },
  ]);
  // CJK 宽字符(含 spacer)
  push(1, [
    ...chars('你好世界', { wide: true }),
    { text: ' Wide CJK ' },
    ...chars('中文', { wide: true }),
  ]);
  // 连字段(整段一个 key,保留 calt 上下文)+ 段上装饰线
  push(2, [...chars('=> -> != <=', { style: { underline: 1 } }), ...chars('  >= == <>')]);
  // 块元素(矢量自绘,不进缓存)
  push(3, [...chars('▀▄█▌▐░▒▓▖▗▘▙▚▛▜▝▞▟')]);
  // 受约束宽符号:→/⇒/˄ 右邻空(放行溢出 → 缓存,墨迹越界由 padding 覆盖);
  // ※ 左溢(恒 scale → 绕过缓存直绘);→ 右邻有字(scale → 直绘)
  push(4, [...chars('→ ⇒ ※ ˄ →x→ ')]);
  // 装饰线:下划线/删除线/上划线(矢量,不进缓存)
  push(5, [
    { text: 'under', style: { underline: 1 } },
    { text: ' ' },
    { text: 'strike', style: { strikethrough: true } },
    { text: ' ' },
    { text: 'over', style: { overline: true } },
    { text: ' ' },
    { text: 'combo', style: { underline: 2, strikethrough: true, overline: true } },
  ]);
  // inverse(前景取自 bg 槽)+ minimum-contrast(调色板色被调整/真彩色原样/达标原样)
  push(6, [
    {
      text: 'inverse',
      style: { inverse: true },
      fgColor: { r: 0, g: 0, b: 255 },
      fgPaletteIndex: 4,
      bgColor: { r: 255, g: 255, b: 0 },
      bgPaletteIndex: 11,
    },
    { text: ' ' },
    { text: 'bright', fgColor: { r: 255, g: 255, b: 255 }, fgPaletteIndex: 15 },
    { text: ' ' },
    { text: 'truecolor', fgColor: { r: 255, g: 255, b: 255 }, fgPaletteIndex: null },
    { text: ' ' },
    { text: 'dark', fgColor: { r: 0, g: 0, b: 0 }, fgPaletteIndex: 0 },
  ]);
  return rows;
}

function makeMeta(): GhosttyRenderSnapshotMeta {
  return {
    cols: COLS,
    rows: ROWS,
    dirty: 'full',
    colors: { background: BACKGROUND, foreground: FOREGROUND, cursor: null, palette: PALETTE },
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

function installSoftwareDom(dpr: number): { canvases: SoftwareCanvas[] } {
  const canvases: SoftwareCanvas[] = [];
  const document = {
    createElement: (tagName: string): unknown => {
      if (String(tagName).toLowerCase() !== 'canvas') {
        throw new Error(`unexpected element: ${tagName}`);
      }
      const canvas = new SoftwareCanvas();
      canvases.push(canvas);
      return canvas;
    },
  };
  (globalThis as { devicePixelRatio?: number }).devicePixelRatio = dpr;
  (globalThis as { document?: unknown }).document = document;
  return { canvases };
}

let previousDpr: unknown;
let previousDocument: unknown;

beforeEach(() => {
  previousDpr = (globalThis as { devicePixelRatio?: unknown }).devicePixelRatio;
  previousDocument = (globalThis as { document?: unknown }).document;
});

afterEach(() => {
  (globalThis as { devicePixelRatio?: unknown }).devicePixelRatio = previousDpr;
  (globalThis as { document?: unknown }).document = previousDocument;
});

function makeRenderer(
  cacheEnabled: boolean,
  dpr = 1
): { renderer: CanvasRenderer; canvas: SoftwareCanvas } {
  const dom = installSoftwareDom(dpr);
  const screen = {
    style: {} as Record<string, string>,
    children: [] as unknown[],
    appendChild(child: unknown): void {
      this.children.push(child);
    },
  };
  const renderer = new CanvasRenderer({
    screenElement: screen as unknown as HTMLElement,
    theme: TEST_THEME,
    fontFamily: 'monospace',
    fontSize: FONT_SIZE,
    ligatures: true,
    minimumContrast: true,
  });
  if (!cacheEnabled) {
    (
      renderer as unknown as { setGlyphRunCacheEnabled(enabled: boolean): void }
    ).setGlyphRunCacheEnabled(false);
  }
  // 构造顺序 main/link/selection/cursor,首个 canvas 即主画布
  return { renderer, canvas: dom.canvases[0] };
}

function cacheStats(renderer: CanvasRenderer): ReturnType<GlyphRunCache['getStats']> {
  return (renderer as unknown as { glyphRunCache: GlyphRunCache }).glyphRunCache.getStats();
}

function renderFrame(
  renderer: CanvasRenderer,
  rows: GhosttyRenderRow[],
  cellDimensions: GhosttyCellDimensions
): void {
  renderer.render({ meta: makeMeta(), rows, cellDimensions });
}

function expectSamePixels(
  a: Uint8ClampedArray,
  b: Uint8ClampedArray,
  label: string,
  width: number
): void {
  expect(a.length).toBe(b.length);
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      const pixel = Math.floor(i / 4);
      throw new Error(
        `${label}: 像素不一致 @(${pixel % width},${Math.floor(pixel / width)}) ` +
          `channel ${i % 4} (byte ${i}): ${a[i]} vs ${b[i]}`
      );
    }
  }
}

function nonBackgroundPixels(pixels: Uint8ClampedArray): number {
  let count = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if (
      pixels[i] !== BACKGROUND.r ||
      pixels[i + 1] !== BACKGROUND.g ||
      pixels[i + 2] !== BACKGROUND.b
    ) {
      count += 1;
    }
  }
  return count;
}

const CELL_DIMENSIONS = { width: CELL_WIDTH, height: CELL_HEIGHT };

// ---------------------------------------------------------------------------
// 像素等价(软件光栅化,容差 0)
// ---------------------------------------------------------------------------

describe('glyph run 位图缓存像素等价', () => {
  test('dpr=1 全场景:缓存启用/禁用逐字节一致,命中帧稳定', () => {
    const rows = makeScene();
    const { renderer: withCache, canvas: canvasA } = makeRenderer(true);
    const { renderer: noCache, canvas: canvasB } = makeRenderer(false);

    renderFrame(withCache, rows, CELL_DIMENSIONS);
    const first = canvasA.getPixels();
    renderFrame(withCache, rows, CELL_DIMENSIONS);
    const second = canvasA.getPixels();
    renderFrame(noCache, rows, CELL_DIMENSIONS);
    const direct = canvasB.getPixels();

    const stats = cacheStats(withCache);
    expect(stats.pages).toBeGreaterThan(0); // 环境无 OffscreenCanvas → detached <canvas> 兜底
    expect(stats.misses).toBeGreaterThan(0);
    expect(stats.hits).toBeGreaterThan(0); // 第二帧全部命中缓存

    expectSamePixels(first, second, '缓存命中帧 vs 首帧', canvasA.width);
    expectSamePixels(second, direct, '缓存 vs 直绘', canvasA.width);
    expect(nonBackgroundPixels(direct)).toBeGreaterThan(200); // 场景确实画了内容
  });

  test('dpr=2 下缓存启用/禁用逐字节一致', () => {
    const rows = makeScene();
    const { renderer: withCache, canvas: canvasA } = makeRenderer(true, 2);
    const { renderer: noCache, canvas: canvasB } = makeRenderer(false, 2);

    renderFrame(withCache, rows, CELL_DIMENSIONS);
    renderFrame(noCache, rows, CELL_DIMENSIONS);

    expectSamePixels(canvasA.getPixels(), canvasB.getPixels(), 'dpr=2 缓存 vs 直绘', canvasA.width);
  });

  test('几何变化(device cell 尺寸)整体失效缓存', () => {
    const rows = makeScene();
    const dims2 = { width: CELL_WIDTH, height: 20 };
    const { renderer, canvas } = makeRenderer(true);
    const { renderer: ref, canvas: refCanvas } = makeRenderer(false);

    renderFrame(renderer, rows, CELL_DIMENSIONS);
    expect(cacheStats(renderer).entries).toBeGreaterThan(0);
    const clearsBefore = cacheStats(renderer).clears;

    renderFrame(renderer, rows, dims2); // resize 检测几何变化 → setCellGeometry 清空
    expect(cacheStats(renderer).clears).toBe(clearsBefore + 1);
    expect(cacheStats(renderer).entries).toBeGreaterThan(0); // 新几何下已重画

    renderFrame(ref, rows, dims2);
    expectSamePixels(canvas.getPixels(), refCanvas.getPixels(), '新几何缓存 vs 直绘', canvas.width);
  });

  test('setTheme 整体失效缓存', () => {
    const rows = makeScene();
    const { renderer } = makeRenderer(true);

    renderFrame(renderer, rows, CELL_DIMENSIONS);
    expect(cacheStats(renderer).entries).toBeGreaterThan(0);

    renderer.setTheme({ ...TEST_THEME, background: '#101010' });
    expect(cacheStats(renderer).entries).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 缓存机制(软件画布,像素级验证)
// ---------------------------------------------------------------------------

describe('GlyphRunCache 页面管理', () => {
  test('LRU 整页回收:条目随页失效,重画重新光栅化且像素一致', () => {
    installSoftwareDom(1);
    const cache = new GlyphRunCache({ pageSize: 64, maxKeys: 1000, maxPages: 2 });
    // rowHeight = 3×16 = 48 → 每页仅 1 行(64px),行内 2 个 24px 位图
    cache.setCellGeometry(CELL_WIDTH, CELL_HEIGHT, 12);
    const main = new SoftwareCanvas();
    main.width = 256;
    main.height = 64;
    const ctx = main.getContext('2d') as unknown as SoftwareCtx & CanvasRenderingContext2D;
    const ink = () => ({ left: 0, right: CELL_WIDTH });
    const request = (text: string, cellX: number) => ({
      font: `${FONT_SIZE}px monospace`,
      text,
      color: 'rgb(10 10 10)',
      spanCells: 1,
      cellX,
      cellY: 0,
    });

    for (let i = 0; i < 4; i += 1) {
      expect(cache.draw(ctx, request(`k${i}`, i * 32), ink)).toBeTrue();
    }
    expect(cache.getStats().pages).toBe(2);
    expect(cache.getStats().entries).toBe(4);

    // 第 5 个 key:两页已满 → LRU 回收页 0,其 2 个条目一并失效
    expect(cache.draw(ctx, request('k4', 4 * 32), ink)).toBeTrue();
    let stats = cache.getStats();
    expect(stats.pages).toBe(2);
    expect(stats.entries).toBe(3);

    // 清空主画布后重画被回收的 k0:miss 重新光栅化,与直绘参考逐字节一致
    ctx.clearRect(0, 0, 256, 64);
    expect(cache.draw(ctx, request('k0', 0), ink)).toBeTrue();
    stats = cache.getStats();
    expect(stats.misses).toBeGreaterThan(4); // k0 是 miss,不是命中
    const reference = new SoftwareCanvas();
    reference.width = 256;
    reference.height = 64;
    const refCtx = reference.getContext('2d') as unknown as SoftwareCtx & CanvasRenderingContext2D;
    refCtx.font = `${FONT_SIZE}px monospace`;
    refCtx.fillStyle = 'rgb(10 10 10)';
    refCtx.textBaseline = 'alphabetic';
    refCtx.fillText('k0', 0, 12);
    expectSamePixels(main.getPixels(), reference.getPixels(), 'LRU 回收后重画 vs 直绘', 256);
  });

  test('key 总数超上限:整体清空重来', () => {
    installSoftwareDom(1);
    const cache = new GlyphRunCache({ pageSize: 512, maxKeys: 4 });
    cache.setCellGeometry(CELL_WIDTH, CELL_HEIGHT, 12);
    const main = new SoftwareCanvas();
    main.width = 64;
    main.height = 64;
    const ctx = main.getContext('2d') as unknown as SoftwareCtx & CanvasRenderingContext2D;
    const request = (text: string) => ({
      font: `${FONT_SIZE}px monospace`,
      text,
      color: 'rgb(10 10 10)',
      spanCells: 1,
      cellX: 0,
      cellY: 0,
    });
    const ink = () => ({ left: 0, right: CELL_WIDTH });

    const clearsBefore = cache.getStats().clears;
    for (let i = 0; i < 4; i += 1) {
      expect(cache.draw(ctx, request(`k${i}`), ink)).toBeTrue();
    }
    expect(cache.draw(ctx, request('k4'), ink)).toBeTrue();
    const stats = cache.getStats();
    expect(stats.clears).toBe(clearsBefore + 1);
    expect(stats.entries).toBe(1); // 清空后只保留 k4
  });

  test('左溢超 1 cell 的字形:位图 leftExtra 扩展后 miss/命中均与直绘逐字节一致', () => {
    installSoftwareDom(1);
    const cache = new GlyphRunCache();
    cache.setCellGeometry(CELL_WIDTH, CELL_HEIGHT, 12);
    const main = new SoftwareCanvas();
    main.width = 128;
    main.height = 48;
    const ctx = main.getContext('2d') as unknown as SoftwareCtx & CanvasRenderingContext2D;
    const request = {
      font: `${FONT_SIZE}px monospace`,
      text: '⟸',
      color: 'rgb(10 10 10)',
      spanCells: 1,
      cellX: 32,
      cellY: 16,
    };
    // ⟸ 字形左缘 -12(墨迹左溢 12px > cellW 8),right 覆盖本格
    const ink = () => ({ left: 12, right: CELL_WIDTH });

    const reference = new SoftwareCanvas();
    reference.width = 128;
    reference.height = 48;
    const refCtx = reference.getContext('2d') as unknown as SoftwareCtx & CanvasRenderingContext2D;
    refCtx.font = request.font;
    refCtx.fillStyle = request.color;
    refCtx.textBaseline = 'alphabetic';
    refCtx.fillText(request.text, request.cellX, request.cellY + 12);

    expect(cache.draw(ctx, request, ink)).toBeTrue(); // miss:atlas 光栅化 + blit
    expectSamePixels(main.getPixels(), reference.getPixels(), '左溢字形 miss vs 直绘', 128);

    ctx.clearRect(0, 0, 128, 48);
    expect(cache.draw(ctx, request, ink)).toBeTrue(); // 命中:纯 blit
    expect(cache.getStats().hits).toBeGreaterThan(0);
    expectSamePixels(main.getPixels(), reference.getPixels(), '左溢字形命中 vs 直绘', 128);
  });

  test('几何相同 no-op,变化整体失效', () => {
    installSoftwareDom(1);
    const cache = new GlyphRunCache();
    cache.setCellGeometry(CELL_WIDTH, CELL_HEIGHT, 12);
    const main = new SoftwareCanvas();
    main.width = 64;
    main.height = 64;
    const ctx = main.getContext('2d') as unknown as SoftwareCtx & CanvasRenderingContext2D;
    const request = (text: string) => ({
      font: `${FONT_SIZE}px monospace`,
      text,
      color: 'rgb(10 10 10)',
      spanCells: 1,
      cellX: 0,
      cellY: 0,
    });
    const ink = () => ({ left: 0, right: CELL_WIDTH });

    expect(cache.draw(ctx, request('a'), ink)).toBeTrue();
    expect(cache.draw(ctx, request('b'), ink)).toBeTrue();
    expect(cache.getStats().entries).toBe(2);

    cache.setCellGeometry(CELL_WIDTH, CELL_HEIGHT, 12);
    expect(cache.getStats().entries).toBe(2); // 相同几何 no-op

    cache.setCellGeometry(9, CELL_HEIGHT, 12);
    expect(cache.getStats().entries).toBe(0); // 几何变化 → 整体失效
  });

  test('位图绘制与 drawImage 走真实像素(非空)', () => {
    installSoftwareDom(1);
    const cache = new GlyphRunCache();
    cache.setCellGeometry(CELL_WIDTH, CELL_HEIGHT, 12);
    const main = new SoftwareCanvas();
    main.width = 64;
    main.height = 64;
    const ctx = main.getContext('2d') as unknown as SoftwareCtx & CanvasRenderingContext2D;
    const request = {
      font: `${FONT_SIZE}px monospace`,
      text: 'M',
      color: 'rgb(10 10 10)',
      spanCells: 1,
      cellX: 0,
      cellY: 0,
    };
    expect(cache.draw(ctx, request, () => ({ left: 0, right: CELL_WIDTH }))).toBeTrue();
    expect(cache.draw(ctx, request, () => ({ left: 0, right: CELL_WIDTH }))).toBeTrue(); // 命中
    expect(cache.getStats().hits).toBe(1);
    const pixels = main.getPixels();
    expect(pixels.some((v, i) => i % 4 !== 3 && v !== 0)).toBeTrue(); // 有墨迹
  });
});

// ---------------------------------------------------------------------------
// 真实光栅化(@napi-rs/canvas)交叉验证:命中路径确定性与场景有效性
// ---------------------------------------------------------------------------

function installNapiDom(dpr: number): { canvases: NapiCanvas[] } {
  const canvases: NapiCanvas[] = [];
  const document = {
    createElement: (tagName: string): unknown => {
      if (String(tagName).toLowerCase() !== 'canvas') {
        throw new Error(`unexpected element: ${tagName}`);
      }
      // @napi-rs/canvas 的 Canvas 是真实光栅化对象(drawImage/getImageData 端到端可用),
      // 渲染器需要的 DOM 外壳(dataset/style/remove)按实例补齐。
      const canvas = createCanvas(1, 1) as unknown as NapiCanvas & {
        dataset: Record<string, string>;
        style: Record<string, string>;
        remove: () => void;
      };
      canvas.dataset = {};
      canvas.style = {};
      canvas.remove = () => {};
      canvases.push(canvas);
      return canvas;
    },
  };
  (globalThis as { devicePixelRatio?: number }).devicePixelRatio = dpr;
  (globalThis as { document?: unknown }).document = document;
  return { canvases };
}

function makeNapiRenderer(cacheEnabled: boolean): { renderer: CanvasRenderer; canvas: NapiCanvas } {
  const dom = installNapiDom(1);
  const screen = {
    style: {} as Record<string, string>,
    children: [] as unknown[],
    appendChild(child: unknown): void {
      this.children.push(child);
    },
  };
  const renderer = new CanvasRenderer({
    screenElement: screen as unknown as HTMLElement,
    theme: TEST_THEME,
    fontFamily: 'monospace',
    fontSize: FONT_SIZE,
    ligatures: true,
    minimumContrast: true,
  });
  if (!cacheEnabled) {
    (
      renderer as unknown as { setGlyphRunCacheEnabled(enabled: boolean): void }
    ).setGlyphRunCacheEnabled(false);
  }
  return { renderer, canvas: dom.canvases[0] };
}

describe('真实光栅化交叉验证(@napi-rs/canvas)', () => {
  test('命中帧与首帧逐字节一致(drawImage 复制确定)', () => {
    const rows = makeScene();
    const { renderer, canvas } = makeNapiRenderer(true);
    renderFrame(renderer, rows, CELL_DIMENSIONS);
    const first = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    renderFrame(renderer, rows, CELL_DIMENSIONS);
    const second = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    expect(cacheStats(renderer).hits).toBeGreaterThan(0);
    expectSamePixels(first, second, '真实画布命中帧 vs 首帧', canvas.width);
  });

  test('场景有效性探针:宽墨迹符号触发宽度约束', () => {
    const probe = createCanvas(64, 32);
    const ctx = probe.getContext('2d');
    ctx.font = `${FONT_SIZE}px monospace`;
    const arrow = ctx.measureText('→');
    // monospace 下 → 墨迹右缘 9px > cellW(8)+5% 容差,右邻有字时必走 scale 直绘路径
    expect(arrow.actualBoundingBoxRight).toBeGreaterThan(CELL_WIDTH * 1.05);
  });
});
