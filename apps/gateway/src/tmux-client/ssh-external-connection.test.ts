import { beforeAll, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { Device, StateSnapshotPayload } from '@tmex/shared';
import type { Client, ClientChannel, ConnectConfig } from 'ssh2';

import { runMigrations } from '../db/migrate';
import { SshExternalTmuxConnection } from './ssh-external-connection';

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
    payload.includes(`'set-option' '-t' '${session}' '-g' 'focus-events' 'on'`)
  );
}

beforeAll(() => {
  runMigrations();
});

class FakeChannel extends EventEmitter {
  readonly stderr = new EventEmitter();
  onWrite?: (data: string) => void;

  write(data: string): boolean {
    this.onWrite?.(data);
    return true;
  }

  end(): this {
    this.emit('close');
    return this;
  }

  close(): this {
    this.emit('close');
    return this;
  }

  destroy(): this {
    return this;
  }
}

class FakeClient extends EventEmitter {
  connectConfig: ConnectConfig | null = null;
  execCalls: Array<{ command: string; options: unknown }> = [];
  readonly commandChannel = new FakeChannel();
  readonly hookChannel = new FakeChannel();
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
    const channel = this.execIndex === 0 ? this.commandChannel : this.hookChannel;
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

describe('SshExternalTmuxConnection', () => {
  test('connect configures session options and syncs pipe readers after snapshot refresh', async () => {
    const fakeClient = new FakeClient();
    const writes: string[] = [];
    let syncCalls = 0;

    fakeClient.commandChannel.onWrite = (payload) => {
      writes.push(payload);
      const commandId = extractCommandId(payload);

      let stdout = '';
      let exitCode = 0;
      if (payload.includes('command -v tmux')) {
        stdout = 'TMEX_BOOT_OK\t/usr/bin/tmux\ttmux 3.4\t/home/alice\n';
      } else if (payload.includes('mkdir -p')) {
        stdout = '';
      } else if (payload.includes("'has-session' '-t' 'tmex-ssh-configure'")) {
        stdout = "can't find session: tmex-ssh-configure\n";
        exitCode = 1;
      } else if (
        payload.includes("'new-session' '-d' '-c' '/home/alice' '-s' 'tmex-ssh-configure'") ||
        payload.includes("'set-option' '-t' 'tmex-ssh-configure' '-s' 'allow-passthrough' 'off'") ||
        payload.includes("'set-option' '-t' 'tmex-ssh-configure' '-g' 'extended-keys' 'on'") ||
        payload.includes("'set-option' '-t' 'tmex-ssh-configure' '-s' 'extended-keys-format' 'csi-u'") ||
        payload.includes("'set-option' '-t' 'tmex-ssh-configure' '-g' 'focus-events' 'on'")
      ) {
        stdout = '';
      } else if (
        payload.includes("'display-message' '-p' '-t' 'tmex-ssh-configure' '#{session_id}|#{session_name}'")
      ) {
        stdout = '$1|tmex-ssh-configure\n';
      } else if (payload.includes("'list-windows' '-t' 'tmex-ssh-configure'")) {
        stdout = '@1|0|main|1\n';
      } else if (payload.includes("'list-panes' '-t' 'tmex-ssh-configure'")) {
        stdout = '%1|@1|0|bash|1|80|24\n%2|@1|1|logs|0|80|24\n';
      } else {
        throw new Error(`unexpected command payload: ${payload}`);
      }

      fakeClient.commandChannel.emit(
        'data',
        Buffer.from(`${stdout}\x1eTMEX_END ${commandId} ${exitCode}\x1e\n`)
      );
    };

    const connection = new SshExternalTmuxConnection(
      {
        deviceId: 'device-ssh',
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
        getDevice: () => createDevice('tmex-ssh-configure'),
        decrypt: async () => 'secret',
        createClient: () => fakeClient as unknown as Client,
      }
    );
    (connection as any).syncPipeReaders = async () => {
      syncCalls += 1;
    };
    (connection as any).startHooks = async () => {};

    await connection.connect();

    expect(
      writes.some((payload) =>
        payload.includes("'set-option' '-t' 'tmex-ssh-configure' '-s' 'allow-passthrough' 'off'")
      )
    ).toBe(true);
    expect(
      writes.some((payload) =>
        payload.includes("'set-option' '-t' 'tmex-ssh-configure' '-g' 'extended-keys' 'on'")
      )
    ).toBe(true);
    expect(
      writes.some((payload) =>
        payload.includes(
          "'set-option' '-t' 'tmex-ssh-configure' '-s' 'extended-keys-format' 'csi-u'"
        )
      )
    ).toBe(true);
    expect(
      writes.some((payload) =>
        payload.includes("'set-option' '-t' 'tmex-ssh-configure' '-g' 'focus-events' 'on'")
      )
    ).toBe(true);
    expect(syncCalls).toBe(1);
  });

  test('selectPane no longer restarts ssh pipe readers', async () => {
    const fakeClient = new FakeClient();
    let startPipeCalls = 0;

    fakeClient.commandChannel.onWrite = (payload) => {
      const commandId = extractCommandId(payload);

      let stdout = '';
      const exitCode = 0;
      if (payload.includes('command -v tmux')) {
        stdout = 'TMEX_BOOT_OK\t/usr/bin/tmux\ttmux 3.4\t/home/alice\n';
      } else if (payload.includes('mkdir -p')) {
        stdout = '';
      } else if (payload.includes("'has-session' '-t' 'tmex-ssh-select-pane'")) {
        stdout = '';
      } else if (
        payload.includes("'set-option' '-t' 'tmex-ssh-select-pane' '-s' 'allow-passthrough' 'off'") ||
        payload.includes("'set-option' '-t' 'tmex-ssh-select-pane' '-g' 'extended-keys' 'on'") ||
        payload.includes("'set-option' '-t' 'tmex-ssh-select-pane' '-s' 'extended-keys-format' 'csi-u'") ||
        payload.includes("'set-option' '-t' 'tmex-ssh-select-pane' '-g' 'focus-events' 'on'")
      ) {
        stdout = '';
      } else if (
        payload.includes("'display-message' '-p' '-t' 'tmex-ssh-select-pane' '#{session_id}|#{session_name}'")
      ) {
        stdout = '$1|tmex-ssh-select-pane\n';
      } else if (payload.includes("'list-windows' '-t' 'tmex-ssh-select-pane'")) {
        stdout = '@1|0|main|1\n';
      } else if (payload.includes("'list-panes' '-t' 'tmex-ssh-select-pane'")) {
        stdout = '%1|@1|0|bash|1|80|24\n';
      } else if (
        payload.includes("'select-window' '-t' '@1'") ||
        payload.includes("'select-pane' '-t' '%1'") ||
        payload.includes("'display-message' '-p' '-t' '%1' '#{alternate_on}'")
      ) {
        stdout = payload.includes("'display-message' '-p' '-t' '%1' '#{alternate_on}'") ? '0\n' : '';
      } else if (payload.includes("'capture-pane' '-t' '%1' '-S' '-' '-E' '-' '-e' '-N' '-p'")) {
        stdout = 'history\n';
      } else if (
        payload.includes("'capture-pane' '-t' '%1' '-a' '-S' '-' '-E' '-' '-e' '-N' '-p' '-q'")
      ) {
        stdout = '';
      } else {
        throw new Error(`unexpected command payload: ${payload}`);
      }

      fakeClient.commandChannel.emit(
        'data',
        Buffer.from(`${stdout}\x1eTMEX_END ${commandId} ${exitCode}\x1e\n`)
      );
    };

    const connection = new SshExternalTmuxConnection(
      {
        deviceId: 'device-ssh',
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
        getDevice: () => createDevice('tmex-ssh-select-pane'),
        decrypt: async () => 'secret',
        createClient: () => fakeClient as unknown as Client,
      }
    );
    (connection as any).syncPipeReaders = async () => {};
    (connection as any).startPipeForPane = async () => {
      startPipeCalls += 1;
    };
    (connection as any).startHooks = async () => {};

    await connection.connect();
    connection.selectPane('@1', '%1');
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(startPipeCalls).toBe(0);
  });

  test('syncPipeReaders starts every pane from snapshot and stops stale ssh readers', async () => {
    const connection = new SshExternalTmuxConnection(
      {
        deviceId: 'device-ssh',
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
        getDevice: () => createDevice('tmex-ssh-sync-readers'),
        decrypt: async () => 'secret',
        createClient: () => new FakeClient() as unknown as Client,
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

  test('ssh hook bell lines should not emit bell events', () => {
    const events: Array<{ type: string; data?: unknown }> = [];
    const connection = new SshExternalTmuxConnection(
      {
        deviceId: 'device-ssh',
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
        getDevice: () => createDevice('tmex-ssh-hook-bell'),
        decrypt: async () => 'secret',
        createClient: () => new FakeClient() as unknown as Client,
      }
    );

    (connection as any).handleHookChunk('bell\t@1\t%1\n');

    expect(events).toEqual([]);
  });

  test('connect parses real tmux snapshot output that is pipe-delimited', async () => {
    const snapshots: StateSnapshotPayload[] = [];
    const fakeClient = new FakeClient();

    fakeClient.commandChannel.onWrite = (payload) => {
      const commandId = extractCommandId(payload);

      let stdout = '';
      let exitCode = 0;
      if (payload.includes('command -v tmux')) {
        stdout = 'TMEX_BOOT_OK\t/usr/bin/tmux\ttmux 3.4\t/home/alice\n';
      } else if (payload.includes('mkdir -p')) {
        stdout = '';
      } else if (payload.includes("mkfifo '/tmp/tmex/device-ssh-")) {
        stdout = '';
      } else if (payload.includes("'has-session' '-t' 'tmex-ssh-pipe'")) {
        stdout = "can't find session: tmex-ssh-pipe\n";
        exitCode = 1;
      } else if (payload.includes("'new-session' '-d' '-c' '/home/alice' '-s' 'tmex-ssh-pipe'")) {
        stdout = '';
      } else if (payload.includes("'set-hook' '-t' 'tmex-ssh-pipe' 'alert-bell'")) {
        stdout = '';
      } else if (payload.includes("'set-hook' '-t' 'tmex-ssh-pipe' 'pane-exited'")) {
        stdout = '';
      } else if (payload.includes("'set-hook' '-t' 'tmex-ssh-pipe' 'pane-died'")) {
        stdout = '';
      } else if (payload.includes("'set-hook' '-t' 'tmex-ssh-pipe' 'after-new-window'")) {
        stdout = '';
      } else if (payload.includes("'set-hook' '-t' 'tmex-ssh-pipe' 'after-split-window'")) {
        stdout = '';
      } else if (isConfigureSessionOptionPayload(payload, 'tmex-ssh-pipe')) {
        stdout = '';
      } else if (
        payload.includes("'display-message' '-p' '-t' 'tmex-ssh-pipe' '#{session_id}|#{session_name}'")
      ) {
        stdout = '$1|tmex-ssh-pipe\n';
      } else if (payload.includes("'list-windows' '-t' 'tmex-ssh-pipe' '-F' '#{window_id}|#{window_index}|#{window_name}|#{window_active}'")) {
        stdout = '@1|0|main|1\n';
      } else if (
        payload.includes(
          "'list-panes' '-t' 'tmex-ssh-pipe' '-F' '#{pane_id}|#{window_id}|#{pane_index}|#{pane_title}|#{pane_active}|#{pane_width}|#{pane_height}'"
        )
      ) {
        stdout = '%1|@1|0|bash|1|80|24\n';
      } else {
        throw new Error(`unexpected command payload: ${payload}`);
      }

      fakeClient.commandChannel.emit(
        'data',
        Buffer.from(`${stdout}\x1eTMEX_END ${commandId} ${exitCode}\x1e\n`)
      );
    };

    const connection = new SshExternalTmuxConnection(
      {
        deviceId: 'device-ssh',
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
        getDevice: () => createDevice('tmex-ssh-pipe'),
        decrypt: async () => 'secret',
        createClient: () => fakeClient as unknown as Client,
      }
    );
    (connection as any).syncPipeReaders = async () => {};

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

  test('connect bootstraps remote tmux and emits parsed snapshot', async () => {
    const snapshots: StateSnapshotPayload[] = [];
    const fakeClient = new FakeClient();

    fakeClient.commandChannel.onWrite = (payload) => {
      const commandId = extractCommandId(payload);

      let stdout = '';
      let exitCode = 0;
      if (payload.includes('command -v tmux')) {
        stdout = 'TMEX_BOOT_OK\t/usr/bin/tmux\ttmux 3.4\t/home/alice\n';
      } else if (payload.includes('find ') && payload.includes('/tmp/tmex')) {
        stdout = '';
      } else if (payload.includes('mkdir -p')) {
        stdout = '';
      } else if (payload.includes("mkfifo '/tmp/tmex/device-ssh-")) {
        stdout = '';
      } else if (payload.includes("'has-session' '-t' 'tmex-ssh-snapshot'")) {
        stdout = "can't find session: tmex-ssh-snapshot\n";
        exitCode = 1;
      } else if (
        payload.includes("'new-session' '-d' '-c' '/home/alice' '-s' 'tmex-ssh-snapshot'")
      ) {
        stdout = '';
      } else if (payload.includes("'set-hook' '-t' 'tmex-ssh-snapshot' 'alert-bell'")) {
        stdout = '';
      } else if (payload.includes("'set-hook' '-t' 'tmex-ssh-snapshot' 'pane-exited'")) {
        stdout = '';
      } else if (payload.includes("'set-hook' '-t' 'tmex-ssh-snapshot' 'pane-died'")) {
        stdout = '';
      } else if (payload.includes("'set-hook' '-t' 'tmex-ssh-snapshot' 'after-new-window'")) {
        stdout = '';
      } else if (payload.includes("'set-hook' '-t' 'tmex-ssh-snapshot' 'after-split-window'")) {
        stdout = '';
      } else if (isConfigureSessionOptionPayload(payload, 'tmex-ssh-snapshot')) {
        stdout = '';
      } else if (
        payload.includes("'display-message' '-p' '-t' 'tmex-ssh-snapshot' '#{session_id}|#{session_name}'")
      ) {
        stdout = '$1|tmex-ssh-snapshot\n';
      } else if (payload.includes("'list-windows' '-t' 'tmex-ssh-snapshot'")) {
        stdout = '@1|0|main|1\n';
      } else if (payload.includes("'list-panes' '-t' 'tmex-ssh-snapshot'")) {
        stdout = '%1|@1|0|bash|1|80|24\n';
      } else {
        throw new Error(`unexpected command payload: ${payload}`);
      }

      fakeClient.commandChannel.emit(
        'data',
        Buffer.from(`${stdout}\x1eTMEX_END ${commandId} ${exitCode}\x1e\n`)
      );
    };

    const connection = new SshExternalTmuxConnection(
      {
        deviceId: 'device-ssh',
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
        getDevice: () => createDevice('tmex-ssh-snapshot'),
        decrypt: async () => 'secret',
        createClient: () => fakeClient as unknown as Client,
      }
    );
    (connection as any).syncPipeReaders = async () => {};

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
    expect(snapshots).toEqual([
      {
        deviceId: 'device-ssh',
        session: {
          id: '$1',
          name: 'tmex-ssh-snapshot',
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

  test('resizePane keeps window-size manual on ssh runtime', async () => {
    const fakeClient = new FakeClient();
    const writes: string[] = [];

    fakeClient.commandChannel.onWrite = (payload) => {
      writes.push(payload);
      const commandId = extractCommandId(payload);

      let stdout = '';
      let exitCode = 0;
      if (payload.includes('command -v tmux')) {
        stdout = 'TMEX_BOOT_OK\t/usr/bin/tmux\ttmux 3.4\t/home/alice\n';
      } else if (payload.includes('find ') && payload.includes('/tmp/tmex')) {
        stdout = '';
      } else if (payload.includes('mkdir -p')) {
        stdout = '';
      } else if (payload.includes("mkfifo '/tmp/tmex/device-ssh-")) {
        stdout = '';
      } else if (payload.includes("'has-session' '-t' 'tmex-ssh-resize'")) {
        stdout = "can't find session: tmex-ssh-resize\n";
        exitCode = 1;
      } else if (payload.includes("'new-session' '-d' '-c' '/home/alice' '-s' 'tmex-ssh-resize'")) {
        stdout = '';
      } else if (payload.includes("'set-hook' '-t' 'tmex-ssh-resize' 'alert-bell'")) {
        stdout = '';
      } else if (payload.includes("'set-hook' '-t' 'tmex-ssh-resize' 'pane-exited'")) {
        stdout = '';
      } else if (payload.includes("'set-hook' '-t' 'tmex-ssh-resize' 'pane-died'")) {
        stdout = '';
      } else if (payload.includes("'set-hook' '-t' 'tmex-ssh-resize' 'after-new-window'")) {
        stdout = '';
      } else if (payload.includes("'set-hook' '-t' 'tmex-ssh-resize' 'after-split-window'")) {
        stdout = '';
      } else if (isConfigureSessionOptionPayload(payload, 'tmex-ssh-resize')) {
        stdout = '';
      } else if (payload.includes("'display-message' '-p' '-t' 'tmex-ssh-resize' '#{session_id}|#{session_name}'")) {
        stdout = '$1|tmex-ssh-resize\n';
      } else if (payload.includes("'list-windows' '-t' 'tmex-ssh-resize'")) {
        stdout = '@1|0|main|1\n';
      } else if (payload.includes("'list-panes' '-t' 'tmex-ssh-resize'")) {
        stdout = '%1|@1|0|bash|1|80|24\n';
      } else if (payload.includes("'resize-window' '-t' '@1' '-x' '137' '-y' '41'")) {
        stdout = '';
      } else {
        throw new Error(`unexpected command payload: ${payload}`);
      }

      fakeClient.commandChannel.emit(
        'data',
        Buffer.from(`${stdout}\x1eTMEX_END ${commandId} ${exitCode}\x1e\n`)
      );
    };

    const connection = new SshExternalTmuxConnection(
      {
        deviceId: 'device-ssh',
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
        getDevice: () => createDevice('tmex-ssh-resize'),
        decrypt: async () => 'secret',
        createClient: () => fakeClient as unknown as Client,
      }
    );
    (connection as any).syncPipeReaders = async () => {};

    await connection.connect();
    connection.resizePane('%1', 137, 41);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(
      writes.some((payload) =>
        payload.includes("'set-window-option' '-t' '@1' 'window-size' 'latest'")
      )
    ).toBe(false);
  });

  test('connect does not issue remote cleanup that can delete sibling gateway runtime dirs', async () => {
    const fakeClient = new FakeClient();
    const writes: string[] = [];

    fakeClient.commandChannel.onWrite = (payload) => {
      writes.push(payload);
      const commandId = extractCommandId(payload);

      let stdout = '';
      let exitCode = 0;
      if (payload.includes('command -v tmux')) {
        stdout = 'TMEX_BOOT_OK\t/usr/bin/tmux\ttmux 3.4\t/home/alice\n';
      } else if (payload.includes('mkdir -p')) {
        stdout = '';
      } else if (payload.includes("mkfifo '/tmp/tmex/device-ssh-")) {
        stdout = '';
      } else if (payload.includes("'has-session' '-t' 'tmex-ssh-no-cleanup'")) {
        stdout = "can't find session: tmex-ssh-no-cleanup\n";
        exitCode = 1;
      } else if (
        payload.includes("'new-session' '-d' '-c' '/home/alice' '-s' 'tmex-ssh-no-cleanup'")
      ) {
        stdout = '';
      } else if (payload.includes("'set-hook' '-t' 'tmex-ssh-no-cleanup' 'alert-bell'")) {
        stdout = '';
      } else if (payload.includes("'set-hook' '-t' 'tmex-ssh-no-cleanup' 'pane-exited'")) {
        stdout = '';
      } else if (payload.includes("'set-hook' '-t' 'tmex-ssh-no-cleanup' 'pane-died'")) {
        stdout = '';
      } else if (payload.includes("'set-hook' '-t' 'tmex-ssh-no-cleanup' 'after-new-window'")) {
        stdout = '';
      } else if (payload.includes("'set-hook' '-t' 'tmex-ssh-no-cleanup' 'after-split-window'")) {
        stdout = '';
      } else if (isConfigureSessionOptionPayload(payload, 'tmex-ssh-no-cleanup')) {
        stdout = '';
      } else if (
        payload.includes(
          "'display-message' '-p' '-t' 'tmex-ssh-no-cleanup' '#{session_id}|#{session_name}'"
        )
      ) {
        stdout = '$1|tmex-ssh-no-cleanup\n';
      } else if (payload.includes("'list-windows' '-t' 'tmex-ssh-no-cleanup'")) {
        stdout = '@1|0|main|1\n';
      } else if (payload.includes("'list-panes' '-t' 'tmex-ssh-no-cleanup'")) {
        stdout = '%1|@1|0|bash|1|80|24\n';
      } else {
        throw new Error(`unexpected command payload: ${payload}`);
      }

      fakeClient.commandChannel.emit(
        'data',
        Buffer.from(`${stdout}\x1eTMEX_END ${commandId} ${exitCode}\x1e\n`)
      );
    };

    const connection = new SshExternalTmuxConnection(
      {
        deviceId: 'device-ssh',
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
        getDevice: () => createDevice('tmex-ssh-no-cleanup'),
        decrypt: async () => 'secret',
        createClient: () => fakeClient as unknown as Client,
      }
    );
    (connection as any).syncPipeReaders = async () => {};

    await connection.connect();

    expect(writes.some((payload) => payload.includes('find ') && payload.includes('/tmp/tmex'))).toBe(
      false
    );
  });
});
