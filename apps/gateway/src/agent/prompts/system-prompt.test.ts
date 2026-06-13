import { describe, expect, test } from 'bun:test';
import type { AgentEnvironmentInfo } from './environment';
import { buildAgentSystemPrompt } from './index';

const baseEnv: AgentEnvironmentInfo = {
  deviceName: 'lab-router',
  deviceType: 'ssh',
  host: '10.0.0.1',
  username: 'admin',
  port: 22,
  tmuxSession: 'tmex',
  timezone: 'Asia/Shanghai',
  nowIso: '2026-06-13T08:00:00.000Z',
  gatewayOs: null,
  gatewayShell: null,
};

describe('system prompt 组装', () => {
  test('包含全部关键段落', () => {
    const out = buildAgentSystemPrompt({
      paneId: '%3',
      writeMode: 'confirm',
      customSystemPrompt: null,
      environment: baseEnv,
    });
    expect(out).toContain('terminal assistant agent');
    expect(out).toContain('pane %3');
    expect(out).toContain('## Entry host');
    expect(out).toContain('## Know your actual working environment');
    expect(out).toContain('## Terminal window size');
    expect(out).toContain('## Terminal tools');
    expect(out).toContain('## Network devices');
    expect(out).toContain('MikroTik');
    expect(out).toContain('Juniper');
    expect(out).toContain('## Untrusted content');
    expect(out).toContain('## Credentials');
    expect(out).toContain('## Understand intent');
    expect(out).toContain('## Safety');
    expect(out).toContain('## General');
    // 段落以空行分隔
    expect(out).toContain('\n\n');
  });

  test('ssh 设备注入 SSH target，不含 entry-host OS', () => {
    const out = buildAgentSystemPrompt({
      paneId: '%1',
      writeMode: 'auto',
      customSystemPrompt: null,
      environment: baseEnv,
    });
    expect(out).toContain('SSH target: admin@10.0.0.1:22');
    expect(out).toContain('Timezone: Asia/Shanghai');
    expect(out).not.toContain('Entry-host OS');
  });

  test('local 设备注入 OS/shell，不含 SSH target', () => {
    const out = buildAgentSystemPrompt({
      paneId: '%1',
      writeMode: 'auto',
      customSystemPrompt: null,
      environment: {
        ...baseEnv,
        deviceType: 'local',
        host: null,
        username: null,
        port: null,
        gatewayOs: 'darwin 27.0.0 (arm64)',
        gatewayShell: '/bin/zsh',
      },
    });
    expect(out).toContain('Entry-host OS: darwin 27.0.0 (arm64)');
    expect(out).toContain('Entry-host shell: /bin/zsh');
    expect(out).not.toContain('SSH target');
  });

  test('writeMode 分支', () => {
    const confirm = buildAgentSystemPrompt({
      paneId: '%1',
      writeMode: 'confirm',
      customSystemPrompt: null,
      environment: baseEnv,
    });
    const auto = buildAgentSystemPrompt({
      paneId: '%1',
      writeMode: 'auto',
      customSystemPrompt: null,
      environment: baseEnv,
    });
    expect(confirm).toContain('requires explicit user approval');
    expect(auto).toContain('without per-call confirmation');
  });

  test('custom 指令拼在末尾且不加列表前缀', () => {
    const out = buildAgentSystemPrompt({
      paneId: '%1',
      writeMode: 'confirm',
      customSystemPrompt: '  使用粤语回复。\n第二行。  ',
      environment: baseEnv,
    });
    expect(out).toContain('## Additional instructions from the user\n使用粤语回复。\n第二行。');
    expect(out.trimEnd().endsWith('第二行。')).toBe(true);
  });

  test('无 custom 时不出现该段', () => {
    const out = buildAgentSystemPrompt({
      paneId: '%1',
      writeMode: 'confirm',
      customSystemPrompt: '   ',
      environment: baseEnv,
    });
    expect(out).not.toContain('## Additional instructions from the user');
  });
});
