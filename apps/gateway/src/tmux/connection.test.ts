import { describe, expect, test } from 'bun:test';
async function createConnection(onHistory: (paneId: string, data: string) => void) {
  process.env.TMEX_ADMIN_PASSWORD ??= 'test-admin-password';
  process.env.JWT_SECRET ??= 'test-jwt-secret';

  const mod = await import('./connection');
  return new mod.TmuxConnection({
    deviceId: 'test-device',
    onEvent: () => {},
    onTerminalOutput: () => {},
    onTerminalHistory: onHistory,
    onSnapshot: () => {},
    onError: () => {},
    onClose: () => {},
  });
}

describe('TmuxConnection history selection', () => {
  test('prefers alternate history when pane reports alternate_on=1', async () => {
    const histories: Array<{ paneId: string; data: string }> = [];
    const connection = await createConnection((paneId, data) => histories.push({ paneId, data }));
    const conn = connection as any;

    conn.historyCaptureStates.set('%1', {
      normal: 'normal-data',
      alternate: 'alt-data',
      preferAlternate: true,
      timeout: null,
    });

    conn.emitCapturedHistory('%1');

    expect(histories).toEqual([{ paneId: '%1', data: 'alt-data' }]);
  });

  test('prefers normal history when pane reports alternate_on=0', async () => {
    const histories: Array<{ paneId: string; data: string }> = [];
    const connection = await createConnection((paneId, data) => histories.push({ paneId, data }));
    const conn = connection as any;

    conn.historyCaptureStates.set('%2', {
      normal: 'normal-data',
      alternate: 'alt-data',
      preferAlternate: false,
      timeout: null,
    });

    conn.emitCapturedHistory('%2');

    expect(histories).toEqual([{ paneId: '%2', data: 'normal-data' }]);
  });

  test('falls back to longer history when mode is unknown', async () => {
    const histories: Array<{ paneId: string; data: string }> = [];
    const connection = await createConnection((paneId, data) => histories.push({ paneId, data }));
    const conn = connection as any;

    conn.historyCaptureStates.set('%3', {
      normal: 'short',
      alternate: 'much-longer-alt-history',
      preferAlternate: null,
      timeout: null,
    });

    conn.emitCapturedHistory('%3');

    expect(histories).toEqual([{ paneId: '%3', data: 'much-longer-alt-history' }]);
  });
});
