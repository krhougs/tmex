import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import type { Device } from '@tmex/shared';
import type { ConnectConfig } from 'ssh2';
import {
  RsyncAuthError,
  buildRsyncDeviceSpec,
  rsyncCopyArgs,
  rsyncListArgs,
  rsyncTargetArg,
} from './ssh-command';

function device(overrides: Partial<Device>): Device {
  return {
    id: 'd1',
    name: 'dev',
    type: 'ssh',
    authMode: 'key',
    sortOrder: 0,
    createdAt: '',
    updatedAt: '',
    ...overrides,
  } as Device;
}

const noopDecrypt = (async () => '') as never;

describe('buildRsyncDeviceSpec', () => {
  test('local device → empty prefix, no rsh', async () => {
    const spec = await buildRsyncDeviceSpec(
      device({ type: 'local', authMode: 'auto' }),
      noopDecrypt
    );
    expect(spec.targetPrefix).toBe('');
    expect(spec.rsh).toBeUndefined();
    spec.cleanup();
  });

  test('password authMode uses SSH_ASKPASS (no extra binary), not BatchMode', async () => {
    const resolveConfig = (async () =>
      ({ host: 'h', port: 22, username: 'u', password: 'secret' }) as ConnectConfig) as never;
    const spec = await buildRsyncDeviceSpec(
      device({ authMode: 'password', passwordEnc: 'x' }),
      noopDecrypt,
      resolveConfig
    );
    expect(spec.targetPrefix).toBe('u@h:');
    expect(spec.env.SSH_ASKPASS_REQUIRE).toBe('force');
    expect(spec.env.TMEX_RSYNC_SECRET).toBe('secret');
    expect(existsSync(spec.env.SSH_ASKPASS)).toBe(true);
    expect(spec.rsh).not.toContain('BatchMode=yes');
    expect(spec.rsh).toContain('PreferredAuthentications=password');
    const apPath = spec.env.SSH_ASKPASS;
    spec.cleanup();
    expect(existsSync(apPath)).toBe(false);
  });

  test('configRef uses ssh alias', async () => {
    const spec = await buildRsyncDeviceSpec(
      device({ authMode: 'configRef', sshConfigRef: 'myhost' }),
      noopDecrypt
    );
    expect(spec.targetPrefix).toBe('myhost:');
    expect(spec.rsh).toContain('ssh');
    expect(spec.rsh).toContain('BatchMode=yes');
    spec.cleanup();
  });

  test('key authMode writes a temp 0600 key file and adds -i', async () => {
    const resolveConfig = (async () =>
      ({ host: 'h', port: 2222, username: 'u', privateKey: 'PEM-DATA' }) as ConnectConfig) as never;
    const spec = await buildRsyncDeviceSpec(
      device({ authMode: 'key', privateKeyEnc: 'x' }),
      noopDecrypt,
      resolveConfig
    );
    expect(spec.targetPrefix).toBe('u@h:');
    expect(spec.rsh).toContain('-p 2222');
    const keyMatch = /-i (\S+)/.exec(spec.rsh ?? '');
    expect(keyMatch).not.toBeNull();
    const keyPath = keyMatch?.[1] as string;
    expect(existsSync(keyPath)).toBe(true);
    expect(readFileSync(keyPath, 'utf8')).toBe('PEM-DATA');
    spec.cleanup();
    expect(existsSync(keyPath)).toBe(false);
  });

  test('agent authMode passes SSH_AUTH_SOCK env, no -i', async () => {
    const resolveConfig = (async () =>
      ({ host: 'h', port: 22, username: 'u', agent: '/tmp/agent.sock' }) as ConnectConfig) as never;
    const spec = await buildRsyncDeviceSpec(
      device({ authMode: 'agent' }),
      noopDecrypt,
      resolveConfig
    );
    expect(spec.env.SSH_AUTH_SOCK).toBe('/tmp/agent.sock');
    expect(spec.rsh).not.toContain('-i ');
    spec.cleanup();
  });

  test('passphrase key uses temp key + SSH_ASKPASS for the passphrase', async () => {
    const resolveConfig = (async () =>
      ({
        host: 'h',
        port: 22,
        username: 'u',
        privateKey: 'PEM',
        passphrase: 'pp',
      }) as ConnectConfig) as never;
    const spec = await buildRsyncDeviceSpec(
      device({ authMode: 'key' }),
      noopDecrypt,
      resolveConfig
    );
    expect(spec.rsh).toContain('-i ');
    expect(spec.env.TMEX_RSYNC_SECRET).toBe('pp');
    expect(existsSync(spec.env.SSH_ASKPASS)).toBe(true);
    expect(spec.rsh).not.toContain('BatchMode=yes');
    spec.cleanup();
  });

  test('no usable auth → unsupported', async () => {
    const resolveConfig = (async () =>
      ({ host: 'h', port: 22, username: 'u' }) as ConnectConfig) as never;
    await expect(
      buildRsyncDeviceSpec(device({ authMode: 'auto' }), noopDecrypt, resolveConfig)
    ).rejects.toBeInstanceOf(RsyncAuthError);
  });
});

describe('rsync arg builders', () => {
  const localSpec = { targetPrefix: '', rsh: undefined, env: {}, cleanup: () => {} };
  const sshSpec = { targetPrefix: 'u@h:', rsh: 'ssh -p 22', env: {}, cleanup: () => {} };

  test('local target is the raw path', () => {
    expect(rsyncTargetArg(localSpec, '/a/b')).toBe('/a/b');
  });
  test('ssh target single-quotes the remote path', () => {
    expect(rsyncTargetArg(sshSpec, "/a/b'c")).toBe("u@h:'/a/b'\\''c'");
  });
  test('list args (local)', () => {
    expect(rsyncListArgs(localSpec, '/a/')).toEqual(['--list-only', '/a/']);
  });
  test('list args (ssh) include -e', () => {
    expect(rsyncListArgs(sshSpec, '/a/')).toEqual(['--list-only', '-e', 'ssh -p 22', "u@h:'/a/'"]);
  });
  test('copy args follow symlinks (-L)', () => {
    expect(rsyncCopyArgs(localSpec, '/a/f', '/tmp/d')).toEqual(['-L', '/a/f', '/tmp/d']);
    expect(rsyncCopyArgs(sshSpec, '/a/f', '/tmp/d')).toEqual([
      '-L',
      '-e',
      'ssh -p 22',
      "u@h:'/a/f'",
      '/tmp/d',
    ]);
  });
});
