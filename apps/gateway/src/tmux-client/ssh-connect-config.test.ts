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

function createAgentDevice(): Device {
  return {
    id: 'device-agent',
    name: 'ssh-agent',
    type: 'ssh',
    host: '10.110.88.5',
    port: 22,
    username: 'root',
    authMode: 'agent',
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

  test('agent mode falls back to implicit identity files with auth handler ordering', async () => {
    const config = await resolveSshConnectConfig(createAgentDevice(), async () => '', {
      env: {
        HOME: '/Users/tester',
        SSH_AUTH_SOCK: '/tmp/test-agent.sock',
      },
      runSync: (cmd) => {
        expect(cmd).toEqual(['ssh', '-G', '-p', '22', 'root@10.110.88.5']);
        return {
          exitCode: 0,
          stdout: [
            'host 10.110.88.5',
            'user root',
            'hostname 10.110.88.5',
            'port 22',
            'identityfile ~/.ssh/id_ed25519',
          ].join('\n'),
          stderr: '',
        };
      },
      fileExists: (path: string) =>
        path === '/tmp/test-agent.sock' || path === '/Users/tester/.ssh/id_ed25519',
      readTextFile: (path: string) => {
        expect(path).toBe('/Users/tester/.ssh/id_ed25519');
        return 'PRIVATE_KEY_CONTENT';
      },
    });

    expect(config).toMatchObject({
      host: '10.110.88.5',
      port: 22,
      username: 'root',
      agent: '/tmp/test-agent.sock',
    });
    expect(config.privateKey).toBeUndefined();
    expect(config.authHandler).toEqual([
      {
        type: 'agent',
        username: 'root',
        agent: '/tmp/test-agent.sock',
      },
      {
        type: 'publickey',
        username: 'root',
        key: 'PRIVATE_KEY_CONTENT',
      },
    ]);
  });

  test('agent mode keeps current behavior when implicit identity file discovery fails', async () => {
    const config = await resolveSshConnectConfig(createAgentDevice(), async () => '', {
      env: {
        HOME: '/Users/tester',
        SSH_AUTH_SOCK: '/tmp/test-agent.sock',
      },
      runSync: (cmd) => {
        expect(cmd).toEqual(['ssh', '-G', '-p', '22', 'root@10.110.88.5']);
        return {
          exitCode: 1,
          stdout: '',
          stderr: 'ssh lookup failed',
        };
      },
      fileExists: (path: string) => path === '/tmp/test-agent.sock',
      readTextFile: () => {
        throw new Error('readTextFile should not be called when ssh -G fails');
      },
    });

    expect(config).toMatchObject({
      host: '10.110.88.5',
      port: 22,
      username: 'root',
      agent: '/tmp/test-agent.sock',
    });
    expect(config.privateKey).toBeUndefined();
    expect(config.authHandler).toBeUndefined();
  });

  test('agent mode keeps ssh -G identity file order for multiple readable keys', async () => {
    const config = await resolveSshConnectConfig(createAgentDevice(), async () => '', {
      env: {
        HOME: '/Users/tester',
        SSH_AUTH_SOCK: '/tmp/test-agent.sock',
      },
      runSync: (cmd) => {
        expect(cmd).toEqual(['ssh', '-G', '-p', '22', 'root@10.110.88.5']);
        return {
          exitCode: 0,
          stdout: [
            'host 10.110.88.5',
            'user root',
            'hostname 10.110.88.5',
            'port 22',
            'identityfile ~/.ssh/id_rsa',
            'identityfile ~/.ssh/id_ed25519',
          ].join('\n'),
          stderr: '',
        };
      },
      fileExists: (path: string) =>
        path === '/tmp/test-agent.sock' ||
        path === '/Users/tester/.ssh/id_rsa' ||
        path === '/Users/tester/.ssh/id_ed25519',
      readTextFile: (path: string) => {
        if (path === '/Users/tester/.ssh/id_rsa') {
          return 'RSA_PRIVATE_KEY_CONTENT';
        }
        if (path === '/Users/tester/.ssh/id_ed25519') {
          return 'ED25519_PRIVATE_KEY_CONTENT';
        }
        throw new Error(`unexpected path: ${path}`);
      },
    });

    expect(config.authHandler).toEqual([
      {
        type: 'agent',
        username: 'root',
        agent: '/tmp/test-agent.sock',
      },
      {
        type: 'publickey',
        username: 'root',
        key: 'RSA_PRIVATE_KEY_CONTENT',
      },
      {
        type: 'publickey',
        username: 'root',
        key: 'ED25519_PRIVATE_KEY_CONTENT',
      },
    ]);
  });
});
