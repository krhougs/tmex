import type {
  CanvasRendererFrame,
  CanvasRendererOptions,
  LinkUnderlineSegment,
} from './canvas-renderer';
import {
  type GlyphConstraintDecision,
  type GlyphInk,
  resolveGlyphConstraint,
} from './glyph-constraint';
import { scanLigatureSegments } from './ligature-segments';
import { ensureMinimumContrast, isFallbackEligible } from './minimum-contrast';
import type { GhosttyColorRgb, GhosttyRenderCell, GhosttyRenderRow, GhosttyTheme } from './types';
import { WebglAtlas } from './webgl-atlas';
import { WebglImages } from './webgl-images';
import { type QuadColor, WebglQuads } from './webgl-quads';

export type WebglRendererOptions = CanvasRendererOptions & { onFailure?: (reason: string) => void };
const rgb = (color: GhosttyColorRgb, alpha = 1): QuadColor => [
  color.r / 255,
  color.g / 255,
  color.b / 255,
  alpha,
];
const css = (color: GhosttyColorRgb) => `rgb(${color.r} ${color.g} ${color.b})`;
const isSymbol = (cell: GhosttyRenderCell) =>
  cell.widthKind === 'narrow' && cell.codepoints.length === 1 && cell.codepoints[0] > 0x7f;
const isGraphics = (cp: number) =>
  (cp >= 0x2500 && cp <= 0x259f) ||
  (cp >= 0x1fb00 && cp <= 0x1fbff) ||
  (cp >= 0x1cc00 && cp <= 0x1cebf) ||
  (cp >= 0xe0b0 && cp <= 0xe0d7);

export class WebglRenderer {
  readonly kind = 'webgl';
  private readonly canvas: HTMLCanvasElement;
  private readonly quads: WebglQuads;
  private readonly atlas: WebglAtlas;
  private readonly images: WebglImages;
  private readonly inkCache = new Map<string, GlyphInk | null>();
  private readonly contrastCache = new Map<string, GhosttyColorRgb>();
  private readonly cssColors = new Map<string, QuadColor>();
  private theme: GhosttyTheme;
  private cellWidth = 9;
  private cellHeight = 17;
  private dpr = 1;
  private baseline = 13;
  private topGap = 0;
  private glyphHeight = 13;
  private geometry = '';
  private disposed = false;
  private failure: string | null = null;
  private frameCount = 0;
  private lastDrawnRows: number[] = [];
  private frame: CanvasRendererFrame | null = null;
  private links: LinkUnderlineSegment[] = [];
  private blinkVisible = true;
  private blinkTimer: ReturnType<typeof setInterval> | null = null;
  private readonly onContextLost = (event: Event) => {
    event.preventDefault();
    this.fail('WebGL context lost');
  };

  constructor(private readonly options: WebglRendererOptions) {
    this.theme = options.theme;
    this.canvas = document.createElement('canvas');
    this.canvas.dataset.layer = 'main';
    this.canvas.dataset.renderer = 'webgl';
    Object.assign(this.canvas.style, {
      position: 'absolute',
      inset: '0',
      pointerEvents: 'none',
      zIndex: '0',
    });
    const gl = this.canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error('WebGL2 context unavailable');
    let quads: WebglQuads | undefined;
    let atlas: WebglAtlas | undefined;
    try {
      quads = new WebglQuads(gl);
      atlas = new WebglAtlas(quads);
      this.quads = quads;
      this.atlas = atlas;
      this.images = new WebglImages(
        quads,
        () => options.onInvalidate?.(),
        (reason) => this.fail(reason)
      );
      options.screenElement.style.position = 'relative';
      options.screenElement.style.overflow = 'hidden';
      this.canvas.addEventListener('webglcontextlost', this.onContextLost);
      options.screenElement.appendChild(this.canvas);
    } catch (error) {
      atlas?.dispose();
      quads?.dispose();
      this.canvas.remove();
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      throw error;
    }
  }

  setTheme(theme: GhosttyTheme): void {
    this.theme = theme;
    this.contrastCache.clear();
    this.cssColors.clear();
    this.atlas.clear();
  }

