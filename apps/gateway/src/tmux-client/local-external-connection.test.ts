import { beforeAll, describe, expect, spyOn, test } from 'bun:test';
import type { Device, StateSnapshotPayload } from '@tmex/shared';

import { createDevice as createDeviceRow, getDeviceById, getDeviceRuntimeStatus } from '../db';
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
    if (command === 'show-options -gqv @tmex-server-epoch') {
      return ok('00112233445566778899aabbccddeeff\n');
    }
    if (command === `new-window -t ${session} -n tmex-park -P -F #{window_id} sleep 30`) {
      return ok('@99\n');
    }
    if (
      command.startsWith(`new-window -t ${session} -c `) ||
      command.startsWith(`new-window -d -t ${session} -c `)
    ) {
      return ok();
    }
    if (command.startsWith(`new-window -P -F #{window_id} -t ${session} -c `)) {
      return ok('@2\n');
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
      return ok('@1|0|1|ba9d,80x24,0,0,1|main\n');
    }
    if (command.startsWith(`list-panes -s -t ${session}`)) {
      return ok('%1|@1|0|1|80|24|0|0|1|bash|node|/home/user\n');
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
  let commandId = 10;
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
        if (data.startsWith('refresh-client -B ') || data.startsWith('refresh-client -A ')) {
          const id = commandId++;
          queueMicrotask(() => {
            try {
              stdoutController.enqueue(encoder.encode(`%begin 1 ${id} 0\n%end 1 ${id} 0\n`));
            } catch {}
          });
        }
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
      'tmux -V',
      'tmux has-session -t tmex-snapshot',
      `tmux new-session -d -c ${homedir} -s tmex-snapshot`,
      'tmux show-options -gqv @tmex-server-epoch',
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
      'tmux list-windows -t tmex-snapshot -F #{window_id}|#{window_index}|#{window_active}|#{window_layout}|#{window_name}',
      'tmux list-panes -s -t tmex-snapshot -F #{pane_id}|#{window_id}|#{pane_index}|#{pane_active}|#{pane_width}|#{pane_height}|#{pane_left}|#{pane_top}|#{window_active}|#{pane_title}|#{pane_current_command}|#{pane_current_path}',
      'tmux list-panes -a -F #{pane_id}|#{@tmex_2031}',
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
              layout: 'ba9d,80x24,0,0,1',
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
                  left: 0,
                  top: 0,
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
              `list-windows -t ${session} -F #{window_id}|#{window_index}|#{window_active}|#{window_layout}|#{window_name}`
            ) {
              return ok('@0_0_1_ba9d,80x24,0,0,1_bash\n');
            }
            if (
              command ===
              `list-panes -s -t ${session} -F #{pane_id}|#{window_id}|#{pane_index}|#{pane_active}|#{pane_width}|#{pane_height}|#{pane_left}|#{pane_top}|#{window_active}|#{pane_title}|#{pane_current_command}|#{pane_current_path}`
            ) {
              return ok('%1_@0_0_1_80_24_0_0_1_bash_node_/home/user\n');
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

  test('control title updates stay on the realtime metadata path without tmux snapshots', async () => {
    const fake = createFakeControlProcess();
    const commands: string[][] = [];
    const snapshots: StateSnapshotPayload[] = [];
    const titles: string[] = [];
    const connection = new LocalExternalTmuxConnection(
      {
        deviceId: 'device-local',
        onEvent: () => {},
        onTerminalOutput: () => {},
        onTerminalHistory: () => {},
        onSourceMetadata: (event) => {
          if (event.type === 'pane-title') titles.push(event.title);
        },
        onSnapshot: (snapshot) => snapshots.push(snapshot),
        onError: (error) => {
          throw error;
        },
        onClose: () => {},
      },
      {
        enableSubscription: true,
        ensureGhosttyTerminfo: async () => false,
        getDevice: () => createDevice('tmex-title'),
        run: createRunStub('tmex-title', { record: commands }),
        spawnControlClient: () => {
          fake.pushStdout('%begin 1 1 0\n%end 1 1 0\n%session-changed $1 tmex-title\n');
          return fake.proc;
        },
      }
    );

    await connection.connect();
    commands.length = 0;
    snapshots.length = 0;

    for (let index = 0; index < 50; index += 1) {
      fake.pushStdout(`%output %1 \\033]2;build-${index}\\007\n`);
    }

    await waitFor(() => (titles.length === 50 ? true : null));

    expect(
      commands.filter((argv) => {
        const command = argv.slice(1).join(' ');
        return (
          command.startsWith('display-message -p -t tmex-title') ||
          command.startsWith('list-windows -t tmex-title') ||
          command.startsWith('list-panes -s -t tmex-title')
        );
      })
    ).toEqual([]);
    expect(snapshots).toEqual([]);
    expect(titles.at(-1)).toBe('build-49');

    fake.pushStdout('%output %1 \\033]2;build-49\\007\n');
    await waitFor(() => (titles.length === 51 ? true : null));
    expect(snapshots).toEqual([]);

    connection.disconnect();
  });

  test('canonical screen capture takes its sequence barrier before following live output', async () => {
    const fake = createFakeControlProcess();
    const outputs: string[] = [];
    const barrierOutputCounts: number[] = [];
    const connection = new LocalExternalTmuxConnection(
      {
        deviceId: 'device-local',
        onEvent: () => {},
        onTerminalOutput: (_paneId, data) => outputs.push(new TextDecoder().decode(data)),
        onTerminalHistory: () => {},
        onSnapshot: () => {},
        onError: (error) => {
          throw error;
        },
        onClose: () => {},
      },
      {
        enableSubscription: true,
        ensureGhosttyTerminfo: async () => false,
        getDevice: () => createDevice('tmex-canonical-capture'),
        run: createRunStub('tmex-canonical-capture'),
        spawnControlClient: () => {
          fake.pushStdout('%begin 1 1 0\n%end 1 1 0\n%session-changed $1 tmex-canonical-capture\n');
          return fake.proc;
        },
      }
    );
    await connection.connect();
    await Bun.sleep(0);

    const capturePromise = connection.capturePaneFrameAtBarrier('%1', 10, () => {
      barrierOutputCounts.push(outputs.length);
    });
    fake.pushStdout(
      '%begin 2 20 0\n80|24|0|3|4|100\n%end 2 20 0\n' +
        '%begin 2 21 0\n%output literal screen row\n%end 2 21 0\n' +
        '%begin 2 22 0\nhistory row\n%end 2 22 0\n' +
        '%output %1 live-after-capture\n'
    );

    await expect(capturePromise).resolves.toMatchObject({
      text: '%output literal screen row',
      historyText: 'history row',
      cols: 80,
      rows: 24,
      historySize: 100,
    });
    await waitFor(() => (outputs.length === 1 ? true : null));
    expect(barrierOutputCounts).toEqual([0]);
    expect(outputs).toEqual(['live-after-capture']);
    connection.disconnect();
  });

  test('an unknown pane title is forwarded for projection-owned reconciliation', async () => {
    const fake = createFakeControlProcess();
    const session = 'tmex-pending-title';
    const commands: string[][] = [];
    const snapshots: StateSnapshotPayload[] = [];
    const titles: Array<{ paneId: string; title: string }> = [];
    let includeSecondPane = false;
    const connection = new LocalExternalTmuxConnection(
      {
        deviceId: 'device-local',
        onEvent: () => {},
        onTerminalOutput: () => {},
        onTerminalHistory: () => {},
        onSourceMetadata: (event) => {
          if (event.type === 'pane-title')
            titles.push({ paneId: event.paneId, title: event.title });
        },
        onSnapshot: (snapshot) => snapshots.push(snapshot),
        onError: (error) => {
          throw error;
        },
        onClose: () => {},
      },
      {
        enableSubscription: true,
        ensureGhosttyTerminfo: async () => false,
        getDevice: () => createDevice(session),
        run: createRunStub(session, {
          record: commands,
          overrides: (command) => {
            if (command.startsWith(`list-panes -s -t ${session}`) && includeSecondPane) {
              return ok(
                '%1|@1|0|1|80|24|0|0|1|bash|node|/home/user\n%2|@1|1|0|80|24|0|0|1|stale|node|/home/user\n'
              );
            }
            return null;
          },
        }),
        spawnControlClient: () => {
          fake.pushStdout(`%begin 1 1 0\n%end 1 1 0\n%session-changed $1 ${session}\n`);
          return fake.proc;
        },
      }
    );

    await connection.connect();
    commands.length = 0;
    snapshots.length = 0;

    fake.pushStdout('%output %2 \\033]2;pending-title\\007\n');
    await waitFor(() => (titles.length === 1 ? true : null));
    expect(commands).toEqual([]);
    expect(snapshots).toEqual([]);
    expect(titles).toEqual([{ paneId: '%2', title: 'pending-title' }]);

    includeSecondPane = true;
    fake.pushStdout('%window-add @2\n');
    await waitFor(() => (snapshots.length > 0 ? true : null));

    expect(snapshots[0]?.session?.windows[0]?.panes.find((pane) => pane.id === '%2')?.title).toBe(
      'stale'
    );

    connection.disconnect();
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
          overrides: (command) => (command.startsWith('send-keys -H -t %1') ? ok() : null),
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
          overrides: (command) => (command === 'resize-window -t @1 -x 137 -y 41' ? ok() : null),
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

  test('applyStackedLayout serializes resize-window before select-layout', async () => {
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
        getDevice: () => createDevice('tmex-stacked-layout'),
        run: createRunStub('tmex-stacked-layout', {
          record: commands,
          overrides: (command) => {
            if (command === 'resize-window -t @1 -x 85 -y 24') return ok();
            if (command === 'select-layout -t @1 even-horizontal') return ok();
            return null;
          },
        }),
      }
    );

    await connection.connect();
    (connection as any).applyStackedLayout('@1', 85, 24);

    await waitFor(() => {
      const names = commands.map((argv) => argv.slice(1).join(' '));
      return names.includes('select-layout -t @1 even-horizontal') ? names : null;
    });

    const names = commands.map((argv) => argv.slice(1).join(' '));
    expect(names.indexOf('resize-window -t @1 -x 85 -y 24')).toBeLessThan(
      names.indexOf('select-layout -t @1 even-horizontal')
    );
  });

  test('capturePaneHistory falls back to normal capture when alternate capture is visually empty', async () => {
    const histories: Array<{
      paneId: string;
      data: string;
      alternateScreen: boolean;
      modes: number;
    }> = [];
    const connection = new LocalExternalTmuxConnection(
      {
        deviceId: 'device-local',
        onEvent: () => {},
        onTerminalOutput: () => {},
        onTerminalHistory: (paneId, data, alternateScreen, modes) => {
          histories.push({ paneId, data, alternateScreen, modes });
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
            'display-message -p -t %1 #{alternate_on} #{cursor_x} #{cursor_y} #{pane_height} #{mouse_standard_flag} #{mouse_button_flag} #{mouse_all_flag} #{mouse_sgr_flag} #{mouse_utf8_flag}'
          ) {
            return ok('1 8 3 40 0 0 0 0 0\n');
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
        modes: 0,
      },
    ]);
  });

  test('capturePaneHistory prefers current visible capture when pane is in alternate screen', async () => {
    const histories: Array<{
      paneId: string;
      data: string;
      alternateScreen: boolean;
      modes: number;
    }> = [];
    const connection = new LocalExternalTmuxConnection(
      {
        deviceId: 'device-local',
        onEvent: () => {},
        onTerminalOutput: () => {},
        onTerminalHistory: (paneId, data, alternateScreen, modes) => {
          histories.push({ paneId, data, alternateScreen, modes });
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
            'display-message -p -t %1 #{alternate_on} #{cursor_x} #{cursor_y} #{pane_height} #{mouse_standard_flag} #{mouse_button_flag} #{mouse_all_flag} #{mouse_sgr_flag} #{mouse_utf8_flag}'
          ) {
            return ok('1 2 1 40 0 1 0 1 0\n');
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
        modes: 10,
      },
    ]);
  });

  test('capturePaneHistory appends relative cursor restore for normal screen', async () => {
    const histories: Array<{
      paneId: string;
      data: string;
      alternateScreen: boolean;
      modes: number;
    }> = [];
    const connection = new LocalExternalTmuxConnection(
      {
        deviceId: 'device-local',
        onEvent: () => {},
        onTerminalOutput: () => {},
        onTerminalHistory: (paneId, data, alternateScreen, modes) => {
          histories.push({ paneId, data, alternateScreen, modes });
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
            'display-message -p -t %1 #{alternate_on} #{cursor_x} #{cursor_y} #{pane_height} #{mouse_standard_flag} #{mouse_button_flag} #{mouse_all_flag} #{mouse_sgr_flag} #{mouse_utf8_flag}'
          ) {
            // 光标在可见区域倒数第 3 行（如 Claude Code 输入行），列 8
            return ok('0 8 1 4 0 0 0 0 0\n');
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
        modes: 0,
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
    const target = fakes[0];
    if (!target) throw new Error('control process was not created');

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

    await waitFor(() => (fake.writtenData.some((d) => d.includes('refresh-client')) ? true : null));

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
    const target = fakes[0];
    if (!target) throw new Error('control process was not created');

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

  test('signalThemeChange is a no-op (stdin injection removed to avoid shell pollution)', async () => {
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
        getDevice: () => createDevice('tmex-theme'),
        run: createRunStub('tmex-theme', {
          record: commands,
          overrides: (command) => (command.startsWith('send-keys -H -t %') ? ok() : null),
        }),
      }
    );

    await connection.connect();

    connection.signalThemeChange('%1', 'dark');
    connection.signalThemeChange('%2', 'light');
    await new Promise((resolve) => setTimeout(resolve, 0));

    // stdin 注入已移除：不应有任何 send-keys 调用
    const sendKeysCalls = commands.filter((argv) => argv.includes('send-keys'));
    expect(sendKeysCalls).toHaveLength(0);
  });

  test('signalThemeChange is a no-op when disconnected', async () => {
    const commands: string[][] = [];
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
        enableSubscription: false,
        ensureGhosttyTerminfo: async () => false,
        getDevice: () => createDevice('tmex-theme-disc'),
        run: createRunStub('tmex-theme-disc', { record: commands }),
      }
    );

    // 不调 connect，connected=false
    connection.signalThemeChange('%1', 'dark');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(commands.some((argv) => argv.includes('send-keys'))).toBe(false);
  });
});

