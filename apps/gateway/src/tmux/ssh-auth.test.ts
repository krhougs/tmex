import { describe, expect, test } from 'bun:test';
import { resolveSshAgentSocket, resolveSshUsername } from './ssh-auth';

describe('resolveSshUsername', () => {
  test('优先使用设备里显式填写的用户名', () => {
    const username = resolveSshUsername('alice', 'agent', {
      USER: 'bob',
      LOGNAME: 'bob',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
    });

    expect(username).toBe('alice');
  });

  test('agent 模式未填写用户名时使用当前系统用户', () => {
    const username = resolveSshUsername(undefined, 'agent', {
      USER: 'krhougs',
      LOGNAME: 'krhougs',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
    });

    expect(username).toBe('krhougs');
  });

  test('auto 模式未填写用户名时同样使用当前系统用户', () => {
    const username = resolveSshUsername(undefined, 'auto', {
      USER: 'krhougs',
      LOGNAME: 'krhougs',
    });

    expect(username).toBe('krhougs');
  });

  test('在 agent/auto 场景找不到系统用户时回退到 root', () => {
    const username = resolveSshUsername(undefined, 'agent', {});
    expect(username).toBe('root');
  });
});

describe('resolveSshAgentSocket', () => {
  test('agent 模式下读取 SSH_AUTH_SOCK', () => {
    const socket = resolveSshAgentSocket('agent', {
      SSH_AUTH_SOCK: '/tmp/agent.sock',
    });

    expect(socket).toBe('/tmp/agent.sock');
  });

  test('agent 模式下缺少 SSH_AUTH_SOCK 时抛错', () => {
    expect(() => resolveSshAgentSocket('agent', {})).toThrow(
      'SSH_AUTH_SOCK 未设置，无法使用 SSH Agent 认证'
    );
  });

  test('非 agent 模式忽略 SSH_AUTH_SOCK', () => {
    const socket = resolveSshAgentSocket('password', {});
    expect(socket).toBeUndefined();
  });
});
