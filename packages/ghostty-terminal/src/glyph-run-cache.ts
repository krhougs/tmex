import type { GlyphInk } from './glyph-constraint';

/**
 * 字形 run 位图缓存。
 *
 * 动机:浏览器对每次 fillText 调用都独立做一次 text shaping,CoreText 为每个 shaping
 * run 重建全字体 glyph class 位图(CJK/Nerd Font 数万字形,单字符也按全字体付费)。
 * 全屏 TUI 每帧数千次 fillText → 数千次 shaping。把 (font, text, color) 相同的绘制
 * 合并为 atlas 上一次 fillText,后续命中直接 drawImage 复制位图,shaping 只发生在 miss。
 *
 * 语义约束(与直绘逐像素等价):
 * - 位图带溢出 padding:上下各 1 cell、左右各 1 cell(device px,整数)。字形墨迹可越出
 *   cell(±1 邻行重绘机制服务的场景),padding 保证溢出墨迹被完整捕获;
 * - miss 时按 measureText 的 actualBoundingBox 扩展位图左右边界:受约束符号在右邻为空
 *   时可放行溢出到 2 格(墨迹右缘上限 cellW×2+tolerance),固定 1 cell padding 的右缘
 *   恰好在其临界带上,显式测量后加宽,杜绝任何裁剪窗口;
 * - 垂直方向固定 3×cellH(行高统一,装箱简化)。字形盒 ≈1.2em ≤ cell 高,常规字体
 *   ascent+descent 落在 [0, cellH] 内,1 cell 上下 padding 余量充足;字形盒 >3×cellH
 *   的病态字体(极少见)位图会裁剪,与 ±1 邻行重绘的服务范围一致;
 * - atlas 上文本原点 = 位图原点 + (cellW, cellH) + textBaselineY,drawImage 落位 =
 *   cell 原点 − (cellW, cellH),与直绘 fillText(cell 原点, baseline) 完全同几何;
 *   所有坐标均为整数物理像素,无亚像素偏移;
 * - 块元素与装饰线不经过本缓存(矢量自绘,语义在 CanvasRenderer 侧)。
 *
 * 失效与兜底:
 * - 几何(device cell 尺寸、textBaselineY)变化、主题切换 → 整体清空;
 * - key 总数超上限(默认 8192)整体清空重来;
 * - 页数超上限(默认 16)LRU 整页回收,被回收页的全部条目一并失效;
 * - OffscreenCanvas 不可用时退化用 detached <canvas>;
 * - 任何异常路径(含位图分配失败)返回 false,调用方降级直绘,渲染不得中断。
 */

export type GlyphRunRequest = {
  /** resolveFont() 结果(style 相关,含设备字号) */
  font: string;
  /** 绘制文本:单 cell 文本或连字段整段文本 */
  text: string;
  /** 最终前景色 CSS(inverse / minimum-contrast 处理后的 fillStyle 值) */
  color: string;
  /** 文本占用的 cell 数(narrow=1 / wide=2 / 连字段长),决定位图宽度下限 */
  spanCells: number;
  /** 文本绘制原点 x(device px,cell 网格对齐) */
  cellX: number;
  /** 行顶 y(device px) */
  cellY: number;
};

export type GlyphRunCacheStats = {
  entries: number;
  pages: number;
  hits: number;
  misses: number;
  clears: number;
};

type GlyphRunCacheOptions = {
  /** 页尺寸(device px,正方形) */
  pageSize?: number;
  /** key 总数上限,超限整体清空重来 */
  maxKeys?: number;
  /** 页数上限,超限 LRU 整页回收 */
  maxPages?: number;
};

type AtlasPage = {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  context: CanvasRenderingContext2D;
  /** 行装箱游标:行高统一,行内从左到右放置,放不下换行 */
  x: number;
  y: number;
  lastUsedFrame: number;
};

type AtlasEntry = {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /** 位图左缘相对 cell 左缘的偏移(1 cell + 左扩展,device px) */
  leftPad: number;
};

