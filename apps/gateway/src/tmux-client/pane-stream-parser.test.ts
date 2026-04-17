import { describe, expect, test } from 'bun:test';

import { createPaneStreamParser } from './pane-stream-parser';

type NotificationRecord = {
  source: 'osc9' | 'osc777' | 'osc1337';
  title?: string;
  body: string;
};

const encoder = new TextEncoder();

function bytes(...parts: Array<number | string | Uint8Array>): Uint8Array {
  const output: number[] = [];
  for (const part of parts) {
    if (typeof part === 'number') {
      output.push(part);
      continue;
    }
    if (typeof part === 'string') {
      output.push(...encoder.encode(part));
      continue;
    }
    output.push(...part);
  }
  return new Uint8Array(output);
}

describe('pane stream parser', () => {
  test('emits bare BEL as bell and removes it from output', () => {
    const bells: number[] = [];
    const parser = createPaneStreamParser({
      onTitle: () => {},
      onBell() {
        bells.push(1);
      },
      onNotification: () => {},
    });

    const output = parser.push(bytes('A', 0x07, 'B'));

    expect(Array.from(output)).toEqual([0x41, 0x42]);
    expect(bells).toEqual([1]);
  });

  test('emits title change for OSC 2 terminated by BEL without emitting bell', () => {
    const titles: string[] = [];
    const bells: number[] = [];
    const parser = createPaneStreamParser({
      onTitle(title: string) {
        titles.push(title);
      },
      onBell() {
        bells.push(1);
      },
      onNotification: () => {},
    });

    const output = parser.push(bytes(0x1b, 0x5d, '2;dev', 0x07));

    expect(Array.from(output)).toEqual([]);
    expect(titles).toEqual(['dev']);
    expect(bells).toEqual([]);
  });

  test('emits title change for OSC 0 terminated by ST and preserves surrounding bytes', () => {
    const titles: string[] = [];
    const parser = createPaneStreamParser({
      onTitle(title: string) {
        titles.push(title);
      },
      onBell: () => {},
      onNotification: () => {},
    });

    const output = parser.push(bytes('A', 0x1b, 0x5d, '0;中', 0x1b, 0x5c, 'B'));

    expect(Array.from(output)).toEqual([0x41, 0x42]);
    expect(titles).toEqual(['中']);
  });

  test('consumes screen title sequences without leaking text or emitting bell', () => {
    const titles: string[] = [];
    const bells: number[] = [];
    const parser = createPaneStreamParser({
      onTitle(title: string) {
        titles.push(title);
      },
      onBell() {
        bells.push(1);
      },
      onNotification: () => {},
    });

    const output = parser.push(bytes(0x1b, 0x6b, 'echo', 0x07, 'test\r\n'));

    expect(Array.from(output)).toEqual(Array.from(bytes('test\r\n')));
    expect(titles).toEqual(['echo']);
    expect(bells).toEqual([]);
  });

  test('emits OSC 9 notification and ignores OSC 9 progress payloads', () => {
    const notifications: NotificationRecord[] = [];
    const bells: number[] = [];
    const parser = createPaneStreamParser({
      onTitle: () => {},
      onBell() {
        bells.push(1);
      },
      onNotification(notification: NotificationRecord) {
        notifications.push(notification);
      },
    });

    const output = parser.push(
      bytes(
        'A',
        0x1b,
        0x5d,
        '9;hello from tmex',
        0x07,
        'B',
        0x1b,
        0x5d,
        '9;4;1;42',
        0x07,
        'C'
      )
    );

    expect(Array.from(output)).toEqual(Array.from(bytes('ABC')));
    expect(notifications).toEqual([{ source: 'osc9', body: 'hello from tmex' }]);
    expect(bells).toEqual([]);
  });

  test('emits OSC 777 notification and keeps semicolons in body', () => {
    const notifications: NotificationRecord[] = [];
    const parser = createPaneStreamParser({
      onTitle: () => {},
      onBell: () => {},
      onNotification(notification: NotificationRecord) {
        notifications.push(notification);
      },
    });

    parser.push(bytes(0x1b, 0x5d, '777;notify;Build finished;All 42 tests;passed', 0x07));

    expect(notifications).toEqual([
      {
        source: 'osc777',
        title: 'Build finished',
        body: 'All 42 tests;passed',
      },
    ]);
  });

  test('emits OSC 1337 RequestAttention only for matching subcommands', () => {
    const notifications: NotificationRecord[] = [];
    const outputParser = createPaneStreamParser({
      onTitle: () => {},
      onBell: () => {},
      onNotification(notification: NotificationRecord) {
        notifications.push(notification);
      },
    });

    const output = outputParser.push(
      bytes(
        'A',
        0x1b,
        0x5d,
        '1337;RequestAttention=yes',
        0x07,
        'B',
        0x1b,
        0x5d,
        '1337;SetMark',
        0x07,
        'C'
      )
    );

    expect(Array.from(output)).toEqual(Array.from(bytes('ABC')));
    expect(notifications).toEqual([{ source: 'osc1337', body: 'RequestAttention' }]);
  });

  test('keeps parser state across push calls for OSC notifications terminated by ST', () => {
    const notifications: NotificationRecord[] = [];
    const parser = createPaneStreamParser({
      onTitle: () => {},
      onBell: () => {},
      onNotification(notification: NotificationRecord) {
        notifications.push(notification);
      },
    });

    const out1 = parser.push(bytes(0x1b, 0x5d, '777;notify;Build'));
    const out2 = parser.push(bytes(' finished;OK', 0x1b, 0x5c, 'X'));

    expect(Array.from(out1)).toEqual([]);
    expect(Array.from(out2)).toEqual([0x58]);
    expect(notifications).toEqual([
      {
        source: 'osc777',
        title: 'Build finished',
        body: 'OK',
      },
    ]);
  });

  test('swallows unknown OSC sequences without leaking bytes', () => {
    const parser = createPaneStreamParser({
      onTitle: () => {},
      onBell: () => {},
      onNotification: () => {},
    });

    const output = parser.push(bytes('A', 0x1b, 0x5d, '999;secret', 0x07, 'B'));

    expect(Array.from(output)).toEqual(Array.from(bytes('AB')));
  });

  test('emits notification when OSC 777 follows echoed shell command text', () => {
    const notifications: NotificationRecord[] = [];
    const bells: number[] = [];
    const parser = createPaneStreamParser({
      onTitle: () => {},
      onBell() {
        bells.push(1);
      },
      onNotification(notification: NotificationRecord) {
        notifications.push(notification);
      },
    });

    const output = parser.push(
      bytes(
        "sh-3.2$ printf $'\\033]777;notify;Build finished;OK\\007'\r\n",
        0x1b,
        0x5d,
        '777;notify;Build finished;OK',
        0x07,
        'sh-3.2$ '
      )
    );

    expect(new TextDecoder().decode(output)).toBe(
      "sh-3.2$ printf $'\\033]777;notify;Build finished;OK\\007'\r\nsh-3.2$ "
    );
    expect(notifications).toEqual([
      {
        source: 'osc777',
        title: 'Build finished',
        body: 'OK',
      },
    ]);
    expect(bells).toEqual([]);
  });
});
