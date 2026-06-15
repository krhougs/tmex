import type {
  GhosttyCellDimensions,
  GhosttyColorRgb,
  GhosttyRenderRow,
  GhosttyRenderSnapshotMeta,
  GhosttySelectionRect,
  GhosttyTheme,
} from './types';

type CanvasRendererOptions = {
  screenElement: HTMLElement;
  theme: GhosttyTheme;
  fontFamily: string;
  fontSize: number;
};

type CanvasRendererFrame = {
  meta: GhosttyRenderSnapshotMeta;
  rows: GhosttyRenderRow[];
  cellDimensions: GhosttyCellDimensions;
  selectionRects?: GhosttySelectionRect[];
  selectionColor?: string;
};

type CanvasRendererDebugState = {
  kind: 'canvas';
  frameCount: number;
  lastDrawnRows: number[];
};

type CursorCell = {
  x: number;
  y: number;
  style: GhosttyRenderSnapshotMeta['cursor']['style'];
};

function colorToCss(color: GhosttyColorRgb): string {
  return `rgb(${color.r} ${color.g} ${color.b})`;
}

// U+2596–U+259F quadrant 块的象限组合：UL=1、UR=2、LL=4、LR=8
const QUADRANT_FLAGS = new Map<number, number>([
  [0x2596, 0b0100],
  [0x2597, 0b1000],
  [0x2598, 0b0001],
  [0x2599, 0b1101],
  [0x259a, 0b1001],
  [0x259b, 0b0111],
  [0x259c, 0b1011],
  [0x259d, 0b0010],
  [0x259e, 0b0110],
  [0x259f, 0b1110],
]);

const SHADE_ALPHA = new Map<number, number>([
  [0x2591, 0.25],
  [0x2592, 0.5],
  [0x2593, 0.75],
]);

function isBlockElement(codepoint: number): boolean {
  return codepoint >= 0x2580 && codepoint <= 0x259f;
}

function ensureContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('2d canvas context unavailable');
  }

  return context;
}

export class CanvasRenderer {
  readonly kind = 'canvas';

