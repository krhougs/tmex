import { beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Device, StateSnapshotPayload } from '@tmex/shared';

import {
  LocalExternalTmuxConnection,
  shouldIgnoreReaderAbortError,
} from './local-external-connection';
import { runMigrations } from '../db/migrate';
import { toSafePathSegment } from './fs-paths';

const now = '2026-04-14T00:00:00.000Z';

function createDevice(session = 'tmex-test'): Device {
  return {
    id: 'device-local',
    name: 'local',
    type: 'local',
    authMode: 'auto',
    session,
    createdAt: now,
    updatedAt: now,
  };
}

function isConfigureSessionOptionCommand(command: string, session: string): boolean {
  return (
    command === `set-option -t ${session} -s allow-passthrough off` ||
    command === `set-option -t ${session} -g extended-keys on` ||
    command === `set-option -t ${session} -s extended-keys-format csi-u` ||
    command === `set-option -t ${session} -g focus-events on`
  );
}

beforeAll(() => {
  runMigrations();
});

describe('LocalExternalTmuxConnection', () => {
  test('shouldIgnoreReaderAbortError matches releaseLock abort noise', () => {
    expect(
      shouldIgnoreReaderAbortError({
        name: 'AbortError',
        code: 'ERR_STREAM_RELEASE_LOCK',
        message: 'Stream reader cancelled via releaseLock()',
      })
    ).toBe(true);

    expect(shouldIgnoreReaderAbortError(new Error('boom'))).toBe(false);
  });

  test('connect configures session options and syncs pipe readers after snapshot refresh', async () => {
    const calls: string[][] = [];
    let syncCalls = 0;
    const connection = new LocalExternalTmuxConnection(
      {
        deviceId: 'device-local',
        onEvent: () => {},
        onTerminalOutput: () => {},
        onTerminalHistory: () => {},
        onSnapshot: () => {},
        onError: (error) => {
          throw error;
        },
        onClose: () => {},
      },
      {
        enableHooks: false,
        getDevice: () => createDevice('tmex-configure'),
        run: async (argv) => {
          calls.push(argv);
          const command = argv.slice(1).join(' ');
          if (command === 'has-session -t tmex-configure') {
            return { exitCode: 1, stdout: '', stderr: "can't find session: tmex-configure" };
          }
          if (command === 'new-session -d -c /Users/krhougs -s tmex-configure') {
            return { exitCode: 0, stdout: '', stderr: '' };
          }
          if (
            command === 'set-option -t tmex-configure -s allow-passthrough off' ||
            command === 'set-option -t tmex-configure -g extended-keys on' ||
            command === 'set-option -t tmex-configure -s extended-keys-format csi-u' ||
            command === 'set-option -t tmex-configure -g focus-events on'
          ) {
            return { exitCode: 0, stdout: '', stderr: '' };
          }
          if (command.startsWith('display-message -p -t tmex-configure #{session_id}')) {
            return { exitCode: 0, stdout: '$1\ttmex-configure\n', stderr: '' };
          }
          if (command.startsWith('list-windows -t tmex-configure')) {
            return { exitCode: 0, stdout: '@1\t0\tmain\t1\n', stderr: '' };
          }
          if (command.startsWith('list-panes -t tmex-configure')) {
            return {
              exitCode: 0,
              stdout: '%1\t@1\t0\tbash\t1\t80\t24\n%2\t@1\t1\tlogs\t0\t80\t24\n',
              stderr: '',
            };
          }
          throw new Error(`unexpected command: ${argv.join(' ')}`);
        },
      }
    );
    (connection as any).syncPipeReaders = async () => {
      syncCalls += 1;
    };

    await connection.connect();

    expect(calls.map((argv) => argv.slice(1).join(' '))).toContain(
      'set-option -t tmex-configure -s allow-passthrough off'
    );
    expect(calls.map((argv) => argv.slice(1).join(' '))).toContain(
      'set-option -t tmex-configure -g extended-keys on'
    );
    expect(calls.map((argv) => argv.slice(1).join(' '))).toContain(
      'set-option -t tmex-configure -s extended-keys-format csi-u'
    );
    expect(calls.map((argv) => argv.slice(1).join(' '))).toContain(
      'set-option -t tmex-configure -g focus-events on'
    );
    expect(syncCalls).toBe(1);
  });

  test('selectPane no longer restarts pipe readers', async () => {
    let startPipeCalls = 0;
    const connection = new LocalExternalTmuxConnection(
      {
        deviceId: 'device-local',
        onEvent: () => {},
        onTerminalOutput: () => {},
        onTerminalHistory: () => {},
        onSnapshot: () => {},
        onError: (error) => {
          throw error;
        },
        onClose: () => {},
      },
      {
        enableHooks: false,
        getDevice: () => createDevice('tmex-select-pane'),
        run: async (argv) => {
          const command = argv.slice(1).join(' ');
          if (command === 'has-session -t tmex-select-pane') {
            return { exitCode: 0, stdout: '', stderr: '' };
          }
          if (
            command === 'set-option -t tmex-select-pane -s allow-passthrough off' ||
            command === 'set-option -t tmex-select-pane -g extended-keys on' ||
            command === 'set-option -t tmex-select-pane -s extended-keys-format csi-u' ||
            command === 'set-option -t tmex-select-pane -g focus-events on'
          ) {
            return { exitCode: 0, stdout: '', stderr: '' };
          }
          if (command.startsWith('display-message -p -t tmex-select-pane #{session_id}')) {
            return { exitCode: 0, stdout: '$1\ttmex-select-pane\n', stderr: '' };
          }
          if (command.startsWith('list-windows -t tmex-select-pane')) {
            return { exitCode: 0, stdout: '@1\t0\tmain\t1\n', stderr: '' };
          }
          if (command.startsWith('list-panes -t tmex-select-pane')) {
            return { exitCode: 0, stdout: '%1\t@1\t0\tbash\t1\t80\t24\n', stderr: '' };
          }
          if (command === 'select-window -t @1' || command === 'select-pane -t %1') {
            return { exitCode: 0, stdout: '', stderr: '' };
          }
          if (command === 'display-message -p -t %1 #{alternate_on}') {
            return { exitCode: 0, stdout: '0\n', stderr: '' };
          }
          if (command === 'capture-pane -t %1 -S - -E - -e -N -p') {
            return { exitCode: 0, stdout: 'history\n', stderr: '' };
          }
          if (command === 'capture-pane -t %1 -a -S - -E - -e -N -p -q') {
            return { exitCode: 0, stdout: '', stderr: '' };
          }
          throw new Error(`unexpected command: ${argv.join(' ')}`);
        },
      }
    );
    (connection as any).syncPipeReaders = async () => {};
    (connection as any).startPipeForPane = async () => {
      startPipeCalls += 1;
    };

    await connection.connect();
    connection.selectPane('@1', '%1');
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(startPipeCalls).toBe(0);
  });

  test('syncPipeReaders starts every pane from snapshot and stops stale readers', async () => {
    const connection = new LocalExternalTmuxConnection(
      {
        deviceId: 'device-local',
        onEvent: () => {},
        onTerminalOutput: () => {},
        onTerminalHistory: () => {},
        onSnapshot: () => {},
        onError: (error) => {
          throw error;
        },
        onClose: () => {},
      },
      {
        enableHooks: false,
        getDevice: () => createDevice('tmex-sync-readers'),
        run: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      }
    );
    const started: string[] = [];
    const stopped: string[] = [];

    (connection as any).snapshotWindows = new Map([
      [
        '@1',
        {
          id: '@1',
          name: 'main',
          index: 0,
          active: true,
          panes: [
            { id: '%1', windowId: '@1', index: 0, active: true, width: 80, height: 24 },
            { id: '%2', windowId: '@1', index: 1, active: false, width: 80, height: 24 },
          ],
        },
      ],
    ]);
    (connection as any).paneReaders.set('%stale', {
      paneId: '%stale',
      fifoPath: '/tmp/stale',
      stopReader: () => {},
    });
    (connection as any).startPipeForPaneNow = async (paneId: string) => {
      started.push(paneId);
      (connection as any).paneReaders.set(paneId, {
        paneId,
        fifoPath: `/tmp/${paneId}`,
        stopReader: () => {},
      });
    };
    (connection as any).stopPipeForPaneNow = async (paneId: string) => {
      stopped.push(paneId);
      (connection as any).paneReaders.delete(paneId);
    };

    await (connection as any).syncPipeReaders();

    expect(stopped).toEqual(['%stale']);
    expect(started).toEqual(['%1', '%2']);
  });

  test('hook bell lines should not emit bell events', () => {
    const events: Array<{ type: string; data?: unknown }> = [];
    const connection = new LocalExternalTmuxConnection(
      {
        deviceId: 'device-local',
        onEvent: (event) => {
          events.push(event);
        },
        onTerminalOutput: () => {},
        onTerminalHistory: () => {},
        onSnapshot: () => {},
        onError: (error) => {
          throw error;
        },
        onClose: () => {},
      },
      {
        enableHooks: true,
        getDevice: () => createDevice('tmex-hook-bell'),
        run: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      }
    );

    (connection as any).handleHookChunk('bell\t@1\t%1\n');

    expect(events).toEqual([]);
  });

  test('requestSnapshot emits parsed session/windows/panes', async () => {
    const snapshots: StateSnapshotPayload[] = [];
    const calls: string[][] = [];
    const connection = new LocalExternalTmuxConnection(
      {
        deviceId: 'device-local',
        onEvent: () => {},
        onTerminalOutput: () => {},
        onTerminalHistory: () => {},
        onSnapshot: (payload) => snapshots.push(payload),
        onError: (error) => {
          throw error;
        },
        onClose: () => {},
      },
      {
        enableHooks: false,
        getDevice: () => createDevice('tmex-snapshot'),
        run: async (argv) => {
          calls.push(argv);
          const command = argv.slice(1).join(' ');
          if (command === 'has-session -t tmex-snapshot') {
            return { exitCode: 1, stdout: '', stderr: "can't find session: tmex-snapshot" };
          }
          if (command === 'new-session -d -c /Users/krhougs -s tmex-snapshot') {
            return { exitCode: 0, stdout: '', stderr: '' };
          }
          if (isConfigureSessionOptionCommand(command, 'tmex-snapshot')) {
            return { exitCode: 0, stdout: '', stderr: '' };
          }
          if (command.startsWith('display-message -p -t tmex-snapshot #{session_id}')) {
            return { exitCode: 0, stdout: '$1\ttmex-snapshot\n', stderr: '' };
          }
          if (command.startsWith('list-windows -t tmex-snapshot')) {
            return {
              exitCode: 0,
              stdout: '@1\t0\tmain\t1\n',
              stderr: '',
            };
          }
          if (command.startsWith('list-panes -t tmex-snapshot')) {
            return {
              exitCode: 0,
              stdout: '%1\t@1\t0\tbash\t1\t80\t24\n',
              stderr: '',
            };
          }
          throw new Error(`unexpected command: ${argv.join(' ')}`);
        },
      }
    );
    (connection as any).syncPipeReaders = async () => {};

    await connection.connect();

    expect(calls.map((argv) => argv.join(' '))).toEqual([
      'tmux has-session -t tmex-snapshot',
      'tmux new-session -d -c /Users/krhougs -s tmex-snapshot',
      'tmux set-option -t tmex-snapshot -s allow-passthrough off',
      'tmux set-option -t tmex-snapshot -g extended-keys on',
      'tmux set-option -t tmex-snapshot -s extended-keys-format csi-u',
      'tmux set-option -t tmex-snapshot -g focus-events on',
      'tmux display-message -p -t tmex-snapshot #{session_id}\t#{session_name}',
      'tmux list-windows -t tmex-snapshot -F #{window_id}\t#{window_index}\t#{window_name}\t#{window_active}',
      'tmux list-panes -t tmex-snapshot -F #{pane_id}\t#{window_id}\t#{pane_index}\t#{pane_title}\t#{pane_active}\t#{pane_width}\t#{pane_height}',
    ]);
    expect(snapshots).toEqual([
      {
        deviceId: 'device-local',
        session: {
          id: '$1',
          name: 'tmex-snapshot',
          windows: [
            {
              id: '@1',
              index: 0,
              name: 'main',
              active: true,
              panes: [
                {
                  id: '%1',
                  windowId: '@1',
                  index: 0,
                  title: 'bash',
                  active: true,
                  width: 80,
                  height: 24,
                },
              ],
            },
          ],
        },
      },
    ]);
  });

  test('sendInput encodes payload as tmux send-keys -H chunks', async () => {
    const commands: string[][] = [];
    const connection = new LocalExternalTmuxConnection(
      {
        deviceId: 'device-local',
        onEvent: () => {},
        onTerminalOutput: () => {},
        onTerminalHistory: () => {},
        onSnapshot: () => {},
        onError: (error) => {
          throw error;
        },
        onClose: () => {},
      },
      {
        enableHooks: false,
        getDevice: () => createDevice('tmex-input'),
        run: async (argv) => {
          commands.push(argv);
          const command = argv.slice(1).join(' ');
          if (command === 'has-session -t tmex-input') {
            return { exitCode: 1, stdout: '', stderr: "can't find session: tmex-input" };
          }
          if (command === 'new-session -d -c /Users/krhougs -s tmex-input') {
            return { exitCode: 0, stdout: '', stderr: '' };
          }
          if (isConfigureSessionOptionCommand(command, 'tmex-input')) {
            return { exitCode: 0, stdout: '', stderr: '' };
          }
          if (command.startsWith('display-message -p -t tmex-input #{session_id}')) {
            return { exitCode: 0, stdout: '$1\ttmex-input\n', stderr: '' };
          }
          if (command.startsWith('list-windows -t tmex-input')) {
            return { exitCode: 0, stdout: '@1\t0\tmain\t1\n', stderr: '' };
          }
          if (command.startsWith('list-panes -t tmex-input')) {
            return { exitCode: 0, stdout: '%1\t@1\t0\tbash\t1\t80\t24\n', stderr: '' };
          }
          if (command.startsWith('send-keys -H -t %1')) {
            return { exitCode: 0, stdout: '', stderr: '' };
          }
          throw new Error(`unexpected command: ${argv.join(' ')}`);
        },
      }
    );
    (connection as any).syncPipeReaders = async () => {};

    await connection.connect();
    connection.sendInput('%1', 'A中');

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(commands.at(-1)).toEqual([
      'tmux',
      'send-keys',
      '-H',
      '-t',
      '%1',
      '41',
      'e4',
      'b8',
      'ad',
    ]);
  });

  test('sendInput serializes tmux send-keys calls to preserve character order', async () => {
    const commands: string[][] = [];
    const sendResolvers: Array<() => void> = [];
    const connection = new LocalExternalTmuxConnection(
      {
        deviceId: 'device-local',
        onEvent: () => {},
        onTerminalOutput: () => {},
        onTerminalHistory: () => {},
        onSnapshot: () => {},
        onError: (error) => {
          throw error;
        },
        onClose: () => {},
      },
      {
        enableHooks: false,
        getDevice: () => createDevice('tmex-input-serial'),
        run: async (argv) => {
          commands.push(argv);
          const command = argv.slice(1).join(' ');
          if (command === 'has-session -t tmex-input-serial') {
            return { exitCode: 1, stdout: '', stderr: "can't find session: tmex-input-serial" };
          }
          if (command === 'new-session -d -c /Users/krhougs -s tmex-input-serial') {
            return { exitCode: 0, stdout: '', stderr: '' };
          }
          if (isConfigureSessionOptionCommand(command, 'tmex-input-serial')) {
            return { exitCode: 0, stdout: '', stderr: '' };
          }
          if (command.startsWith('display-message -p -t tmex-input-serial #{session_id}')) {
            return { exitCode: 0, stdout: '$1\ttmex-input-serial\n', stderr: '' };
          }
          if (command.startsWith('list-windows -t tmex-input-serial')) {
            return { exitCode: 0, stdout: '@1\t0\tmain\t1\n', stderr: '' };
          }
          if (command.startsWith('list-panes -t tmex-input-serial')) {
            return { exitCode: 0, stdout: '%1\t@1\t0\tbash\t1\t80\t24\n', stderr: '' };
          }
          if (command === 'send-keys -H -t %1 41' || command === 'send-keys -H -t %1 42') {
            await new Promise<void>((resolve) => {
              sendResolvers.push(resolve);
            });
            return { exitCode: 0, stdout: '', stderr: '' };
          }
          throw new Error(`unexpected command: ${argv.join(' ')}`);
        },
      }
    );
    (connection as any).syncPipeReaders = async () => {};

    await connection.connect();
    connection.sendInput('%1', 'A');
    connection.sendInput('%1', 'B');

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(commands.map((argv) => argv.slice(1).join(' '))).toContain('send-keys -H -t %1 41');
    expect(commands.map((argv) => argv.slice(1).join(' '))).not.toContain('send-keys -H -t %1 42');

    sendResolvers.shift()?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(commands.map((argv) => argv.slice(1).join(' '))).toContain('send-keys -H -t %1 42');

    sendResolvers.shift()?.();
  });

  test('connect keeps sibling runtime dirs that belong to another gateway instance', async () => {
    const deviceId = `device local cleanup ${Date.now()}`;
    const safeDeviceId = toSafePathSegment(deviceId);
    const foreignRuntimeDir = join('/tmp/tmex', `${safeDeviceId}-foreign-runtime`);
    mkdirSync(foreignRuntimeDir, { recursive: true, mode: 0o700 });

    const connection = new LocalExternalTmuxConnection(
      {
        deviceId,
        onEvent: () => {},
        onTerminalOutput: () => {},
        onTerminalHistory: () => {},
        onSnapshot: () => {},
        onError: (error) => {
          throw error;
        },
        onClose: () => {},
      },
      {
        enableHooks: false,
        getDevice: () => ({ ...createDevice('tmex-cleanup-safe'), id: deviceId }),
        run: async (argv) => {
          const command = argv.slice(1).join(' ');
          if (command === 'has-session -t tmex-cleanup-safe') {
            return { exitCode: 1, stdout: '', stderr: "can't find session: tmex-cleanup-safe" };
          }
          if (command === 'new-session -d -c /Users/krhougs -s tmex-cleanup-safe') {
            return { exitCode: 0, stdout: '', stderr: '' };
          }
          if (isConfigureSessionOptionCommand(command, 'tmex-cleanup-safe')) {
            return { exitCode: 0, stdout: '', stderr: '' };
          }
          if (command.startsWith('display-message -p -t tmex-cleanup-safe #{session_id}')) {
            return { exitCode: 0, stdout: '$1\ttmex-cleanup-safe\n', stderr: '' };
          }
          if (command.startsWith('list-windows -t tmex-cleanup-safe')) {
            return { exitCode: 0, stdout: '@1\t0\tmain\t1\n', stderr: '' };
          }
          if (command.startsWith('list-panes -t tmex-cleanup-safe')) {
            return { exitCode: 0, stdout: '%1\t@1\t0\tbash\t1\t80\t24\n', stderr: '' };
          }
          throw new Error(`unexpected command: ${argv.join(' ')}`);
        },
      }
    );
    (connection as any).syncPipeReaders = async () => {};

    try {
      await connection.connect();
      expect(existsSync(foreignRuntimeDir)).toBe(true);
    } finally {
      connection.disconnect();
      rmSync(foreignRuntimeDir, { recursive: true, force: true });
    }
  });

  test('resizePane keeps window-size in manual mode instead of forcing latest', async () => {
    const commands: string[][] = [];
    const connection = new LocalExternalTmuxConnection(
      {
        deviceId: 'device-local',
        onEvent: () => {},
        onTerminalOutput: () => {},
        onTerminalHistory: () => {},
        onSnapshot: () => {},
        onError: (error) => {
          throw error;
        },
        onClose: () => {},
      },
      {
        enableHooks: false,
        getDevice: () => createDevice('tmex-resize'),
        run: async (argv) => {
          commands.push(argv);
          const command = argv.slice(1).join(' ');
          if (command === 'has-session -t tmex-resize') {
            return { exitCode: 1, stdout: '', stderr: "can't find session: tmex-resize" };
          }
          if (command === 'new-session -d -c /Users/krhougs -s tmex-resize') {
            return { exitCode: 0, stdout: '', stderr: '' };
          }
          if (isConfigureSessionOptionCommand(command, 'tmex-resize')) {
            return { exitCode: 0, stdout: '', stderr: '' };
          }
          if (command.startsWith('display-message -p -t tmex-resize #{session_id}')) {
            return { exitCode: 0, stdout: '$1\ttmex-resize\n', stderr: '' };
          }
          if (command.startsWith('list-windows -t tmex-resize')) {
            return { exitCode: 0, stdout: '@1\t0\tmain\t1\n', stderr: '' };
          }
          if (command.startsWith('list-panes -t tmex-resize')) {
            return { exitCode: 0, stdout: '%1\t@1\t0\tbash\t1\t80\t24\n', stderr: '' };
          }
          if (command === 'resize-window -t @1 -x 137 -y 41') {
            return { exitCode: 0, stdout: '', stderr: '' };
          }
          throw new Error(`unexpected command: ${argv.join(' ')}`);
        },
      }
    );
    (connection as any).syncPipeReaders = async () => {};

    await connection.connect();
    connection.resizePane('%1', 137, 41);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(commands.map((argv) => argv.slice(1).join(' '))).not.toContain(
      'set-window-option -t @1 window-size latest'
    );
  });

  test('capturePaneHistory falls back to normal capture when alternate capture is visually empty', async () => {
    const histories: Array<{ paneId: string; data: string; alternateScreen: boolean }> = [];
    const connection = new LocalExternalTmuxConnection(
      {
        deviceId: 'device-local',
        onEvent: () => {},
        onTerminalOutput: () => {},
        onTerminalHistory: (paneId, data, alternateScreen) => {
          histories.push({ paneId, data, alternateScreen });
        },
        onSnapshot: () => {},
        onError: (error) => {
          throw error;
        },
        onClose: () => {},
      },
      {
        enableHooks: false,
        getDevice: () => createDevice('tmex-alt-fallback'),
        run: async (argv) => {
          const command = argv.slice(1).join(' ');
          if (command === "display-message -p -t %1 #{alternate_on}") {
            return { exitCode: 0, stdout: '1\n', stderr: '' };
          }
          if (command === 'capture-pane -t %1 -S - -E - -e -N -p') {
            return { exitCode: 0, stdout: 'VIM SCREEN\n', stderr: '' };
          }
          if (command === 'capture-pane -t %1 -a -S - -E - -e -N -p -q') {
            return { exitCode: 0, stdout: '\n\n\n', stderr: '' };
          }
          throw new Error(`unexpected command: ${command}`);
        },
      }
    );

    await (connection as any).capturePaneHistory('%1');

    expect(histories).toEqual([
      {
        paneId: '%1',
        data: 'VIM SCREEN\n',
        alternateScreen: true,
      },
    ]);
  });

  test('capturePaneHistory prefers current visible capture when pane is in alternate screen', async () => {
    const histories: Array<{ paneId: string; data: string; alternateScreen: boolean }> = [];
    const connection = new LocalExternalTmuxConnection(
      {
        deviceId: 'device-local',
        onEvent: () => {},
        onTerminalOutput: () => {},
        onTerminalHistory: (paneId, data, alternateScreen) => {
          histories.push({ paneId, data, alternateScreen });
        },
        onSnapshot: () => {},
        onError: (error) => {
          throw error;
        },
        onClose: () => {},
      },
      {
        enableHooks: false,
        getDevice: () => createDevice('tmex-alt-visible'),
        run: async (argv) => {
          const command = argv.slice(1).join(' ');
          if (command === "display-message -p -t %1 #{alternate_on}") {
            return { exitCode: 0, stdout: '1\n', stderr: '' };
          }
          if (command === 'capture-pane -t %1 -S - -E - -e -N -p') {
            return { exitCode: 0, stdout: 'VISIBLE TUI\n', stderr: '' };
          }
          if (command === 'capture-pane -t %1 -a -S - -E - -e -N -p -q') {
            return { exitCode: 0, stdout: 'sh-3.2$ opencode .\n', stderr: '' };
          }
          throw new Error(`unexpected command: ${command}`);
        },
      }
    );

    await (connection as any).capturePaneHistory('%1');

    expect(histories).toEqual([
      {
        paneId: '%1',
        data: 'VISIBLE TUI\n',
        alternateScreen: true,
      },
    ]);
  });
});
