import type { GhosttyKittyGraphicsSnapshot, GhosttyKittyPlacementSnapshot } from './types';
import { WHITE, type WebglQuads } from './webgl-quads';

type ImageTexture = {
  generation: bigint;
  texture: WebGLTexture | null;
  width: number;
  height: number;
  bytes: number;
};
const MAX_BYTES = 64 * 1024 * 1024;

export class WebglImages {
  private readonly images = new Map<number, ImageTexture>();
  private bytes = 0;
  private disposed = false;
  private failures = 0;
  private lastError: string | null = null;

  constructor(
    private readonly quads: WebglQuads,
    private readonly onInvalidate: () => void,
    private readonly onFailure: (reason: string) => void
  ) {}

  prepare(snapshot?: GhosttyKittyGraphicsSnapshot): void {
    const active = new Set(snapshot?.imageIds ?? []);
    for (const [id, entry] of this.images) {
      if (!active.has(id)) this.remove(id, entry);
    }
    for (const image of snapshot?.images ?? []) {
      if (this.images.get(image.id)?.generation === image.generation) continue;
      const previous = this.images.get(image.id);
      if (previous) this.remove(image.id, previous);
      const bytes = image.width * image.height * 4;
      const maxSize = this.quads.gl.getParameter(this.quads.gl.MAX_TEXTURE_SIZE) as number;
      if (
        !Number.isSafeInteger(bytes) ||
        bytes <= 0 ||
        image.width > maxSize ||
        image.height > maxSize ||
        this.bytes + bytes > MAX_BYTES ||
        this.images.size >= 128
      ) {
        throw new Error('Kitty image exceeds WebGL texture budget');
      }
      const entry: ImageTexture = {
        generation: image.generation,
        texture: null,
        width: image.width,
        height: image.height,
        bytes,
      };
      this.images.set(image.id, entry);
      this.bytes += bytes;
      if (image.format === 100) {
        if (typeof createImageBitmap !== 'function')
          throw new Error('PNG image decoding unavailable');
        const png = new Uint8Array(image.data);
        void createImageBitmap(new Blob([png], { type: 'image/png' }), {
          premultiplyAlpha: 'premultiply',
        }).then(
          (bitmap) => {
            try {
              if (this.disposed || this.images.get(image.id) !== entry) return;
              if (bitmap.width !== entry.width || bitmap.height !== entry.height) {
                this.recordDecodeError('Kitty PNG dimensions do not match metadata');
                return;
              }
              const gl = this.quads.gl;
              entry.texture = this.quads.createTexture(bitmap.width, bitmap.height);
              gl.bindTexture(gl.TEXTURE_2D, entry.texture);
              gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
              this.quads.checkError();
              this.onInvalidate();
            } catch (error) {
              this.onFailure(error instanceof Error ? error.message : String(error));
            } finally {
              bitmap.close();
            }
          },
          (error: unknown) => {
            if (!this.disposed && this.images.get(image.id) === entry) {
              this.recordDecodeError(
                `Kitty PNG decoding failed: ${error instanceof Error ? error.message : String(error)}`
              );
            }
          }
        );
      } else {
        const stride =
          image.format === 0
            ? 3
            : image.format === 1
              ? 4
              : image.format === 3
                ? 2
                : image.format === 4
                  ? 1
                  : 0;
        if (!stride || image.data.length !== image.width * image.height * stride) {
          throw new Error('Invalid Kitty image pixel format or length');
        }
        const rgba = new Uint8Array(bytes);
        for (let pixel = 0; pixel < image.width * image.height; pixel++) {
          const source = pixel * stride;
          const target = pixel * 4;
          const alpha =
            stride === 4 ? image.data[source + 3] : stride === 2 ? image.data[source + 1] : 255;
          rgba[target] = Math.round((image.data[source] * alpha) / 255);
          rgba[target + 1] = Math.round((image.data[source + (stride >= 3 ? 1 : 0)] * alpha) / 255);
          rgba[target + 2] = Math.round((image.data[source + (stride >= 3 ? 2 : 0)] * alpha) / 255);
          rgba[target + 3] = alpha;
        }
        entry.texture = this.quads.createTexture(image.width, image.height, rgba);
      }
    }
  }

  private recordDecodeError(message: string): void {
    this.failures++;
    this.lastError = message;
    this.onInvalidate();
  }

  draw(
    placement: GhosttyKittyPlacementSnapshot,
    cellWidth: number,
    cellHeight: number,
    dpr: number,
    rowOffset: number
  ): void {
    if (!placement.viewportVisible || placement.pixelWidth <= 0 || placement.pixelHeight <= 0)
      return;
    const entry = this.images.get(placement.imageId);
    if (!entry?.texture) return;
    this.quads.quad(
      placement.viewportCol * cellWidth + Math.round(placement.xOffset * dpr),
      (placement.viewportRow + rowOffset) * cellHeight + Math.round(placement.yOffset * dpr),
      Math.max(1, Math.round(placement.pixelWidth * dpr)),
      Math.max(1, Math.round(placement.pixelHeight * dpr)),
      WHITE,
      entry.texture,
      placement.sourceX / entry.width,
      placement.sourceY / entry.height,
      placement.sourceWidth / entry.width,
      placement.sourceHeight / entry.height
    );
  }

  private remove(id: number, entry: ImageTexture): void {
    if (entry.texture) this.quads.gl.deleteTexture(entry.texture);
    this.bytes -= entry.bytes;
    this.images.delete(id);
  }

  getStats() {
    return {
      entries: this.images.size,
      bytes: this.bytes,
      failures: this.failures,
      lastError: this.lastError,
    };
  }

  dispose(): void {
    this.disposed = true;
    for (const [id, entry] of this.images) this.remove(id, entry);
  }
}
