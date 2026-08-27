import { type GlyphInk, resolveGlyphConstraint } from './glyph-constraint';
import { GlyphRunCache } from './glyph-run-cache';
import { type LigatureSegment, scanLigatureSegments } from './ligature-segments';
import { ensureMinimumContrast, isFallbackEligible } from './minimum-contrast';
import type {
  GhosttyCellDimensions,
  GhosttyColorRgb,
  GhosttyKittyGraphicsSnapshot,
  GhosttyKittyImageSnapshot,
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
  ligatures?: boolean;
  minimumContrast?: boolean;
  onInvalidate?: () => void;
};

type CanvasRendererFrame = {
  meta: GhosttyRenderSnapshotMeta;
  rows: GhosttyRenderRow[];
  cellDimensions: GhosttyCellDimensions;
  selectionRects?: GhosttySelectionRect[];
  selectionColor?: string;
  graphics?: GhosttyKittyGraphicsSnapshot;
  graphicsRowOffset?: number;
  // canvas 在上次 render 后被 resize 清空了位图（HTML5 canvas.width 赋值副作用），
  // 或 terminal 显式请求全画（forceFullRepaint）：两种情形都必须忽略 dirty='clean'
  // 早退、强制按 'full' 重画所有行，否则屏幕空白（issue #45 bug 3）。
  forceFull?: boolean;
};

type CanvasRendererDebugState = {
  kind: 'canvas';
  frameCount: number;
  lastDrawnRows: number[];
};

type LinkUnderlineSegment = {
  /** 视口内行号（0 起） */
  row: number;
  startCol: number;
  endCol: number;
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

// 图形元素（box drawing/block/legacy computing/powerline）参与拼接，不作为
// 「相邻符号」触发宽度收紧（对齐 ghostty isGraphicsElement）。
function isGraphicsElement(codepoint: number): boolean {
  return (
    (codepoint >= 0x2500 && codepoint <= 0x259f) ||
    (codepoint >= 0x1fb00 && codepoint <= 0x1fbff) ||
    (codepoint >= 0x1cc00 && codepoint <= 0x1cebf) ||
    (codepoint >= 0xe0b0 && codepoint <= 0xe0d7)
  );
}

function isConstrainedSymbolCell(cell: GhosttyRenderRow['cells'][number]): boolean {
  return cell.widthKind === 'narrow' && cell.codepoints.length === 1 && cell.codepoints[0] > 0x7f;
}

function ensureContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('2d canvas context unavailable');
  }

  return context;
}

type KittyTexture = {
  generation: bigint;
  source: CanvasImageSource;
  fallbackCanvas: HTMLCanvasElement | null;
  bitmap: ImageBitmap | null;
};

function kittyRgbaPixels(image: GhosttyKittyImageSnapshot): Uint8ClampedArray | null {
  const pixels = image.width * image.height;
  if (!Number.isSafeInteger(pixels) || pixels <= 0) return null;
  const rgba = new Uint8ClampedArray(pixels * 4);
  const source = image.data;
  let sourceStride: number;
  switch (image.format) {
    case 0:
      sourceStride = 3;
      break;
    case 1:
      sourceStride = 4;
      break;
    case 3:
      sourceStride = 2;
      break;
    case 4:
      sourceStride = 1;
      break;
    default:
      return null;
  }
  if (source.byteLength !== pixels * sourceStride) return null;
  for (let index = 0; index < pixels; index += 1) {
    const sourceOffset = index * sourceStride;
    const targetOffset = index * 4;
    switch (image.format) {
      case 0:
        rgba[targetOffset] = source[sourceOffset];
        rgba[targetOffset + 1] = source[sourceOffset + 1];
        rgba[targetOffset + 2] = source[sourceOffset + 2];
        rgba[targetOffset + 3] = 255;
        break;
      case 1:
        rgba.set(source.subarray(sourceOffset, sourceOffset + 4), targetOffset);
        break;
      case 3:
        rgba[targetOffset] = source[sourceOffset];
        rgba[targetOffset + 1] = source[sourceOffset];
        rgba[targetOffset + 2] = source[sourceOffset];
        rgba[targetOffset + 3] = source[sourceOffset + 1];
        break;
      case 4:
        rgba[targetOffset] = source[sourceOffset];
        rgba[targetOffset + 1] = source[sourceOffset];
        rgba[targetOffset + 2] = source[sourceOffset];
        rgba[targetOffset + 3] = 255;
        break;
    }
  }
  return rgba;
}

