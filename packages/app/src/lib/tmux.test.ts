import { describe, expect, test } from 'bun:test';
import { checkTmuxVersion, compareTmuxVersion, parseTmuxVersion } from './tmux';

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

  test('parses version with extra whitespace', () => {
    expect(parseTmuxVersion('  tmux 3.4  ')).toEqual({ major: 3, minor: 4 });
  });
});

describe('compareTmuxVersion', () => {
  const min = { major: 3, minor: 0 };

  test('accepts >= 3.0', () => {
    expect(compareTmuxVersion({ major: 3, minor: 0 }, min)).toBe(true);
    expect(compareTmuxVersion({ major: 3, minor: 4 }, min)).toBe(true);
    expect(compareTmuxVersion({ major: 4, minor: 0 }, min)).toBe(true);
  });

  test('rejects < 3.0', () => {
    expect(compareTmuxVersion({ major: 2, minor: 9 }, min)).toBe(false);
    expect(compareTmuxVersion({ major: 1, minor: 8 }, min)).toBe(false);
  });

  test('accepts null version (master/unknown)', () => {
    expect(compareTmuxVersion(null, min)).toBe(true);
  });
});

describe('checkTmuxVersion', () => {
  test('returns ok on a system with tmux installed', async () => {
    const result = await checkTmuxVersion();
    expect(result.ok).toBe(true);
    expect(result.versionRaw).toBeTruthy();
  });

  test('returns version-too-low with unrealistically high min', async () => {
    const result = await checkTmuxVersion({ major: 999, minor: 0 });
    if (result.ok) {
      // tmux might have unparseable version (master), which passes
      expect(result.version).toBeUndefined();
    } else {
      expect(result.reason).toBe('version-too-low');
    }
  });
});
