import { describe, expect, test } from 'bun:test';

import { ControlModeCommandQueue, capturePaneFrameAtControlBarrier } from './control-mode-capture';
import { createControlModeParser } from './control-mode-parser';

const encoder = new TextEncoder();

function createHarness() {
  const writes: string[] = [];
  const events: string[] = [];
  const queue = new ControlModeCommandQueue();
  const parser = createControlModeParser({
    onOutput: () => events.push('output'),
    onNotification: () => events.push('notification'),
    onExit: () => {},
    onBlockBegin: () => queue.nextBlockIsLiteral(),
    onBlockEnd: (block) => {
      queue.handleBlock(block);
      events.push('block-end');
    },
  });
  return { writes, events, queue, parser };
}

function block(lines: string[], isError = false) {
  return { args: '1 1 0', isError, lines };
}

describe('control-mode command queue', () => {
  test('does not spend timeout while waiting behind the queue head', async () => {
    const writes: string[] = [];
    const queue = new ControlModeCommandQueue();
    let secondSettled = false;
    const first = queue
      .execute((command) => writes.push(command), 'first', {
        timeoutMs: 5_000,
        transform: (response) => response.lines[0],
      })
      .then(
        (value) => ({ status: 'fulfilled' as const, value }),
        (error) => ({ status: 'rejected' as const, error })
      );
    const second = queue
      .execute((command) => writes.push(command), 'second', {
        timeoutMs: 10,
        transform: (response) => response.lines[0],
      })
      .then(
        (value) => {
          secondSettled = true;
          return { status: 'fulfilled' as const, value };
        },
        (error) => {
          secondSettled = true;
          return { status: 'rejected' as const, error };
        }
      );

    expect(writes).toEqual(['first\n', 'second\n']);
    await Bun.sleep(40);
    expect(secondSettled).toBe(false);

    queue.handleBlock(block(['first-response']));
    queue.handleBlock(block(['second-response']));

    expect(await first).toEqual({ status: 'fulfilled', value: 'first-response' });
    expect(await second).toEqual({ status: 'fulfilled', value: 'second-response' });
    queue.dispose();
  });

  test('%error rejects only the current command and the next command still resolves', async () => {
    const queue = new ControlModeCommandQueue();
    const first = queue
      .execute(() => {}, 'first', {
        timeoutMs: 100,
        transform: () => undefined,
      })
      .then(
        () => ({ status: 'fulfilled' as const }),
        (error) => ({ status: 'rejected' as const, message: String(error) })
      );
    const second = queue
      .execute(() => {}, 'second', {
        timeoutMs: 100,
        transform: (response) => response.lines[0],
      })
      .then(
        (value) => ({ status: 'fulfilled' as const, value }),
        (error) => ({ status: 'rejected' as const, message: String(error) })
      );

    queue.handleBlock(block(['first failed'], true));
    queue.handleBlock(block(['second-response']));

    expect(await first).toEqual({ status: 'rejected', message: 'Error: first failed' });
    expect(await second).toEqual({ status: 'fulfilled', value: 'second-response' });
    queue.dispose();
  });

  test('a stalled queue head poisons the queue and invokes the watchdog once', async () => {
    let poisonCount = 0;
    const queue = new ControlModeCommandQueue(() => {
      poisonCount += 1;
    });
    const result = queue
      .execute(() => {}, 'stalled', {
        timeoutMs: 10,
        transform: () => undefined,
      })
      .then(
        () => ({ status: 'fulfilled' as const }),
        (error) => ({ status: 'rejected' as const, message: String(error) })
      );

    await Bun.sleep(40);

    expect(await result).toEqual({
      status: 'rejected',
      message: 'Error: tmux control command timed out: stalled',
    });
    expect(poisonCount).toBe(1);
    queue.dispose();
    expect(poisonCount).toBe(1);
  });
});

describe('control-mode atomic capture', () => {
  test('aligns command blocks and keeps notification-looking screen lines literal', async () => {
    const { writes, events, queue, parser } = createHarness();
    const capturePromise = capturePaneFrameAtControlBarrier(
      queue,
      (command) => writes.push(command),
      '%1',
      50,
      () => events.push('barrier')
    );
    expect(writes).toHaveLength(3);
    parser.push(
      encoder.encode(
        '%begin 1 2 0\n80|24|0|3|4|200|1|0|0|1|0\n%end 1 2 0\n' +
          '%begin 1 3 0\n%output this is terminal text\n%window-add also terminal text\n' +
          '%end 1 3 0\n' +
          '%begin 1 4 0\nold history line\n%end 1 4 0\n%output %1 live\n'
      )
    );

    const capture = await capturePromise;
    expect(capture).toEqual({
      text: '%output this is terminal text\n%window-add also terminal text',
      historyText: 'old history line',
      cols: 80,
      rows: 24,
      cursorX: 3,
      cursorY: 4,
      alternateScreen: false,
      historySize: 200,
      modes: {
        mouseStandard: true,
        mouseButton: false,
        mouseAll: false,
        mouseSgr: true,
        mouseUtf8: false,
      },
    });
    expect(events).toEqual(['block-end', 'barrier', 'block-end', 'block-end', 'output']);
    expect(writes[1]).toBe('capture-pane -p -e -J -N -t %1\n');
    expect(writes[2]).toBe('capture-pane -p -e -J -N -t %1 -S -50 -E -1\n');
    queue.dispose();
  });

  test('preserves blank screen rows inside literal capture blocks', async () => {
    const { writes, queue, parser } = createHarness();
    const capturePromise = capturePaneFrameAtControlBarrier(
      queue,
      (command) => writes.push(command),
      '%1',
      0,
      () => {}
    );
    expect(writes).toHaveLength(2);
    parser.push(
      encoder.encode(
        '%begin 1 2 0\n80|24|0|0|0|0|0|0|0|0|0\n%end 1 2 0\n' +
          '%begin 1 3 0\nfirst\n\n\nfourth\n%end 1 3 0\n'
      )
    );
    const capture = await capturePromise;
    expect(capture.text).toBe('first\n\n\nfourth');
    expect(capture.historyText).toBeNull();
    queue.dispose();
  });
});
