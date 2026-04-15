import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { Device, StateSnapshotPayload } from '@tmex/shared';
import type { Client, ClientChannel, ConnectConfig } from 'ssh2';

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
      } else if (
        payload.includes("'display-message' '-p' '-t' 'tmex-ssh-snapshot' '#{session_id}")
      ) {
        stdout = '$1\ttmex-ssh-snapshot\n';
      } else if (payload.includes("'list-windows' '-t' 'tmex-ssh-snapshot'")) {
        stdout = '@1\t0\tmain\t1\n';
      } else if (payload.includes("'list-panes' '-t' 'tmex-ssh-snapshot'")) {
        stdout = '%1\t@1\t0\tbash\t1\t80\t24\n';
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
});
