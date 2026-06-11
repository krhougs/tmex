import { describe, expect, test } from 'bun:test';

import {
  type ControlModeBlock,
  type ControlModeNotification,
  createControlModeParser,
  unescapeControlModeData,
} from './control-mode-parser';

const encoder = new TextEncoder();

function bytes(...parts: Array<number | string | Uint8Array>): Uint8Array {
  const list: number[] = [];
  for (const part of parts) {
    if (typeof part === 'number') {
      list.push(part);
    } else if (typeof part === 'string') {
      list.push(...encoder.encode(part));
    } else {
      list.push(...part);
    }
  }
  return new Uint8Array(list);
}

interface Collected {
  outputs: Array<{ paneId: string; data: number[] }>;
  notifications: ControlModeNotification[];
  exits: Array<string | null>;
  blocks: ControlModeBlock[];
}

function createCollector() {
  const collected: Collected = { outputs: [], notifications: [], exits: [], blocks: [] };
  const parser = createControlModeParser({
    onOutput: (paneId, data) => {
      collected.outputs.push({ paneId, data: Array.from(data) });
    },
    onNotification: (notification) => {
      collected.notifications.push(notification);
    },
    onExit: (reason) => {
      collected.exits.push(reason);
    },
    onBlockEnd: (block) => {
      collected.blocks.push(block);
    },
  });
  return { parser, collected };
}

describe('unescapeControlModeData', () => {
  test('decodes 3-digit octal escapes for control bytes and backslash', () => {
    const line = bytes('A\\011B\\134\\134C\\007D');
    expect(Array.from(unescapeControlModeData(line, 0))).toEqual([
      0x41, 0x09, 0x42, 0x5c, 0x5c, 0x43, 0x07, 0x44,
    ]);
  });

  test('keeps raw high bytes (UTF-8) untouched', () => {
    const line = bytes('D', 0xe4, 0xb8, 0xad, 'E\\015\\012');
    expect(Array.from(unescapeControlModeData(line, 0))).toEqual([
      0x44, 0xe4, 0xb8, 0xad, 0x45, 0x0d, 0x0a,
    ]);
  });

  test('passes through invalid escape sequences leniently', () => {
    let invalid = 0;
    const line = bytes('A\\12');
    expect(Array.from(unescapeControlModeData(line, 0, () => invalid++))).toEqual([
      0x41, 0x5c, 0x31, 0x32,
    ]);
    expect(invalid).toBe(1);

    const trailing = bytes('A\\');
    expect(Array.from(unescapeControlModeData(trailing, 0))).toEqual([0x41, 0x5c]);

    const nonOctal = bytes('\\189');
    expect(Array.from(unescapeControlModeData(nonOctal, 0))).toEqual([0x5c, 0x31, 0x38, 0x39]);
  });

  test('respects start offset', () => {
    const line = bytes('%output %0 \\033[m');
    expect(Array.from(unescapeControlModeData(line, 11))).toEqual([0x1b, 0x5b, 0x6d]);
  });
});

