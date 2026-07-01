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

    const received: Array<{ paneId: string; data: string; alternateScreen: boolean }> = [];
    sm.setCallbacks({
      onApplyHistory: (_deviceId, paneId, data, alternateScreen) => {
        received.push({ paneId, data, alternateScreen });
      },
    });

    expect(received).toEqual([{ paneId: '%1', data: 'alt-history', alternateScreen: true }]);
  });

  test('routes non-transaction pane output instead of dropping it (split view siblings)', () => {
    const sm = new SelectStateMachine();
    const token = new Uint8Array(16).fill(2);
    const outputs: Array<{ paneId: string; text: string }> = [];

    sm.setCallbacks({
      onOutput: (_deviceId, paneId, data) => {
        outputs.push({ paneId, text: new TextDecoder().decode(data) });
      },
    });

    sm.dispatch({
      type: 'SELECT_START',
      deviceId: 'device-1',
      windowId: '@1',
      paneId: '%1',
      selectToken: token,
      wantHistory: true,
    });

    // 事务期间：事务 pane 输出被门控缓冲，兄弟 pane 输出直接路由
    sm.dispatch({
      type: 'OUTPUT',
      deviceId: 'device-1',
      paneId: '%1',
      data: new TextEncoder().encode('focused'),
    });
    sm.dispatch({
      type: 'OUTPUT',
      deviceId: 'device-1',
      paneId: '%2',
      data: new TextEncoder().encode('sibling'),
    });

    expect(outputs).toEqual([{ paneId: '%2', text: 'sibling' }]);

    sm.dispatch({ type: 'SWITCH_ACK', deviceId: 'device-1', selectToken: token });
    sm.dispatch({ type: 'LIVE_RESUME', deviceId: 'device-1', selectToken: token });

    // LIVE 后缓冲的事务 pane 输出经 onFlushBuffer 释放；此处只验证兄弟输出未丢
    expect(outputs.some((o) => o.paneId === '%2')).toBe(true);
  });

  test('flush buffer carries the transaction paneId', () => {
    const sm = new SelectStateMachine();
    const token = new Uint8Array(16).fill(3);
    const flushes: Array<{ paneId: string; chunks: number }> = [];

    sm.setCallbacks({
      onFlushBuffer: (_deviceId, paneId, buffer) => {
        flushes.push({ paneId, chunks: buffer.length });
      },
    });

    sm.dispatch({
      type: 'SELECT_START',
      deviceId: 'device-1',
      windowId: '@1',
      paneId: '%7',
      selectToken: token,
      wantHistory: false,
    });
    sm.dispatch({
      type: 'OUTPUT',
      deviceId: 'device-1',
      paneId: '%7',
      data: new TextEncoder().encode('buffered'),
    });
    sm.dispatch({ type: 'SWITCH_ACK', deviceId: 'device-1', selectToken: token });
    sm.dispatch({ type: 'LIVE_RESUME', deviceId: 'device-1', selectToken: token });

    expect(flushes).toEqual([{ paneId: '%7', chunks: 1 }]);
  });
});
