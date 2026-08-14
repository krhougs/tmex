import { describe, expect, test } from 'bun:test';
import { buildDelegatedUpgradeArgs } from './upgrade';

describe('upgrade handoff contract', () => {
  test('keeps the tmex-cli registry channel and hidden apply-current-package handoff', () => {
    const args = buildDelegatedUpgradeArgs(
      {
        command: 'upgrade',
        positionals: [],
        flags: {
          'install-dir': '/tmp/tmex',
          'service-name': 'tmex-test',
          lang: 'zh-CN',
        },
      },
      '1.2.3'
    );

    expect(args.slice(0, 4)).toEqual([
      '--yes',
      'tmex-cli@1.2.3',
      'upgrade',
      '--apply-current-package',
    ]);
    expect(args).toContain('/tmp/tmex');
    expect(args).toContain('tmex-test');
  });
});
