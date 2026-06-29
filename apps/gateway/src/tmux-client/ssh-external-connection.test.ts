import { beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { Device, StateSnapshotPayload } from '@tmex/shared';
import type { Client, ClientChannel, ConnectConfig } from 'ssh2';

import { createDevice as createDeviceRow, getDeviceRuntimeStatus } from '../db';
import { runMigrations } from '../db/migrate';
import type { TmuxEvent } from './events';
import { SshExternalTmuxConnection } from './ssh-external-connection';
import { TmuxTargetMissingError } from './target-missing';

const now = '2026-04-14T00:00:00.000Z';

function createDevice(session = 'tmex-ssh-test'): Device {
  return {
    id: 'device-ssh',
    name: 'ssh',
    type: 'ssh',
    host: 'example.com',
    port: 22,
    username: 'alice',
    authMode: 'password',
    passwordEnc: 'encrypted-password',
    session,
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
  };
}

function extractCommandId(command: string): string {
  const match = command.match(/printf '\\036TMEX_END %s %d\\036\\n' '([^']+)' \$\?/);
  if (!match) {
    throw new Error(`missing command id in payload: ${command}`);
  }
  return match[1];
}

function isConfigureSessionOptionPayload(payload: string, session: string): boolean {
  return (
    payload.includes(`'set-option' '-t' '${session}' '-s' 'allow-passthrough' 'off'`) ||
    payload.includes(`'set-option' '-t' '${session}' '-g' 'extended-keys' 'on'`) ||
    payload.includes(`'set-option' '-t' '${session}' '-s' 'extended-keys-format' 'csi-u'`) ||
    payload.includes(`'set-option' '-t' '${session}' '-g' 'focus-events' 'off'`) ||
    payload.includes(`'set-option' '-t' '${session}' 'destroy-unattached' 'off'`) ||
    payload.includes(`'set-environment' '-t' '${session}' 'TERM_PROGRAM' 'ghostty'`) ||
    payload.includes(`'set-environment' '-t' '${session}' 'COLORTERM' 'truecolor'`) ||
    payload.includes(`'set-option' '-t' '${session}' 'default-path'`) ||
    payload.includes(`'set-hook' '-t' '${session}' 'after-new-window'`) ||
    payload.includes("'set-option' '-w' '-t' '@1' 'window-style' 'fg=#d0d0d0,bg=#262626'")
  );
}

// 通用命令应答：覆盖 connect 全流程（bootstrap、会话、配置、parking 舞步、快照）。
function respondToPayload(
  session: string,
  payload: string,
  tmuxVersion = 'tmux 3.4'
): { stdout: string; exitCode: number } | null {
  if (payload.includes('command -v tmux')) {
    return { stdout: `TMEX_BOOT_OK\t/usr/bin/tmux\t${tmuxVersion}\t/home/alice\n`, exitCode: 0 };
  }
  if (payload.includes(`'has-session' '-t' '${session}'`)) {
    return { stdout: '', exitCode: 0 };
  }
  if (isConfigureSessionOptionPayload(payload, session)) {
    return { stdout: '', exitCode: 0 };
  }
  if (
    payload.includes(
      `'new-window' '-t' '${session}' '-n' 'tmex-park' '-P' '-F' '#{window_id}' 'sleep 30'`
    )
  ) {
    return { stdout: '@99\n', exitCode: 0 };
  }
  if (payload.includes(`'new-window' '-t' '${session}' '-c'`) || payload.includes(`'new-window' '-d' '-t' '${session}' '-c'`)) {
    return { stdout: '', exitCode: 0 };
  }
  if (payload.includes(`'last-window' '-t' '${session}'`) || payload.includes("'kill-window' '-t' '@99'")) {
    return { stdout: '', exitCode: 0 };
  }
  if (payload.includes(`'display-message' '-p' '-t' '${session}' '#{session_id}|#{session_name}'`)) {
    return { stdout: `$1|${session}\n`, exitCode: 0 };
  }
  if (payload.includes(`'list-windows' '-t' '${session}' '-F' '#{window_id}'`)) {
    return { stdout: '@1\n', exitCode: 0 };
  }
  if (payload.includes(`'list-windows' '-t' '${session}'`)) {
    return { stdout: '@1|0|main|1\n', exitCode: 0 };
  }
  if (payload.includes(`'list-panes' '-s' '-t' '${session}'`)) {
    return { stdout: '%1|@1|0|bash|1|80|24|1|node\n', exitCode: 0 };
  }
  return null;
}