const DEFAULT_PAGE_SIZE = 512;
const DEFAULT_MAX_KEYS = 8192;
const DEFAULT_MAX_PAGES = 16;

export class GlyphRunCache {
  private readonly pageSize: number;
  private readonly maxKeys: number;
  private readonly maxPages: number;
  private readonly entries = new Map<string, AtlasEntry>();
  private readonly pages: AtlasPage[] = [];
  private frame = 0;
  private hits = 0;
  private misses = 0;
  private clears = 0;
  private deviceCellWidth = 0;
  private deviceCellHeight = 0;
  private textBaselineY = 0;
  private padX = 0;
  private padY = 0;
  private rowHeight = 0;

  constructor(options: GlyphRunCacheOptions = {}) {
    this.pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
    this.maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
    this.maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  }

  /**
   * 几何变化(device cell 尺寸 / dpr / 基线度量)时调用;与旧几何不同则整体失效。
   * CanvasRenderer.resize 在每帧渲染前调用,相同几何为 no-op。
   */
  setCellGeometry(deviceCellWidth: number, deviceCellHeight: number, textBaselineY: number): void {
    if (
      this.deviceCellWidth === deviceCellWidth &&
      this.deviceCellHeight === deviceCellHeight &&
      this.textBaselineY === textBaselineY
    ) {
      return;
    }
    this.deviceCellWidth = deviceCellWidth;
    this.deviceCellHeight = deviceCellHeight;
    this.textBaselineY = textBaselineY;
    this.padX = deviceCellWidth;
    this.padY = deviceCellHeight;
    this.rowHeight = deviceCellHeight * 3;
    this.clear();
  }

  clear(): void {
    this.entries.clear();
    for (const page of this.pages) {
      this.wipePage(page);
    }
    this.clears += 1;
  }

  getStats(): GlyphRunCacheStats {
    return {
      entries: this.entries.size,
      pages: this.pages.length,
      hits: this.hits,
      misses: this.misses,
      clears: this.clears,
    };
  }

  /**
   * 命中:把已缓存的位图 blit 到 `context`;miss:atlas 上 fillText 一次后落缓存再 blit。
   * 返回 false 表示任何失败,调用方必须降级直绘。
   *
   * `measureInk` 仅在 miss 时调用(命中不产生 shaping),返回实际墨迹边界用于位图加宽。
   */
  draw(
    context: CanvasRenderingContext2D,
    request: GlyphRunRequest,
    measureInk: (text: string) => GlyphInk | null
  ): boolean {
    try {
      const key = `${request.font}\u0000${request.text}\u0000${request.color}`;
      let entry = this.entries.get(key);
      if (entry) {
        this.hits += 1;
        this.pages[entry.page].lastUsedFrame = ++this.frame;
        this.blit(context, entry, request);
        return true;
      }

      this.misses += 1;
      if (this.entries.size >= this.maxKeys) {
        this.clear();
      }
      const placed = this.allocate(request, measureInk(request.text));
      if (!placed) {
        return false;
      }
      const page = this.pages[placed.page];
      page.lastUsedFrame = ++this.frame;
      // 与直绘同几何:文本原点相对位图左缘偏移 leftPad(= padX + 左溢扩展,blit 落位
      // 按同值回退),垂直偏移 padY 再叠加 alphabetic baseline。
      page.context.fillStyle = request.color;
      page.context.font = request.font;
      page.context.textBaseline = 'alphabetic';
      page.context.fillText(
        request.text,
        placed.x + placed.leftPad,
        placed.y + this.padY + this.textBaselineY
      );
      entry = {
        page: placed.page,
        x: placed.x,
        y: placed.y,
        width: placed.width,
        height: this.rowHeight,
        leftPad: placed.leftPad,
      };
      this.entries.set(key, entry);
      this.blit(context, entry, request);
      return true;
    } catch {
      // 一切异常路径(上下文丢失、drawImage 不支持、位图绘制失败)降级直绘。
      return false;
    }
  }

