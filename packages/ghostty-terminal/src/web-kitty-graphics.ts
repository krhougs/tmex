import { unzlibSync } from 'fflate';
import type {
  GhosttyCellDimensions,
  GhosttyKittyGraphicsSnapshot,
  GhosttyKittyImageSnapshot,
  GhosttyKittyPlacementSnapshot,
  GhosttyRenderRow,
} from './types';
import { KITTY_DIACRITIC_INDEX } from './web-kitty-diacritics';

const ESC = 0x1b;
const KITTY_PLACEHOLDER = 0x10eeee;
const MAX_ENCODED_BYTES = Math.ceil((16 * 1024 * 1024) / 3) * 4;
const STORAGE_LIMIT_BYTES = 64 * 1024 * 1024;

export type WebKittyCursorContext = {
  col: number;
  absoluteRow: number;
  viewportOffset: number;
  viewportRows: number;
  alternateScreen: boolean;
  cellDimensions: GhosttyCellDimensions;
  renderRowOffset?: number;
};

type Parameters = Map<string, string>;

type StoredImage = GhosttyKittyImageSnapshot;

type StoredPlacement = {
  key: string;
  imageId: number;
  placementId: number;
  anchorCol: number;
  anchorRow: number;
  z: number;
  xOffset: number;
  yOffset: number;
  sourceX: number;
  sourceY: number;
  sourceWidth: number;
  sourceHeight: number;
  columns: number;
  rows: number;
  cursorColumns: number;
  cursorRows: number;
};

type VirtualPlacement = {
  imageId: number;
  placementId: number;
  z: number;
  columns: number;
  rows: number;
};

type ScreenState = {
  images: Map<number, StoredImage>;
  placements: Map<string, StoredPlacement>;
  virtualPlacements: Map<string, VirtualPlacement>;
  storageBytes: number;
  generation: bigint;
  nextSyntheticImageId: number;
  nextPlacementSequence: number;
};

type PendingTransfer = {
  params: Parameters;
  chunks: Uint8Array[];
  encodedBytes: number;
};

type ParserPhase =
  | 'normal'
  | 'esc'
  | 'apc-detect'
  | 'kitty-control'
  | 'kitty-payload'
  | 'kitty-payload-esc'
  | 'apc-pass'
  | 'apc-pass-esc'
  | 'kitty-ignore'
  | 'kitty-ignore-esc';

function screenState(): ScreenState {
  return {
    images: new Map(),
    placements: new Map(),
    virtualPlacements: new Map(),
    storageBytes: 0,
    generation: 0n,
    nextSyntheticImageId: 0x80000000,
    nextPlacementSequence: 1,
  };
}

function parseParameters(control: Uint8Array): Parameters {
  const text = new TextDecoder().decode(control);
  const params: Parameters = new Map();
  for (const entry of text.split(',')) {
    const separator = entry.indexOf('=');
    if (separator <= 0) continue;
    params.set(entry.slice(0, separator), entry.slice(separator + 1));
  }
  return params;
}

function numberParameter(params: Parameters, key: string, fallback = 0): number {
  const value = Number.parseInt(params.get(key) ?? '', 10);
  return Number.isFinite(value) ? value : fallback;
}

function base64Bytes(encoded: Uint8Array): Uint8Array | null {
  if (encoded.byteLength > MAX_ENCODED_BYTES) return null;
  const alphabet = new Int16Array(256).fill(-1);
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  for (let index = 0; index < chars.length; index += 1) alphabet[chars.charCodeAt(index)] = index;
  let useful = encoded.byteLength;
  while (useful > 0 && encoded[useful - 1] === 0x3d) useful -= 1;
  const output = new Uint8Array(Math.floor((useful * 6) / 8));
  let accumulator = 0;
  let bits = 0;
  let out = 0;
  for (let index = 0; index < useful; index += 1) {
    const value = alphabet[encoded[index]];
    if (value < 0) return null;
    accumulator = (accumulator << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      if (out < output.length) output[out++] = (accumulator >>> bits) & 0xff;
    }
  }
  return out === output.length ? output : output.slice(0, out);
}