beforeAll(() => {
  runMigrations();
});

class FakeChannel extends EventEmitter {
  readonly stderr = new EventEmitter();
  readonly writes: string[] = [];
  ended = false;
  closed = false;
  destroyed = false;
  onWrite?: (data: string) => void;

  write(data: string): boolean {
    this.writes.push(data);
    this.onWrite?.(data);
    return true;
  }

  end(): this {
    this.ended = true;
    this.emit('close');
    return this;
  }

  close(): this {
    this.closed = true;
    this.emit('close');
    return this;
  }

  destroy(): this {
    this.destroyed = true;
    return this;
  }
}

class FakeClient extends EventEmitter {
  connectConfig: ConnectConfig | null = null;
  execCalls: Array<{ command: string; options: unknown }> = [];
  readonly commandChannel = new FakeChannel();
  readonly controlChannels: FakeChannel[] = [];
  private execIndex = 0;

  connect(config: ConnectConfig): this {
    this.connectConfig = config;
    queueMicrotask(() => {
      this.emit('ready');
    });
    return this;
  }

  exec(
    command: string,
    options: unknown,
    callback?: (error: Error | undefined, channel: ClientChannel) => void
  ): this {
    const cb =
      typeof options === 'function'
        ? (options as (error: Error | undefined, channel: ClientChannel) => void)
        : callback;
    const actualOptions = typeof options === 'function' ? undefined : options;
    let channel: FakeChannel;
    if (this.execIndex === 0) {
      channel = this.commandChannel;
    } else {
      channel = new FakeChannel();
      // control channel：收到 attach 命令后回送 greeting 块，解除 attach-ready 等待
      channel.onWrite = (data) => {
        if (data.includes("-C attach-session")) {
          queueMicrotask(() => {
            channel.emit('data', Buffer.from('%begin 1 1 0\n%end 1 1 0\n%session-changed $1 s\n'));
          });
        }
      };
      this.controlChannels.push(channel);
    }
    this.execIndex += 1;
    this.execCalls.push({ command, options: actualOptions });
    cb?.(undefined, channel as unknown as ClientChannel);
    return this;
  }

  end(): this {
    this.emit('close');
    return this;
  }
}

