import { describe, expect, test } from 'bun:test';

import { createPaneTitleParser } from './pane-title-parser';

describe('pane title parser', () => {
  test('emits title change for OSC 2 sequence terminated by BEL', () => {
    const titles: string[] = [];
    const parser = createPaneTitleParser({
      onTitle(title) {
        titles.push(title);
      },
    });

    const output = parser.push(new Uint8Array([0x1b, 0x5d, 0x32, 0x3b, 0x64, 0x65, 0x76, 0x07]));

    expect(Array.from(output)).toEqual([]);
    expect(titles).toEqual(['dev']);
  });

  test('emits title change for OSC 0 sequence terminated by ST and preserves surrounding bytes', () => {
    const titles: string[] = [];
    const parser = createPaneTitleParser({
      onTitle(title) {
        titles.push(title);
      },
    });

    const output = parser.push(
      new Uint8Array([0x41, 0x1b, 0x5d, 0x30, 0x3b, 0xe4, 0xb8, 0xad, 0x1b, 0x5c, 0x42])
    );

    expect(Array.from(output)).toEqual([0x41, 0x42]);
    expect(titles).toEqual(['中']);
  });
});
