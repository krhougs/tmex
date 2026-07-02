import { afterEach, describe, expect, test } from 'bun:test';
import {
  beginPaneHistoryGate,
  cleanupDevicePaneState,
  dispatchPaneHistory,
  dispatchPaneOutput,
  dispatchPaneReset,
  hasPaneSink,
  registerPaneSink,
  resetPaneSinkRegistryForTest,
  type PaneSink,
} from './pane-sink-registry';

function createRecordingSink() {
  const events: Array<{ type: string; data?: string; alternateScreen?: boolean }> = [];
  const sink: PaneSink = {
    onReset: () => events.push({ type: 'reset' }),
    onApplyHistory: (data, alternateScreen) =>
      events.push({ type: 'history', data, alternateScreen }),
    onOutput: (data) => events.push({ type: 'output', data: new TextDecoder().decode(data) }),
  };
  return { sink, events };
}

const encode = (text: string) => new TextEncoder().encode(text);

afterEach(() => {
  resetPaneSinkRegistryForTest();
});

describe('pane-sink-registry', () => {
  test('routes output to the matching pane sink only', () => {
    const a = createRecordingSink();
    const b = createRecordingSink();
    registerPaneSink('dev', '%1', a.sink);
    registerPaneSink('dev', '%2', b.sink);

    dispatchPaneOutput('dev', '%1', encode('for-a'));
    dispatchPaneOutput('dev', '%2', encode('for-b'));

    expect(a.events).toEqual([{ type: 'output', data: 'for-a' }]);
    expect(b.events).toEqual([{ type: 'output', data: 'for-b' }]);
  });

  test('buffers output while sink is unregistered and replays on register', () => {
    dispatchPaneReset('dev', '%1');
    dispatchPaneOutput('dev', '%1', encode('early'));

    const { sink, events } = createRecordingSink();
    registerPaneSink('dev', '%1', sink);

    expect(events).toEqual([{ type: 'reset' }, { type: 'output', data: 'early' }]);
  });

  test('unregister only removes own sink', () => {
    const a = createRecordingSink();
    const unregister = registerPaneSink('dev', '%1', a.sink);
    const b = createRecordingSink();
    registerPaneSink('dev', '%1', b.sink);

    unregister();
    expect(hasPaneSink('dev', '%1')).toBe(true);

    dispatchPaneOutput('dev', '%1', encode('x'));
    expect(b.events).toEqual([{ type: 'output', data: 'x' }]);
    expect(a.events).toEqual([]);
  });

  test('history gate buffers live output until matching history arrives', () => {
    const { sink, events } = createRecordingSink();
    registerPaneSink('dev', '%3', sink);

    const token = new Uint8Array(16).fill(7);
    beginPaneHistoryGate('dev', '%3', token);

    dispatchPaneOutput('dev', '%3', encode('live-1'));
    dispatchPaneOutput('dev', '%3', encode('live-2'));
    expect(events).toEqual([]);

    const consumed = dispatchPaneHistory('dev', '%3', token, 'HISTORY', false);
    expect(consumed).toBe(true);
    expect(events).toEqual([
      { type: 'reset' },
      { type: 'history', data: 'HISTORY', alternateScreen: false },
      { type: 'output', data: 'live-1' },
      { type: 'output', data: 'live-2' },
    ]);
  });

  test('history with mismatched token is not consumed', () => {
    const { sink } = createRecordingSink();
    registerPaneSink('dev', '%3', sink);
    beginPaneHistoryGate('dev', '%3', new Uint8Array(16).fill(1));

    const consumed = dispatchPaneHistory('dev', '%3', new Uint8Array(16).fill(9), 'H', false);
    expect(consumed).toBe(false);
  });

  test('history without gate is not consumed (select path falls through)', () => {
    const consumed = dispatchPaneHistory('dev', '%9', new Uint8Array(16), 'H', true);
    expect(consumed).toBe(false);
  });

  test('cleanupDevicePaneState drops pending buffers and gates for the device', () => {
    dispatchPaneOutput('dev-a', '%1', encode('pending'));
    beginPaneHistoryGate('dev-a', '%2', new Uint8Array(16).fill(4));
    dispatchPaneOutput('dev-b', '%1', encode('other-device'));

    cleanupDevicePaneState('dev-a');

    const a = createRecordingSink();
    registerPaneSink('dev-a', '%1', a.sink);
    expect(a.events).toEqual([]);

    const gateConsumed = dispatchPaneHistory('dev-a', '%2', new Uint8Array(16).fill(4), 'H', false);
    expect(gateConsumed).toBe(false);

    const b = createRecordingSink();
    registerPaneSink('dev-b', '%1', b.sink);
    expect(b.events).toEqual([{ type: 'output', data: 'other-device' }]);
  });
});