function setupCommandChannel(
  fakeClient: FakeClient,
  session: string,
  options: {
    record?: string[];
    tmuxVersion?: string;
    overrides?: (payload: string) => { stdout: string; exitCode: number } | null;
  } = {}
): void {
  fakeClient.commandChannel.onWrite = (payload) => {
    options.record?.push(payload);
    const commandId = extractCommandId(payload);
    const response =
      options.overrides?.(payload) ?? respondToPayload(session, payload, options.tmuxVersion);
    if (!response) {
      throw new Error(`unexpected command payload: ${payload}`);
    }
    fakeClient.commandChannel.emit(
      'data',
      Buffer.from(`${response.stdout}\x1eTMEX_END ${commandId} ${response.exitCode}\x1e\n`)
    );
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

function createCallbacks(overrides: Partial<Parameters<typeof collectCallbacks>[0]> = {}) {
  return collectCallbacks(overrides);
}

function collectCallbacks(overrides: {
  onEvent?: (event: TmuxEvent) => void;
  onTerminalOutput?: (paneId: string, data: Uint8Array) => void;
  onSnapshot?: (payload: StateSnapshotPayload) => void;
  onClose?: () => void;
}) {
  return {
    deviceId: 'device-ssh',
    onEvent: overrides.onEvent ?? (() => {}),
    onTerminalOutput: overrides.onTerminalOutput ?? (() => {}),
    onTerminalHistory: () => {},
    onSnapshot: overrides.onSnapshot ?? (() => {}),
    onError: (error: Error) => {
      throw error;
    },
    onClose: overrides.onClose ?? (() => {}),
  };
}

describe('SshExternalTmuxConnection', () => {
  test('connect configures control-mode session options and attaches control client', async () => {
    const fakeClient = new FakeClient();
    const writes: string[] = [];
    setupCommandChannel(fakeClient, 'tmex-ssh-configure', {
      record: writes,
      overrides: (payload) => {
        if (payload.includes("'has-session' '-t' 'tmex-ssh-configure'")) {
          return { stdout: "can't find session: tmex-ssh-configure\n", exitCode: 1 };
        }
        if (payload.includes("'new-session' '-d' '-c' '/home/alice' '-s' 'tmex-ssh-configure'")) {
          return { stdout: '', exitCode: 0 };
        }
        return null;
      },
    });

    const connection = new SshExternalTmuxConnection(createCallbacks({}), {
      getDevice: () => createDevice('tmex-ssh-configure'),
      decrypt: async () => 'secret',
      createClient: () => fakeClient as unknown as Client,
    });

    await connection.connect();

    expect(
      writes.some((payload) =>
        payload.includes("'set-option' '-t' 'tmex-ssh-configure' '-g' 'focus-events' 'off'")
      )
    ).toBe(true);
    expect(
      writes.some((payload) =>
        payload.includes("'set-option' '-t' 'tmex-ssh-configure' 'destroy-unattached' 'off'")
      )
    ).toBe(true);
    // parking 舞步
    expect(
      writes.some((payload) =>
        payload.includes(
          "'new-window' '-t' 'tmex-ssh-configure' '-n' 'tmex-park' '-P' '-F' '#{window_id}' 'sleep 30'"
        )
      )
    ).toBe(true);
    expect(writes.some((payload) => payload.includes("'kill-window' '-t' '@99'"))).toBe(true);
    // control channel 已用 tmux -C attach 打开
    expect(fakeClient.controlChannels).toHaveLength(1);

    connection.disconnect();
  });

  test('connect rejects when remote tmux is too old for control mode', async () => {
    const fakeClient = new FakeClient();
    setupCommandChannel(fakeClient, 'tmex-ssh-old', { tmuxVersion: 'tmux 2.9a' });

    const connection = new SshExternalTmuxConnection(
      {
        ...createCallbacks({}),
        onError: () => {},
      },
      {
        getDevice: () => createDevice('tmex-ssh-old'),
        decrypt: async () => 'secret',
        createClient: () => fakeClient as unknown as Client,
      }
    );

    await expect(connection.connect()).rejects.toThrow(/control mode requires tmux >= 3.0/);
    expect(fakeClient.controlChannels).toHaveLength(0);
  });

  test('control channel %output flows through pane stream parser to terminal output', async () => {
    const fakeClient = new FakeClient();
    setupCommandChannel(fakeClient, 'tmex-ssh-stream', {});

    const outputs: Array<{ paneId: string; text: string }> = [];
    const events: TmuxEvent[] = [];
    const connection = new SshExternalTmuxConnection(
      createCallbacks({
        onTerminalOutput: (paneId, data) => {
          outputs.push({ paneId, text: new TextDecoder().decode(data) });
        },
        onEvent: (event) => {
          events.push(event);
        },
      }),
      {
        getDevice: () => createDevice('tmex-ssh-stream'),
        decrypt: async () => 'secret',
        createClient: () => fakeClient as unknown as Client,
      }
    );

    await connection.connect();
    const controlChannel = fakeClient.controlChannels[0];
    if (!controlChannel) {
      throw new Error('control channel missing');
    }

    controlChannel.emit('data', Buffer.from('%output %1 hi\\015\\012\n'));
    controlChannel.emit('data', Buffer.from('%output %1 \\033]9;ssh notify\\007\n'));

    await Bun.sleep(20);
    expect(outputs).toEqual([{ paneId: '%1', text: 'hi\r\n' }]);
    expect(events.find((event) => event.type === 'notification')?.data).toEqual({
      paneId: '%1',
      source: 'osc9',
      body: 'ssh notify',
    });

    connection.disconnect();
  });

  test('connect parses real tmux snapshot output that is pipe-delimited', async () => {
    const snapshots: StateSnapshotPayload[] = [];
    const fakeClient = new FakeClient();
    setupCommandChannel(fakeClient, 'tmex-ssh-pipe', {
      overrides: (payload) => {
        if (payload.includes("'has-session' '-t' 'tmex-ssh-pipe'")) {
          return { stdout: "can't find session: tmex-ssh-pipe\n", exitCode: 1 };
        }
        if (payload.includes("'new-session' '-d' '-c' '/home/alice' '-s' 'tmex-ssh-pipe'")) {
          return { stdout: '', exitCode: 0 };
        }
        return null;
      },
    });

    const connection = new SshExternalTmuxConnection(
      createCallbacks({ onSnapshot: (payload) => snapshots.push(payload) }),
      {
        getDevice: () => createDevice('tmex-ssh-pipe'),
        decrypt: async () => 'secret',
        createClient: () => fakeClient as unknown as Client,
      }
    );

    await connection.connect();

    expect(snapshots).toEqual([
      {
        deviceId: 'device-ssh',
        session: {
          id: '$1',
          name: 'tmex-ssh-pipe',
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

    connection.disconnect();
  });

  test('drops invalid snapshot rows instead of emitting composite tmux ids', async () => {
    const session = 'tmex-ssh-invalid-snapshot';
    const snapshots: StateSnapshotPayload[] = [];
    const fakeClient = new FakeClient();
    setupCommandChannel(fakeClient, session, {
      overrides: (payload) => {
        if (payload.includes(`'has-session' '-t' '${session}'`)) {
          return { stdout: "can't find session: tmex-ssh-invalid-snapshot\n", exitCode: 1 };
        }
        if (payload.includes(`'new-session' '-d' '-c' '/home/alice' '-s' '${session}'`)) {
          return { stdout: '', exitCode: 0 };
        }
        if (
          payload.includes(
            `'display-message' '-p' '-t' '${session}' '#{session_id}|#{session_name}'`
          )
        ) {
          return { stdout: `$1_${session}\n`, exitCode: 0 };
        }
        if (
          payload.includes(
            `'list-windows' '-t' '${session}' '-F' '#{window_id}|#{window_index}|#{window_name}|#{window_active}'`
          )
        ) {
          return { stdout: '@0_0_bash_1\n', exitCode: 0 };
        }
        if (
          payload.includes(
            `'list-panes' '-s' '-t' '${session}' '-F' '#{pane_id}|#{window_id}|#{pane_index}|#{pane_title}|#{pane_active}|#{pane_width}|#{pane_height}|#{window_active}|#{pane_current_command}'`
          )
        ) {
          return { stdout: '%1_@0_0_bash_1_80_24_1_node\n', exitCode: 0 };
        }
        return null;
      },
    });

    const connection = new SshExternalTmuxConnection(
      createCallbacks({ onSnapshot: (payload) => snapshots.push(payload) }),
      {
        getDevice: () => createDevice(session),
        decrypt: async () => 'secret',
        createClient: () => fakeClient as unknown as Client,
      }
    );

    await connection.connect();

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toEqual({ deviceId: 'device-ssh', session: null });
    expect(JSON.stringify(snapshots[0])).not.toContain('@0_0_bash_1');

    connection.disconnect();
  });

  test('connect bootstraps remote tmux over dedicated command and control channels', async () => {
    const fakeClient = new FakeClient();
    setupCommandChannel(fakeClient, 'tmex-ssh-snapshot', {});

    const connection = new SshExternalTmuxConnection(createCallbacks({}), {
      getDevice: () => createDevice('tmex-ssh-snapshot'),
      decrypt: async () => 'secret',
      createClient: () => fakeClient as unknown as Client,
    });

    await connection.connect();

    expect(fakeClient.connectConfig).toMatchObject({
      host: 'example.com',
      port: 22,
      username: 'alice',
      password: 'secret',
    });
    expect(fakeClient.execCalls[0]).toEqual({
      command: '/bin/sh -s',
      options: { pty: false },
    });
    expect(fakeClient.execCalls[1]).toEqual({
      command: '/bin/sh -s',
      options: { pty: false },
    });
    expect(fakeClient.controlChannels).toHaveLength(1);

    connection.disconnect();
  });

  test('resizePane keeps window-size manual on ssh runtime', async () => {
    const fakeClient = new FakeClient();
    const writes: string[] = [];
    setupCommandChannel(fakeClient, 'tmex-ssh-resize', {
      record: writes,
      overrides: (payload) => {
        if (payload.includes("'resize-window' '-t' '@1' '-x' '137' '-y' '41'")) {
          return { stdout: '', exitCode: 0 };
        }
        return null;
      },
    });

    const connection = new SshExternalTmuxConnection(createCallbacks({}), {
      getDevice: () => createDevice('tmex-ssh-resize'),
      decrypt: async () => 'secret',
      createClient: () => fakeClient as unknown as Client,
    });

    await connection.connect();
    connection.resizePane('%1', 137, 41);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(
      writes.some((payload) =>
        payload.includes("'set-window-option' '-t' '@1' 'window-size' 'latest'")
      )
    ).toBe(false);

    connection.disconnect();
  });

  test('selectWindow treats missing window targets as benign and refreshes snapshot', async () => {
    const session = 'tmex-ssh-select-missing';
    const fakeClient = new FakeClient();
    const writes: string[] = [];
    const errors: Error[] = [];
    setupCommandChannel(fakeClient, session, {
      record: writes,
      overrides: (payload) => {
        if (payload.includes("'select-window' '-t' '@404'")) {
          return { stdout: "can't find window: @404\n", exitCode: 1 };
        }
        return null;
      },
    });

    const connection = new SshExternalTmuxConnection(
      {
        ...createCallbacks({}),
        onError: (error) => {
          errors.push(error);
        },
      },
      {
        getDevice: () => createDevice(session),
        decrypt: async () => 'secret',
        createClient: () => fakeClient as unknown as Client,
      }
    );

    await connection.connect();
    writes.length = 0;

    connection.selectWindow('@404');
    await waitFor(() =>
      errors.length > 0 ||
      writes.some((payload) =>
        payload.includes(`'display-message' '-p' '-t' '${session}' '#{session_id}|#{session_name}'`)
      )
        ? true
        : null
    );

    expect(errors).toEqual([]);
    expect(writes.some((payload) => payload.includes("'select-window' '-t' '@404'"))).toBe(true);
    expect(
      writes.some((payload) =>
        payload.includes(`'display-message' '-p' '-t' '${session}' '#{session_id}|#{session_name}'`)
      )
    ).toBe(true);

    connection.disconnect();
  });

  test('logs tmux command context when a non-target-missing command fails', async () => {
    const session = 'tmex-ssh-command-context';
    const fakeClient = new FakeClient();
    const errors: Error[] = [];
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    setupCommandChannel(fakeClient, session, {
      overrides: (payload) => {
        if (payload.includes("'rename-window' '-t' '@1' 'broken'")) {
          return { stdout: 'rename failed\n', exitCode: 1 };
        }
        return null;
      },
    });

    const connection = new SshExternalTmuxConnection(
      {
        ...createCallbacks({}),
        onError: (error) => {
          errors.push(error);
        },
      },
      {
        getDevice: () => createDevice(session),
        decrypt: async () => 'secret',
        createClient: () => fakeClient as unknown as Client,
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
            text.includes('[ssh] tmux command failed') &&
            text.includes('device-ssh') &&
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

  test('capturePaneText runs plain capture-pane and fails fast when unavailable', async () => {
    const fakeClient = new FakeClient();
    const writes: string[] = [];
    setupCommandChannel(fakeClient, 'tmex-ssh-capture', {
      record: writes,
      overrides: (payload) => {
        if (payload.includes("'capture-pane' '-t' '%1' '-p' '-J' '-S' '-120'")) {
          return { stdout: 'history line\nhello world\n', exitCode: 0 };
        }
        if (payload.includes("'capture-pane' '-t' '%1' '-p' '-J'")) {
          return { stdout: 'hello world\n', exitCode: 0 };
        }
        if (payload.includes("'capture-pane' '-t' '%404' '-p' '-J'")) {
          return { stdout: "can't find pane: %404\n", exitCode: 1 };
        }
        return null;
      },
    });

    const captureDeviceId = 'device-ssh-capture-status';
    const captureDevice = { ...createDevice('tmex-ssh-capture'), id: captureDeviceId };
    createDeviceRow(captureDevice);

    const connection = new SshExternalTmuxConnection(
      {
        ...createCallbacks({}),
        deviceId: captureDeviceId,
        onError: () => {},
      },
      {
        getDevice: () => captureDevice,
        decrypt: async () => 'secret',
        createClient: () => fakeClient as unknown as Client,
      }
    );

    // 未连接时 fail-fast
    await expect(connection.capturePaneText('%1')).rejects.toThrow(
      /tmux connection not available/
    );

    await connection.connect();

    await expect(connection.capturePaneText('%1')).resolves.toBe('hello world\n');
    await expect(connection.capturePaneText('%1', { historyLines: 120 })).resolves.toBe(
      'history line\nhello world\n'
    );

    let missingError: unknown = null;
    try {
      await connection.capturePaneText('%404');
    } catch (error) {
      missingError = error;
    }
    expect(missingError).toBeInstanceOf(TmuxTargetMissingError);
    expect(String((missingError as Error).message)).toMatch(/can't find pane/);

    // 静默形态不得污染设备运行状态（connect 成功写入的健康状态保持不变）
    const status = getDeviceRuntimeStatus(captureDeviceId);
    expect(status.tmuxAvailable).toBe(true);
    expect(status.lastError).toBeNull();

    // 纯文本捕获不得携带 -e（转义序列）
    expect(
      writes.some((payload) => payload.includes("'capture-pane'") && payload.includes("'-e'"))
    ).toBe(false);

    connection.disconnect();
    await expect(connection.capturePaneText('%1')).rejects.toThrow(
      /tmux connection not available/
    );
  });

  test('connect no longer provisions remote fifo dirs or hooks', async () => {
    const fakeClient = new FakeClient();
    const writes: string[] = [];
    setupCommandChannel(fakeClient, 'tmex-ssh-no-cleanup', { record: writes });

    const connection = new SshExternalTmuxConnection(createCallbacks({}), {
      getDevice: () => createDevice('tmex-ssh-no-cleanup'),
      decrypt: async () => 'secret',
      createClient: () => fakeClient as unknown as Client,
    });

    await connection.connect();

    expect(writes.some((payload) => payload.includes('mkfifo'))).toBe(false);
    // window-style 的 after-new-window hook 是预期内的，旧 fifo 方案不再注册其他 hook
    expect(
      writes.some(
        (payload) => payload.includes("'set-hook'") && !payload.includes("'after-new-window'")
      )
    ).toBe(false);
    expect(
      writes.some((payload) => payload.includes('find ') && payload.includes('/tmp/tmex'))
    ).toBe(false);
    expect(writes.some((payload) => payload.includes('rm -rf'))).toBe(false);

    connection.disconnect();
  });

  test('createWindow uses remoteHomeDir when defaultWorkingDir is empty', async () => {
    const session = 'tmex-ssh-cwd-empty';
    const fakeClient = new FakeClient();
    const writes: string[] = [];
    setupCommandChannel(fakeClient, session, { record: writes });

    const connection = new SshExternalTmuxConnection(createCallbacks({}), {
      getDevice: () => createDevice(session),
      decrypt: async () => 'secret',
      createClient: () => fakeClient as unknown as Client,
    });

    await connection.connect();
    writes.length = 0;

    connection.createWindow();
    await Bun.sleep(100);

    expect(
      writes.some((payload) =>
        payload.includes(`'new-window' '-t' '${session}' '-c' '/home/alice'`)
      )
    ).toBe(true);

    connection.disconnect();
  });

  test('createWindow uses custom dir when defaultWorkingDir is set', async () => {
    const session = 'tmex-ssh-cwd-custom';
    const fakeClient = new FakeClient();
    const writes: string[] = [];
    const device = createDevice(session);
    device.defaultWorkingDir = '/custom/remote/path';

    setupCommandChannel(fakeClient, session, { record: writes });

    const connection = new SshExternalTmuxConnection(createCallbacks({}), {
      getDevice: () => device,
      decrypt: async () => 'secret',
      createClient: () => fakeClient as unknown as Client,
    });

    await connection.connect();
    writes.length = 0;

    connection.createWindow('test-win');
    await Bun.sleep(100);

    expect(
      writes.some((payload) =>
        payload.includes(`'new-window' '-t' '${session}' '-c' '/custom/remote/path'`) &&
        payload.includes("'-n' 'test-win'")
      )
    ).toBe(true);

    connection.disconnect();
  });

  test('control channel supports write after connect', async () => {
    const fakeClient = new FakeClient();
    setupCommandChannel(fakeClient, 'tmex-ssh-ctrl-write', {});

    const connection = new SshExternalTmuxConnection(createCallbacks({}), {
      getDevice: () => createDevice('tmex-ssh-ctrl-write'),
      decrypt: async () => 'secret',
      createClient: () => fakeClient as unknown as Client,
    });

    await connection.connect();
    const controlChannel = fakeClient.controlChannels[0];
    expect(controlChannel).toBeDefined();
    expect(controlChannel!.writes.some((w) => w.includes('-C attach-session'))).toBe(true);

    connection.disconnect();
  });

  test('heartbeat sends display-message to control channel', async () => {
    const fakeClient = new FakeClient();
    setupCommandChannel(fakeClient, 'tmex-ssh-hb-send', {});

    const connection = new SshExternalTmuxConnection(createCallbacks({}), {
      getDevice: () => createDevice('tmex-ssh-hb-send'),
      decrypt: async () => 'secret',
      createClient: () => fakeClient as unknown as Client,
    });

    await connection.connect();
    const controlChannel = fakeClient.controlChannels[0]!;

    (connection as any).sendHeartbeat();
    await Bun.sleep(20);

    expect(controlChannel.writes.some((w) => w === 'display-message -p "tmex-hb"\n')).toBe(true);

    connection.disconnect();
  });

  test('heartbeat timeout stops control channel', async () => {
    const session = 'tmex-ssh-hb-timeout';
    const fakeClient = new FakeClient();
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    setupCommandChannel(fakeClient, session, {});

    const connection = new SshExternalTmuxConnection(
      { ...createCallbacks({}), onError: () => {} },
      {
        getDevice: () => createDevice(session),
        decrypt: async () => 'secret',
        createClient: () => fakeClient as unknown as Client,
      }
    );

    try {
      await connection.connect();
      const controlChannel = fakeClient.controlChannels[0]!;

      (connection as any).sendHeartbeat();

      await waitFor(() => (controlChannel.ended ? true : null), 12000);

      expect(controlChannel.ended).toBe(true);
      expect(controlChannel.closed).toBe(true);
      expect(controlChannel.destroyed).toBe(true);

      expect(
        warn.mock.calls.some((call) =>
          call.some((arg: unknown) => String(arg).includes('heartbeat timeout'))
        )
      ).toBe(true);
    } finally {
      warn.mockRestore();
      connection.disconnect();
    }
  }, 20000);

  test('%pause triggers continue command on control channel', async () => {
    const fakeClient = new FakeClient();
    setupCommandChannel(fakeClient, 'tmex-ssh-pause', {});

    const connection = new SshExternalTmuxConnection(createCallbacks({}), {
      getDevice: () => createDevice('tmex-ssh-pause'),
      decrypt: async () => 'secret',
      createClient: () => fakeClient as unknown as Client,
    });

    await connection.connect();
    const controlChannel = fakeClient.controlChannels[0]!;

    controlChannel.emit('data', Buffer.from('%pause %1\n'));
    await Bun.sleep(20);

    expect(controlChannel.writes.some((w) => w === 'refresh-client -A %1:continue\n')).toBe(true);

    connection.disconnect();
  });

  test('configureSessionOptions sets default-path with custom dir', async () => {
    const session = 'tmex-ssh-defpath';
    const fakeClient = new FakeClient();
    const writes: string[] = [];
    const device = createDevice(session);
    device.defaultWorkingDir = '/projects';

    setupCommandChannel(fakeClient, session, { record: writes });

    const connection = new SshExternalTmuxConnection(createCallbacks({}), {
      getDevice: () => device,
      decrypt: async () => 'secret',
      createClient: () => fakeClient as unknown as Client,
    });

    await connection.connect();

    expect(
      writes.some((payload) =>
        payload.includes(`'set-option' '-t' '${session}' 'default-path' '/projects'`)
      )
    ).toBe(true);

    connection.disconnect();
  });

  test('ensureSession uses custom defaultWorkingDir for new session', async () => {
    const session = 'tmex-ssh-newsess-cwd';
    const fakeClient = new FakeClient();
    const writes: string[] = [];
    const device = createDevice(session);
    device.defaultWorkingDir = '/workspace';

    setupCommandChannel(fakeClient, session, {
      record: writes,
      overrides: (payload) => {
        if (payload.includes(`'has-session' '-t' '${session}'`)) {
          return { stdout: '', exitCode: 1 };
        }
        if (payload.includes(`'new-session' '-d' '-c' '/workspace' '-s' '${session}'`)) {
          return { stdout: '', exitCode: 0 };
        }
        return null;
      },
    });

    const connection = new SshExternalTmuxConnection(createCallbacks({}), {
      getDevice: () => device,
      decrypt: async () => 'secret',
      createClient: () => fakeClient as unknown as Client,
    });

    await connection.connect();

    expect(
      writes.some((payload) =>
        payload.includes(`'new-session' '-d' '-c' '/workspace' '-s' '${session}'`)
      )
    ).toBe(true);

    connection.disconnect();
  });
});
