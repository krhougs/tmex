import { describe, expect, test } from 'bun:test';

import { createPaneStreamParser } from './pane-stream-parser';

type NotificationRecord = {
  source: 'osc9' | 'osc99' | 'osc777' | 'osc1337';
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

describe('pane stream parser - OSC 133 prompt markers', () => {
  function collectMarkers() {
    const markers: Array<{ kind: string; exitCode: number | null; params: string[] }> = [];
    const parser = createPaneStreamParser({
      onTitle: () => {},
      onBell: () => {},
      onNotification: () => {},
      onPromptMarker: (marker) => markers.push(marker),
    });
    return { parser, markers };
  }

  const ST = bytes(0x1b, 0x5c);

  test('C 输出开始（ST 结尾）从输出剥离并上抛', () => {
    const { parser, markers } = collectMarkers();
    const output = parser.push(bytes('X', 0x1b, ']', '133;C', ST, 'Y'));
    expect(Array.from(output)).toEqual([0x58, 0x59]);
    expect(markers).toEqual([{ kind: 'C', exitCode: null, params: [] }]);
  });

  test('D 命令结束带退出码', () => {
    const { parser, markers } = collectMarkers();
    parser.push(bytes(0x1b, ']', '133;D;0', ST));
    parser.push(bytes(0x1b, ']', '133;D;1', 0x07));
    expect(markers).toEqual([
      { kind: 'D', exitCode: 0, params: ['0'] },
      { kind: 'D', exitCode: 1, params: ['1'] },
    ]);
  });

  test('D 带 nonce 参数', () => {
    const { parser, markers } = collectMarkers();
    parser.push(bytes(0x1b, ']', '133;D;137;tmex=abc123', ST));
    expect(markers[0]).toEqual({ kind: 'D', exitCode: 137, params: ['137', 'tmex=abc123'] });
  });

  test('A/B 提示符标记', () => {
    const { parser, markers } = collectMarkers();
    parser.push(bytes(0x1b, ']', '133;A', ST, 0x1b, ']', '133;B', ST));
    expect(markers.map((m) => m.kind)).toEqual(['A', 'B']);
  });

  test('tmux passthrough 包裹的 OSC 133 也能解析', () => {
    const { parser, markers } = collectMarkers();
    // 外层 DCS：ESC P tmux ; <body> ESC \；body 内每个 ESC 都被加倍（1b 1b）。
    // 内层目标序列 = ESC ] 133;D;0 ESC \  →  body = 1b1b 5d 133;D;0 1b1b 5c
    parser.push(
      bytes(0x1b, 'Ptmux;', 0x1b, 0x1b, 0x5d, '133;D;0', 0x1b, 0x1b, 0x5c, 0x1b, 0x5c)
    );
    expect(markers).toEqual([{ kind: 'D', exitCode: 0, params: ['0'] }]);
  });

  test('未知子命令忽略', () => {
    const { parser, markers } = collectMarkers();
    parser.push(bytes(0x1b, ']', '133;Z', ST));
    expect(markers).toEqual([]);
  });
});

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

  test('unwraps tmux passthrough wrapped OSC 9 notification (Claude Code in tmux)', () => {
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

    // \x1bPtmux;\x1b\x1b]9;task done\x07\x1b\\ —— 内层 ESC 翻倍，BEL 终结内层 OSC
    const output = parser.push(
      bytes('A', 0x1b, 'Ptmux;', 0x1b, 0x1b, ']9;task done', 0x07, 0x1b, 0x5c, 'B')
    );

    expect(Array.from(output)).toEqual(Array.from(bytes('AB')));
    expect(notifications).toEqual([{ source: 'osc9', body: 'task done' }]);
    expect(bells).toEqual([]);
  });

  test('unwraps tmux passthrough wrapped OSC 777 with ST terminator split across pushes', () => {
    const notifications: NotificationRecord[] = [];
    const parser = createPaneStreamParser({
      onTitle: () => {},
      onBell: () => {},
      onNotification(notification: NotificationRecord) {
        notifications.push(notification);
      },
    });

    // 内层 OSC 777 用 ST 终结：包装后为 ESC ESC ] ... ESC ESC \ + 外层 ESC \
    const wrapped = bytes(
      0x1b,
      'Ptmux;',
      0x1b,
      0x1b,
      ']777;notify;Claude;done',
      0x1b,
      0x1b,
      0x5c,
      0x1b,
      0x5c
    );
    parser.push(wrapped.slice(0, 12));
    parser.push(wrapped.slice(12));

    expect(notifications).toEqual([
      { source: 'osc777', title: 'Claude', body: 'done' },
    ]);
  });

  test('aggregates kitty OSC 99 notification fragments by id (Claude Code kitty channel)', () => {
    const notifications: NotificationRecord[] = [];
    const parser = createPaneStreamParser({
      onTitle: () => {},
      onBell: () => {},
      onNotification(notification: NotificationRecord) {
        notifications.push(notification);
      },
    });

    const output = parser.push(
      bytes(
        0x1b,
        0x5d,
        '99;i=42:d=0:p=title;Claude Code',
        0x1b,
        0x5c,
        0x1b,
        0x5d,
        '99;i=42:p=body;Task finished',
        0x1b,
        0x5c,
        0x1b,
        0x5d,
        '99;i=42:d=1:a=focus;',
        0x1b,
        0x5c,
        'Z'
      )
    );

    expect(Array.from(output)).toEqual(Array.from(bytes('Z')));
    expect(notifications).toEqual([
      { source: 'osc99', title: 'Claude Code', body: 'Task finished' },
    ]);
  });

  test('passes through non-tmux DCS sequences unchanged', () => {
    const notifications: NotificationRecord[] = [];
    const parser = createPaneStreamParser({
      onTitle: () => {},
      onBell: () => {},
      onNotification(notification: NotificationRecord) {
        notifications.push(notification);
      },
    });

    const dcs = bytes('A', 0x1b, 'P+q544e', 0x1b, 0x5c, 'B');
    const output = parser.push(dcs);

    expect(Array.from(output)).toEqual(Array.from(dcs));
    expect(notifications).toEqual([]);
  });

  test('keeps OSC body intact when payload contains ESC followed by regular bytes', () => {
    const notifications: NotificationRecord[] = [];
    const parser = createPaneStreamParser({
      onTitle: () => {},
      onBell: () => {},
      onNotification(notification: NotificationRecord) {
        notifications.push(notification);
      },
    });

    // payload 中混入 ESC x：应保留并回到 body 状态，由 BEL 正常终结
    const output = parser.push(bytes(0x1b, 0x5d, '9;ab', 0x1b, 'xcd', 0x07, 'Z'));

    expect(Array.from(output)).toEqual(Array.from(bytes('Z')));
    expect(notifications).toEqual([{ source: 'osc9', body: 'ab\u001bxcd' }]);
  });
});