  render(frame: CanvasRendererFrame): void {
    if (this.disposed || this.failure) return;
    this.frame = frame;
    this.frameCount++;
    try {
      this.resize(frame);
      this.images.prepare(frame.graphics);
      this.paint(frame);
      this.updateBlink(frame);
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
    }
  }

  private resize(frame: CanvasRendererFrame): void {
    const dpr = Math.max(1, globalThis.devicePixelRatio ?? 1);
    const cellWidth = Math.max(1, Math.round(frame.cellDimensions.width * dpr));
    const cellHeight = Math.max(1, Math.round(frame.cellDimensions.height * dpr));
    const geometry = `${cellWidth}/${cellHeight}/${dpr}`;
    if (this.geometry !== geometry) {
      this.geometry = geometry;
      this.cellWidth = cellWidth;
      this.cellHeight = cellHeight;
      this.dpr = dpr;
      this.atlas.context.font = `${this.options.fontSize * dpr}px ${this.options.fontFamily}`;
      const metrics = this.atlas.context.measureText('Mg|qyÅ');
      const valid =
        Number.isFinite(metrics.fontBoundingBoxAscent) &&
        metrics.fontBoundingBoxAscent > 0 &&
        Number.isFinite(metrics.fontBoundingBoxDescent);
      const ascent = valid ? metrics.fontBoundingBoxAscent : this.options.fontSize * dpr * 0.8;
      const descent = valid ? metrics.fontBoundingBoxDescent : this.options.fontSize * dpr * 0.2;
      this.glyphHeight = ascent + descent;
      this.topGap = Math.round((cellHeight - this.glyphHeight) / 2);
      this.baseline = Math.round(this.topGap + ascent);
      this.atlas.clear();
      this.inkCache.clear();
    }
    const width = Math.max(1, frame.meta.cols) * cellWidth;
    const height = Math.max(1, frame.meta.rows) * cellHeight;
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    this.canvas.style.width = `${width / dpr}px`;
    this.canvas.style.height = `${height / dpr}px`;
    if (
      this.quads.gl.drawingBufferWidth !== width ||
      this.quads.gl.drawingBufferHeight !== height
    ) {
      throw new Error('WebGL drawing buffer dimensions unavailable');
    }
  }

  private paint(frame: CanvasRendererFrame): void {
    const { colors } = frame.meta;
    this.quads.begin(this.canvas.width, this.canvas.height, rgb(colors.background));
    for (const row of frame.rows)
      for (const cell of row.cells) {
        if (cell.widthKind === 'spacer-head' || cell.widthKind === 'spacer-tail') continue;
        const bg = cell.style.inverse
          ? (cell.fgColor ?? colors.foreground)
          : (cell.bgColor ?? colors.background);
        if (
          bg.r === colors.background.r &&
          bg.g === colors.background.g &&
          bg.b === colors.background.b
        )
          continue;
        this.quads.quad(
          cell.x * this.cellWidth,
          row.y * this.cellHeight,
          this.cellWidth * (cell.widthKind === 'wide' ? 2 : 1),
          this.cellHeight,
          rgb(bg)
        );
      }
    const placements = [...(frame.graphics?.placements ?? [])].sort(
      (a, b) => a.z - b.z || a.imageId - b.imageId
    );
    const drawImages = (min: number, max: number) => {
      for (const placement of placements)
        if (placement.z >= min && placement.z < max) {
          this.images.draw(
            placement,
            this.cellWidth,
            this.cellHeight,
            this.dpr,
            frame.graphicsRowOffset ?? 0
          );
        }
    };
    drawImages(-Infinity, 0);
    for (const row of frame.rows) this.drawRow(row, frame);
    drawImages(0, 1000);
    this.drawLinks();
    const selection = this.parseColor(frame.selectionColor ?? this.theme.selectionBackground);
    for (const rect of frame.selectionRects ?? [])
      this.quads.quad(
        rect.x * this.cellWidth,
        rect.row * this.cellHeight,
        rect.width * this.cellWidth,
        this.cellHeight,
        selection
      );
    this.drawCursor(frame);
    drawImages(1000, Infinity);
    this.quads.flush();
    this.quads.checkError();
    this.lastDrawnRows = frame.rows.map((row) => row.y);
  }

