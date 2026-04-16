import { describe, expect, test } from 'bun:test';
import { SelectStateMachine } from './state-machine';

describe('SelectStateMachine', () => {
  test('replays deferred history with alternateScreen preserved', () => {
    const sm = new SelectStateMachine();
    const token = new Uint8Array(16).fill(1);

    sm.dispatch({
      type: 'SELECT_START',
      deviceId: 'device-1',
      windowId: '@1',
      paneId: '%1',
      selectToken: token,
      wantHistory: true,
    });
    sm.dispatch({
      type: 'SWITCH_ACK',
      deviceId: 'device-1',
      selectToken: token,
    });
    sm.dispatch({
      type: 'HISTORY',
      deviceId: 'device-1',
      selectToken: token,
      data: 'alt-history',
      alternateScreen: true,
    });

    const received: Array<{ data: string; alternateScreen: boolean }> = [];
    sm.setCallbacks({
      onApplyHistory: (_deviceId, data, alternateScreen) => {
        received.push({ data, alternateScreen });
      },
    });

    expect(received).toEqual([{ data: 'alt-history', alternateScreen: true }]);
  });
});
