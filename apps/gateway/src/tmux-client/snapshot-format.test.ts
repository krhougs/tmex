import { describe, expect, test } from 'bun:test';

import {
  SNAPSHOT_FIELD_SEPARATOR,
  formatSnapshotRowForLog,
  isTmuxPaneId,
  isTmuxSessionId,
  isTmuxWindowId,
  parseSnapshotInteger,
  splitSnapshotFields,
} from './snapshot-format';

describe('snapshot format helpers', () => {
  test('uses a locale-stable visible ASCII field separator', () => {
    expect(SNAPSHOT_FIELD_SEPARATOR).toBe('|');
  });

  test('keeps separator characters inside flexible middle fields', () => {
    expect(splitSnapshotFields('@1|0|name|with|pipe|1', 4)).toEqual([
      '@1',
      '0',
      'name|with|pipe',
      '1',
    ]);

    expect(splitSnapshotFields('%1|@1|0|title|with|pipe|1|80|24|1|node', 9)).toEqual([
      '%1',
      '@1',
      '0',
      'title|with|pipe',
      '1',
      '80',
      '24',
      '1',
      'node',
    ]);
  });

  test('validates tmux id shapes', () => {
    expect(isTmuxSessionId('$1')).toBe(true);
    expect(isTmuxSessionId('$abc')).toBe(false);

    expect(isTmuxWindowId('@1')).toBe(true);
    expect(isTmuxWindowId('@0_0_bash_1')).toBe(false);

    expect(isTmuxPaneId('%1')).toBe(true);
    expect(isTmuxPaneId('%1_bad')).toBe(false);
  });

  test('parses snapshot integers strictly', () => {
    expect(parseSnapshotInteger('0')).toBe(0);
    expect(parseSnapshotInteger('80')).toBe(80);
    expect(parseSnapshotInteger('0abc')).toBeNull();
    expect(parseSnapshotInteger('80x')).toBeNull();
    expect(parseSnapshotInteger('')).toBeNull();
    expect(parseSnapshotInteger(undefined)).toBeNull();
  });

  test('truncates snapshot rows before logging', () => {
    const row = `@1|0|${'x'.repeat(200)}|1`;
    const formatted = formatSnapshotRowForLog(row);

    expect(formatted.length).toBeLessThan(row.length);
    expect(formatted.endsWith('...')).toBe(true);
  });
});
