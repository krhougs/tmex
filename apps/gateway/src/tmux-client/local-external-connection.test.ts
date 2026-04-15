import { describe, expect, test } from 'bun:test';
import type { Device, StateSnapshotPayload } from '@tmex/shared';

import {
  LocalExternalTmuxConnection,
  shouldIgnoreReaderAbortError,
} from './local-external-connection';

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

    await connection.connect();

    expect(calls.map((argv) => argv.join(' '))).toEqual([
      'tmux has-session -t tmex-snapshot',
      'tmux new-session -d -c /Users/krhougs -s tmex-snapshot',
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

    await connection.connect();
    connection.resizePane('%1', 137, 41);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(commands.map((argv) => argv.slice(1).join(' '))).not.toContain(
      'set-window-option -t @1 window-size latest'
    );
  });
});
