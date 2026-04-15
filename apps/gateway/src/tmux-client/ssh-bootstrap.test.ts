import { describe, expect, test } from 'bun:test';

import { buildSshBootstrapScript, parseSshBootstrapOutput } from './ssh-bootstrap';

describe('ssh-bootstrap', () => {
  test('buildSshBootstrapScript probes tmux and home dir', () => {
    const script = buildSshBootstrapScript();

    expect(script).toContain('command -v tmux');
    expect(script).toContain('TMEX_BOOT_OK');
    expect(script).toContain('TMEX_BOOT_FAIL');
    expect(script).toContain('HOME_DIR="${HOME:-$(pwd)}"');
  });

  test('parseSshBootstrapOutput parses success payload', () => {
    expect(
      parseSshBootstrapOutput('noise\nTMEX_BOOT_OK\t/usr/bin/tmux\ttmux 3.4\t/home/alice\n')
    ).toEqual({
      ok: true,
      tmuxBin: '/usr/bin/tmux',
      tmuxVersion: 'tmux 3.4',
      homeDir: '/home/alice',
    });
  });

  test('parseSshBootstrapOutput parses failure payload', () => {
    expect(parseSshBootstrapOutput('TMEX_BOOT_FAIL\ttmux_not_found\n')).toEqual({
      ok: false,
      reason: 'tmux_not_found',
    });
  });

  test('parseSshBootstrapOutput rejects missing markers', () => {
    expect(parseSshBootstrapOutput('hello world\n')).toEqual({
      ok: false,
      reason: 'missing_bootstrap_marker',
    });
  });
});
