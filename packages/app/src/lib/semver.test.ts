import { describe, expect, test } from 'bun:test';
import { compareSemver, parseSemver } from './semver';

describe('semver', () => {
  test('parses basic versions', () => {
    expect(parseSemver('1.3.9')).toEqual({ major: 1, minor: 3, patch: 9 });
    expect(parseSemver('0.0.1')).toEqual({ major: 0, minor: 0, patch: 1 });
  });

  test('ignores suffix', () => {
    expect(parseSemver('1.3.9-canary.1')).toEqual({ major: 1, minor: 3, patch: 9 });
  });

  test('compares versions', () => {
    expect(compareSemver('1.3.0', '1.3.0')).toBe(0);
    expect(compareSemver('1.3.1', '1.3.0')).toBe(1);
    expect(compareSemver('1.2.9', '1.3.0')).toBe(-1);
  });
});
