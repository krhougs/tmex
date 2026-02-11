import { describe, expect, test } from 'bun:test';
async function createConnection(options?: {
  onHistory?: (paneId: string, data: string) => void;
  onSnapshot?: (payload: unknown) => void;
}) {
  const mod = await import('./connection');
  return new mod.TmuxConnection({
    deviceId: 'test-device',
    onEvent: () => {},
    onTerminalOutput: () => {},
    onTerminalHistory: options?.onHistory ?? (() => {}),
    onSnapshot: options?.onSnapshot ?? (() => {}),
    onError: () => {},
    onClose: () => {},
  });
}

describe('TmuxConnection history selection', () => {
  test('emits bell event when terminal output contains BEL byte', async () => {
    const events: Array<{ type: string; data: unknown }> = [];
    const mod = await import('./connection');
    const connection = new mod.TmuxConnection({
      deviceId: 'test-device',
      onEvent: (event) => events.push({ type: event.type, data: event.data }),
      onTerminalOutput: () => {},
      onTerminalHistory: () => {},
      onSnapshot: () => {},
      onError: () => {},
      onClose: () => {},
    }) as any;

    connection.emitTerminalOutput('%9', new Uint8Array([0x48, 0x07, 0x69]));

    expect(events).toEqual([
      {
        type: 'bell',
        data: {
          paneId: '%9',
        },
      },
    ]);
  });

  test('capturePaneHistory should keep -e and not use -J', async () => {
    const connection = await createConnection();
    const conn = connection as any;
    const sentCommands: string[] = [];

    conn.connected = true;
    conn.sendCommand = (cmd: string) => {
      sentCommands.push(cmd);
    };

    conn.capturePaneHistory('%9');

    const state = conn.historyCaptureStates.get('%9');
    if (state?.timeout) {
      clearTimeout(state.timeout);
      state.timeout = null;
    }

    const captureCommands = sentCommands.filter((cmd) => cmd.startsWith('capture-pane '));

    expect(captureCommands).toEqual([
      'capture-pane -t %9 -S -1000 -e -p\n',
      'capture-pane -t %9 -a -S -1000 -e -p -q\n',
    ]);
    expect(captureCommands.every((cmd) => !cmd.includes(' -J'))).toBe(true);
  });

  test('prefers alternate history when pane reports alternate_on=1', async () => {
    const histories: Array<{ paneId: string; data: string }> = [];
    const connection = await createConnection({
      onHistory: (paneId, data) => histories.push({ paneId, data }),
    });
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
    const connection = await createConnection({
      onHistory: (paneId, data) => histories.push({ paneId, data }),
    });
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
    const connection = await createConnection({
      onHistory: (paneId, data) => histories.push({ paneId, data }),
    });
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

  test('applies pending pane title during snapshot panes parse', async () => {
    const connection = await createConnection();
    const conn = connection as any;

    conn.parseSnapshotWindows(['@1\t0\tmain\t1']);
    conn.pendingPaneTitles.set('%7', 'live-title');

    conn.parseSnapshotPanes(['%7\t@1\t0\told-title\t1\t80\t24']);

    const window = conn.snapshotWindows.get('@1');
    expect(window.panes[0].title).toBe('live-title');
    expect(conn.pendingPaneTitles.has('%7')).toBe(false);
  });

  test('updates existing pane title and emits snapshot', async () => {
    const snapshots: unknown[] = [];
    const connection = await createConnection({ onSnapshot: (payload) => snapshots.push(payload) });
    const conn = connection as any;

    conn.snapshotSession = { id: '$1', name: 'tmex' };
    conn.snapshotPanesReady = true;
    conn.snapshotWindows.set('@1', {
      id: '@1',
      name: 'main',
      index: 0,
      active: true,
      panes: [
        {
          id: '%1',
          windowId: '@1',
          index: 0,
          title: 'old',
          active: true,
          width: 80,
          height: 24,
        },
      ],
    });

    conn.handlePaneTitleUpdate('%1', 'new-pane-title');

    const window = conn.snapshotWindows.get('@1');
    expect(window.panes[0].title).toBe('new-pane-title');
    expect(snapshots.length).toBe(1);
  });
});