export class CanvasRenderer {
  readonly kind = 'canvas';

  private readonly screenElement: HTMLElement;
  private readonly mainCanvas: HTMLCanvasElement;
  private imageOverCanvas: HTMLCanvasElement | null = null;
  private readonly linkCanvas: HTMLCanvasElement;
  private readonly selectionCanvas: HTMLCanvasElement;
  private readonly cursorCanvas: HTMLCanvasElement;
  private imageTopCanvas: HTMLCanvasElement | null = null;
  private readonly mainContext: CanvasRenderingContext2D;
  private imageOverContext: CanvasRenderingContext2D | null = null;
  private readonly linkContext: CanvasRenderingContext2D;
  private readonly selectionContext: CanvasRenderingContext2D;
  private readonly cursorContext: CanvasRenderingContext2D;
  private imageTopContext: CanvasRenderingContext2D | null = null;
  private theme: GhosttyTheme;
  private readonly fontFamily: string;
  private readonly fontSize: number;
  private readonly ligatures: boolean;
  private readonly minimumContrast: boolean;
  private readonly onInvalidate: (() => void) | undefined;
  private readonly kittyTextures = new Map<number, KittyTexture>();
  private kittySnapshot: GhosttyKittyGraphicsSnapshot | undefined;
  private kittyRowOffset = 0;
  /** createImageBitmap(ImageData) 能力（探测失败后永久回落 canvas 路径）。 */
  private imageDataBitmapSupported: boolean | null = null;
  private hadKittyUnder = false;
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
  // (fg,bg) 组合数远少于 cell 数,缓存后每帧只算少量新组合。
  private readonly contrastCache = new Map<string, GhosttyColorRgb>();
  private readonly fontCache = new Map<string, string>();
  private readonly glyphInkCache = new Map<string, GlyphInk | null>();
  // 字形 run 位图缓存:同 (font, text, color) 的 fillText 只在 atlas 上发生一次,
  // 命中直接 drawImage,消除逐 cell shaping(见 glyph-run-cache.ts)。
  private readonly glyphRunCache = new GlyphRunCache();
  // 测试专用开关:关闭后走直绘,用于缓存启用/禁用的像素等价回归对比。
  private glyphRunCacheEnabled = true;
  private cursorBlinkVisible = true;
  private cursorBlinkTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: CanvasRendererOptions) {
    this.theme = options.theme;
    this.fontFamily = options.fontFamily;
    this.fontSize = options.fontSize;
    this.ligatures = options.ligatures ?? false;
    this.minimumContrast = options.minimumContrast ?? false;
    this.onInvalidate = options.onInvalidate;
    this.screenElement = options.screenElement;

    options.screenElement.style.position = 'relative';
    options.screenElement.style.overflow = 'hidden';

    this.mainCanvas = document.createElement('canvas');
    this.linkCanvas = document.createElement('canvas');
    this.selectionCanvas = document.createElement('canvas');
    this.cursorCanvas = document.createElement('canvas');

    for (const [canvas, layer] of [
      [this.mainCanvas, 'main'],
      [this.linkCanvas, 'link'],
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
    this.mainCanvas.style.zIndex = '0';
    this.linkCanvas.style.zIndex = '3';
    this.selectionCanvas.style.zIndex = '4';
    this.cursorCanvas.style.zIndex = '5';

    this.mainContext = ensureContext(this.mainCanvas);
    this.linkContext = ensureContext(this.linkCanvas);
    this.selectionContext = ensureContext(this.selectionCanvas);
    this.cursorContext = ensureContext(this.cursorCanvas);
  }

  setTheme(theme: GhosttyTheme): void {
    this.theme = theme;
    this.colorCache.clear();
    this.contrastCache.clear();
    // 主题切换后 minimum-contrast 解析出的前景色全部可能变化,位图整体失效。
    this.glyphRunCache.clear();
  }

  render(frame: CanvasRendererFrame): void {
    this.frameCount += 1;
    this.lastDrawnRows = [];
    this.cellDimensions = frame.cellDimensions;
    const wiped = this.resize(frame.meta.cols, frame.meta.rows);
    const repaintKittyUnder = this.prepareKittyGraphics(
      frame.graphics,
      frame.graphicsRowOffset ?? 0
    );
    this.drawSelection(
      frame.selectionRects ?? [],
      frame.selectionColor ?? this.theme.selectionBackground
    );

    // canvas 位图被 resize 清空 / 外部强制全画 → 必须忽略 dirty='clean' 早退，
    // 否则屏幕空白（issue #45 bug 3）。
    const effectiveDirty =
      wiped || frame.forceFull === true || repaintKittyUnder ? 'full' : frame.meta.dirty;

    if (effectiveDirty === 'clean') {
      this.drawCursor(frame.meta, frame.rows);
      return;
    }

    const drawAllRows = effectiveDirty === 'full';
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
    this.drawKittyUnder();
    for (const row of renderRows) {
      this.drawRowForeground(row, frame.meta.colors);
    }

    for (const row of dirtyRows) {
      this.lastDrawnRows.push(row.y);
    }

    this.drawCursor(frame.meta, frame.rows);
  }

  getDebugState(): CanvasRendererDebugState {
    return {
      kind: this.kind,
      frameCount: this.frameCount,
      lastDrawnRows: [...this.lastDrawnRows],
    };
  }

  // 测试专用:关闭字形位图缓存走直绘,供像素等价回归对比缓存启用/禁用两条路径。
  // 保持非 private:唯一调用方是测试,private 会在 noUnusedLocals 构建里报 TS6133。
  setGlyphRunCacheEnabled(enabled: boolean): void {
    if (enabled) {
      this.glyphRunCache.clear();
    }
    this.glyphRunCacheEnabled = enabled;
  }

  dispose(): void {
    for (const texture of this.kittyTextures.values()) this.disposeKittyTexture(texture);
    this.kittyTextures.clear();
    this.releaseKittyLayers();
    this.mainCanvas.remove();
    this.linkCanvas.remove();
    this.selectionCanvas.remove();
    this.cursorCanvas.remove();
    this.colorCache.clear();
    this.contrastCache.clear();
    this.fontCache.clear();
    this.glyphInkCache.clear();
    this.glyphRunCache.clear();
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

  // 返回 true 表示触发了 canvas.width/height 赋值（HTML5 标准会 wipe 已绘位图），
  // 调用方需把 dirty 视作 'full' 强制全画以避免空白屏（issue #45 bug 3）。
  private resize(cols: number, rows: number): boolean {
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
      return false;
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
    // 几何(dpr/cell 尺寸/基线)变化 → 位图尺寸与定位度量全部失效,整体清空。
    this.glyphRunCache.setCellGeometry(deviceCellWidth, deviceCellHeight, this.textBaselineY);

    const width = nextCols * deviceCellWidth;
    const height = nextRows * deviceCellHeight;

    const canvases = [
      this.mainCanvas,
      this.imageOverCanvas,
      this.linkCanvas,
      this.selectionCanvas,
      this.cursorCanvas,
      this.imageTopCanvas,
    ].filter((canvas): canvas is HTMLCanvasElement => canvas !== null);
    for (const canvas of canvases) {
      canvas.width = width;
      canvas.height = height;
      canvas.style.width = `${width / dpr}px`;
      canvas.style.height = `${height / dpr}px`;
    }

    const contexts = [
      this.mainContext,
      this.imageOverContext,
      this.linkContext,
      this.selectionContext,
      this.cursorContext,
      this.imageTopContext,
    ].filter((context): context is CanvasRenderingContext2D => context !== null);
    for (const context of contexts) {
      context.setTransform(1, 0, 0, 1, 0, 0);
      // alphabetic：按真实 baseline 定位，配合 textBaselineY 精确居中字形盒。
      context.textBaseline = 'alphabetic';
      context.imageSmoothingEnabled = false;
    }

    return true;
  }

  private ensureKittyLayers(): void {
    if (this.imageOverCanvas && this.imageTopCanvas) return;
    const createLayer = (name: string, zIndex: number) => {
      const canvas = document.createElement('canvas');
      canvas.dataset.layer = name;
      canvas.style.position = 'absolute';
      canvas.style.inset = '0';
      canvas.style.width = this.mainCanvas.style.width;
      canvas.style.height = this.mainCanvas.style.height;
      canvas.style.pointerEvents = 'none';
      canvas.style.zIndex = String(zIndex);
      canvas.width = this.mainCanvas.width;
      canvas.height = this.mainCanvas.height;
      this.screenElement.appendChild(canvas);
      const context = ensureContext(canvas);
      context.imageSmoothingEnabled = false;
      return { canvas, context };
    };
    if (!this.imageOverCanvas) {
      const layer = createLayer('image-over', 2);
      this.imageOverCanvas = layer.canvas;
      this.imageOverContext = layer.context;
    }
    if (!this.imageTopCanvas) {
      const layer = createLayer('image-top', 6);
      this.imageTopCanvas = layer.canvas;
      this.imageTopContext = layer.context;
    }
  }

  private releaseKittyLayers(): void {
    this.imageOverCanvas?.remove();
    this.imageTopCanvas?.remove();
    this.imageOverCanvas = null;
    this.imageOverContext = null;
    this.imageTopCanvas = null;
    this.imageTopContext = null;
  }

  private prepareKittyGraphics(
    snapshot: GhosttyKittyGraphicsSnapshot | undefined,
    rowOffset: number
  ): boolean {
    const hadUnder = this.hadKittyUnder;
    this.kittySnapshot = snapshot;
    this.kittyRowOffset = rowOffset;
    this.hadKittyUnder = false;
    if (!snapshot && this.kittyTextures.size === 0 && !hadUnder) return false;
    if (!snapshot) {
      for (const [imageId, texture] of this.kittyTextures) {
        this.disposeKittyTexture(texture);
        this.kittyTextures.delete(imageId);
      }
      this.releaseKittyLayers();
      return hadUnder;
    }

    const needsOverlayLayers = snapshot.placements.some((placement) => placement.z >= 0);
    if (needsOverlayLayers) {
      this.ensureKittyLayers();
      this.imageOverContext?.clearRect(
        0,
        0,
        this.imageOverCanvas?.width ?? 0,
        this.imageOverCanvas?.height ?? 0
      );
      this.imageTopContext?.clearRect(
        0,
        0,
        this.imageTopCanvas?.width ?? 0,
        this.imageTopCanvas?.height ?? 0
      );
    } else {
      this.releaseKittyLayers();
    }

    for (const image of snapshot.images) this.upsertKittyTexture(image);
    const activeImageIds = new Set(snapshot.imageIds);
    for (const [imageId, texture] of this.kittyTextures) {
      if (activeImageIds.has(imageId)) continue;
      this.disposeKittyTexture(texture);
      this.kittyTextures.delete(imageId);
    }

    snapshot.placements.sort((left, right) => left.z - right.z || left.imageId - right.imageId);
    for (const placement of snapshot.placements) {
      if (placement.z < 0) {
        this.hadKittyUnder = true;
        continue;
      }
      const context = placement.z >= 1000 ? this.imageTopContext : this.imageOverContext;
      if (context) this.drawKittyPlacement(placement, context);
    }
    return hadUnder || this.hadKittyUnder;
  }

  private drawKittyUnder(): void {
    const snapshot = this.kittySnapshot;
    if (!snapshot) return;
    for (const placement of snapshot.placements) {
      if (placement.z >= 0) break;
      this.drawKittyPlacement(placement, this.mainContext);
    }
  }

  private drawKittyPlacement(
    placement: GhosttyKittyGraphicsSnapshot['placements'][number],
    context: CanvasRenderingContext2D
  ): void {
    if (!placement.viewportVisible || placement.pixelWidth === 0 || placement.pixelHeight === 0) {
      return;
    }
    const texture = this.kittyTextures.get(placement.imageId);
    if (!texture) return;
    const x =
      placement.viewportCol * this.deviceCellWidth + Math.round(placement.xOffset * this.dpr);
    const y =
      (placement.viewportRow + this.kittyRowOffset) * this.deviceCellHeight +
      Math.round(placement.yOffset * this.dpr);
    context.drawImage(
      texture.source,
      placement.sourceX,
      placement.sourceY,
      placement.sourceWidth,
      placement.sourceHeight,
      x,
      y,
      Math.max(1, Math.round(placement.pixelWidth * this.dpr)),
      Math.max(1, Math.round(placement.pixelHeight * this.dpr))
    );
  }

  private upsertKittyTexture(image: GhosttyKittyImageSnapshot): void {
    const previous = this.kittyTextures.get(image.id);
    if (previous?.generation === image.generation) return;
    if (previous) this.disposeKittyTexture(previous);
    const pixels = kittyRgbaPixels(image);
    if (!pixels) {
      this.kittyTextures.delete(image.id);
      return;
    }

    // 像素上传异步化：createImageBitmap(ImageData) 在位图管线里解码上传，
    // 主线程只留一次 data.set() 拷贝；占位 canvas 与最终纹理同尺寸防布局跳变。
    // 不支持该输入的旧环境回落同步 canvas putImageData 路径。
    const canOffload =
      typeof globalThis.createImageBitmap === 'function' &&
      this.imageDataBitmapSupported !== false;
    if (canOffload) {
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const context = ensureContext(canvas);
      const imageData = context.createImageData(image.width, image.height);
      imageData.data.set(pixels);
      const texture: KittyTexture = {
        generation: image.generation,
        source: canvas,
        fallbackCanvas: null,
        bitmap: null,
      };
      this.kittyTextures.set(image.id, texture);
      globalThis
        .createImageBitmap(imageData)
        .then((result) => {
          if (this.kittyTextures.get(image.id) !== texture) {
            result.close();
            return;
          }
          texture.bitmap = result;
          texture.source = result;
          this.onInvalidate?.();
        })
        .catch(() => {
          this.imageDataBitmapSupported = false;
          // 回落：同步 canvas 路径补上这块纹理。
          const fallback = this.syncTextureFromPixels(pixels, image);
          if (fallback) {
            const current = this.kittyTextures.get(image.id);
            if (current === texture) {
              this.disposeKittyTexture(texture);
              this.kittyTextures.set(image.id, fallback);
              this.onInvalidate?.();
            } else {
              this.disposeKittyTexture(fallback);
            }
          }
        });
      return;
    }

    const fallback = this.syncTextureFromPixels(pixels, image);
    if (fallback) this.kittyTextures.set(image.id, fallback);
    else this.kittyTextures.delete(image.id);
  }

  private syncTextureFromPixels(
    pixels: Uint8ClampedArray,
    image: GhosttyKittyImageSnapshot
  ): KittyTexture | null {
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = ensureContext(canvas);
    const imageData = context.createImageData(image.width, image.height);
    imageData.data.set(pixels);
    context.putImageData(imageData, 0, 0);
    const texture: KittyTexture = {
      generation: image.generation,
      source: canvas,
      fallbackCanvas: canvas,
      bitmap: null,
    };
    if (typeof globalThis.createImageBitmap === 'function') {
      void globalThis
        .createImageBitmap(canvas)
        .then((result) => {
          if (this.kittyTextures.get(image.id) !== texture) {
            result.close();
            return;
          }
          texture.bitmap = result;
          texture.source = result;
          if (texture.fallbackCanvas) {
            texture.fallbackCanvas.width = 0;
            texture.fallbackCanvas.height = 0;
            texture.fallbackCanvas = null;
          }
          this.onInvalidate?.();
        })
        .catch(() => {});
    }
    return texture;
  }

  private disposeKittyTexture(texture: KittyTexture): void {
    texture.bitmap?.close();
    if (texture.fallbackCanvas) {
      texture.fallbackCanvas.width = 0;
      texture.fallbackCanvas.height = 0;
    }
  }


  // 链接虚线下划线层：独立 canvas，与主画布的按行局部重绘互不干扰。
  // 每次全量重画（段数少、开销可忽略），由 terminal 侧节流调用。
  drawLinkUnderlines(segments: LinkUnderlineSegment[]): void {
    const context = this.linkContext;
    context.clearRect(0, 0, this.linkCanvas.width, this.linkCanvas.height);
    if (segments.length === 0) {
      return;
    }

    const thickness = Math.max(1, Math.round(this.dpr));
    const dash = Math.max(2, Math.round(2 * this.dpr));
    // 奇数线宽时偏移 0.5 物理像素，避免 1px 线被抗锯齿糊成 2px。
    const crisp = thickness % 2 === 1 ? 0.5 : 0;

    context.strokeStyle = this.theme.foreground;
    context.globalAlpha = 0.55;
    context.lineWidth = thickness;
    context.setLineDash([dash, dash]);
    context.beginPath();
    for (const segment of segments) {
      const cellTop = segment.row * this.deviceCellHeight;
      const y =
        Math.min(
          Math.round(cellTop + this.textTopGap + this.glyphBoxHeight - thickness),
          cellTop + this.deviceCellHeight - thickness
        ) + crisp;
      const x0 = segment.startCol * this.deviceCellWidth;
      const x1 = (segment.endCol + 1) * this.deviceCellWidth;
      context.moveTo(x0, y);
      context.lineTo(x1, y);
    }
    context.stroke();
    context.setLineDash([]);
    context.globalAlpha = 1;
  }

  clearLinkUnderlines(): void {
    this.linkContext.clearRect(0, 0, this.linkCanvas.width, this.linkCanvas.height);
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
  private drawRowBackground(
    row: GhosttyRenderRow,
    colors: GhosttyRenderSnapshotMeta['colors']
  ): void {
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
        ? (cell.fgColor ?? colors.foreground)
        : (cell.bgColor ?? colors.background);
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
  private drawRowForeground(
    row: GhosttyRenderRow,
    colors: GhosttyRenderSnapshotMeta['colors']
  ): void {
    const y = row.y * this.deviceCellHeight;
    const lineThickness = Math.max(1, Math.round(this.dpr));

    // 连字：同样式连续 ASCII 符号合并为段、整段一次 fillText，浏览器 shaping
    // 才能拿到上下文触发 calt（=> -> != 等）。段首绘制全文，段内其余 cell 只画
    // 装饰线。段起点按网格定位，段内亚像素漂移由段长上限压住。
    const segments = this.ligatures
      ? scanLigatureSegments(row.cells, {
          foreground: colors.foreground,
          background: colors.background,
          minimumContrast: this.minimumContrast,
        })
      : [];
    const segmentStarts = new Map<number, LigatureSegment>();
    const segmentTails = new Set<number>();
    for (const segment of segments) {
      segmentStarts.set(segment.startIndex, segment);
      for (let k = segment.startIndex + 1; k < segment.endIndex; k += 1) {
        segmentTails.add(k);
      }
    }

    for (const [index, cell] of row.cells.entries()) {
      if (cell.codepoints[0] === 0x10eeee) continue;
      if (cell.widthKind === 'spacer-tail' || cell.widthKind === 'spacer-head') {
        continue;
      }

      if (!cell.text || cell.style.invisible) {
        continue;
      }

      const x = cell.x * this.deviceCellWidth;
      const rawFg = cell.style.inverse
        ? (cell.bgColor ?? colors.background)
        : (cell.fgColor ?? colors.foreground);
      // 该 cell 实际铺的背景（drawRowBackground 用同一套判定），据此保底可读性。
      const effectiveBg = cell.style.inverse
        ? (cell.fgColor ?? colors.foreground)
        : (cell.bgColor ?? colors.background);
      // 反显时前景取自 bg 槽位，来源判定要跟着换。
      const fgSourceIndex = cell.style.inverse ? cell.bgPaletteIndex : cell.fgPaletteIndex;
      const fgSourceColor = cell.style.inverse ? cell.bgColor : cell.fgColor;
      const fg =
        this.minimumContrast && isFallbackEligible(fgSourceColor, fgSourceIndex)
          ? this.withMinimumContrast(rawFg, effectiveBg)
          : rawFg;
      const cellWidth = cell.widthKind === 'wide' ? this.deviceCellWidth * 2 : this.deviceCellWidth;

      const colorCss = this.toCss(fg);
      this.mainContext.fillStyle = colorCss;
      // 块元素(▀▄█▌▐░▒▓ 等)不能交给字体:字形最多覆盖 1em,而 cell 高为
      // 1.2em,行列间会留缝(logo/色块图中的明显间隙),必须按 cell 精确自绘。
      const blockCodepoint =
        cell.codepoints.length === 1 && isBlockElement(cell.codepoints[0])
          ? cell.codepoints[0]
          : null;
      const segment = segmentStarts.get(index);
      if (segment) {
        const font = this.resolveFont(cell.style);
        this.mainContext.font = font;
        if (
          !this.glyphRunCacheEnabled ||
          !this.glyphRunCache.draw(
            this.mainContext,
            {
              font,
              text: segment.text,
              color: colorCss,
              spanCells: segment.endIndex - segment.startIndex,
              cellX: segment.startX * this.deviceCellWidth,
              cellY: y,
            },
            (text) => this.measureGlyphInk(font, text)
          )
        ) {
          this.mainContext.fillText(
            segment.text,
            segment.startX * this.deviceCellWidth,
            y + this.textBaselineY
          );
        }
      } else if (segmentTails.has(index)) {
        // 段内后续 cell:文本已随段首画出
      } else if (blockCodepoint !== null) {
        this.drawBlockElement(blockCodepoint, x, y, cellWidth, this.deviceCellHeight);
      } else {
        this.drawCellText(cell, row.cells, index, x, y, cellWidth, colorCss);
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

  // 非 ASCII 窄符号做宽度约束（对齐 ghostty .fit）：Iosevka Term 系字体的宽墨迹
  // 符号（→ ⇒ — ※ 等）advance 1 格墨迹近 2 格，右邻有字时等比缩进本格避免重合；
  // 右邻为空 cell 时放行溢出（保留字体设计的双格宽符号效果）。放行的两个例外
  // （对齐 ghostty constraintWidth 规则）：行末溢出会被 canvas 边界裁切，强制本格；
  // 前一格也是受约束符号（非图形元素）时同样收紧，避免相邻符号一缩一放尺寸不齐。
  private drawCellText(
    cell: GhosttyRenderRow['cells'][number],
    cells: GhosttyRenderRow['cells'],
    index: number,
    x: number,
    y: number,
    cellWidth: number,
    colorCss: string
  ): void {
    const context = this.mainContext;
    const font = this.resolveFont(cell.style);
    context.font = font;
    const baselineY = y + this.textBaselineY;

    if (isConstrainedSymbolCell(cell)) {
      const ink = this.measureGlyphInk(font, cell.text);
      if (ink) {
        const next = cells[index + 1];
        const prev = index > 0 ? cells[index - 1] : undefined;
        const atLineEnd = cell.x + 1 >= this.cols;
        // 行尾空白列可能被裁剪出 cells,next 缺失但未到行末仍视为空。
        const nextEmpty = !atLineEnd && (!next || !next.text || next.text === ' ');
        const prevIsSymbol =
          !!prev && isConstrainedSymbolCell(prev) && !isGraphicsElement(prev.codepoints[0]);
        const decision = resolveGlyphConstraint({
          ink,
          cellWidth,
          maxInkWidth: nextEmpty && !prevIsSymbol ? cellWidth * 2 : cellWidth,
        });
        if (decision.mode === 'scale') {
          // 缩放路径绕过位图缓存直绘:scale/dx 由左右邻居连续决定、命中率低,位图内
          // 再叠加变换徒增复杂度;直绘天然与缓存启用/禁用逐像素一致。受约束符号在
          // 右邻为空时放行溢出(decision normal)仍走缓存,溢出墨迹由位图 padding 覆盖。
          context.save();
          context.translate(x + decision.dx, baselineY);
          context.scale(decision.scale, decision.scale);
          context.fillText(cell.text, 0, 0);
          context.restore();
          return;
        }
      }
    }

    if (
      this.glyphRunCacheEnabled &&
      this.glyphRunCache.draw(
        context,
        {
          font,
          text: cell.text,
          color: colorCss,
          spanCells: cellWidth / this.deviceCellWidth,
          cellX: x,
          cellY: y,
        },
        (text) => this.measureGlyphInk(font, text)
      )
    ) {
      return;
    }

    // 缓存不可用/失败:降级直绘,语义与无缓存时完全一致。
    context.fillStyle = colorCss;
    context.fillText(cell.text, x, baselineY);
  }

  private measureGlyphInk(font: string, text: string): GlyphInk | null {
    const key = `${font}|${text}`;
    const cached = this.glyphInkCache.get(key);
    if (cached !== undefined) {
      return cached;
    }

    const metrics = this.mainContext.measureText(text);
    const left = metrics.actualBoundingBoxLeft;
    const right = metrics.actualBoundingBoxRight;
    const ink = Number.isFinite(left) && Number.isFinite(right) ? { left, right } : null;
    this.glyphInkCache.set(key, ink);
    return ink;
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

  private drawCursor(
    meta: GhosttyRenderSnapshotMeta,
    rows: readonly GhosttyRenderRow[]
  ): void {
    const colors = meta.colors;
    const cursor = meta.cursor;
    const previous = this.lastCursor;
    this.cursorContext.clearRect(0, 0, this.cursorCanvas.width, this.cursorCanvas.height);

    if (!cursor.visible || cursor.x === null || cursor.y === null) {
      this.lastCursor = null;
      this.stopCursorBlink();
      return;
    }

    const cursorColumn = cursor.wideTail ? Math.max(0, cursor.x - 1) : cursor.x;
    const x = cursorColumn * this.deviceCellWidth;
    const y = cursor.y * this.deviceCellHeight;
    const width = cursor.wideTail ? this.deviceCellWidth * 2 : this.deviceCellWidth;
    const thickness = Math.max(1, Math.round(this.dpr));
    const cursorColor = colors.cursor ?? colors.foreground;
    const cssColor = this.toCss(cursorColor);

    this.cursorContext.fillStyle = cssColor;
    this.cursorContext.strokeStyle = cssColor;
    this.cursorContext.globalAlpha = 1;
    switch (cursor.style) {
      case 'block': {
        this.cursorContext.fillRect(x, y, width, this.deviceCellHeight);
        const row = rows.find((candidate) => candidate.y === cursor.y);
        const cell = row?.cells.find((candidate) => candidate.x === cursorColumn);
        if (cell?.text && !cell.style.invisible) {
          // Cursor canvas 位于主字形层上方；block 背景会遮住原字符，因此以 cell
          // 原背景色重绘字形，得到传统终端的反色 block 语义。
          const cellBackground = cell.style.inverse
            ? (cell.fgColor ?? colors.foreground)
            : (cell.bgColor ?? colors.background);
          this.cursorContext.fillStyle = this.toCss(cellBackground);
          this.cursorContext.font = this.resolveFont(cell.style);
          this.cursorContext.fillText(cell.text, x, y + this.textBaselineY);
        }
        break;
      }
      case 'block-hollow':
        this.cursorContext.lineWidth = thickness;
        this.cursorContext.strokeRect(
          x + thickness / 2,
          y + thickness / 2,
          Math.max(width - thickness, thickness),
          Math.max(this.deviceCellHeight - thickness, thickness)
        );
        break;
      case 'underline':
        this.cursorContext.fillRect(
          x,
          y + this.deviceCellHeight - 2 * thickness,
          width,
          2 * thickness
        );
        break;
      case 'bar':
        this.cursorContext.fillRect(x, y, 2 * thickness, this.deviceCellHeight);
        break;
    }

    if (cursor.blinking) {
      this.startCursorBlink();
    } else {
      this.stopCursorBlink();
    }

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

  private withMinimumContrast(fg: GhosttyColorRgb, bg: GhosttyColorRgb): GhosttyColorRgb {
    const key = `${fg.r},${fg.g},${fg.b}/${bg.r},${bg.g},${bg.b}`;
    const cached = this.contrastCache.get(key);
    if (cached) {
      return cached;
    }
    const adjusted = ensureMinimumContrast(fg, bg);
    this.contrastCache.set(key, adjusted);
    return adjusted;
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

export type {
  CanvasRendererDebugState,
  CanvasRendererFrame,
  CanvasRendererOptions,
  LinkUnderlineSegment,
};
