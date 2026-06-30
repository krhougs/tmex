import { beforeAll, describe, expect, spyOn, test } from 'bun:test';
import type { Device, StateSnapshotPayload } from '@tmex/shared';

import { createDevice as createDeviceRow, getDeviceRuntimeStatus } from '../db';
import { runMigrations } from '../db/migrate';
import type { TmuxEvent } from './events';
import {
  type ControlClientProcess,
  LocalExternalTmuxConnection,
  shouldIgnoreReaderAbortError,
} from './local-external-connection';
import { TmuxTargetMissingError } from './target-missing';

const now = '2026-04-14T00:00:00.000Z';
const encoder = new TextEncoder();

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function ok(stdout = ''): CommandResult {
  return { exitCode: 0, stdout, stderr: '' };
}

function createDevice(session = 'tmex-test'): Device {
  return {
    id: 'device-local',
    name: 'local',
    type: 'local',
    authMode: 'auto',
    session,
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
  };
}

function isConfigureSessionOptionCommand(command: string, session: string): boolean {
  return (
    command === `set-option -t ${session} -s allow-passthrough off` ||
    command === `set-option -t ${session} -g extended-keys on` ||
    command === `set-option -t ${session} -s extended-keys-format csi-u` ||
    command === `set-option -t ${session} -g focus-events off` ||
    command === `set-option -t ${session} destroy-unattached off` ||
    command === `set-environment -t ${session} TERM_PROGRAM ghostty` ||
    command === `set-environment -t ${session} COLORTERM truecolor` ||
    command.startsWith(`set-option -t ${session} default-path `) ||
    command ===
      `set-hook -t ${session} after-new-window set-option -w window-style 'fg=#d0d0d0,bg=#262626'` ||
    command === 'set-option -w -t @1 window-style fg=#d0d0d0,bg=#262626'
  );
}

function createRunStub(
  session: string,
  options: {
    record?: string[][];
    overrides?: (command: string) => CommandResult | null;
  } = {}
) {
  return async (argv: string[]): Promise<CommandResult> => {
    options.record?.push(argv);
    const command = argv.slice(1).join(' ');
    const overridden = options.overrides?.(command);
    if (overridden) {
      return overridden;
    }
    if (command === '-V') {
      return ok('tmux 3.4\n');
    }
    if (command === `has-session -t ${session}`) {
      return ok();
    }
    if (command === `new-window -t ${session} -n tmex-park -P -F #{window_id} sleep 30`) {
      return ok('@99\n');
    }
    if (command.startsWith(`new-window -t ${session} -c `) || command.startsWith(`new-window -d -t ${session} -c `)) {
      return ok();
    }
    if (command === `last-window -t ${session}` || command === 'kill-window -t @99') {
      return ok();
    }
    if (
      isConfigureSessionOptionCommand(command, session) ||
      command === `set-option -t ${session} default-terminal xterm-ghostty`
    ) {
      return ok();
    }
    if (command.startsWith(`display-message -p -t ${session} #{session_id}`)) {
      return ok(`$1|${session}\n`);
    }
    if (command === `list-windows -t ${session} -F #{window_id}`) {
      return ok('@1\n');
    }
    if (command.startsWith(`list-windows -t ${session}`)) {
      return ok('@1|0|main|1\n');
    }
    if (command.startsWith(`list-panes -s -t ${session}`)) {
      return ok('%1|@1|0|bash|1|80|24|1|node|/home/user\n');
    }
    throw new Error(`unexpected command: ${argv.join(' ')}`);
  };
}

interface FakeControlProcess {
  proc: ControlClientProcess;
  pushStdout: (text: string) => void;
  closeStdout: () => void;
  exit: (code: number) => void;
  killed: () => boolean;
  writtenData: string[];
}

function createFakeControlProcess(): FakeControlProcess {
  let stdoutController!: ReadableStreamDefaultController<Uint8Array>;
  let stderrController!: ReadableStreamDefaultController<Uint8Array>;
  let exitResolve!: (code: number) => void;
  let killed = false;
  let closed = false;
  const writtenData: string[] = [];

  const close = (code: number) => {
    if (closed) {
      return;
    }
    closed = true;
    try {
      stdoutController.close();
    } catch {
      /* already closed */
    }
    try {
      stderrController.close();
    } catch {
      /* already closed */
    }
    exitResolve(code);
  };

  return {
    proc: {
      stdout: new ReadableStream<Uint8Array>({
        start(controller) {
          stdoutController = controller;
        },
      }),
      stderr: new ReadableStream<Uint8Array>({
        start(controller) {
          stderrController = controller;
        },
      }),
      exited: new Promise<number>((resolve) => {
        exitResolve = resolve;
      }),
      kill: () => {
        killed = true;
        close(0);
      },
      write: (data: string) => {
        writtenData.push(data);
      },
    },
    pushStdout: (text) => stdoutController.enqueue(encoder.encode(text)),
    closeStdout: () => {
      try {
        stdoutController.close();
      } catch {
        /* already closed */
      }
    },
    exit: (code) => close(code),
    killed: () => killed,
    writtenData,
  };
}

