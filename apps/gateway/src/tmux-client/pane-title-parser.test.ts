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

  test('consumes screen/tmux style ESC k <title> ESC \\\\ sequence without leaking text', () => {
    const titles: string[] = [];
    const parser = createPaneTitleParser({
      onTitle(title) {
        titles.push(title);
      },
    });

    const output = parser.push(
      new Uint8Array([
        0x1b, 0x6b, 0x65, 0x63, 0x68, 0x6f, 0x1b, 0x5c, 0x74, 0x65, 0x73, 0x74, 0x0d, 0x0a,
      ])
    );

    expect(Array.from(output)).toEqual([0x74, 0x65, 0x73, 0x74, 0x0d, 0x0a]);
    expect(titles).toEqual(['echo']);
  });

  test('accepts BEL terminator for ESC k title sequence', () => {
    const titles: string[] = [];
    const parser = createPaneTitleParser({
      onTitle(title) {
        titles.push(title);
      },
    });

    const output = parser.push(new Uint8Array([0x1b, 0x6b, 0x66, 0x6f, 0x6f, 0x07, 0x42]));

    expect(Array.from(output)).toEqual([0x42]);
    expect(titles).toEqual(['foo']);
  });

  test('handles ESC k title split across push calls', () => {
    const titles: string[] = [];
    const parser = createPaneTitleParser({
      onTitle(title) {
        titles.push(title);
      },
    });

    const out1 = parser.push(new Uint8Array([0x1b, 0x6b, 0x65, 0x63, 0x68]));
    const out2 = parser.push(new Uint8Array([0x6f, 0x1b, 0x5c, 0x58]));

    expect(Array.from(out1)).toEqual([]);
    expect(Array.from(out2)).toEqual([0x58]);
    expect(titles).toEqual(['echo']);
  });
});
