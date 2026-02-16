import { describe, expect, test } from 'bun:test';
import { stripAnsi } from './bun';

describe('stripAnsi', () => {
  test('removes CSI sequences', () => {
    expect(stripAnsi('\x1b[31mred text\x1b[0m')).toBe('red text');
    expect(stripAnsi('\x1b[1;33mbold yellow')).toBe('bold yellow');
    expect(stripAnsi('\x1b[?25h')).toBe('');
  });

  test('removes OSC sequences', () => {
    expect(stripAnsi('\x1b]1337;RemoteHost=example\x07path')).toBe('path');
    expect(stripAnsi('\x1b]0;title\x07')).toBe('');
    expect(stripAnsi('\x1b]1337;CurrentDir=/home\x1b\\')).toBe('');
  });

  test('removes mixed sequences', () => {
    expect(stripAnsi('\x1b[31m\x1b]1337;RemoteHost=example\x07red path\x1b[0m')).toBe('red path');
    expect(stripAnsi('before \x1b[1m\x1b]0;title\x07after')).toBe('before after');
  });

  test('keeps text without escape codes', () => {
    expect(stripAnsi('hello world')).toBe('hello world');
    expect(stripAnsi('123')).toBe('123');
    expect(stripAnsi('')).toBe('');
  });

  test('handles empty string', () => {
    expect(stripAnsi('')).toBe('');
  });
});
