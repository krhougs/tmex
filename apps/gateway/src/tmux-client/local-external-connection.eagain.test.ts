import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { Device } from '@tmex/shared';

import { config } from '../config';
import { runMigrations } from '../db/migrate';
import { LocalExternalTmuxConnection } from './local-external-connection';

const now = '2026-06-14T00:00:00.000Z';

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

// 内联一份最小 run 桩：argv 形如 ['tmux', ...(socketArgs), ...subcommand]。
// 这里以「去掉前导 tmux 与可选 -L <socket>」后的子命令字符串做匹配，
// 这样无论是否注入 socket，匹配逻辑都不变。
function subcommandOf(argv: string[]): string {
  const rest = argv.slice(1);
  if (rest[0] === '-L') {
    return rest.slice(2).join(' ');
  }
  return rest.join(' ');
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
    const command = subcommandOf(argv);
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
    if (command === `last-window -t ${session}` || command === 'kill-window -t @99') {
      return ok();
    }
    if (command.startsWith(`set-option -t ${session}`) || command.startsWith(`set-environment -t ${session}`)) {
      return ok();
    }
    if (command.startsWith(`set-hook -t ${session}`)) {
      return ok();
    }
    if (command.startsWith('set-option -w -t @')) {
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
      return ok('%1|@1|0|bash|1|80|24|1|node\n');
    }
    throw new Error(`unexpected command: ${argv.join(' ')}`);
  };
}

function makeEagainError(): Error & { code: string } {
  const error = new Error('posix_spawn failed: EAGAIN: resource temporarily unavailable') as Error & {
    code: string;
  };
  error.code = 'EAGAIN';
  return error;
}

const SNAPSHOT_PREFIXES = ['display-message -p -t', 'list-windows -t', 'list-panes -s -t'];

function isSnapshotReadCommand(command: string): boolean {
  return SNAPSHOT_PREFIXES.some((prefix) => command.startsWith(prefix));
}

function setTmuxSocket(value: string): void {
  (config as { tmuxSocket: string }).tmuxSocket = value;
}

const originalTmuxSocket = config.tmuxSocket;

beforeAll(() => {
  runMigrations();
});

afterEach(() => {
  setTmuxSocket('');
});

describe('LocalExternalTmuxConnection socket injection', () => {
  test('injects -L <socket> into run argv and control-client argv when tmuxSocket is set', async () => {
    setTmuxSocket('tmex-e2e');
    const session = 'tmex-socket-on';
    const calls: string[][] = [];
    let controlArgv: string[] | null = null;

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
        spawnControlClient: (argv) => {
          controlArgv = argv;
          throw new Error('should not spawn control client when subscription disabled');
        },
      }
    );

    await connection.connect();

    expect(calls.length).toBeGreaterThan(0);
    for (const argv of calls) {
      expect(argv.slice(0, 3)).toEqual(['tmux', '-L', 'tmex-e2e']);
    }
    expect(controlArgv).toBeNull();

    // control-client argv 单独验证（不真正起进程）
    const built = [
      'tmux',
      ...(config.tmuxSocket ? ['-L', config.tmuxSocket] : []),
      '-C',
      'attach-session',
      '-t',
      session,
    ];
    expect(built.slice(0, 3)).toEqual(['tmux', '-L', 'tmex-e2e']);
  });

  test('control-client argv contains -L <socket> when subscription enabled', async () => {
    setTmuxSocket('tmex-e2e');
    const session = 'tmex-socket-ctl';
    let controlArgv: string[] | null = null;

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
        getDevice: () => createDevice(session),
        run: createRunStub(session),
        spawnControlClient: (argv) => {
          controlArgv = argv;
          // 抛错使 connect() 失败，避免真正驱动控制流；argv 已被捕获。
          throw new Error('stop after capturing control argv');
        },
      }
    );

    await expect(connection.connect()).rejects.toThrow();
    expect(controlArgv).toEqual([
      'tmux',
      '-L',
      'tmex-e2e',
      '-C',
      'attach-session',
      '-t',
      session,
    ]);
  });

  test('omits -L from run argv when tmuxSocket is empty', async () => {
    setTmuxSocket('');
    const session = 'tmex-socket-off';
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

    expect(calls.length).toBeGreaterThan(0);
    for (const argv of calls) {
      expect(argv[0]).toBe('tmux');
      expect(argv[1]).not.toBe('-L');
    }
  });

  test('omits -L from control-client argv when tmuxSocket is empty', async () => {
    setTmuxSocket('');
    const session = 'tmex-socket-off-ctl';
    let controlArgv: string[] | null = null;

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
        getDevice: () => createDevice(session),
        run: createRunStub(session),
        spawnControlClient: (argv) => {
          controlArgv = argv;
          throw new Error('stop after capturing control argv');
        },
      }
    );

    await expect(connection.connect()).rejects.toThrow();
    expect(controlArgv).toEqual(['tmux', '-C', 'attach-session', '-t', session]);
  });
});

