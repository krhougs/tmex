import { describe, expect, test } from 'bun:test';
import { normalizeHistoryForTerminal, normalizeLiveOutputForTerminal } from './normalization';

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

describe('normalizeHistoryForTerminal', () => {
  test('keeps intermediate line breaks but should not advance past the last visible row', () => {
    expect(normalizeHistoryForTerminal('row-1\nrow-2\n')).toBe('row-1\r\nrow-2');
  });

  test('normalizes CRLF input without leaving a trailing terminal advance', () => {
    expect(normalizeHistoryForTerminal('row-1\r\nrow-2\r\n')).toBe('row-1\r\nrow-2');
  });
});

describe('normalizeLiveOutputForTerminal', () => {
  test('preserves CRLF chunk boundaries without inserting duplicate CR', () => {
    const first = normalizeLiveOutputForTerminal(new TextEncoder().encode('a\r'), false);
    const second = normalizeLiveOutputForTerminal(new TextEncoder().encode('\nb'), first.endedWithCR);

    expect(decode(first.normalized)).toBe('a\r');
    expect(decode(second.normalized)).toBe('\nb');
  });
});