  private blit(
    context: CanvasRenderingContext2D,
    entry: AtlasEntry,
    request: GlyphRunRequest
  ): void {
    context.drawImage(
      this.pages[entry.page].canvas,
      entry.x,
      entry.y,
      entry.width,
      entry.height,
      request.cellX - entry.leftPad,
      request.cellY - this.padY,
      entry.width,
      entry.height
    );
  }

  private allocate(
    request: GlyphRunRequest,
    ink: GlyphInk | null
  ): { page: number; x: number; y: number; width: number; leftPad: number } | null {
    const cellW = this.deviceCellWidth;
    // 左扩展:墨迹左溢超过 1 cell 时位图向左扩(极少见,保险起见支持)
    const leftExtra = ink && ink.left > this.padX ? Math.ceil(ink.left - this.padX) : 0;
    // 右扩展:墨迹右缘超过 (1+span) cell 时加宽(约束符号放行溢出到 2 格 + tolerance 的情形)
    const rightLimit = this.padX + request.spanCells * cellW;
    const rightExtra = ink && ink.right > rightLimit ? Math.ceil(ink.right - rightLimit) : 0;
    const width = leftExtra + this.padX + request.spanCells * cellW + this.padX + rightExtra;
    if (width > this.pageSize) {
      return null;
    }

    for (let i = 0; i < this.pages.length; i += 1) {
      const placed = this.tryPlace(i, width);
      if (placed) {
        return { ...placed, width, leftPad: this.padX + leftExtra };
      }
    }
    if (this.pages.length < this.maxPages) {
      const page = this.createPage();
      if (!page) {
        return null;
      }
      this.pages.push(page);
      return {
        ...(this.tryPlace(this.pages.length - 1, width) as { page: number; x: number; y: number }),
        width,
        leftPad: this.padX + leftExtra,
      };
    }
    // 页数到顶:回收最久未用的一页(整页失效),腾出整页空间
    let lru = 0;
    for (let i = 1; i < this.pages.length; i += 1) {
      if (this.pages[i].lastUsedFrame < this.pages[lru].lastUsedFrame) {
        lru = i;
      }
    }
    this.evictPage(lru);
    return {
      ...(this.tryPlace(lru, width) as { page: number; x: number; y: number }),
      width,
      leftPad: this.padX + leftExtra,
    };
  }

  private tryPlace(index: number, width: number): { page: number; x: number; y: number } | null {
    const page = this.pages[index];
    if (page.x + width > this.pageSize) {
      page.x = 0;
      page.y += this.rowHeight;
    }
    if (page.y + this.rowHeight > this.pageSize) {
      return null;
    }
    const placed = { page: index, x: page.x, y: page.y };
    page.x += width;
    return placed;
  }

  private createPage(): AtlasPage | null {
    let canvas: HTMLCanvasElement | OffscreenCanvas;
    const OffscreenCanvasCtor = globalThis.OffscreenCanvas;
    if (typeof OffscreenCanvasCtor === 'function') {
      canvas = new OffscreenCanvasCtor(this.pageSize, this.pageSize);
    } else {
      // OffscreenCanvas 不可用(老浏览器/测试环境):退化用 detached <canvas>
      canvas = document.createElement('canvas');
      canvas.width = this.pageSize;
      canvas.height = this.pageSize;
    }
    const context = canvas.getContext('2d') as unknown as CanvasRenderingContext2D | null;
    if (!context) {
      return null;
    }
    return { canvas, context, x: 0, y: 0, lastUsedFrame: 0 };
  }

  private evictPage(index: number): void {
    const page = this.pages[index];
    for (const [key, entry] of this.entries) {
      if (entry.page === index) {
        this.entries.delete(key);
      }
    }
    this.wipePage(page);
  }

  private wipePage(page: AtlasPage): void {
    // 重新赋值 width 触发整页清空(HTML 标准:width 赋值 wipe 位图),同时重置状态
    page.canvas.width = this.pageSize;
    page.x = 0;
    page.y = 0;
    page.lastUsedFrame = 0;
  }
}