  private readonly mainCanvas: HTMLCanvasElement;
  private readonly selectionCanvas: HTMLCanvasElement;
  private readonly cursorCanvas: HTMLCanvasElement;
  private readonly mainContext: CanvasRenderingContext2D;
  private readonly selectionContext: CanvasRenderingContext2D;
  private readonly cursorContext: CanvasRenderingContext2D;
  private theme: GhosttyTheme;
  private readonly fontFamily: string;
  private readonly fontSize: number;
  private cellDimensions: GhosttyCellDimensions = { width: 9, height: 17 };
  // 设备像素整数 cell。所有绘制坐标必须落在整数物理像素上：相邻 fillRect 在
  // 小数边界各自抗锯齿半覆盖，叠加后边界像素覆盖不满，会在大面积色块中透出
  // 底色形成横竖细线。
  private deviceCellWidth = 9;
  private deviceCellHeight = 17;
  // 字号（fontSize×dpr，用于 ctx.font），及由「真实字体度量」算出的垂直定位：
  // 用 em-box=fontSize 当字形盒会忽略实际 ascent/descent，降部溢出 cell 被逐行 clearRect
  // 擦掉（f/y/g 掐尾）。改用 measureText 的 fontBoundingBox 把字形盒在 cell 内垂直居中。
  // 三者随 cell/dpr 在 resize() 内一并刷新。
  private deviceFontSize = 13;
  private textTopGap = 0; // 字形盒顶到 cell 顶的间距
  private textBaselineY = 0; // alphabetic baseline 相对 cell 顶的 y
  private glyphBoxHeight = 0; // 字形盒高 = ascent + descent
  private dpr = 1;
  private cols = 0;
  private rows = 0;
  private lastCursor: CursorCell | null = null;
  private frameCount = 0;
  private lastDrawnRows: number[] = [];
  private readonly colorCache = new Map<string, string>();
  private readonly fontCache = new Map<string, string>();
  private cursorBlinkVisible = true;
  private cursorBlinkTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: CanvasRendererOptions) {
    this.theme = options.theme;
    this.fontFamily = options.fontFamily;
    this.fontSize = options.fontSize;

    options.screenElement.style.position = 'relative';
    options.screenElement.style.overflow = 'hidden';

    this.mainCanvas = document.createElement('canvas');
    this.selectionCanvas = document.createElement('canvas');
    this.cursorCanvas = document.createElement('canvas');

    for (const [canvas, layer] of [
      [this.mainCanvas, 'main'],
      [this.selectionCanvas, 'selection'],
      [this.cursorCanvas, 'cursor'],
    ] as const) {
      canvas.dataset.layer = layer;
      canvas.style.position = 'absolute';
      canvas.style.inset = '0';
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      canvas.style.pointerEvents = 'none';
      options.screenElement.appendChild(canvas);
    }

    this.mainContext = ensureContext(this.mainCanvas);
    this.selectionContext = ensureContext(this.selectionCanvas);
    this.cursorContext = ensureContext(this.cursorCanvas);
  }

  setTheme(theme: GhosttyTheme): void {
    this.theme = theme;
    this.colorCache.clear();
  }

  render(frame: CanvasRendererFrame): void {
    this.frameCount += 1;
    this.lastDrawnRows = [];
    this.cellDimensions = frame.cellDimensions;
    this.resize(frame.meta.cols, frame.meta.rows);
    this.drawSelection(frame.selectionRects ?? [], frame.selectionColor ?? this.theme.selectionBackground);

    if (frame.meta.dirty === 'clean') {
      this.drawCursor(frame.meta);
      return;
    }

    const drawAllRows = frame.meta.dirty === 'full';
    const dirtyRows = drawAllRows ? frame.rows : frame.rows.filter((row) => row.dirty);

    // 允许字形垂直溢出相邻 cell——兼容带高升部/深降部的「奇怪」Unicode（组合记号、Zalgo、
    // 部分非拉丁文字），它们的墨迹可超出字体度量盒乃至 cell。两点保障：
    // 1) 重绘集扩到脏行上下邻行（±1），邻行溢入本行的墨迹随之恢复；
    // 2) 分两遍——先铺所有目标行背景、再画所有目标行前景。不透明背景全部先于字形落地，
    //    相邻 cell 背景便不会擦掉溢出的字形墨迹。
    // lastDrawnRows 仍只记真正脏的行（邻行重绘属实现细节）。
    let renderRows: GhosttyRenderRow[];
    if (drawAllRows) {
      renderRows = frame.rows;
    } else {
      const ys = new Set<number>();
      for (const row of dirtyRows) {
        ys.add(row.y - 1);
        ys.add(row.y);
        ys.add(row.y + 1);
      }
      renderRows = frame.rows.filter((row) => ys.has(row.y));
    }

    for (const row of renderRows) {
      this.drawRowBackground(row, frame.meta.colors);
    }
    for (const row of renderRows) {
      this.drawRowForeground(row, frame.meta.colors);
    }

    for (const row of dirtyRows) {
      this.lastDrawnRows.push(row.y);
    }

    this.drawCursor(frame.meta);
  }

  getDebugState(): CanvasRendererDebugState {
    return {
      kind: this.kind,
      frameCount: this.frameCount,
      lastDrawnRows: [...this.lastDrawnRows],
    };
  }

  dispose(): void {
    this.mainCanvas.remove();
    this.selectionCanvas.remove();
    this.cursorCanvas.remove();
    this.colorCache.clear();
    this.fontCache.clear();
    this.lastCursor = null;
    this.stopCursorBlink();
  }

  private startCursorBlink(): void {
    if (this.cursorBlinkTimer) {
      return;
    }
    this.cursorBlinkTimer = setInterval(() => {
      this.cursorBlinkVisible = !this.cursorBlinkVisible;
      this.cursorCanvas.style.opacity = this.cursorBlinkVisible ? '1' : '0';
    }, 1000);
  }

  private stopCursorBlink(): void {
    if (this.cursorBlinkTimer) {
      clearInterval(this.cursorBlinkTimer);
      this.cursorBlinkTimer = null;
    }
    this.cursorBlinkVisible = true;
    this.cursorCanvas.style.opacity = '1';
  }

  private resize(cols: number, rows: number): void {
    const nextCols = Math.max(1, cols);
    const nextRows = Math.max(1, rows);
    const dpr = Math.max(1, globalThis.devicePixelRatio ?? 1);
    const deviceCellWidth = Math.max(1, Math.round(this.cellDimensions.width * dpr));
    const deviceCellHeight = Math.max(1, Math.round(this.cellDimensions.height * dpr));

    if (
      this.cols === nextCols &&
      this.rows === nextRows &&
      this.dpr === dpr &&
      this.deviceCellWidth === deviceCellWidth &&
      this.deviceCellHeight === deviceCellHeight
    ) {
      return;
    }

    this.cols = nextCols;
    this.rows = nextRows;
    this.dpr = dpr;
    this.deviceCellWidth = deviceCellWidth;
    this.deviceCellHeight = deviceCellHeight;
    this.deviceFontSize = this.fontSize * dpr;
    // 量真实字体度量（含升/降部的字形盒），把字形盒整体在 cell 内垂直居中。
    // baseline 用 alphabetic：盒高 ≤ cell 时 [topGap, topGap+ascent+descent] ⊆ [0, cellH]，
    // 升降部都不溢出，且用本引擎自报度量，跨平台自洽。
    this.mainContext.font = `${this.deviceFontSize}px ${this.fontFamily}`;
    const metrics = this.mainContext.measureText('Mg|qyÅ');
    let ascent = metrics.fontBoundingBoxAscent;
    let descent = metrics.fontBoundingBoxDescent;
    if (!(Number.isFinite(ascent) && Number.isFinite(descent) && ascent > 0)) {
      // 极少数环境无 fontBoundingBox：按典型 0.8/0.2 em 兜底，仍优于贴顶。
      ascent = this.deviceFontSize * 0.8;
      descent = this.deviceFontSize * 0.2;
    }
    this.glyphBoxHeight = ascent + descent;
    this.textTopGap = Math.round((deviceCellHeight - this.glyphBoxHeight) / 2);
    this.textBaselineY = Math.round(this.textTopGap + ascent);

    const width = nextCols * deviceCellWidth;
    const height = nextRows * deviceCellHeight;

    for (const canvas of [this.mainCanvas, this.selectionCanvas, this.cursorCanvas]) {
      canvas.width = width;
      canvas.height = height;
      canvas.style.width = `${width / dpr}px`;
      canvas.style.height = `${height / dpr}px`;
    }

    for (const context of [this.mainContext, this.selectionContext, this.cursorContext]) {
      context.setTransform(1, 0, 0, 1, 0, 0);
      // alphabetic：按真实 baseline 定位，配合 textBaselineY 精确居中字形盒。
      context.textBaseline = 'alphabetic';
      context.imageSmoothingEnabled = false;
    }
  }

  private drawSelection(rects: GhosttySelectionRect[], color: string): void {
    this.selectionContext.clearRect(0, 0, this.selectionCanvas.width, this.selectionCanvas.height);

    if (rects.length === 0) {
      return;
    }

    this.selectionContext.fillStyle = color;
    for (const rect of rects) {
      this.selectionContext.fillRect(
        rect.x * this.deviceCellWidth,
        rect.row * this.deviceCellHeight,
        rect.width * this.deviceCellWidth,
        this.deviceCellHeight
      );
    }
  }

  // 背景遍：清本行带、铺默认底色、逐 cell 铺非默认底色。不画任何字形。
  private drawRowBackground(row: GhosttyRenderRow, colors: GhosttyRenderSnapshotMeta['colors']): void {
    const y = row.y * this.deviceCellHeight;
    const width = this.cols * this.deviceCellWidth;
    const defaultBackground = this.toCss(colors.background);

    this.mainContext.clearRect(0, y, width, this.deviceCellHeight);
    this.mainContext.fillStyle = defaultBackground;
    this.mainContext.fillRect(0, y, width, this.deviceCellHeight);

    for (const cell of row.cells) {
      if (cell.widthKind === 'spacer-tail' || cell.widthKind === 'spacer-head') {
        continue;
      }

      const bg = cell.style.inverse
        ? cell.fgColor ?? colors.foreground
        : cell.bgColor ?? colors.background;
      if (
        bg.r !== colors.background.r ||
        bg.g !== colors.background.g ||
        bg.b !== colors.background.b
      ) {
        const x = cell.x * this.deviceCellWidth;
        const cellWidth =
          cell.widthKind === 'wide' ? this.deviceCellWidth * 2 : this.deviceCellWidth;
        this.mainContext.fillStyle = this.toCss(bg);
        this.mainContext.fillRect(x, y, cellWidth, this.deviceCellHeight);
      }
    }
  }

  // 前景遍：逐 cell 画字形/块元素/装饰线。在所有行背景铺完后调用，故字形可越界相邻 cell
  // 而不被邻 cell 的不透明背景擦掉（允许「奇怪」Unicode 的升/降部溢出）。
  private drawRowForeground(row: GhosttyRenderRow, colors: GhosttyRenderSnapshotMeta['colors']): void {
    const y = row.y * this.deviceCellHeight;
    const lineThickness = Math.max(1, Math.round(this.dpr));

    for (const cell of row.cells) {
      if (cell.widthKind === 'spacer-tail' || cell.widthKind === 'spacer-head') {
        continue;
      }

      if (!cell.text || cell.style.invisible) {
        continue;
      }

      const x = cell.x * this.deviceCellWidth;
      const fg = cell.style.inverse
        ? cell.bgColor ?? colors.background
        : cell.fgColor ?? colors.foreground;
      const cellWidth = cell.widthKind === 'wide' ? this.deviceCellWidth * 2 : this.deviceCellWidth;

      this.mainContext.fillStyle = this.toCss(fg);
      // 块元素（▀▄█▌▐░▒▓ 等）不能交给字体：字形最多覆盖 1em，而 cell 高为
      // 1.2em，行列间会留缝（logo/色块图中的明显间隙），必须按 cell 精确自绘。
      const blockCodepoint =
        cell.codepoints.length === 1 && isBlockElement(cell.codepoints[0])
          ? cell.codepoints[0]
          : null;
      if (blockCodepoint !== null) {
        this.drawBlockElement(blockCodepoint, x, y, cellWidth, this.deviceCellHeight);
      } else {
        this.mainContext.font = this.resolveFont(cell.style);
        this.mainContext.fillText(cell.text, x, y + this.textBaselineY);
      }

      // 装饰线随真实字形盒走，而非 cell 边缘：下划线贴字底、上划线贴字顶、
      // 删除线穿字形几何中线。
      const glyphTop = y + this.textTopGap;
      const glyphBottom = y + this.textTopGap + this.glyphBoxHeight;
      if (cell.style.underline > 0) {
        this.mainContext.fillRect(
          x,
          Math.min(
            Math.round(glyphBottom - lineThickness),
            y + this.deviceCellHeight - lineThickness
          ),
          Math.max(cellWidth - lineThickness, lineThickness),
          lineThickness
        );
      }

      if (cell.style.strikethrough) {
        this.mainContext.fillRect(
          x,
          Math.round(y + this.textTopGap + this.glyphBoxHeight / 2),
          Math.max(cellWidth - lineThickness, lineThickness),
          lineThickness
        );
      }

      if (cell.style.overline) {
        this.mainContext.fillRect(
          x,
          Math.max(y, Math.round(glyphTop)),
          Math.max(cellWidth - lineThickness, lineThickness),
          lineThickness
        );
      }
    }
  }

  // fillStyle 由调用方设好。分割点统一 round 到整数物理像素，相邻块元素的
  // 拼接处既不留缝也不重叠。
  private drawBlockElement(
    codepoint: number,
    x: number,
    y: number,
    width: number,
    height: number
  ): void {
    const context = this.mainContext;
    const sx = (n: number) => Math.round((width * n) / 8);
    const sy = (n: number) => Math.round((height * n) / 8);
    const fill = (x0: number, y0: number, x1: number, y1: number) => {
      context.fillRect(x + x0, y + y0, x1 - x0, y1 - y0);
    };

    if (codepoint === 0x2580) {
      // ▀ 上半块
      fill(0, 0, width, sy(4));
      return;
    }
    if (codepoint >= 0x2581 && codepoint <= 0x2588) {
      // ▁..█ 自下而上 n/8
      fill(0, sy(8 - (codepoint - 0x2580)), width, height);
      return;
    }
    if (codepoint >= 0x2589 && codepoint <= 0x258f) {
      // ▉..▏ 自左起 n/8
      fill(0, 0, sx(0x2590 - codepoint), height);
      return;
    }
    if (codepoint === 0x2590) {
      // ▐ 右半块
      fill(sx(4), 0, width, height);
      return;
    }
    const shadeAlpha = SHADE_ALPHA.get(codepoint);
    if (shadeAlpha !== undefined) {
      // ░▒▓ 按前景色 alpha 混合
      const previousAlpha = context.globalAlpha;
      context.globalAlpha = previousAlpha * shadeAlpha;
      fill(0, 0, width, height);
      context.globalAlpha = previousAlpha;
      return;
    }
    if (codepoint === 0x2594) {
      // ▔ 上 1/8
      fill(0, 0, width, sy(1));
      return;
    }
    if (codepoint === 0x2595) {
      // ▕ 右 1/8
      fill(sx(7), 0, width, height);
      return;
    }
    const quadrants = QUADRANT_FLAGS.get(codepoint) ?? 0;
    const midX = sx(4);
    const midY = sy(4);
    if (quadrants & 0b0001) fill(0, 0, midX, midY);
    if (quadrants & 0b0010) fill(midX, 0, width, midY);
    if (quadrants & 0b0100) fill(0, midY, midX, height);
    if (quadrants & 0b1000) fill(midX, midY, width, height);
  }

  private drawCursor(meta: GhosttyRenderSnapshotMeta): void {
    const colors = meta.colors;
    const cursor = meta.cursor;
    const previous = this.lastCursor;
    this.cursorContext.clearRect(0, 0, this.cursorCanvas.width, this.cursorCanvas.height);

    if (!cursor.visible || cursor.x === null || cursor.y === null) {
      this.lastCursor = null;
      this.stopCursorBlink();
      return;
    }

    const x = cursor.x * this.deviceCellWidth;
    const y = cursor.y * this.deviceCellHeight;
    const width = cursor.wideTail ? this.deviceCellWidth * 2 : this.deviceCellWidth;
    const thickness = Math.max(1, Math.round(this.dpr));
    const cursorColor = colors.cursor ?? colors.foreground;
    const cssColor = this.toCss(cursorColor);

    this.cursorContext.fillStyle = cssColor;
    this.cursorContext.strokeStyle = cssColor;
    this.cursorContext.globalAlpha = 0.7;
    this.cursorContext.fillRect(
      x,
      y + this.deviceCellHeight - 2 * thickness,
      Math.max(width - thickness, thickness),
      2 * thickness
    );
    this.cursorContext.globalAlpha = 1;

    this.startCursorBlink();

    this.lastCursor = {
      x: cursor.x,
      y: cursor.y,
      style: cursor.style,
    };

    if (
      previous &&
      (previous.x !== this.lastCursor.x ||
        previous.y !== this.lastCursor.y ||
        previous.style !== this.lastCursor.style)
    ) {
      this.lastDrawnRows.push(previous.y);
    }
  }

  private resolveFont(style: GhosttyRenderRow['cells'][number]['style']): string {
    const deviceFontSize = this.deviceFontSize;
    const key = [
      style.italic ? 'italic' : 'normal',
      style.bold ? '700' : '400',
      `${deviceFontSize}px`,
      this.fontFamily,
    ].join('|');

    const cached = this.fontCache.get(key);
    if (cached) {
      return cached;
    }

    const font = `${style.italic ? 'italic ' : ''}${style.bold ? '700 ' : ''}${deviceFontSize}px ${this.fontFamily}`;
    this.fontCache.set(key, font);
    return font;
  }

  private toCss(color: GhosttyColorRgb): string {
    const key = `${color.r},${color.g},${color.b}`;
    const cached = this.colorCache.get(key);
    if (cached) {
      return cached;
    }

    const css = colorToCss(color);
    this.colorCache.set(key, css);
    return css;
  }
}

export type { CanvasRendererDebugState, CanvasRendererFrame, CanvasRendererOptions };
