import { afterEach, describe, expect, test } from 'bun:test';
import {
  type PaneSink,
  PaneSinkRegistry,
  beginPaneHistoryGate,
  cleanupDevicePaneState,
  dispatchPaneHistory,
  dispatchPaneOutput,
  dispatchPaneReset,
  hasPaneSink,
  registerPaneSink,
  resetPaneSinkRegistryForTest,
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
  test('replays an atomic screen before sequenced output registered during mount', () => {
    const registry = new PaneSinkRegistry();
    const events: string[] = [];
    const paneEpoch = new Uint8Array(16).fill(3);
    registry.dispatchPaneScreenSnapshot({
      deviceId: 'dev',
      paneId: '%1',
      paneEpoch,
      baseSeq: 0n,
      rows: 24,
      cols: 80,
      modes: 0,
      data: encode('screen'),
      historyCursor: null,
    });
    registry.dispatchPaneTerminalData({
      deviceId: 'dev',
      paneId: '%1',
      paneEpoch,
      seqStart: 0n,
      seqEnd: 4n,
      data: encode('live'),
    });

    registry.registerPaneSink('dev', '%1', {
      onReset() {},
      onApplyHistory() {},
      onScreenSnapshot: () => events.push('screen'),
      onOutput: () => events.push('output'),
    });

    expect(events).toEqual(['screen', 'output']);
  });

  test('turns an unmounted-pane buffer overflow into scoped recovery', () => {
    const registry = new PaneSinkRegistry();
    registry.dispatchPaneOutput('dev', '%1', new Uint8Array(2 * 1024 * 1024 + 1));
    const reasons: string[] = [];

    registry.registerPaneSink('dev', '%1', {
      onReset() {},
      onApplyHistory() {},
      onOutput() {},
      onRebase: (reason) => reasons.push(reason),
    });

    expect(reasons).toEqual(['resource_exhausted']);
  });

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

  test('attachment changes are level-triggered and ignore sink replacement', () => {
    const registry = new PaneSinkRegistry();
    let changes = 0;
    const off = registry.onPaneSinkChange(() => {
      changes += 1;
    });
    const a = createRecordingSink();
    const b = createRecordingSink();
    const unregisterA = registry.registerPaneSink('dev', '%1', a.sink);
    const unregisterB = registry.registerPaneSink('dev', '%1', b.sink);
    expect(registry.hasPaneSink('dev', '%1')).toBe(true);
    expect(changes).toBe(1);

    unregisterA();
    expect(changes).toBe(1);
    unregisterB();
    expect(registry.hasPaneSink('dev', '%1')).toBe(false);
    expect(changes).toBe(2);

    registry.registerPaneSink('dev', '%2', a.sink);
    registry.reset();
    expect(changes).toBe(4);
    off();
  });

  test('history gate buffers live output until matching history arrives', () => {
    const { sink, events } = createRecordingSink();
    registerPaneSink('dev', '%3', sink);

    const token = new Uint8Array(16).fill(7);
    beginPaneHistoryGate('dev', '%3', token);

    dispatchPaneOutput('dev', '%3', encode('live-1'));
    dispatchPaneOutput('dev', '%3', encode('live-2'));
    expect(events).toEqual([]);

    const consumed = dispatchPaneHistory('dev', '%3', token, 'HISTORY', false, 0);
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

    const consumed = dispatchPaneHistory('dev', '%3', new Uint8Array(16).fill(9), 'H', false, 0);
    expect(consumed).toBe(false);
  });

  test('history without gate is not consumed (select path falls through)', () => {
    const consumed = dispatchPaneHistory('dev', '%9', new Uint8Array(16), 'H', true, 0);
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

    const gateConsumed = dispatchPaneHistory(
      'dev-a',
      '%2',
      new Uint8Array(16).fill(4),
      'H',
      false,
      0
    );
    expect(gateConsumed).toBe(false);

    const b = createRecordingSink();
    registerPaneSink('dev-b', '%1', b.sink);
    // 无画面基线（reset/history/screen）的流中片段不回放：写进全新空终端只会闪现乱码
    expect(b.events).toEqual([]);
  });
});
