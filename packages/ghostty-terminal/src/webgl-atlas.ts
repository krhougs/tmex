import type { GlyphConstraintDecision } from './glyph-constraint';
import { WHITE, type WebglQuads } from './webgl-quads';

type Page = { texture: WebGLTexture; x: number; y: number; height: number; used: number };
type Entry = {
  page: Page;
  x: number;
  y: number;
  width: number;
  height: number;
  left: number;
  top: number;
};

export class WebglAtlas {
  readonly context: CanvasRenderingContext2D;
  private readonly canvas: HTMLCanvasElement;
  private readonly pages: Page[] = [];
  private readonly entries = new Map<string, Entry>();
  private clock = 0;
  readonly size: number;
  hits = 0;
  misses = 0;

  constructor(private readonly quads: WebglQuads) {
    this.size = Math.min(2048, quads.gl.getParameter(quads.gl.MAX_TEXTURE_SIZE) as number);
    this.canvas = document.createElement('canvas');
    const context = this.canvas.getContext('2d');
    if (!context) throw new Error('Glyph rasterization canvas unavailable');
    this.context = context;
  }

  draw(
    font: string,
    text: string,
    color: string,
    x: number,
    y: number,
    cellWidth: number,
    cellHeight: number,
    baseline: number,
    span: number,
    constraint?: GlyphConstraintDecision
  ): void {
    const scale = constraint?.mode === 'scale' ? constraint.scale : 1;
    const dx = constraint?.mode === 'scale' ? constraint.dx : 0;
    const key = `${font}\0${text}\0${color}\0${span}\0${scale}\0${dx}`;
    let entry = this.entries.get(key);
    if (entry) {
      this.hits++;
    } else {
      this.misses++;
      this.context.font = font;
      const metrics = this.context.measureText(text);
      const left = Math.max(
        cellWidth,
        Math.ceil((metrics.actualBoundingBoxLeft || 0) * scale - dx)
      );
      const right = Math.max(
        (span + 1) * cellWidth,
        Math.ceil((metrics.actualBoundingBoxRight || 0) * scale + dx)
      );
      const top = cellHeight;
      const width = left + right;
      const height = cellHeight * 3;
      if (width > this.size || height > this.size)
        throw new Error('Glyph exceeds WebGL atlas dimensions');
      if (this.entries.size >= 8192) this.clear();
      const page = this.allocate(width, height);
      this.canvas.width = width;
      this.canvas.height = height;
      const context = this.context;
      context.font = font;
      context.textBaseline = 'alphabetic';
      context.fillStyle = color;
      context.translate(left + dx, top + baseline);
      context.scale(scale, scale);
      context.fillText(text, 0, 0);
      const gl = this.quads.gl;
      gl.bindTexture(gl.TEXTURE_2D, page.texture);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, page.x, page.y, gl.RGBA, gl.UNSIGNED_BYTE, this.canvas);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      entry = { page, x: page.x, y: page.y, width, height, left, top };
      page.x += width;
      page.height = Math.max(page.height, height);
      this.entries.set(key, entry);
    }
    entry.page.used = ++this.clock;
    this.quads.quad(
      x - entry.left,
      y - entry.top,
      entry.width,
      entry.height,
      WHITE,
      entry.page.texture,
      entry.x / this.size,
      entry.y / this.size,
      entry.width / this.size,
      entry.height / this.size
    );
  }

  private allocate(width: number, height: number): Page {
    for (const page of this.pages) {
      if (page.x + width > this.size) {
        page.y += page.height;
        page.x = 0;
        page.height = 0;
      }
      if (page.y + height <= this.size) return page;
    }
    if (this.pages.length < 4) {
      const page = {
        texture: this.quads.createTexture(this.size, this.size),
        x: 0,
        y: 0,
        height: 0,
        used: ++this.clock,
      };
      this.pages.push(page);
      return page;
    }
    let oldest = this.pages[0];
    if (!oldest) throw new Error('Glyph atlas page unavailable');
    for (const page of this.pages) if (page.used < oldest.used) oldest = page;
    // Submit references before overwriting a page used earlier in this frame.
    this.quads.flush();
    for (const [key, entry] of this.entries) if (entry.page === oldest) this.entries.delete(key);
    oldest.x = 0;
    oldest.y = 0;
    oldest.height = 0;
    return oldest;
  }

  clear(): void {
    this.quads.flush();
    for (const page of this.pages) this.quads.gl.deleteTexture(page.texture);
    this.pages.length = 0;
    this.entries.clear();
  }

  getStats() {
    return {
      entries: this.entries.size,
      pages: this.pages.length,
      hits: this.hits,
      misses: this.misses,
    };
  }

  dispose(): void {
    this.clear();
    this.canvas.width = 0;
    this.canvas.height = 0;
  }
}