function rgbId(color: { r: number; g: number; b: number } | null | undefined): number {
  return color ? (color.r << 16) | (color.g << 8) | color.b : 0;
}

function virtualKey(imageId: number, placementId: number): string {
  return `${imageId}:${placementId}`;
}

export class WebKittyGraphicsStore {
  private readonly main = screenState();
  private readonly alternate = screenState();
  private phase: ParserPhase = 'normal';
  private readonly passBytes: number[] = [];
  private readonly controlBytes: number[] = [];
  private readonly payloadBytes: number[] = [];
  private pending: PendingTransfer | null = null;

  hasPendingInput(): boolean {
    return this.phase !== 'normal';
  }

  process(
    data: string | Uint8Array,
    writeTerminal: (bytes: Uint8Array) => void,
    cursorContext: () => WebKittyCursorContext
  ): void {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    for (const byte of bytes) this.processByte(byte, writeTerminal, cursorContext);
    if (this.phase === 'normal') this.flushPass(writeTerminal);
  }

  reset(): void {
    this.clearState(this.main);
    this.clearState(this.alternate);
    this.pending = null;
    this.phase = 'normal';
    this.passBytes.length = 0;
    this.controlBytes.length = 0;
    this.payloadBytes.length = 0;
  }

  snapshot(
    rows: readonly GhosttyRenderRow[],
    context: WebKittyCursorContext
  ): GhosttyKittyGraphicsSnapshot | undefined {
    const state = context.alternateScreen ? this.alternate : this.main;
    const placements: GhosttyKittyPlacementSnapshot[] = [];
    const imageIds = new Set<number>();
    for (const placement of state.placements.values()) {
      const image = state.images.get(placement.imageId);
      if (!image) continue;
      const rendered = this.classicPlacementSnapshot(placement, image, context);
      if (!rendered) continue;
      placements.push(rendered);
      imageIds.add(image.id);
    }
    this.appendVirtualPlacements(state, rows, context, placements, imageIds);
    if (state.generation === 0n && placements.length === 0) return undefined;
    const images: GhosttyKittyImageSnapshot[] = [];
    for (const imageId of imageIds) {
      const image = state.images.get(imageId);
      if (image) images.push(image);
    }
    return {
      generation: state.generation,
      imageIds: [...imageIds],
      images,
      placements,
    };
  }

  private processByte(
    byte: number,
    writeTerminal: (bytes: Uint8Array) => void,
    cursorContext: () => WebKittyCursorContext
  ): void {
    switch (this.phase) {
      case 'normal':
        if (byte === ESC) {
          this.flushPass(writeTerminal);
          this.phase = 'esc';
        } else {
          this.passBytes.push(byte);
        }
        return;
      case 'esc':
        if (byte === 0x5f) {
          this.phase = 'apc-detect';
        } else {
          this.passBytes.push(ESC, byte);
          if (byte === 0x63) this.resetScreensOnly();
          this.phase = 'normal';
        }
        return;
      case 'apc-detect':
        if (byte === 0x47) {
          this.controlBytes.length = 0;
          this.payloadBytes.length = 0;
          this.phase = 'kitty-control';
        } else {
          this.passBytes.push(ESC, 0x5f, byte);
          this.phase = 'apc-pass';
        }
        return;
      case 'kitty-control':
        if (byte === 0x3b) {
          this.phase = 'kitty-payload';
        } else if (byte === ESC) {
          this.phase = 'kitty-payload-esc';
        } else if (this.controlBytes.length >= 4096) {
          this.phase = 'kitty-ignore';
        } else {
          this.controlBytes.push(byte);
        }
        return;
      case 'kitty-payload':
        if (byte === ESC) {
          this.phase = 'kitty-payload-esc';
        } else if (this.payloadBytes.length >= MAX_ENCODED_BYTES) {
          this.phase = 'kitty-ignore';
        } else {
          this.payloadBytes.push(byte);
        }
        return;
      case 'kitty-payload-esc':
        if (byte === 0x5c) {
          this.finishCommand(writeTerminal, cursorContext);
          this.phase = 'normal';
        } else if (this.payloadBytes.length + 2 > MAX_ENCODED_BYTES) {
          this.phase = 'kitty-ignore';
        } else {
          this.payloadBytes.push(ESC, byte);
          this.phase = 'kitty-payload';
        }
        return;
      case 'apc-pass':
        this.passBytes.push(byte);
        if (byte === ESC) this.phase = 'apc-pass-esc';
        return;
      case 'apc-pass-esc':
        this.passBytes.push(byte);
        this.phase = byte === 0x5c ? 'normal' : byte === ESC ? 'apc-pass-esc' : 'apc-pass';
        return;
      case 'kitty-ignore':
        if (byte === ESC) this.phase = 'kitty-ignore-esc';
        return;
      case 'kitty-ignore-esc':
        if (byte === 0x5c) {
          this.pending = null;
          this.phase = 'normal';
        } else if (byte !== ESC) {
          this.phase = 'kitty-ignore';
        }
    }
  }

