import { describe, expect, test } from 'bun:test';

import { isControlModeSupported, parseTmuxVersion } from './tmux-version';

describe('parseTmuxVersion', () => {
  test('parses release versions', () => {
    expect(parseTmuxVersion('tmux 3.4')).toEqual({ major: 3, minor: 4 });
    expect(parseTmuxVersion('tmux 3.3a')).toEqual({ major: 3, minor: 3 });
    expect(parseTmuxVersion('tmux 2.9a')).toEqual({ major: 2, minor: 9 });
  });

  test('parses next/dev versions', () => {
    expect(parseTmuxVersion('tmux next-3.6')).toEqual({ major: 3, minor: 6 });
  });

  test('returns null for unversioned builds', () => {
    expect(parseTmuxVersion('tmux master')).toBeNull();
    expect(parseTmuxVersion('')).toBeNull();
  });
});

describe('isControlModeSupported', () => {
  test('accepts >= 3.0 and unknown versions', () => {
    expect(isControlModeSupported({ major: 3, minor: 0 })).toBe(true);
    expect(isControlModeSupported({ major: 3, minor: 4 })).toBe(true);
    expect(isControlModeSupported({ major: 4, minor: 0 })).toBe(true);
    expect(isControlModeSupported(null)).toBe(true);
  });

  test('rejects < 3.0', () => {
    expect(isControlModeSupported({ major: 2, minor: 9 })).toBe(false);
    expect(isControlModeSupported({ major: 1, minor: 8 })).toBe(false);
  });
});