describe('control mode parser', () => {
  test('parses attach greeting block, session-changed and exit (real 3.4 sample)', () => {
    const { parser, collected } = createCollector();
    parser.push(
      bytes('%begin 1781125427 276 0\n%end 1781125427 276 0\n%session-changed $0 t1\n%exit\n')
    );

    expect(collected.blocks).toEqual([{ args: '1781125427 276 0', isError: false, lines: [] }]);
    expect(collected.notifications).toEqual([
      { type: 'session-changed', args: '$0 t1', raw: '%session-changed $0 t1' },
    ]);
    expect(collected.exits).toEqual([null]);
  });

  test('parses %output with escapes and raw UTF-8 payload bytes', () => {
    const { parser, collected } = createCollector();
    parser.push(bytes('%output %0 A\\011B\\134C', 0xe4, 0xb8, 0xad, '\\015\\012\n'));

    expect(collected.outputs).toEqual([
      {
        paneId: '%0',
        data: [0x41, 0x09, 0x42, 0x5c, 0x43, 0xe4, 0xb8, 0xad, 0x0d, 0x0a],
      },
    ]);
  });

  test('emits empty output payload when %output has no data', () => {
    const { parser, collected } = createCollector();
    parser.push(bytes('%output %3 \n'));
    expect(collected.outputs).toEqual([{ paneId: '%3', data: [] }]);
  });

  test('handles chunk splits at arbitrary positions including inside escapes', () => {
    const full = bytes('%output %12 X\\033[1mY\n%window-add @2\n');
    for (let splitAt = 1; splitAt < full.length - 1; splitAt += 1) {
      const { parser, collected } = createCollector();
      parser.push(full.subarray(0, splitAt));
      parser.push(full.subarray(splitAt));
      expect(collected.outputs).toEqual([
        { paneId: '%12', data: [0x58, 0x1b, 0x5b, 0x31, 0x6d, 0x59] },
      ]);
      expect(collected.notifications).toEqual([
        { type: 'window-add', args: '@2', raw: '%window-add @2' },
      ]);
    }
  });

  test('handles byte-at-a-time delivery', () => {
    const full = bytes('%output %1 \\134ok\n%exit reason here\n');
    const { parser, collected } = createCollector();
    for (const byte of full) {
      parser.push(new Uint8Array([byte]));
    }
    expect(collected.outputs).toEqual([{ paneId: '%1', data: [0x5c, 0x6f, 0x6b] }]);
    expect(collected.exits).toEqual(['reason here']);
  });

  test('parses %extended-output with age field and " : " separator', () => {
    const { parser, collected } = createCollector();
    parser.push(bytes('%extended-output %5 1234 : pay : load\\007\n'));
    expect(collected.outputs).toEqual([
      {
        paneId: '%5',
        data: Array.from(bytes('pay : load', 0x07)),
      },
    ]);
  });

  test('parses structural notifications from real 3.4 capture', () => {
    const { parser, collected } = createCollector();
    parser.push(
      bytes(
        '%window-renamed @1 zsh\n',
        '%window-add @2\n',
        '%window-pane-changed @0 %3\n',
        '%layout-change @0 c196,80x24,0,0[80x12,0,0,0,80x11,0,13,3] c196,80x24,0,0[80x12,0,0,0,80x11,0,13,3] !\n',
        '%unlinked-window-close @2\n',
        '%sessions-changed\n',
        '%client-session-changed client-70153 $0 t1\n'
      )
    );

    expect(collected.notifications.map((item) => item.type)).toEqual([
      'window-renamed',
      'window-add',
      'window-pane-changed',
      'layout-change',
      'unlinked-window-close',
      'sessions-changed',
      'client-session-changed',
    ]);
    expect(collected.notifications[0]?.args).toBe('@1 zsh');
    expect(collected.notifications[3]?.args).toBe(
      '@0 c196,80x24,0,0[80x12,0,0,0,80x11,0,13,3] c196,80x24,0,0[80x12,0,0,0,80x11,0,13,3] !'
    );
    expect(collected.notifications[5]?.args).toBe('');
  });

  test('keeps unknown notifications without throwing (forward compatibility)', () => {
    const { parser, collected } = createCollector();
    parser.push(bytes('%future-notification a b c\n%another\n'));
    expect(collected.notifications).toEqual([
      { type: 'future-notification', args: 'a b c', raw: '%future-notification a b c' },
      { type: 'another', args: '', raw: '%another' },
    ]);
  });

  test('collects error block body and flags isError', () => {
    const { parser, collected } = createCollector();
    parser.push(bytes('%begin 100 2 1\n', "can't find session: nope\n", '%error 100 2 1\n'));
    expect(collected.blocks).toEqual([
      { args: '100 2 1', isError: true, lines: ["can't find session: nope"] },
    ]);
  });

  test('dispatches interleaved known notifications and %output inside a block', () => {
    const { parser, collected } = createCollector();
    parser.push(
      bytes(
        '%begin 100 3 0\n',
        'body line\n',
        '%window-add @9\n',
        '%output %1 hi\n',
        '%unknown-inside x\n',
        '%end 100 3 0\n'
      )
    );

    expect(collected.notifications).toEqual([
      { type: 'window-add', args: '@9', raw: '%window-add @9' },
    ]);
    expect(collected.outputs).toEqual([{ paneId: '%1', data: [0x68, 0x69] }]);
    expect(collected.blocks).toEqual([
      { args: '100 3 0', isError: false, lines: ['body line', '%unknown-inside x'] },
    ]);
  });

  test('closes block on guard mismatch instead of getting stuck', () => {
    const { parser, collected } = createCollector();
    parser.push(bytes('%begin 100 4 0\n%end 999 9 9\n%window-add @1\n'));
    expect(collected.blocks).toHaveLength(1);
    expect(collected.notifications.map((item) => item.type)).toEqual(['window-add']);
  });

  test('ignores empty lines and non-percent noise outside blocks', () => {
    const { parser, collected } = createCollector();
    parser.push(bytes('\n\nnoise without percent\n%window-add @1\n'));
    expect(collected.notifications.map((item) => item.type)).toEqual(['window-add']);
  });

  test('end() flushes a final line without trailing newline', () => {
    const { parser, collected } = createCollector();
    parser.push(bytes('%exit'));
    expect(collected.exits).toEqual([]);
    parser.end();
    expect(collected.exits).toEqual([null]);
  });

  test('drops oversized lines without breaking subsequent parsing', () => {
    const { parser, collected } = createCollector();
    const huge = new Uint8Array(5 * 1024 * 1024).fill(0x61);
    parser.push(bytes('%output %1 '));
    parser.push(huge);
    parser.push(bytes('tail\n%window-add @7\n'));
    expect(collected.outputs).toEqual([]);
    expect(collected.notifications).toEqual([
      { type: 'window-add', args: '@7', raw: '%window-add @7' },
    ]);
  });

  test('multiple panes interleaved keep independent payloads', () => {
    const { parser, collected } = createCollector();
    parser.push(bytes('%output %0 a\n%output %1 b\n%output %0 c\n'));
    expect(collected.outputs).toEqual([
      { paneId: '%0', data: [0x61] },
      { paneId: '%1', data: [0x62] },
      { paneId: '%0', data: [0x63] },
    ]);
  });
});