describe('LocalExternalTmuxConnection EAGAIN handling', () => {
  test('transient spawn EAGAIN does not escape, shutdown, or error out', async () => {
    setTmuxSocket('');
    const session = 'tmex-eagain';
    let eagainPhase = false;
    let closeCalls = 0;
    const errors: unknown[] = [];

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
        onClose: () => {
          closeCalls += 1;
        },
      },
      {
        enableSubscription: false,
        ensureGhosttyTerminfo: async () => false,
        getDevice: () => createDevice(session),
        run: createRunStub(session, {
          overrides: (command) => {
            if (eagainPhase && isSnapshotReadCommand(command)) {
              throw makeEagainError();
            }
            return null;
          },
        }),
      }
    );

    await connection.connect();
    expect((connection as unknown as { connected: boolean }).connected).toBe(true);

    eagainPhase = true;

    let escaped = false;
    const onUnhandled = () => {
      escaped = true;
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      // public requestSnapshot：内部捕获瞬时 spawn 错误，不应抛出/不触发 onError/onClose
      connection.requestSnapshot();
      await Bun.sleep(30);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }

    expect(escaped).toBe(false);
    expect(closeCalls).toBe(0);
    // EAGAIN 不应作为 onError 上报
    expect(errors.filter((e) => e instanceof Error && /EAGAIN|posix_spawn/.test(e.message))).toEqual(
      []
    );
    expect((connection as unknown as { connected: boolean }).connected).toBe(true);

    connection.disconnect();
  });

  test('recovers after a transient EAGAIN: subsequent snapshot emits normally', async () => {
    setTmuxSocket('');
    const session = 'tmex-eagain-recover';
    let eagainPhase = false;
    let closeCalls = 0;
    const snapshots: unknown[] = [];
    const errors: unknown[] = [];

    const connection = new LocalExternalTmuxConnection(
      {
        deviceId: 'device-local',
        onEvent: () => {},
        onTerminalOutput: () => {},
        onTerminalHistory: () => {},
        onSnapshot: (payload) => {
          snapshots.push(payload);
        },
        onError: (error) => {
          errors.push(error);
        },
        onClose: () => {
          closeCalls += 1;
        },
      },
      {
        enableSubscription: false,
        ensureGhosttyTerminfo: async () => false,
        getDevice: () => createDevice(session),
        run: createRunStub(session, {
          overrides: (command) => {
            if (eagainPhase && isSnapshotReadCommand(command)) {
              throw makeEagainError();
            }
            return null;
          },
        }),
      }
    );

    await connection.connect();
    const baseSnapshots = snapshots.length;

    // 1) 触发一次 EAGAIN：不发快照、不 shutdown
    eagainPhase = true;
    connection.requestSnapshot();
    await Bun.sleep(30);
    expect(snapshots.length).toBe(baseSnapshots);
    expect(closeCalls).toBe(0);

    // 2) 恢复正常：后续快照正常发出，连接健康
    eagainPhase = false;
    connection.requestSnapshot();
    await Bun.sleep(30);
    expect(snapshots.length).toBeGreaterThan(baseSnapshots);

    expect(errors.filter((e) => e instanceof Error && /EAGAIN|posix_spawn/.test(e.message))).toEqual(
      []
    );
    expect((connection as unknown as { connected: boolean }).connected).toBe(true);

    connection.disconnect();
  });
});