  private drawRow(row: GhosttyRenderRow, frame: CanvasRendererFrame): void {
    const { colors } = frame.meta;
    const segments = this.options.ligatures
      ? scanLigatureSegments(row.cells, {
          foreground: colors.foreground,
          background: colors.background,
          minimumContrast: this.options.minimumContrast ?? false,
        })
      : [];
    const starts = new Map(segments.map((segment) => [segment.startIndex, segment]));
    const tails = new Set<number>();
    for (const segment of segments)
      for (let index = segment.startIndex + 1; index < segment.endIndex; index++) tails.add(index);
    for (const [index, cell] of row.cells.entries()) {
      if (
        cell.codepoints[0] === 0x10eeee ||
        cell.widthKind === 'spacer-head' ||
        cell.widthKind === 'spacer-tail' ||
        !cell.text ||
        cell.style.invisible
      )
        continue;
      const x = cell.x * this.cellWidth;
      const y = row.y * this.cellHeight;
      const width = this.cellWidth * (cell.widthKind === 'wide' ? 2 : 1);
      const raw = cell.style.inverse
        ? (cell.bgColor ?? colors.background)
        : (cell.fgColor ?? colors.foreground);
      const bg = cell.style.inverse
        ? (cell.fgColor ?? colors.foreground)
        : (cell.bgColor ?? colors.background);
      let fg = raw;
      if (
        this.options.minimumContrast &&
        isFallbackEligible(
          cell.style.inverse ? cell.bgColor : cell.fgColor,
          cell.style.inverse ? cell.bgPaletteIndex : cell.fgPaletteIndex
        )
      ) {
        const key = `${css(raw)}/${css(bg)}`;
        fg = this.contrastCache.get(key) ?? ensureMinimumContrast(raw, bg);
        if (this.contrastCache.size >= 4096) this.contrastCache.clear();
        this.contrastCache.set(key, fg);
      }
      const segment = starts.get(index);
      const cp = cell.codepoints.length === 1 ? cell.codepoints[0] : 0;
      if (segment)
        this.text(
          cell,
          segment.text,
          css(fg),
          segment.startX * this.cellWidth,
          y,
          segment.endIndex - segment.startIndex
        );
      else if (!tails.has(index)) {
        if (cp >= 0x2580 && cp <= 0x259f) this.block(cp, x, y, width, rgb(fg));
        else
          this.text(
            cell,
            cell.text,
            css(fg),
            x,
            y,
            width / this.cellWidth,
            this.constraint(cell, row, index, frame.meta.cols)
          );
      }
      const thickness = Math.max(1, Math.round(this.dpr));
      const lineWidth = Math.max(width - thickness, thickness);
      if (cell.style.underline > 0)
        this.quads.quad(
          x,
          Math.min(
            Math.round(y + this.topGap + this.glyphHeight - thickness),
            y + this.cellHeight - thickness
          ),
          lineWidth,
          thickness,
          rgb(fg)
        );
      if (cell.style.strikethrough)
        this.quads.quad(
          x,
          Math.round(y + this.topGap + this.glyphHeight / 2),
          lineWidth,
          thickness,
          rgb(fg)
        );
      if (cell.style.overline)
        this.quads.quad(x, Math.max(y, Math.round(y + this.topGap)), lineWidth, thickness, rgb(fg));
    }
  }

  private font(cell: GhosttyRenderCell): string {
    return `${cell.style.italic ? 'italic ' : ''}${cell.style.bold ? '700 ' : ''}${this.options.fontSize * this.dpr}px ${this.options.fontFamily}`;
  }

  private text(
    cell: GhosttyRenderCell,
    text: string,
    color: string,
    x: number,
    y: number,
    span: number,
    constraint?: GlyphConstraintDecision
  ): void {
    this.atlas.draw(
      this.font(cell),
      text,
      color,
      x,
      y,
      this.cellWidth,
      this.cellHeight,
      this.baseline,
      span,
      constraint
    );
  }