  private finishCommand(
    writeTerminal: (bytes: Uint8Array) => void,
    cursorContext: () => WebKittyCursorContext
  ): void {
    const params = parseParameters(Uint8Array.from(this.controlBytes));
    const payload = Uint8Array.from(this.payloadBytes);
    this.controlBytes.length = 0;
    this.payloadBytes.length = 0;
    const more = numberParameter(params, 'm', 0);
    if (this.pending) {
      this.pending.chunks.push(payload);
      this.pending.encodedBytes += payload.byteLength;
      if (this.pending.encodedBytes > MAX_ENCODED_BYTES) {
        this.pending = null;
        return;
      }
      if (more === 1) return;
      const pending = this.pending;
      this.pending = null;
      this.execute(pending.params, this.combineChunks(pending), writeTerminal, cursorContext());
      return;
    }
    if (more === 1) {
      this.pending = { params, chunks: [payload], encodedBytes: payload.byteLength };
      return;
    }
    this.execute(params, payload, writeTerminal, cursorContext());
  }

  private execute(
    params: Parameters,
    encoded: Uint8Array,
    writeTerminal: (bytes: Uint8Array) => void,
    context: WebKittyCursorContext
  ): void {
    const action = params.get('a') ?? 't';
    if (action === 'q') return;
    const state = context.alternateScreen ? this.alternate : this.main;
    if (action === 'd') {
      this.deleteImages(state, params);
      return;
    }
    if (action === 'p') {
      this.placeExisting(state, params, context, writeTerminal);
      return;
    }
    if (action !== 't' && action !== 'T') return;
    if ((params.get('t') ?? 'd') !== 'd') return;
    const image = this.decodeImage(state, params, encoded, action === 'T');
    if (!image || action !== 'T') return;
    const placement = this.addClassicPlacement(state, image.id, params, context);
    this.moveCursorAfterPlacement(params, placement, writeTerminal);
  }

  private decodeImage(
    state: ScreenState,
    params: Parameters,
    encoded: Uint8Array,
    needsSyntheticId: boolean
  ): StoredImage | null {
    const compressed = base64Bytes(encoded);
    if (!compressed) return null;
    const width = numberParameter(params, 's');
    const height = numberParameter(params, 'v');
    const format = numberParameter(params, 'f', 32);
    const stride = format === 24 ? 3 : format === 32 ? 4 : 0;
    const expected = width * height * stride;
    if (
      !stride ||
      !Number.isSafeInteger(expected) ||
      expected <= 0 ||
      expected > STORAGE_LIMIT_BYTES
    ) {
      return null;
    }
    let data = compressed;
    if (params.get('o') === 'z') {
      try {
        data = unzlibSync(compressed, { out: new Uint8Array(expected) });
      } catch {
        return null;
      }
    }
    if (data.byteLength !== expected) return null;
    let imageId = numberParameter(params, 'i');
    if (imageId === 0) {
      if (!needsSyntheticId) return null;
      imageId = state.nextSyntheticImageId++;
    }
    const previous = state.images.get(imageId);
    if (previous) {
      state.storageBytes -= previous.data.byteLength;
      state.images.delete(imageId);
      for (const [key, placement] of state.placements) {
        if (placement.imageId === imageId) state.placements.delete(key);
      }
    }
    state.generation += 1n;
    const image: StoredImage = {
      id: imageId,
      generation: state.generation,
      width,
      height,
      format: format === 24 ? 0 : 1,
      data,
    };
    state.images.set(imageId, image);
    state.storageBytes += data.byteLength;
    this.evictImages(state);
    return state.images.get(imageId) ?? null;
  }