describe('LocalExternalTmuxConnection lifecycle events', () => {
  type EmittedEvent = { eventType: string; event: any };

  function makeLifecycleConnection(options: {
    session: string;
    overrides?: (command: string) => CommandResult | null;
  }) {
    const events: EmittedEvent[] = [];
    const connection = new LocalExternalTmuxConnection(
      {
        deviceId: 'device-local',
        notifyEvent: (eventType, event) => {
          events.push({ eventType, event });
        },
        onEvent: () => {},
        onTerminalOutput: () => {},
        onTerminalHistory: () => {},
        onSnapshot: () => {},
        onError: () => {},
        onClose: () => {},
      },
      {
        enableSubscription: false,
        ensureGhosttyTerminfo: async () => false,
        getDevice: () => createDevice(options.session),
        run: createRunStub(options.session, { overrides: options.overrides }),
      }
    );
    return { connection, events };
  }

  test('emits session_created only when the session is actually created', async () => {
    let created = false;
    const { connection, events } = makeLifecycleConnection({
      session: 'tmex-lc-created',
      overrides: (command) => {
        if (command === 'has-session -t tmex-lc-created' && !created) {
          created = true;
          return { exitCode: 1, stdout: '', stderr: "can't find session" };
        }
        if (command.startsWith('new-session -d -c ')) {
          return ok();
        }
        return null;
      },
    });

    await connection.connect();
    expect(events.map((e) => e.eventType)).toEqual(['session_created']);
    expect(events[0].event.tmux.sessionName).toBe('tmex-lc-created');
    expect(events[0].event.device.id).toBe('device-local');
    connection.disconnect();
  });

  test('does not emit session_created when the session already exists (and first snapshot emits no closures)', async () => {
    const { connection, events } = makeLifecycleConnection({ session: 'tmex-lc-existing' });
    await connection.connect();
    expect(events).toHaveLength(0);
    connection.disconnect();
  });

  test('emits tmux_pane_close when a pane disappears from the snapshot', async () => {
    let panesGone = false;
    const session = 'tmex-lc-pane';
    const { connection, events } = makeLifecycleConnection({
      session,
      overrides: (command) => {
        if (command.startsWith(`list-panes -s -t ${session}`) && panesGone) {
          return ok('%2|@1|1|1|80|24|0|0|1|bash|node|/home/user\n');
        }
        if (command.startsWith(`list-panes -s -t ${session}`)) {
          return ok(
            '%1|@1|0|1|80|24|0|0|1|first pane|vim|/home/user\n%2|@1|1|0|80|24|0|0|1|bash|node|/home/user\n'
          );
        }
        return null;
      },
    });

    await connection.connect();
    expect(events).toHaveLength(0);

    panesGone = true;
    connection.requestSnapshot();
    await waitFor(() => (events.length > 0 ? true : null));

    expect(events.map((e) => e.eventType)).toEqual(['tmux_pane_close']);
    expect(events[0].event.tmux.paneId).toBe('%1');
    expect(events[0].event.tmux.windowId).toBe('@1');
    expect(events[0].event.tmux.paneTitle).toBe('first pane');
    expect(events[0].event.tmux.paneCurrentCommand).toBe('vim');
    connection.disconnect();
  });

  test('emits tmux_window_close without per-pane events when a window disappears', async () => {
    let windowGone = false;
    const session = 'tmex-lc-window';
    const { connection, events } = makeLifecycleConnection({
      session,
      overrides: (command) => {
        if (command.startsWith(`list-windows -t ${session} -F #{window_id}|`)) {
          return windowGone
            ? ok('@1|0|1|ba9d,80x24,0,0,1|main\n')
            : ok('@1|0|1|ba9d,80x24,0,0,1|main\n@2|1|0|ba9d,80x24,0,0,2|second\n');
        }
        if (command === `list-windows -t ${session} -F #{window_id}`) {
          return windowGone ? ok('@1\n') : ok('@1\n@2\n');
        }
        if (command.startsWith('set-option -w -t @2 window-style')) {
          return ok();
        }
        if (command.startsWith(`list-panes -s -t ${session}`) && !windowGone) {
          return ok(
            '%1|@1|0|1|80|24|0|0|1|bash|node|/home/user\n%2|@2|0|1|80|24|0|0|0|bash|node|/home/user\n'
          );
        }
        return null;
      },
    });

    await connection.connect();
    expect(events).toHaveLength(0);

    windowGone = true;
    connection.requestSnapshot();
    await waitFor(() => (events.length > 0 ? true : null));

    expect(events.map((e) => e.eventType)).toEqual(['tmux_window_close']);
    expect(events[0].event.tmux.windowId).toBe('@2');
    expect(events[0].event.payload.windowName).toBe('second');
    connection.disconnect();
  });

  test('does not emit closures when the snapshot turns invalid', async () => {
    let invalid = false;
    const session = 'tmex-lc-invalid';
    const { connection, events } = makeLifecycleConnection({
      session,
      overrides: (command) => {
        if (invalid && command.startsWith(`display-message -p -t ${session}`)) {
          return ok('not-a-session-id|whatever\n');
        }
        return null;
      },
    });

    await connection.connect();
    invalid = true;
    connection.requestSnapshot();
    await Bun.sleep(80);

    expect(events).toHaveLength(0);
    connection.disconnect();
  });

  test('emits session_closed exactly once when the tmux server goes away during snapshot', async () => {
    let serverGone = false;
    const session = 'tmex-lc-gone';
    const { connection, events } = makeLifecycleConnection({
      session,
      overrides: (command) => {
        if (
          serverGone &&
          (command.startsWith(`display-message -p -t ${session}`) ||
            command.startsWith(`list-windows -t ${session}`) ||
            command.startsWith(`list-panes -s -t ${session}`))
        ) {
          return { exitCode: 1, stdout: '', stderr: 'no server running on /tmp/sock' };
        }
        return null;
      },
    });

    await connection.connect();
    expect(events).toHaveLength(0);

    serverGone = true;
    // 并发触发两次：两个 in-flight 快照都会命中 server-gone 分支，once 守卫必须兜住
    connection.requestSnapshot();
    connection.requestSnapshot();
    await waitFor(() => (events.length > 0 ? true : null));
    await Bun.sleep(50);

    expect(events.map((e) => e.eventType)).toEqual(['session_closed']);
    expect(events[0].event.payload.message).toBe('no server running on /tmp/sock');
    expect(events[0].event.tmux.sessionName).toBe(session);
  });

  test('runTmux server-gone marks tmux unavailable before emitting session_closed', async () => {
    let serverGone = false;
    const session = 'tmex-lc-cmd-gone';
    const { connection, events } = makeLifecycleConnection({
      session,
      overrides: (command) => {
        if (command.startsWith('send-keys -H -t %1')) {
          return serverGone
            ? { exitCode: 1, stdout: '', stderr: 'no server running on /tmp/sock' }
            : ok();
        }
        return null;
      },
    });

    // 设备行存在时 notifyRuntimeError 走 runtime 告警通路（不落 tmuxAvailable），
    // 只有 server-gone 分支负责把 tmuxAvailable 置 false
    if (!getDeviceById('device-local')) {
      createDeviceRow(createDevice(session));
    }

    await connection.connect();
    expect(events).toHaveLength(0);

    serverGone = true;
    connection.sendInput('%1', 'x');
    await waitFor(() => (events.length > 0 ? true : null));

    expect(events.map((e) => e.eventType)).toEqual(['session_closed']);
    const status = getDeviceRuntimeStatus('device-local');
    expect(status.tmuxAvailable).toBe(false);
    expect(status.lastError).toBe('no server running on /tmp/sock');
  });

  test('concurrent snapshot demands run one batch plus one trailing refresh without overlap', async () => {
    const session = 'tmex-lc-race';
    const fresh = '%2|@1|1|1|80|24|0|0|1|bash|node|/home/user\n';
    const stale =
      '%1|@1|0|1|80|24|0|0|1|first pane|vim|/home/user\n%2|@1|1|0|80|24|0|0|1|bash|node|/home/user\n';
    let paneListCalls = 0;
    let releaseStale: (() => void) | null = null;
    const staleGate = new Promise<void>((resolve) => {
      releaseStale = resolve;
    });
    const baseRun = createRunStub(session);
    const events: EmittedEvent[] = [];
    const connection = new LocalExternalTmuxConnection(
      {
        deviceId: 'device-local',
        notifyEvent: (eventType, event) => {
          events.push({ eventType, event });
        },
        onEvent: () => {},
        onTerminalOutput: () => {},
        onTerminalHistory: () => {},
        onSnapshot: () => {},
        onError: () => {},
        onClose: () => {},
      },
      {
        enableSubscription: false,
        ensureGhosttyTerminfo: async () => false,
        getDevice: () => createDevice(session),
        run: async (argv) => {
          const command = argv.slice(1).join(' ');
          if (command.startsWith(`list-panes -s -t ${session}`)) {
            paneListCalls += 1;
            if (paneListCalls === 1) {
              return ok(stale); // connect 首帧：两个 pane
            }
            if (paneListCalls === 2) {
              await staleGate; // 请求 A：挂起直到手动放行，届时返回过期数据（%1 仍在）
              return ok(stale);
            }
            return ok(fresh); // 请求 B 与后续帧：%1 已关闭
          }
          return baseRun(argv);
        },
      }
    );

    await connection.connect();
    expect(events).toHaveLength(0);

    connection.requestSnapshot();
    connection.requestSnapshot();
    connection.requestSnapshot();
    await Bun.sleep(30);

    expect(paneListCalls).toBe(2);
    expect(events).toHaveLength(0);

    releaseStale?.();
    await waitFor(() => (events.length > 0 ? true : null));

    expect(paneListCalls).toBe(3);
    expect(events.map((e) => e.eventType)).toEqual(['tmux_pane_close']);

    connection.requestSnapshot();
    await Bun.sleep(50);
    expect(events.map((e) => e.eventType)).toEqual(['tmux_pane_close']);
    connection.disconnect();
  });
});
