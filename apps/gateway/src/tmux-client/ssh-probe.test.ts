import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { Device } from '@tmex/shared';
import type { Client, ClientChannel, ConnectConfig } from 'ssh2';

import { probeSshDevice } from './ssh-probe';

const now = '2026-04-16T00:00:00.000Z';

function createDevice(): Device {
  return {
    id: 'device-ssh',
    name: 'ssh',
    type: 'ssh',
    host: 'example.com',
    port: 22,
    username: 'alice',
    authMode: 'password',
    passwordEnc: 'encrypted-password',
    session: 'tmex',
    createdAt: now,
    updatedAt: now,
  };
}

function createPasswordMisconfiguredDevice(): Device {
  return {
    id: 'device-ssh-bad-auth',
    name: 'ssh-bad-auth',
    type: 'ssh',
    host: 'example.com',
    port: 22,
    username: 'alice',
    authMode: 'password',
    session: 'tmex',
    createdAt: now,
    updatedAt: now,
  };
}

class FakeChannel extends EventEmitter {
  readonly stderr = new EventEmitter();
  onWrite?: (data: string) => void;
  endPayload = '';

  write(data: string): boolean {
    this.onWrite?.(data);
    return true;
  }

  override emit(event: string | symbol, ...args: any[]): boolean {
    return super.emit(event, ...args);
  }

  end(data?: string): this {
    if (typeof data === 'string') {
      this.endPayload += data;
      this.onWrite?.(data);
    }
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
    this.execCalls.push({ command, options: actualOptions });
    cb?.(undefined, this.commandChannel as unknown as ClientChannel);
    return this;
  }

  end(): this {
    this.emit('close');
    return this;
  }
}

describe('probeSshDevice', () => {
  test('returns ready phase when ssh transport and tmux bootstrap succeed', async () => {
    const fakeClient = new FakeClient();

    fakeClient.commandChannel.onWrite = (payload) => {
      expect(payload).toContain('command -v tmux');
      fakeClient.commandChannel.emit(
        'data',
        Buffer.from('TMEX_BOOT_OK\t/usr/bin/tmux\ttmux 3.4\t/home/alice\n')
      );
      queueMicrotask(() => {
        fakeClient.commandChannel.emit('close');
      });
    };

    const result = await probeSshDevice('device-ssh', {
      getDevice: () => createDevice(),
      decrypt: async () => 'secret',
      createClient: () => fakeClient as unknown as Client,
    });

    expect(fakeClient.connectConfig).toMatchObject({
      host: 'example.com',
      port: 22,
      username: 'alice',
      password: 'secret',
    });
    expect(fakeClient.execCalls).toEqual([
      {
        command: '/bin/sh -s',
        options: { pty: false },
      },
    ]);
    expect(result).toEqual({
      success: true,
      tmuxAvailable: true,
      phase: 'ready',
    });
  });

  test('ends bootstrap stdin so real ssh probe can complete', async () => {
    const fakeClient = new FakeClient();

    fakeClient.commandChannel.onWrite = (payload) => {
      expect(payload).toContain('command -v tmux');
      fakeClient.commandChannel.emit(
        'data',
        Buffer.from('TMEX_BOOT_OK\t/usr/bin/tmux\ttmux 3.4\t/home/alice\n')
      );
    };

    const channel = fakeClient.commandChannel;
    const originalEnd = channel.end.bind(channel);
    let endCalled = false;
    channel.end = (...args: [string?]) => {
      endCalled = true;
      return originalEnd(typeof args[0] === 'string' ? args[0] : undefined);
    };

    const result = await Promise.race([
      probeSshDevice('device-ssh', {
        getDevice: () => createDevice(),
        decrypt: async () => 'secret',
        createClient: () => fakeClient as unknown as Client,
      }),
      new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error('probe did not finish after bootstrap output'));
        }, 50);
      }),
    ]);

    expect(endCalled).toBe(true);
    expect(result).toEqual({
      success: true,
      tmuxAvailable: true,
      phase: 'ready',
    });
  });

  test('returns structured connect failure when auth config resolution throws', async () => {
    const result = await probeSshDevice('device-ssh-bad-auth', {
      getDevice: () => createPasswordMisconfiguredDevice(),
      decrypt: async () => 'unused',
      createClient: () => new FakeClient() as unknown as Client,
    });

    expect(result.success).toBe(false);
    expect(result.tmuxAvailable).toBe(false);
    expect(result.phase).toBe('connect');
    expect(result.rawMessage).toContain('auth_password_missing');
  });
});