  private placeExisting(
    state: ScreenState,
    params: Parameters,
    context: WebKittyCursorContext,
    writeTerminal: (bytes: Uint8Array) => void
  ): void {
    const imageId = numberParameter(params, 'i');
    if (!state.images.has(imageId)) return;
    if (numberParameter(params, 'U') === 1) {
      const placementId = numberParameter(params, 'p');
      state.virtualPlacements.set(virtualKey(imageId, placementId), {
        imageId,
        placementId,
        z: numberParameter(params, 'z'),
        columns: numberParameter(params, 'c'),
        rows: numberParameter(params, 'r'),
      });
      state.generation += 1n;
      return;
    }
    const placement = this.addClassicPlacement(state, imageId, params, context);
    this.moveCursorAfterPlacement(params, placement, writeTerminal);
  }

  private addClassicPlacement(
    state: ScreenState,
    imageId: number,
    params: Parameters,
    context: WebKittyCursorContext
  ): StoredPlacement {
    const image = state.images.get(imageId);
    const placementId = numberParameter(params, 'p');
    const sourceX = Math.max(0, numberParameter(params, 'x'));
    const sourceY = Math.max(0, numberParameter(params, 'y'));
    const sourceWidth = Math.max(0, numberParameter(params, 'w', image?.width ?? 0));
    const sourceHeight = Math.max(0, numberParameter(params, 'h', image?.height ?? 0));
    const columns = Math.max(0, numberParameter(params, 'c'));
    const rows = Math.max(0, numberParameter(params, 'r'));
    let pixelWidth = sourceWidth;
    let pixelHeight = sourceHeight;
    if (columns && rows) {
      pixelWidth = columns * context.cellDimensions.width;
      pixelHeight = rows * context.cellDimensions.height;
    } else if (columns && sourceWidth > 0) {
      pixelWidth = columns * context.cellDimensions.width;
      pixelHeight = pixelWidth * (sourceHeight / sourceWidth);
    } else if (rows && sourceHeight > 0) {
      pixelHeight = rows * context.cellDimensions.height;
      pixelWidth = pixelHeight * (sourceWidth / sourceHeight);
    }
    const sequence = state.nextPlacementSequence++;
    const key = placementId ? virtualKey(imageId, placementId) : `${imageId}:0:${sequence}`;
    const placement: StoredPlacement = {
      key,
      imageId,
      placementId,
      anchorCol: context.col,
      anchorRow: context.absoluteRow,
      z: numberParameter(params, 'z'),
      xOffset: Math.max(0, numberParameter(params, 'X')),
      yOffset: Math.max(0, numberParameter(params, 'Y')),
      sourceX,
      sourceY,
      sourceWidth,
      sourceHeight,
      columns,
      rows,
      cursorColumns: Math.max(1, columns || Math.ceil(pixelWidth / context.cellDimensions.width)),
      cursorRows: Math.max(1, rows || Math.ceil(pixelHeight / context.cellDimensions.height)),
    };
    state.placements.set(key, placement);
    state.generation += 1n;
    return placement;
  }

