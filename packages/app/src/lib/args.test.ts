import { describe, expect, test } from 'bun:test';
import { parseArgs } from './args';

describe('parseArgs', () => {
  test('parses command, flags and positionals', () => {
    const parsed = parseArgs(['init', '--host', '0.0.0.0', '--port=9883', 'extra']);

    expect(parsed.command).toBe('init');
    expect(parsed.positionals).toEqual(['extra']);
    expect(parsed.flags.host).toBe('0.0.0.0');
    expect(parsed.flags.port).toBe('9883');
  });

  test('parses boolean flags', () => {
    const parsed = parseArgs(['doctor', '--json', '--no-interactive']);
    expect(parsed.flags.json).toBe(true);
    expect(parsed.flags['no-interactive']).toBe(true);
  });

  test('allows global flags before command', () => {
    const parsed = parseArgs(['--lang', 'zh-CN', 'doctor', '--json']);
    expect(parsed.command).toBe('doctor');
    expect(parsed.flags.lang).toBe('zh-CN');
    expect(parsed.flags.json).toBe(true);
  });
});