async function waitFor<T>(fn: () => T | null | undefined, timeoutMs = 3000): Promise<T> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = fn();
    if (value !== null && value !== undefined) {
      return value;
    }
    await Bun.sleep(10);
  }
  throw new Error('waitFor timeout');
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

  test('connect runs exact command sequence with control-mode session options', async () => {
    const calls: string[][] = [];
    const snapshots: StateSnapshotPayload[] = [];
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
        enableSubscription: false,
        ensureGhosttyTerminfo: async () => false,
        getDevice: () => createDevice('tmex-snapshot'),
        run: createRunStub('tmex-snapshot', {
          record: calls,
          overrides: (command) => {
            if (command === 'has-session -t tmex-snapshot') {
              return { exitCode: 1, stdout: '', stderr: "can't find session: tmex-snapshot" };
            }
            if (command === 'new-session -d -c /Users/krhougs -s tmex-snapshot') {
              return ok();
            }
            return null;
          },
        }),
      }
    );

    await connection.connect();

    const homedir = require('node:os').homedir();
    expect(calls.map((argv) => argv.join(' '))).toEqual([
      'tmux has-session -t tmex-snapshot',
      `tmux new-session -d -c ${homedir} -s tmex-snapshot`,
      'tmux set-option -t tmex-snapshot -s allow-passthrough off',
      'tmux set-option -t tmex-snapshot -g extended-keys on',
      'tmux set-option -t tmex-snapshot -s extended-keys-format csi-u',
      'tmux set-option -t tmex-snapshot -g focus-events off',
      'tmux set-option -t tmex-snapshot destroy-unattached off',
      'tmux set-environment -t tmex-snapshot TERM_PROGRAM ghostty',
      'tmux set-environment -t tmex-snapshot COLORTERM truecolor',
      `tmux set-option -t tmex-snapshot default-path ${homedir}`,
      "tmux set-hook -t tmex-snapshot after-new-window set-option -w window-style 'fg=#d0d0d0,bg=#262626'",
      'tmux list-windows -t tmex-snapshot -F #{window_id}',
      'tmux set-option -w -t @1 window-style fg=#d0d0d0,bg=#262626',
      'tmux display-message -p -t tmex-snapshot #{session_id}|#{session_name}',
      'tmux list-windows -t tmex-snapshot -F #{window_id}|#{window_index}|#{window_name}|#{window_active}',
      'tmux list-panes -s -t tmex-snapshot -F #{pane_id}|#{window_id}|#{pane_index}|#{pane_title}|#{pane_active}|#{pane_width}|#{pane_height}|#{window_active}|#{pane_current_command}|#{pane_current_path}',
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
                  currentCommand: 'node',
                  currentPath: '/home/user',
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

  test('drops LANG=C underscore-rendered snapshot rows instead of emitting composite window ids', async () => {
    const session = 'tmex-lang-c';
    const snapshots: StateSnapshotPayload[] = [];
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
        enableSubscription: false,
        ensureGhosttyTerminfo: async () => false,
        getDevice: () => createDevice(session),
        run: createRunStub(session, {
          overrides: (command) => {
            if (command === `display-message -p -t ${session} #{session_id}|#{session_name}`) {
              return ok(`$1_${session}\n`);
            }
            if (
              command ===
              `list-windows -t ${session} -F #{window_id}|#{window_index}|#{window_name}|#{window_active}`
            ) {
              return ok('@0_0_bash_1\n');
            }
            if (
              command ===
              `list-panes -s -t ${session} -F #{pane_id}|#{window_id}|#{pane_index}|#{pane_title}|#{pane_active}|#{pane_width}|#{pane_height}|#{window_active}|#{pane_current_command}|#{pane_current_path}`
            ) {
              return ok('%1_@0_0_bash_1_80_24_1_node_/home/user\n');
            }
            return null;
          },
        }),
      }
    );

    await connection.connect();

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toEqual({ deviceId: 'device-local', session: null });
    expect(JSON.stringify(snapshots[0])).not.toContain('@0_0_bash_1');
  });

  test('connect rejects when tmux is too old for control mode', async () => {
    const connection = new LocalExternalTmuxConnection(
      {
        deviceId: 'device-local',
        onEvent: () => {},
        onTerminalOutput: () => {},
        onTerminalHistory: () => {},
        onSnapshot: () => {},
        onError: () => {},
        onClose: () => {},
      },
      {
        enableSubscription: true,
        ensureGhosttyTerminfo: async () => false,
        getDevice: () => createDevice('tmex-version'),
        run: createRunStub('tmex-version', {
          overrides: (command) => (command === '-V' ? ok('tmux 2.9a\n') : null),
        }),
        spawnControlClient: () => {
          throw new Error('should not spawn control client on old tmux');
        },
      }
    );

    await expect(connection.connect()).rejects.toThrow(/control mode requires tmux >= 3.0/);
  });

  test('control client subscription streams output, bell and notifications', async () => {
    const fake = createFakeControlProcess();
    const outputs: Array<{ paneId: string; text: string }> = [];
    const events: TmuxEvent[] = [];
    let snapshotCount = 0;

    const connection = new LocalExternalTmuxConnection(
      {
        deviceId: 'device-local',
        onEvent: (event) => {
          events.push(event);
        },
        onTerminalOutput: (paneId, data) => {
          outputs.push({ paneId, text: new TextDecoder().decode(data) });
        },
        onTerminalHistory: () => {},
        onSnapshot: () => {
          snapshotCount += 1;
        },
        onError: (error) => {
          throw error;
        },
        onClose: () => {},
      },
      {
        enableSubscription: true,
        ensureGhosttyTerminfo: async () => false,
        getDevice: () => createDevice('tmex-stream'),
        run: createRunStub('tmex-stream'),
        spawnControlClient: (argv) => {
          expect(argv).toEqual(['tmux', '-C', 'attach-session', '-t', 'tmex-stream']);
          fake.pushStdout('%begin 1 1 0\n%end 1 1 0\n%session-changed $1 tmex-stream\n');
          return fake.proc;
        },
      }
    );

    await connection.connect();
    const baseSnapshots = snapshotCount;

    fake.pushStdout('%output %1 hello\\015\\012\n');
    fake.pushStdout('%output %1 \\007\n');
    fake.pushStdout('%output %1 \\033]9;notify body\\007\n');

    await waitFor(() => (outputs.length > 0 ? outputs : null));
    expect(outputs).toEqual([{ paneId: '%1', text: 'hello\r\n' }]);

    await waitFor(() => events.find((event) => event.type === 'bell') ?? null);
    const notification = await waitFor(
      () => events.find((event) => event.type === 'notification') ?? null
    );
    expect(notification.data).toEqual({
      paneId: '%1',
      source: 'osc9',
      body: 'notify body',
    });

    fake.pushStdout('%window-add @2\n');
    await waitFor(() => (snapshotCount > baseSnapshots ? snapshotCount : null));

    connection.disconnect();
    expect(fake.killed()).toBe(true);
  });

  test('control client restarts after unexpected exit and resyncs snapshot', async () => {
    const fakes: FakeControlProcess[] = [];
    let snapshotCount = 0;

    const connection = new LocalExternalTmuxConnection(
      {
        deviceId: 'device-local',
        onEvent: () => {},
        onTerminalOutput: () => {},
        onTerminalHistory: () => {},
        onSnapshot: () => {
          snapshotCount += 1;
        },
        onError: () => {},
        onClose: () => {},
      },
      {
        enableSubscription: true,
        ensureGhosttyTerminfo: async () => false,
        getDevice: () => createDevice('tmex-restart'),
        run: createRunStub('tmex-restart'),
        spawnControlClient: () => {
          const fake = createFakeControlProcess();
          fake.pushStdout('%begin 1 1 0\n%end 1 1 0\n%session-changed $1 tmex-restart\n');
          fakes.push(fake);
          return fake.proc;
        },
      }
    );

    await connection.connect();
    expect(fakes).toHaveLength(1);

    const baseSnapshots = snapshotCount;
    fakes[0]?.exit(1);

    await waitFor(() => (fakes.length === 2 ? fakes : null));
    await waitFor(() => (snapshotCount > baseSnapshots ? snapshotCount : null));

    connection.disconnect();
  }, 10_000);

  test('control client exit tears down when session is gone', async () => {
    const fakes: FakeControlProcess[] = [];
    let closed = false;
    let sessionGone = false;

    const connection = new LocalExternalTmuxConnection(
      {
        deviceId: 'device-local',
        onEvent: () => {},
        onTerminalOutput: () => {},
        onTerminalHistory: () => {},
        onSnapshot: () => {},
        onError: () => {},
        onClose: () => {
          closed = true;
        },
      },
      {
        enableSubscription: true,
        ensureGhosttyTerminfo: async () => false,
        getDevice: () => createDevice('tmex-gone'),
        run: createRunStub('tmex-gone', {
          overrides: (command) => {
            if (sessionGone && command === 'has-session -t tmex-gone') {
              return { exitCode: 1, stdout: '', stderr: "can't find session: tmex-gone" };
            }
            if (sessionGone && command.startsWith('display-message -p -t tmex-gone')) {
              return { exitCode: 1, stdout: '', stderr: "can't find session: tmex-gone" };
            }
            if (sessionGone && command.startsWith('list-windows -t tmex-gone')) {
              return { exitCode: 1, stdout: '', stderr: "can't find session: tmex-gone" };
            }
            if (sessionGone && command.startsWith('list-panes -s -t tmex-gone')) {
              return { exitCode: 1, stdout: '', stderr: "can't find session: tmex-gone" };
            }
            return null;
          },
        }),
        spawnControlClient: () => {
          const fake = createFakeControlProcess();
          fake.pushStdout('%begin 1 1 0\n%end 1 1 0\n%session-changed $1 tmex-gone\n');
          fakes.push(fake);
          return fake.proc;
        },
      }
    );

    await connection.connect();
    sessionGone = true;
    fakes[0]?.exit(1);

    await waitFor(() => (closed ? true : null));
    expect(fakes).toHaveLength(1);
  }, 10_000);

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
        enableSubscription: false,
        ensureGhosttyTerminfo: async () => false,
        getDevice: () => createDevice('tmex-input'),
        run: createRunStub('tmex-input', {
          record: commands,
          overrides: (command) =>
            command.startsWith('send-keys -H -t %1') ? ok() : null,
        }),
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
        enableSubscription: false,
        ensureGhosttyTerminfo: async () => false,
        getDevice: () => createDevice('tmex-input-serial'),
        run: async (argv) => {
          commands.push(argv);
          const command = argv.slice(1).join(' ');
          if (command === 'send-keys -H -t %1 41' || command === 'send-keys -H -t %1 42') {
            await new Promise<void>((resolve) => {
              sendResolvers.push(resolve);
            });
            return ok();
          }
          return createRunStub('tmex-input-serial')(argv);
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

  test('selectWindow treats missing window targets as benign and refreshes snapshot', async () => {
    const session = 'tmex-select-window-missing';
    const calls: string[][] = [];
    const errors: Error[] = [];
    const connection = new LocalExternalTmuxConnection(
      {
        deviceId: 'device-local',
        onEvent: () => {},
        onTerminalOutput: () => {},
        onTerminalHistory: () => {},
        onSnapshot: () => {},
        onError: (error) => {
          errors.push(error);
        },
        onClose: () => {},
      },
      {
        enableSubscription: false,
        ensureGhosttyTerminfo: async () => false,
        getDevice: () => createDevice(session),
        run: createRunStub(session, {
          record: calls,
          overrides: (command) =>
            command === 'select-window -t @404'
              ? { exitCode: 1, stdout: '', stderr: "can't find window: @404" }
              : null,
        }),
      }
    );

    await connection.connect();
    calls.length = 0;

    connection.selectWindow('@404');
    await waitFor(() =>
      errors.length > 0 ||
      calls.some((argv) => argv.slice(1).join(' ').startsWith(`display-message -p -t ${session}`))
        ? true
        : null
    );

    expect(errors).toEqual([]);
    expect(calls.map((argv) => argv.join(' '))).toContain('tmux select-window -t @404');
    expect(
      calls.some((argv) => argv.slice(1).join(' ').startsWith(`display-message -p -t ${session}`))
    ).toBe(true);
  });

  test('logs tmux command context when a non-target-missing command fails', async () => {
    const session = 'tmex-command-context';
    const errors: Error[] = [];
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    const connection = new LocalExternalTmuxConnection(
      {
        deviceId: 'device-local',
        onEvent: () => {},
        onTerminalOutput: () => {},
        onTerminalHistory: () => {},
        onSnapshot: () => {},
        onError: (error) => {
          errors.push(error);
        },
        onClose: () => {},
      },
      {
        enableSubscription: false,
        ensureGhosttyTerminfo: async () => false,
        getDevice: () => createDevice(session),
        run: createRunStub(session, {
          overrides: (command) =>
            command === 'rename-window -t @1 broken'
              ? { exitCode: 1, stdout: '', stderr: 'rename failed' }
              : null,
        }),
      }
    );

    try {
      await connection.connect();
      connection.renameWindow('@1', 'broken');
      await waitFor(() => (errors.length > 0 ? true : null));

      expect(
        warn.mock.calls.some((call) => {
          const text = call.map(String).join(' ');
          return (
            text.includes('[local] tmux command failed') &&
            text.includes('device-local') &&
            text.includes(session) &&
            text.includes('rename-window -t @1 broken') &&
            text.includes('exitCode=1')
          );
        })
      ).toBe(true);
    } finally {
      warn.mockRestore();
      connection.disconnect();
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
        enableSubscription: false,
        ensureGhosttyTerminfo: async () => false,
        getDevice: () => createDevice('tmex-resize'),
        run: createRunStub('tmex-resize', {
          record: commands,
          overrides: (command) =>
            command === 'resize-window -t @1 -x 137 -y 41' ? ok() : null,
        }),
      }
    );

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
        enableSubscription: false,
        ensureGhosttyTerminfo: async () => false,
        getDevice: () => createDevice('tmex-alt-fallback'),
        run: async (argv) => {
          const command = argv.slice(1).join(' ');
          if (
            command ===
            'display-message -p -t %1 #{alternate_on} #{cursor_x} #{cursor_y} #{pane_height}'
          ) {
            return ok('1 8 3 40\n');
          }
          if (command === 'capture-pane -t %1 -S - -E - -e -J -N -p') {
            return ok('VIM SCREEN\n');
          }
          if (command === 'capture-pane -t %1 -a -S - -E - -e -J -N -p -q') {
            return ok('\n\n\n');
          }
          throw new Error(`unexpected command: ${command}`);
        },
      }
    );

    await (connection as any).capturePaneHistory('%1');

    expect(histories).toEqual([
      {
        paneId: '%1',
        data: 'VIM SCREEN\x1b[4;9H',
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
        enableSubscription: false,
        ensureGhosttyTerminfo: async () => false,
        getDevice: () => createDevice('tmex-alt-visible'),
        run: async (argv) => {
          const command = argv.slice(1).join(' ');
          if (
            command ===
            'display-message -p -t %1 #{alternate_on} #{cursor_x} #{cursor_y} #{pane_height}'
          ) {
            return ok('1 2 1 40\n');
          }
          if (command === 'capture-pane -t %1 -S - -E - -e -J -N -p') {
            return ok('VISIBLE TUI\n');
          }
          if (command === 'capture-pane -t %1 -a -S - -E - -e -J -N -p -q') {
            return ok('sh-3.2$ opencode .\n');
          }
          throw new Error(`unexpected command: ${command}`);
        },
      }
    );

    await (connection as any).capturePaneHistory('%1');

    expect(histories).toEqual([
      {
        paneId: '%1',
        data: 'VISIBLE TUI\x1b[2;3H',
        alternateScreen: true,
      },
    ]);
  });

  test('capturePaneHistory appends relative cursor restore for normal screen', async () => {
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
        enableSubscription: false,
        ensureGhosttyTerminfo: async () => false,
        getDevice: () => createDevice('tmex-normal-cursor'),
        run: async (argv) => {
          const command = argv.slice(1).join(' ');
          if (
            command ===
            'display-message -p -t %1 #{alternate_on} #{cursor_x} #{cursor_y} #{pane_height}'
          ) {
            // 光标在可见区域倒数第 3 行（如 Claude Code 输入行），列 8
            return ok('0 8 1 4\n');
          }
          if (command === 'capture-pane -t %1 -S - -E - -e -J -N -p') {
            return ok('sh-3.2$ \n> input   \nstatus bar\n\n');
          }
          if (command === 'capture-pane -t %1 -a -S - -E - -e -J -N -p -q') {
            return ok('');
          }
          throw new Error(`unexpected command: ${command}`);
        },
      }
    );

    await (connection as any).capturePaneHistory('%1');

    expect(histories).toEqual([
      {
        paneId: '%1',
        data: 'sh-3.2$ \n> input   \nstatus bar\n\x1b[2A\x1b[9G',
        alternateScreen: false,
      },
    ]);
  });

  test('setWindowStyle re-applies client style to hook and existing windows', async () => {
    const session = 'tmex-style';
    const lightStyle = 'fg=#616161,bg=#e1e1e1';
    const calls: string[][] = [];
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
        enableSubscription: false,
        ensureGhosttyTerminfo: async () => false,
        getDevice: () => createDevice(session),
        run: createRunStub(session, {
          record: calls,
          overrides: (command) => {
            if (
              command ===
                `set-hook -t ${session} after-new-window set-option -w window-style '${lightStyle}'` ||
              command === `set-option -w -t @1 window-style ${lightStyle}`
            ) {
              return ok();
            }
            return null;
          },
        }),
      }
    );

    await connection.connect();
    calls.length = 0;

    connection.setWindowStyle(lightStyle);
    await waitFor(() => (calls.length >= 3 ? true : null));

    expect(calls.map((argv) => argv.join(' '))).toEqual([
      `tmux set-hook -t ${session} after-new-window set-option -w window-style '${lightStyle}'`,
      `tmux list-windows -t ${session} -F #{window_id}`,
      `tmux set-option -w -t @1 window-style ${lightStyle}`,
    ]);
  });

  test('setWindowStyle ignores style with unsafe characters', async () => {
    const session = 'tmex-style-bad';
    const calls: string[][] = [];
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
        enableSubscription: false,
        ensureGhosttyTerminfo: async () => false,
        getDevice: () => createDevice(session),
        run: createRunStub(session, { record: calls }),
      }
    );

    await connection.connect();
    calls.length = 0;

    connection.setWindowStyle("fg=#ffffff' ; kill-server #");
    await Bun.sleep(50);

    expect(calls).toEqual([]);
  });

  test('capturePaneText pane missing throws TmuxTargetMissingError without polluting device status', async () => {
    const deviceId = 'device-local-capture-missing';
    const session = 'tmex-capture-missing';
    const device = { ...createDevice(session), id: deviceId };
    createDeviceRow(device);

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
        enableSubscription: false,
        ensureGhosttyTerminfo: async () => false,
        getDevice: () => device,
        run: createRunStub(session, {
          overrides: (command) => {
            if (command === 'capture-pane -t %1 -p -J') {
              return ok('screen text\n');
            }
            if (command === 'capture-pane -t %404 -p -J') {
              return { exitCode: 1, stdout: '', stderr: "can't find pane: %404" };
            }
            return null;
          },
        }),
      }
    );

    await connection.connect();
    await expect(connection.capturePaneText('%1')).resolves.toBe('screen text\n');

    let captured: unknown = null;
    try {
      await connection.capturePaneText('%404');
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(TmuxTargetMissingError);

    // 静默形态不得污染设备运行状态（connect 成功时写入的健康状态保持不变）
    const status = getDeviceRuntimeStatus(deviceId);
    expect(status.tmuxAvailable).toBe(true);
    expect(status.lastError).toBeNull();

    connection.disconnect();
  });

  test('createWindow uses homedir when defaultWorkingDir is empty', async () => {
    const session = 'tmex-cwd-empty';
    const calls: string[][] = [];
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
        enableSubscription: false,
        ensureGhosttyTerminfo: async () => false,
        getDevice: () => createDevice(session),
        run: createRunStub(session, { record: calls }),
      }
    );

    await connection.connect();
    calls.length = 0;

    connection.createWindow();
    await Bun.sleep(50);

    const homedir = require('node:os').homedir();
    const createCmd = calls.find((argv) => argv.includes('new-window'));
    expect(createCmd).toBeDefined();
    expect(createCmd).toContain('-c');
    expect(createCmd).toContain(homedir);
  });

  test('createWindow uses custom dir when defaultWorkingDir is set', async () => {
    const session = 'tmex-cwd-custom';
    const calls: string[][] = [];
    const device = createDevice(session);
    device.defaultWorkingDir = '/custom/path';

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
        enableSubscription: false,
        ensureGhosttyTerminfo: async () => false,
        getDevice: () => device,
        run: createRunStub(session, { record: calls }),
      }
    );

    await connection.connect();
    calls.length = 0;

    connection.createWindow('test-win');
    await Bun.sleep(50);

    const createCmd = calls.find((argv) => argv.includes('new-window'));
    expect(createCmd).toBeDefined();
    expect(createCmd).toContain('-c');
    expect(createCmd).toContain('/custom/path');
    expect(createCmd).toContain('-n');
    expect(createCmd).toContain('test-win');
  });

  test('configureSessionOptions sets default-path with custom dir', async () => {
    const session = 'tmex-defpath';
    const calls: string[][] = [];
    const device = createDevice(session);
    device.defaultWorkingDir = '/projects';

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
        enableSubscription: false,
        ensureGhosttyTerminfo: async () => false,
        getDevice: () => device,
        run: createRunStub(session, { record: calls }),
      }
    );

    await connection.connect();

    const defaultPathCmd = calls.find(
      (argv) => argv.includes('set-option') && argv.includes('default-path')
    );
    expect(defaultPathCmd).toBeDefined();
    expect(defaultPathCmd).toContain('/projects');
  });

  test('ensureSession uses custom defaultWorkingDir for new session', async () => {
    const session = 'tmex-newsess-cwd';
    const calls: string[][] = [];
    const device = createDevice(session);
    device.defaultWorkingDir = '/workspace';

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
        enableSubscription: false,
        ensureGhosttyTerminfo: async () => false,
        getDevice: () => device,
        run: createRunStub(session, {
          record: calls,
          overrides: (command) => {
            if (command === `has-session -t ${session}`) {
              return { exitCode: 1, stdout: '', stderr: `can't find session: ${session}` };
            }
            if (command === `new-session -d -c /workspace -s ${session}`) {
              return ok();
            }
            return null;
          },
        }),
      }
    );

    await connection.connect();

    const newSessionCmd = calls.find((argv) => argv.includes('new-session'));
    expect(newSessionCmd).toBeDefined();
    expect(newSessionCmd).toContain('-c');
    expect(newSessionCmd).toContain('/workspace');
  });

  test('heartbeat sends display-message via write', async () => {
    const fake = createFakeControlProcess();
    const connection = new LocalExternalTmuxConnection(
      {
        deviceId: 'device-local',
        onEvent: () => {},
        onTerminalOutput: () => {},
        onTerminalHistory: () => {},
        onSnapshot: () => {},
        onError: () => {},
        onClose: () => {},
      },
      {
        enableSubscription: true,
        ensureGhosttyTerminfo: async () => false,
        getDevice: () => createDevice('tmex-heartbeat'),
        run: createRunStub('tmex-heartbeat'),
        spawnControlClient: () => {
          fake.pushStdout('%begin 1 1 0\n%end 1 1 0\n%session-changed $1 tmex-heartbeat\n');
          return fake.proc;
        },
      }
    );

    await connection.connect();

    (connection as any).sendHeartbeat();

    expect(fake.writtenData).toContain('display-message -p "tmex-hb"\n');

    connection.disconnect();
  });

  test('heartbeat response clears pending state', async () => {
    const fake = createFakeControlProcess();
    const connection = new LocalExternalTmuxConnection(
      {
        deviceId: 'device-local',
        onEvent: () => {},
        onTerminalOutput: () => {},
        onTerminalHistory: () => {},
        onSnapshot: () => {},
        onError: () => {},
        onClose: () => {},
      },
      {
        enableSubscription: true,
        ensureGhosttyTerminfo: async () => false,
        getDevice: () => createDevice('tmex-hb-response'),
        run: createRunStub('tmex-hb-response'),
        spawnControlClient: () => {
          fake.pushStdout('%begin 1 1 0\n%end 1 1 0\n%session-changed $1 tmex-hb-response\n');
          return fake.proc;
        },
      }
    );

    await connection.connect();

    (connection as any).sendHeartbeat();
    expect((connection as any).heartbeatPending).toBe(true);

    fake.pushStdout('%begin 2 2 0\ntmex-hb\n%end 2 2 0\n');

    await waitFor(() => (!(connection as any).heartbeatPending ? true : null));

    expect((connection as any).heartbeatPending).toBe(false);
    expect((connection as any).heartbeatTimeoutTimer).toBeNull();
    expect(fake.killed()).toBe(false);

    connection.disconnect();
  });

  test('heartbeat timeout kills process', async () => {
    const fakes: FakeControlProcess[] = [];
    const connection = new LocalExternalTmuxConnection(
      {
        deviceId: 'device-local',
        onEvent: () => {},
        onTerminalOutput: () => {},
        onTerminalHistory: () => {},
        onSnapshot: () => {},
        onError: () => {},
        onClose: () => {},
      },
      {
        enableSubscription: true,
        ensureGhosttyTerminfo: async () => false,
        getDevice: () => createDevice('tmex-hb-timeout'),
        run: createRunStub('tmex-hb-timeout'),
        spawnControlClient: () => {
          const f = createFakeControlProcess();
          f.pushStdout('%begin 1 1 0\n%end 1 1 0\n%session-changed $1 tmex-hb-timeout\n');
          fakes.push(f);
          return f.proc;
        },
      }
    );

    await connection.connect();
    const target = fakes[0]!;

    (connection as any).sendHeartbeat();
    expect(target.writtenData).toContain('display-message -p "tmex-hb"\n');

    // Replace the 10s timeout with a short one to avoid slow test.
    // The replacement replicates the same guard logic from sendHeartbeat.
    clearTimeout((connection as any).heartbeatTimeoutTimer);
    (connection as any).heartbeatTimeoutTimer = setTimeout(() => {
      const c = connection as any;
      if (!c.heartbeatPending || !c.connected || c.manualDisconnect) {
        return;
      }
      c.controlProcess?.kill();
    }, 50);

    await waitFor(() => (target.killed() ? true : null), 2000);
    expect(target.killed()).toBe(true);

    connection.disconnect();
  });

  test('%pause triggers continue command', async () => {
    const fake = createFakeControlProcess();
    const connection = new LocalExternalTmuxConnection(
      {
        deviceId: 'device-local',
        onEvent: () => {},
        onTerminalOutput: () => {},
        onTerminalHistory: () => {},
        onSnapshot: () => {},
        onError: () => {},
        onClose: () => {},
      },
      {
        enableSubscription: true,
        ensureGhosttyTerminfo: async () => false,
        getDevice: () => createDevice('tmex-pause'),
        run: createRunStub('tmex-pause'),
        spawnControlClient: () => {
          fake.pushStdout('%begin 1 1 0\n%end 1 1 0\n%session-changed $1 tmex-pause\n');
          return fake.proc;
        },
      }
    );

    await connection.connect();

    fake.pushStdout('%pause %1\n');

    await waitFor(() =>
      fake.writtenData.some((d) => d.includes('refresh-client')) ? true : null
    );

    expect(fake.writtenData).toContain('refresh-client -A %1:continue\n');

    connection.disconnect();
  });

  test('pump stdout ending unexpectedly kills process', async () => {
    const fakes: FakeControlProcess[] = [];
    const connection = new LocalExternalTmuxConnection(
      {
        deviceId: 'device-local',
        onEvent: () => {},
        onTerminalOutput: () => {},
        onTerminalHistory: () => {},
        onSnapshot: () => {},
        onError: () => {},
        onClose: () => {},
      },
      {
        enableSubscription: true,
        ensureGhosttyTerminfo: async () => false,
        getDevice: () => createDevice('tmex-stdout-end'),
        run: createRunStub('tmex-stdout-end'),
        spawnControlClient: () => {
          const f = createFakeControlProcess();
          f.pushStdout('%begin 1 1 0\n%end 1 1 0\n%session-changed $1 tmex-stdout-end\n');
          fakes.push(f);
          return f.proc;
        },
      }
    );

    await connection.connect();
    const target = fakes[0]!;

    target.closeStdout();

    await waitFor(() => (target.killed() ? true : null));
    expect(target.killed()).toBe(true);

    connection.disconnect();
  });

  test('disconnect cleans up heartbeat timers', async () => {
    const fake = createFakeControlProcess();
    const connection = new LocalExternalTmuxConnection(
      {
        deviceId: 'device-local',
        onEvent: () => {},
        onTerminalOutput: () => {},
        onTerminalHistory: () => {},
        onSnapshot: () => {},
        onError: () => {},
        onClose: () => {},
      },
      {
        enableSubscription: true,
        ensureGhosttyTerminfo: async () => false,
        getDevice: () => createDevice('tmex-hb-cleanup'),
        run: createRunStub('tmex-hb-cleanup'),
        spawnControlClient: () => {
          fake.pushStdout('%begin 1 1 0\n%end 1 1 0\n%session-changed $1 tmex-hb-cleanup\n');
          return fake.proc;
        },
      }
    );

    await connection.connect();

    expect((connection as any).heartbeatTimer).not.toBeNull();

    (connection as any).sendHeartbeat();
    expect((connection as any).heartbeatTimeoutTimer).not.toBeNull();

    connection.disconnect();

    expect((connection as any).heartbeatTimer).toBeNull();
    expect((connection as any).heartbeatTimeoutTimer).toBeNull();
    expect((connection as any).heartbeatPending).toBe(false);
  });
});