  private moveCursorAfterPlacement(
    params: Parameters,
    placement: StoredPlacement,
    writeTerminal: (bytes: Uint8Array) => void
  ): void {
    if (numberParameter(params, 'C') === 1) return;
    const columns = placement.cursorColumns;
    const rows = placement.cursorRows;
    writeTerminal(new TextEncoder().encode(`\x1b[${columns}C\x1b[${rows}B`));
  }

  private deleteImages(state: ScreenState, params: Parameters): void {
    const selector = params.get('d') ?? 'a';
    const imageId = numberParameter(params, 'i');
    if (selector === 'A') {
      this.clearState(state);
      return;
    }
    if (selector === 'I' && imageId !== 0) {
      const image = state.images.get(imageId);
      if (image) state.storageBytes -= image.data.byteLength;
      state.images.delete(imageId);
      for (const [key, placement] of state.placements) {
        if (placement.imageId === imageId) state.placements.delete(key);
      }
      for (const [key, placement] of state.virtualPlacements) {
        if (placement.imageId === imageId) state.virtualPlacements.delete(key);
      }
      state.generation += 1n;
    }
  }

  private classicPlacementSnapshot(
    placement: StoredPlacement,
    image: StoredImage,
    context: WebKittyCursorContext
  ): GhosttyKittyPlacementSnapshot | null {
    const sourceX = Math.min(image.width, placement.sourceX);
    const sourceY = Math.min(image.height, placement.sourceY);
    const sourceWidth = Math.min(placement.sourceWidth || image.width, image.width - sourceX);
    const sourceHeight = Math.min(placement.sourceHeight || image.height, image.height - sourceY);
    if (sourceWidth <= 0 || sourceHeight <= 0) return null;
    let pixelWidth = sourceWidth;
    let pixelHeight = sourceHeight;
    if (placement.columns && placement.rows) {
      pixelWidth = placement.columns * context.cellDimensions.width;
      pixelHeight = placement.rows * context.cellDimensions.height;
    } else if (placement.columns) {
      pixelWidth = placement.columns * context.cellDimensions.width;
      pixelHeight = pixelWidth * (sourceHeight / sourceWidth);
    } else if (placement.rows) {
      pixelHeight = placement.rows * context.cellDimensions.height;
      pixelWidth = pixelHeight * (sourceWidth / sourceHeight);
    }
    const gridRows = Math.max(
      1,
      placement.rows || Math.ceil(pixelHeight / context.cellDimensions.height)
    );
    const viewportRow =
      placement.anchorRow - context.viewportOffset + (context.renderRowOffset ?? 0);
    return {
      imageId: image.id,
      placementId: placement.placementId,
      z: placement.z,
      xOffset: placement.xOffset,
      yOffset: placement.yOffset,
      pixelWidth,
      pixelHeight,
      viewportCol: placement.anchorCol,
      viewportRow,
      viewportVisible: viewportRow < context.viewportRows && viewportRow + gridRows > 0,
      sourceX,
      sourceY,
      sourceWidth,
      sourceHeight,
    };
  }

  private appendVirtualPlacements(
    state: ScreenState,
    rows: readonly GhosttyRenderRow[],
    context: WebKittyCursorContext,
    placements: GhosttyKittyPlacementSnapshot[],
    imageIds: Set<number>
  ): void {
    for (const row of rows) {
      let previousRow = 0;
      let previousCol = -1;
      let previousImageId = 0;
      let previousPlacementId = 0;
      for (const cell of row.cells) {
        if (cell.codepoints[0] !== KITTY_PLACEHOLDER) continue;
        const diacritics = cell.codepoints.slice(1).map((cp) => KITTY_DIACRITIC_INDEX.get(cp));
        let imageId = rgbId(cell.fgColor);
        if (diacritics[2] !== undefined && diacritics[2] <= 255) {
          imageId += diacritics[2] * 0x1000000;
        }
        const placementId = rgbId(cell.underlineColor);
        const sameRun = imageId === previousImageId && placementId === previousPlacementId;
        const fragmentRow = diacritics[0] ?? (sameRun ? previousRow : 0);
        const fragmentCol = diacritics[1] ?? (sameRun ? previousCol + 1 : 0);
        previousRow = fragmentRow;
        previousCol = fragmentCol;
        previousImageId = imageId;
        previousPlacementId = placementId;
        const image = state.images.get(imageId);
        const definition =
          state.virtualPlacements.get(virtualKey(imageId, placementId)) ??
          state.virtualPlacements.get(virtualKey(imageId, 0));
        if (!image || !definition) continue;
        const fragment = this.virtualFragment(
          image,
          definition,
          fragmentCol,
          fragmentRow,
          cell.x,
          row.y,
          context
        );
        if (!fragment) continue;
        placements.push(fragment);
        imageIds.add(imageId);
      }
    }
  }