  private constraint(
    cell: GhosttyRenderCell,
    row: GhosttyRenderRow,
    index: number,
    cols: number
  ): GlyphConstraintDecision | undefined {
    if (!isSymbol(cell)) return;
    const font = this.font(cell);
    const key = `${font}\0${cell.text}`;
    let ink = this.inkCache.get(key);
    if (ink === undefined) {
      this.atlas.context.font = font;
      const metrics = this.atlas.context.measureText(cell.text);
      ink =
        Number.isFinite(metrics.actualBoundingBoxLeft) &&
        Number.isFinite(metrics.actualBoundingBoxRight)
          ? { left: metrics.actualBoundingBoxLeft, right: metrics.actualBoundingBoxRight }
          : null;
      if (this.inkCache.size >= 8192) this.inkCache.clear();
      this.inkCache.set(key, ink);
    }
    if (!ink) return;
    const next = row.cells[index + 1];
    const previous = row.cells[index - 1];
    const nextEmpty = cell.x + 1 < cols && (!next || !next.text || next.text === ' ');
    const previousSymbol = previous && isSymbol(previous) && !isGraphics(previous.codepoints[0]);
    return resolveGlyphConstraint({
      ink,
      cellWidth: this.cellWidth,
      maxInkWidth: nextEmpty && !previousSymbol ? this.cellWidth * 2 : this.cellWidth,
    });
  }

  private block(cp: number, x: number, y: number, width: number, color: QuadColor): void {
    const height = this.cellHeight;
    const sx = (n: number) => Math.round((width * n) / 8);
    const sy = (n: number) => Math.round((height * n) / 8);
    const fill = (left: number, top: number, right: number, bottom: number, tint = color) =>
      this.quads.quad(x + left, y + top, right - left, bottom - top, tint);
    if (cp === 0x2580) fill(0, 0, width, sy(4));
    else if (cp <= 0x2588) fill(0, sy(8 - (cp - 0x2580)), width, height);
    else if (cp <= 0x258f) fill(0, 0, sx(0x2590 - cp), height);
    else if (cp === 0x2590) fill(sx(4), 0, width, height);
    else if (cp <= 0x2593)
      fill(0, 0, width, height, [color[0], color[1], color[2], (cp - 0x2590) / 4]);
    else if (cp === 0x2594) fill(0, 0, width, sy(1));
    else if (cp === 0x2595) fill(sx(7), 0, width, height);
    else {
      const flags = [4, 8, 1, 13, 9, 7, 11, 2, 6, 14][cp - 0x2596] ?? 0;
      if (flags & 1) fill(0, 0, sx(4), sy(4));
      if (flags & 2) fill(sx(4), 0, width, sy(4));
      if (flags & 4) fill(0, sy(4), sx(4), height);
      if (flags & 8) fill(sx(4), sy(4), width, height);
    }
  }

  private parseColor(value: string): QuadColor {
    const cached = this.cssColors.get(value);
    if (cached) return cached;
    const context = this.atlas.context;
    context.save();
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = value;
    context.fillRect(0, 0, 1, 1);
    const pixel = context.getImageData(0, 0, 1, 1).data;
    context.restore();
    const color: QuadColor = [pixel[0] / 255, pixel[1] / 255, pixel[2] / 255, pixel[3] / 255];
    if (this.cssColors.size >= 256) this.cssColors.clear();
    this.cssColors.set(value, color);
    return color;
  }

