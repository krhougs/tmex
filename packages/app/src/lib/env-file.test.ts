import { describe, expect, test } from 'bun:test';
import { parseEnvContent, stringifyEnv } from './env-file';

describe('env-file', () => {
  test('parses env content', () => {
    const parsed = parseEnvContent('A=1\nB=hello\n# comment\n');
    expect(parsed).toEqual({ A: '1', B: 'hello' });
  });

  test('stringifies env with stable order', () => {
    const text = stringifyEnv({ B: '2', A: '1' });
    expect(text).toBe('A=1\nB=2\n');
  });
});