  private virtualFragment(
    image: StoredImage,
    placement: VirtualPlacement,
    col: number,
    row: number,
    viewportCol: number,
    viewportRow: number,
    context: WebKittyCursorContext
  ): GhosttyKittyPlacementSnapshot | null {
    const columns = Math.max(
      1,
      placement.columns || Math.ceil(image.width / context.cellDimensions.width)
    );
    const rows = Math.max(
      1,
      placement.rows || Math.ceil(image.height / context.cellDimensions.height)
    );
    if (col >= columns || row >= rows) return null;
    const gridWidth = columns * context.cellDimensions.width;
    const gridHeight = rows * context.cellDimensions.height;
    const scale = Math.min(gridWidth / image.width, gridHeight / image.height);
    const displayedWidth = image.width * scale;
    const displayedHeight = image.height * scale;
    const padX = (gridWidth - displayedWidth) / 2;
    const padY = (gridHeight - displayedHeight) / 2;
    const cellLeft = col * context.cellDimensions.width;
    const cellTop = row * context.cellDimensions.height;
    const left = Math.max(cellLeft, padX);
    const top = Math.max(cellTop, padY);
    const right = Math.min(cellLeft + context.cellDimensions.width, padX + displayedWidth);
    const bottom = Math.min(cellTop + context.cellDimensions.height, padY + displayedHeight);
    if (right <= left || bottom <= top) return null;
    return {
      imageId: image.id,
      placementId: placement.placementId,
      z: placement.z,
      xOffset: left - cellLeft,
      yOffset: top - cellTop,
      pixelWidth: right - left,
      pixelHeight: bottom - top,
      viewportCol,
      viewportRow,
      viewportVisible: true,
      sourceX: (left - padX) / scale,
      sourceY: (top - padY) / scale,
      sourceWidth: (right - left) / scale,
      sourceHeight: (bottom - top) / scale,
    };
  }

  private evictImages(state: ScreenState): void {
    while (state.storageBytes > STORAGE_LIMIT_BYTES) {
      const oldest = state.images.keys().next().value as number | undefined;
      if (oldest === undefined) return;
      const image = state.images.get(oldest);
      if (image) state.storageBytes -= image.data.byteLength;
      state.images.delete(oldest);
      for (const [key, placement] of state.placements) {
        if (placement.imageId === oldest) state.placements.delete(key);
      }
      for (const [key, placement] of state.virtualPlacements) {
        if (placement.imageId === oldest) state.virtualPlacements.delete(key);
      }
      state.generation += 1n;
    }
  }

  private combineChunks(pending: PendingTransfer): Uint8Array {
    const combined = new Uint8Array(pending.encodedBytes);
    let offset = 0;
    for (const chunk of pending.chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return combined;
  }

  private flushPass(writeTerminal: (bytes: Uint8Array) => void): void {
    if (this.passBytes.length === 0) return;
    writeTerminal(Uint8Array.from(this.passBytes));
    this.passBytes.length = 0;
  }

  private clearState(state: ScreenState): void {
    state.images.clear();
    state.placements.clear();
    state.virtualPlacements.clear();
    state.storageBytes = 0;
    state.generation += 1n;
  }

  private resetScreensOnly(): void {
    this.clearState(this.main);
    this.clearState(this.alternate);
  }
}
