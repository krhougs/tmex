import { describe, expect, test } from 'bun:test';
import type { GhosttyRenderRow } from './types';
import { KITTY_DIACRITICS } from './web-kitty-diacritics';
import { type WebKittyCursorContext, WebKittyGraphicsStore } from './web-kitty-graphics';

const context: WebKittyCursorContext = {
  col: 2,
  absoluteRow: 5,
  viewportOffset: 3,
  viewportRows: 24,
  alternateScreen: false,
  cellDimensions: { width: 8, height: 16 },
};

function command(control: string, payload = ''): string {
  return `\x1b_G${control};${payload}\x1b\\`;
}

describe('web Kitty graphics store', () => {
  test('filters APC bytes, stores direct RGBA and exposes classic placement', () => {
    const store = new WebKittyGraphicsStore();
    const terminalBytes: number[] = [];
    store.process(
      `before${command('a=T,f=32,s=1,v=1,i=7,C=1', '/wAA/w==')}after`,
      (bytes) => terminalBytes.push(...bytes),
      () => context
    );

    expect(new TextDecoder().decode(Uint8Array.from(terminalBytes))).toBe('beforeafter');
    const snapshot = store.snapshot([], context);
    expect(snapshot?.imageIds).toEqual([7]);
    expect(snapshot?.images[0]).toMatchObject({ id: 7, width: 1, height: 1, format: 1 });
    expect([...(snapshot?.images[0].data ?? [])]).toEqual([255, 0, 0, 255]);
    expect(snapshot?.placements[0]).toMatchObject({
      imageId: 7,
      viewportCol: 2,
      viewportRow: 2,
      viewportVisible: true,
      sourceWidth: 1,
      sourceHeight: 1,
    });
  });

  test('resolves Unicode placeholder fragments from cell colors and diacritics', () => {
    const imageId = 0x8eb462e0;
    const store = new WebKittyGraphicsStore();
    store.process(
      command(`a=t,f=32,s=1,v=1,i=${imageId}`, '/wAA/w=='),
      () => {},
      () => context
    );
    store.process(
      command(`a=p,U=1,i=${imageId},p=2,c=1,r=1,C=1`),
      () => {},
      () => context
    );
    const rows: GhosttyRenderRow[] = [
      {
        y: 0,
        dirty: true,
        wrap: false,
        wrapContinuation: false,
        text: '',
        cells: [
          {
            x: 0,
            text: '',
            codepoints: [
              0x10eeee,
              KITTY_DIACRITICS[0],
              KITTY_DIACRITICS[0],
              KITTY_DIACRITICS[0x8e],
            ],
            widthKind: 'narrow',
            hasText: true,
            style: {
              bold: false,
              italic: false,
              faint: false,
              blink: false,
              inverse: false,
              invisible: false,
              strikethrough: false,
              overline: false,
              underline: 0,
            },
            fgColor: { r: 0xb4, g: 0x62, b: 0xe0 },
            bgColor: null,
            underlineColor: { r: 0, g: 0, b: 2 },
            fgPaletteIndex: null,
            bgPaletteIndex: null,
          },
        ],
      },
    ];

    const snapshot = store.snapshot(rows, { ...context, viewportOffset: 0 });
    expect(snapshot?.placements).toHaveLength(1);
    expect(snapshot?.placements[0]).toMatchObject({
      imageId,
      placementId: 2,
      viewportCol: 0,
      viewportRow: 0,
      viewportVisible: true,
    });
  });

  test('ingests protocol-level pixels and placement without base64 parsing', () => {
    const store = new WebKittyGraphicsStore();
    let invalidations = 0;
    const invalidate = () => invalidations++;
    store.ingestGraphicsMessage(
      { kind: 'begin', imageId: 42, width: 1, height: 1, format: 0 },
      () => context,
      invalidate
    );
    store.ingestGraphicsMessage(
      { kind: 'chunk', imageId: 42, offset: 0n, pixels: Uint8Array.of(1, 2, 3, 4) },
      () => context,
      invalidate
    );
    store.ingestGraphicsMessage(
      { kind: 'end', imageId: 42, generation: 1n },
      () => context,
      invalidate
    );
    store.ingestGraphicsMessage(
      {
        kind: 'placement',
        imageId: 42,
        placementId: 8,
        col: 0,
        row: 0,
        cols: 1,
        rows: 1,
        z: 0,
        action: 0,
        cursorPolicy: 0,
      },
      () => context,
      invalidate
    );

    const snapshot = store.snapshot([], context);
    expect(snapshot?.images[0]).toMatchObject({
      id: 42,
      width: 1,
      height: 1,
      format: 1,
    });
    expect(snapshot?.images[0].data).toEqual(Uint8Array.of(1, 2, 3, 4));
    expect(snapshot?.placements[0]).toMatchObject({ imageId: 42, placementId: 8 });
    expect(invalidations).toBe(2);
  });

  test('rejects out-of-order graphics chunks', () => {
    const store = new WebKittyGraphicsStore();
    let invalidations = 0;
    const invalidate = () => invalidations++;
    store.ingestGraphicsMessage(
      { kind: 'begin', imageId: 42, width: 1, height: 1, format: 0 },
      () => context,
      invalidate
    );
    store.ingestGraphicsMessage(
      { kind: 'chunk', imageId: 42, offset: 1n, pixels: Uint8Array.of(1, 2, 3, 4) },
      () => context,
      invalidate
    );
    store.ingestGraphicsMessage(
      { kind: 'end', imageId: 42, generation: 1n },
      () => context,
      invalidate
    );
    expect(store.snapshot([], context)).toBeUndefined();
    expect(invalidations).toBe(0);
  });

  test('preserves non-graphics APC and aggregates graphics chunks', () => {
    const store = new WebKittyGraphicsStore();
    const terminalBytes: number[] = [];
    const write = (bytes: Uint8Array) => terminalBytes.push(...bytes);
    store.process('\x1b_custom\x1b\\', write, () => context);
    store.process(command('a=T,f=32,s=1,v=1,i=9,C=1,m=1', '/wAA'), write, () => context);
    store.process(command('m=0', '/w=='), write, () => context);

    expect(new TextDecoder().decode(Uint8Array.from(terminalBytes))).toBe('\x1b_custom\x1b\\');
    expect(store.snapshot([], context)?.imageIds).toEqual([9]);
  });
});
