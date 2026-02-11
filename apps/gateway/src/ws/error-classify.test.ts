import { describe, expect, test } from 'bun:test';
import { classifySshError } from './error-classify';

describe('classifySshError', () => {
  test('classifies ssh config ref not supported', () => {
    const result = classifySshError(
      new Error('ssh_config_ref_not_supported: 当前版本暂不支持 SSH Config 引用')
    );
    expect(result.type).toBe('ssh_config_ref_not_supported');
  });

  test('classifies missing SSH_AUTH_SOCK', () => {
    const result = classifySshError(new Error('SSH_AUTH_SOCK 未设置，无法使用 SSH Agent 认证'));
    expect(result.type).toBe('agent_unavailable');
  });

  test('classifies connection refused', () => {
    const result = classifySshError(new Error('connect ECONNREFUSED 127.0.0.1:22'));
    expect(result.type).toBe('connection_refused');
  });

  test('classifies tmux unavailable', () => {
    const result = classifySshError(new Error('tmux: command not found'));
    expect(result.type).toBe('tmux_unavailable');
  });
});

