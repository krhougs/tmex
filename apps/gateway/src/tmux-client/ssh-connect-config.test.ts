import { describe, expect, test } from 'bun:test';
import type { Device } from '@tmex/shared';

import { resolveSshConnectConfig } from './ssh-connect-config';

const now = '2026-04-16T00:00:00.000Z';

function createConfigRefDevice(): Device {
  return {
    id: 'device-config-ref',
    name: 'ssh-config-ref',
    type: 'ssh',
    authMode: 'configRef',
    sshConfigRef: 'prod-alias',
    session: 'tmex',
    createdAt: now,
    updatedAt: now,
  };
}

describe('resolveSshConnectConfig', () => {
  test('resolves ssh config alias with SSH_AUTH_SOCK agent', async () => {
    const config = await resolveSshConnectConfig(createConfigRefDevice(), async () => '', {
      env: {
        HOME: '/Users/tester',
        SSH_AUTH_SOCK: '/tmp/test-agent.sock',
      },
      runSync: () => ({
        exitCode: 0,
        stdout: ['host prod-alias', 'user root', 'hostname 10.10.10.10', 'port 2200', 'identityagent SSH_AUTH_SOCK'].join('\n'),
        stderr: '',
      }),
      fileExists: (path: string) => path === '/tmp/test-agent.sock',
      readTextFile: () => {
        throw new Error('readTextFile should not be called when agent is available');
      },
    });

    expect(config).toMatchObject({
      host: '10.10.10.10',
      port: 2200,
      username: 'root',
      agent: '/tmp/test-agent.sock',
    });
  });

  test('loads the first readable identity file from ssh config alias', async () => {
    const config = await resolveSshConnectConfig(createConfigRefDevice(), async () => '', {
      env: {
        HOME: '/Users/tester',
      },
      runSync: () => ({
        exitCode: 0,
        stdout: [
          'host prod-alias',
          'user alice',
          'hostname 10.20.30.40',
          'port 22',
          'identityfile ~/.ssh/first_key',
          'identityfile ~/.ssh/second_key',
        ].join('\n'),
        stderr: '',
      }),
      fileExists: (path: string) => path === '/Users/tester/.ssh/second_key',
      readTextFile: (path: string) => {
        expect(path).toBe('/Users/tester/.ssh/second_key');
        return 'PRIVATE_KEY_CONTENT';
      },
    });

    expect(config).toMatchObject({
      host: '10.20.30.40',
      port: 22,
      username: 'alice',
      privateKey: 'PRIVATE_KEY_CONTENT',
    });
  });
});