  private drawCursor(frame: CanvasRendererFrame): void {
    const { cursor, colors } = frame.meta;
    if (
      !cursor.visible ||
      cursor.x === null ||
      cursor.y === null ||
      (cursor.blinking && !this.blinkVisible)
    )
      return;
    const column = cursor.wideTail ? Math.max(0, cursor.x - 1) : cursor.x;
    const x = column * this.cellWidth;
    const y = cursor.y * this.cellHeight;
    const width = this.cellWidth * (cursor.wideTail ? 2 : 1);
    const thickness = Math.max(1, Math.round(this.dpr));
    const color = rgb(colors.cursor ?? colors.foreground);
    if (cursor.style === 'block') {
      this.quads.quad(x, y, width, this.cellHeight, color);
      const cell = frame.rows
        .find((row) => row.y === cursor.y)
        ?.cells.find((item) => item.x === column);
      if (cell?.text && !cell.style.invisible)
        this.text(
          cell,
          cell.text,
          css(
            cell.style.inverse
              ? (cell.fgColor ?? colors.foreground)
              : (cell.bgColor ?? colors.background)
          ),
          x,
          y,
          width / this.cellWidth
        );
    } else if (cursor.style === 'block-hollow') {
      this.quads.quad(x, y, width, thickness, color);
      this.quads.quad(x, y + this.cellHeight - thickness, width, thickness, color);
      this.quads.quad(x, y + thickness, thickness, this.cellHeight - 2 * thickness, color);
      this.quads.quad(
        x + width - thickness,
        y + thickness,
        thickness,
        this.cellHeight - 2 * thickness,
        color
      );
    } else if (cursor.style === 'underline')
      this.quads.quad(x, y + this.cellHeight - 2 * thickness, width, 2 * thickness, color);
    else if (cursor.style === 'bar') this.quads.quad(x, y, 2 * thickness, this.cellHeight, color);
  }

  private updateBlink(frame: CanvasRendererFrame): void {
    const cursor = frame.meta.cursor;
    if (cursor.visible && cursor.x !== null && cursor.y !== null && cursor.blinking) {
      if (!this.blinkTimer)
        this.blinkTimer = setInterval(() => {
          this.blinkVisible = !this.blinkVisible;
          this.redraw();
        }, 1000);
    } else {
      if (this.blinkTimer) clearInterval(this.blinkTimer);
      this.blinkTimer = null;
      this.blinkVisible = true;
    }
  }

  drawLinkUnderlines(segments: LinkUnderlineSegment[]): void {
    if (
      segments.length === this.links.length &&
      segments.every((segment, index) => {
        const old = this.links[index];
        return (
          old &&
          old.row === segment.row &&
          old.startCol === segment.startCol &&
          old.endCol === segment.endCol
        );
      })
    )
      return;
    this.links = segments.map((segment) => ({ ...segment }));
    this.redraw();
  }

  clearLinkUnderlines(): void {
    this.drawLinkUnderlines([]);
  }

  private drawLinks(): void {
    const thickness = Math.max(1, Math.round(this.dpr));
    const dash = Math.max(2, Math.round(2 * this.dpr));
    const base = this.parseColor(this.theme.foreground);
    const color: QuadColor = [base[0], base[1], base[2], base[3] * 0.55];
    for (const segment of this.links) {
      const top = segment.row * this.cellHeight;
      const y = Math.min(
        Math.round(top + this.topGap + this.glyphHeight - thickness),
        top + this.cellHeight - thickness
      );
      const end = (segment.endCol + 1) * this.cellWidth;
      for (let x = segment.startCol * this.cellWidth; x < end; x += dash * 2)
        this.quads.quad(x, y, Math.min(dash, end - x), thickness, color);
    }
  }

  private redraw(): void {
    if (!this.frame || this.disposed || this.failure) return;
    try {
      this.paint(this.frame);
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
    }
  }

  private fail(reason: string): void {
    if (this.disposed || this.failure) return;
    this.failure = reason;
    if (this.blinkTimer) clearInterval(this.blinkTimer);
    this.blinkTimer = null;
    this.options.onFailure?.(reason);
  }

  getDebugState() {
    return {
      kind: this.kind,
      frameCount: this.frameCount,
      lastDrawnRows: [...this.lastDrawnRows],
      drawCalls: this.quads.drawCalls,
      atlas: this.atlas.getStats(),
      images: this.images.getStats(),
      failure: this.failure,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.blinkTimer) clearInterval(this.blinkTimer);
    this.blinkTimer = null;
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.images.dispose();
    this.atlas.dispose();
    this.quads.dispose();
    this.inkCache.clear();
    this.contrastCache.clear();
    this.cssColors.clear();
    this.frame = null;
    this.links = [];
    this.canvas.remove();
    this.quads.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
