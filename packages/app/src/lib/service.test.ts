import { describe, expect, test } from 'bun:test';
import { buildSystemdServiceContent } from './service';

describe('buildSystemdServiceContent', () => {
  test('renders absolute WorkingDirectory without wrapping quotes', () => {
    const content = buildSystemdServiceContent({
      serviceName: 'tmex',
      installDir: '/home/krhougs/.local/share/tmex',
      runScriptPath: '/home/krhougs/.local/share/tmex/run.sh',
      autostart: true,
    });

    expect(content).toContain('WorkingDirectory=/home/krhougs/.local/share/tmex');
    expect(content).not.toContain('WorkingDirectory="/home/krhougs/.local/share/tmex"');
    expect(content).toContain('ExecStart=/usr/bin/env bash "/home/krhougs/.local/share/tmex/run.sh"');
    expect(content).toContain('SyslogIdentifier=tmex');
    expect(content).toContain('StandardOutput=journal');
    expect(content).toContain('StandardError=journal');
  });
});
