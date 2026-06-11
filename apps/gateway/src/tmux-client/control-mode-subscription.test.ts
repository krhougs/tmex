import { describe, expect, test } from 'bun:test';
import type { PaneStreamNotification } from './pane-stream-parser';

import { createControlModeSubscription } from './control-mode-subscription';

const encoder = new TextEncoder();

function lines(...items: string[]): Uint8Array {
  return encoder.encode(`${items.join('\n')}\n`);
}

interface Collected {
  outputs: Array<{ paneId: string; text: string }>;
  titles: Array<{ paneId: string; title: string }>;
  bells: string[];
  notifications: Array<{ paneId: string; notification: PaneStreamNotification }>;
  structureChanges: number;
  exits: Array<string | null>;
}

function createCollector() {
  const collected: Collected = {
    outputs: [],
    titles: [],
    bells: [],
    notifications: [],
    structureChanges: 0,
    exits: [],
  };
  const subscription = createControlModeSubscription({
    onTerminalOutput: (paneId, data) => {
      collected.outputs.push({ paneId, text: new TextDecoder().decode(data) });
    },
    onTitle: (paneId, title) => {
      collected.titles.push({ paneId, title });
    },
    onBell: (paneId) => {
      collected.bells.push(paneId);
    },
    onNotification: (paneId, notification) => {
      collected.notifications.push({ paneId, notification });
    },
    onStructureChanged: () => {
      collected.structureChanges += 1;
    },
    onExit: (reason) => {
      collected.exits.push(reason);
    },
  });
  return { subscription, collected };
}

describe('control mode subscription', () => {
  test('routes %output through per-pane stream parsers', () => {
    const { subscription, collected } = createCollector();
    subscription.push(lines('%output %1 hello', '%output %2 world'));
    expect(collected.outputs).toEqual([
      { paneId: '%1', text: 'hello' },
      { paneId: '%2', text: 'world' },
    ]);
    subscription.dispose();
  });

  test('extracts bell and strips it from terminal output', () => {
    const { subscription, collected } = createCollector();
    subscription.push(lines('%output %1 A\\007B'));
    expect(collected.outputs).toEqual([{ paneId: '%1', text: 'AB' }]);
    expect(collected.bells).toEqual(['%1']);
    subscription.dispose();
  });

  test('parses OSC 9 notification escaped in control stream', () => {
    const { subscription, collected } = createCollector();
    subscription.push(lines('%output %4 \\033]9;hi from claude\\007'));
    expect(collected.notifications).toEqual([
      { paneId: '%4', notification: { source: 'osc9', body: 'hi from claude' } },
    ]);
    expect(collected.outputs).toEqual([]);
    subscription.dispose();
  });

  test('parses tmux-passthrough-wrapped OSC 777 split across %output lines', () => {
    const { subscription, collected } = createCollector();
    // DCS tmux; 包装：ESC P tmux; ... ESC ESC ] ... ESC \
    subscription.push(lines('%output %7 \\033Ptmux;\\033\\033]777;notify;Title;Bo'));
    subscription.push(lines('%output %7 dy\\007\\033\\134'));
    expect(collected.notifications).toEqual([
      {
        paneId: '%7',
        notification: { source: 'osc777', title: 'Title', body: 'Body' },
      },
    ]);
    subscription.dispose();
  });

  test('emits pane title updates', () => {
    const { subscription, collected } = createCollector();
    subscription.push(lines('%output %1 \\033]2;my-title\\007'));
    expect(collected.titles).toEqual([{ paneId: '%1', title: 'my-title' }]);
    subscription.dispose();
  });

  test('keeps per-pane parser state independent across interleaved output', () => {
    const { subscription, collected } = createCollector();
    subscription.push(lines('%output %1 \\033]9;part'));
    subscription.push(lines('%output %2 plain'));
    subscription.push(lines('%output %1 ial\\007'));
    expect(collected.outputs).toEqual([{ paneId: '%2', text: 'plain' }]);
    expect(collected.notifications).toEqual([
      { paneId: '%1', notification: { source: 'osc9', body: 'partial' } },
    ]);
    subscription.dispose();
  });

  test('debounces bursts of structure notifications (leading + trailing)', async () => {
    const { subscription, collected } = createCollector();
    subscription.push(lines('%window-add @1', '%layout-change @1 x y !', '%window-renamed @1 zsh'));
    expect(collected.structureChanges).toBe(1);
    await Bun.sleep(250);
    expect(collected.structureChanges).toBe(2);
    subscription.dispose();
  });

  test('non-structural notifications do not trigger snapshot refresh', () => {
    const { subscription, collected } = createCollector();
    subscription.push(lines('%client-session-changed client-1 $0 t1', '%pause %1'));
    expect(collected.structureChanges).toBe(0);
    subscription.dispose();
  });

  test('forwards %exit reason', () => {
    const { subscription, collected } = createCollector();
    subscription.push(lines('%exit detached'));
    expect(collected.exits).toEqual(['detached']);
    subscription.dispose();
  });

  test('prunePanes drops parsers for closed panes', () => {
    const { subscription, collected } = createCollector();
    subscription.push(lines('%output %1 a', '%output %2 b'));
    subscription.prunePanes(new Set(['%1']));
    subscription.push(lines('%output %1 c', '%output %2 d'));
    // %2 的 parser 被清掉后会重新懒建，输出仍然可达（pane id 复用场景）
    expect(collected.outputs.map((item) => item.text)).toEqual(['a', 'b', 'c', 'd']);
    subscription.dispose();
  });

  test('dispose cancels pending trailing structure callback', async () => {
    const { subscription, collected } = createCollector();
    subscription.push(lines('%window-add @1', '%window-add @2'));
    expect(collected.structureChanges).toBe(1);
    subscription.dispose();
    await Bun.sleep(250);
    expect(collected.structureChanges).toBe(1);
  });
});
