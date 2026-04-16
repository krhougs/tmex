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
    const targetRows = drawAllRows ? frame.rows : frame.rows.filter((row) => row.dirty);

    for (const row of targetRows) {
      this.drawRow(row, frame.meta.colors);
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
    const width = nextCols * this.cellDimensions.width;
    const height = nextRows * this.cellDimensions.height;
    const dpr = Math.max(1, globalThis.devicePixelRatio ?? 1);

    if (this.cols === nextCols && this.rows === nextRows) {
      const cssWidth = `${width}px`;
      const cssHeight = `${height}px`;
      if (this.mainCanvas.style.width === cssWidth && this.mainCanvas.style.height === cssHeight) {
        return;
      }
    }

    this.cols = nextCols;
    this.rows = nextRows;

    for (const canvas of [this.mainCanvas, this.selectionCanvas, this.cursorCanvas]) {
      canvas.width = Math.max(1, Math.ceil(width * dpr));
      canvas.height = Math.max(1, Math.ceil(height * dpr));
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    }

    for (const context of [this.mainContext, this.selectionContext, this.cursorContext]) {
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.textBaseline = 'top';
      context.imageSmoothingEnabled = false;
    }
  }

  private drawSelection(rects: GhosttySelectionRect[], color: string): void {
    this.selectionContext.clearRect(
      0,
      0,
      this.cols * this.cellDimensions.width,
      this.rows * this.cellDimensions.height
    );

    if (rects.length === 0) {
      return;
    }

    this.selectionContext.fillStyle = color;
    for (const rect of rects) {
      this.selectionContext.fillRect(
        rect.x * this.cellDimensions.width,
        rect.row * this.cellDimensions.height,
        rect.width * this.cellDimensions.width,
        this.cellDimensions.height
      );
    }
  }

  private drawRow(row: GhosttyRenderRow, colors: GhosttyRenderSnapshotMeta['colors']): void {
    const y = row.y * this.cellDimensions.height;
    const width = this.cols * this.cellDimensions.width;
    const defaultBackground = this.toCss(colors.background);

    this.mainContext.clearRect(0, y, width, this.cellDimensions.height);
    this.mainContext.fillStyle = defaultBackground;
    this.mainContext.fillRect(0, y, width, this.cellDimensions.height);

    for (const cell of row.cells) {
      if (cell.widthKind === 'spacer-tail' || cell.widthKind === 'spacer-head') {
        continue;
      }

      const x = cell.x * this.cellDimensions.width;
      const bg = cell.style.inverse
        ? cell.fgColor ?? colors.foreground
        : cell.bgColor ?? colors.background;
      const fg = cell.style.inverse
        ? cell.bgColor ?? colors.background
        : cell.fgColor ?? colors.foreground;
      const cellWidth = cell.widthKind === 'wide' ? this.cellDimensions.width * 2 : this.cellDimensions.width;

      if (bg.r !== colors.background.r || bg.g !== colors.background.g || bg.b !== colors.background.b) {
        this.mainContext.fillStyle = this.toCss(bg);
        this.mainContext.fillRect(x, y, cellWidth, this.cellDimensions.height);
      }

      if (!cell.text || cell.style.invisible) {
        continue;
      }

      this.mainContext.font = this.resolveFont(cell.style);
      this.mainContext.fillStyle = this.toCss(fg);
      this.mainContext.fillText(cell.text, x, y);

      if (cell.style.underline > 0) {
        this.mainContext.fillRect(
          x,
          y + this.cellDimensions.height - 2,
          Math.max(cellWidth - 1, 1),
          1
        );
      }

      if (cell.style.strikethrough) {
        this.mainContext.fillRect(
          x,
          y + this.cellDimensions.height * 0.55,
          Math.max(cellWidth - 1, 1),
          1
        );
      }

      if (cell.style.overline) {
        this.mainContext.fillRect(x, y + 1, Math.max(cellWidth - 1, 1), 1);
      }
    }
  }

  private drawCursor(meta: GhosttyRenderSnapshotMeta): void {
    const colors = meta.colors;
    const cursor = meta.cursor;
    const previous = this.lastCursor;
    this.cursorContext.clearRect(
      0,
      0,
      this.cols * this.cellDimensions.width,
      this.rows * this.cellDimensions.height
    );

    if (!cursor.visible || cursor.x === null || cursor.y === null) {
      this.lastCursor = null;
      this.stopCursorBlink();
      return;
    }

    const x = cursor.x * this.cellDimensions.width;
    const y = cursor.y * this.cellDimensions.height;
    const width = cursor.wideTail ? this.cellDimensions.width * 2 : this.cellDimensions.width;
    const cursorColor = colors.cursor ?? colors.foreground;
    const cssColor = this.toCss(cursorColor);

    this.cursorContext.fillStyle = cssColor;
    this.cursorContext.strokeStyle = cssColor;
    this.cursorContext.globalAlpha = 0.7;
    this.cursorContext.fillRect(
      x,
      y + this.cellDimensions.height - 2,
      Math.max(width - 1, 1),
      2
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
    const key = [
      style.italic ? 'italic' : 'normal',
      style.bold ? '700' : '400',
      `${this.fontSize}px`,
      this.fontFamily,
    ].join('|');

    const cached = this.fontCache.get(key);
    if (cached) {
      return cached;
    }

    const font = `${style.italic ? 'italic ' : ''}${style.bold ? '700 ' : ''}${this.fontSize}px ${this.fontFamily}`;
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
