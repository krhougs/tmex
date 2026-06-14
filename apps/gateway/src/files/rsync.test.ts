import { describe, expect, test } from 'bun:test';
import { classifyRsyncFailure, parseListOnly, parseRsyncProgress } from './rsync';

describe('parseListOnly', () => {
  test('parses openrsync (macOS) output, skips dot entries', () => {
    const out = [
      'drwxr-xr-x          160 2026/06/14 15:06:34 .',
      '-rw-r--r--            5 2026/06/14 15:06:34 a.txt',
      'lrwxr-xr-x           22 2026/06/14 15:06:34 link',
      'drwxr-xr-x           64 2026/06/14 15:06:34 sub',
    ].join('\n');
    const entries = parseListOnly(out);
    expect(entries.map((e) => e.name)).toEqual(['a.txt', 'link', 'sub']);
    const byName = Object.fromEntries(entries.map((e) => [e.name, e]));
    expect(byName['a.txt'].type).toBe('file');
    expect(byName['a.txt'].size).toBe(5);
    expect(byName.link.type).toBe('symlink');
    expect(byName.sub.type).toBe('dir');
    expect(byName.sub.size).toBeNull();
    expect(byName['a.txt'].modifiedAt).toBe('2026-06-14T15:06:34');
  });

  test('parses GNU rsync output: comma sizes + symlink target', () => {
    const out = [
      'drwxr-xr-x        4,096 2024/01/15 10:30:00 .',
      '-rw-r--r--        1,234 2024/01/15 10:30:00 file.txt',
      'lrwxrwxrwx           10 2024/01/15 10:30:00 mylink -> /etc/hosts',
    ].join('\n');
    const entries = parseListOnly(out);
    expect(entries.map((e) => e.name)).toEqual(['file.txt', 'mylink']);
    expect(entries[0].size).toBe(1234);
    expect(entries[1].type).toBe('symlink');
    expect(entries[1].name).toBe('mylink');
  });

  test('handles names with spaces', () => {
    const out = '-rw-r--r--            5 2026/06/14 15:06:34 my file.txt';
    expect(parseListOnly(out)[0].name).toBe('my file.txt');
  });

  test('ignores non-matching lines', () => {
    const out = 'receiving file list ... done\n-rw-r--r-- 5 2026/06/14 15:06:34 a\n';
    expect(parseListOnly(out).map((e) => e.name)).toEqual(['a']);
  });
});

describe('parseRsyncProgress', () => {
  test('parses openrsync --progress line', () => {
    const p = parseRsyncProgress(
      '              5 100%  353.10KB/s   00:00:00 (xfer#1, to-check=0/1)'
    );
    expect(p).toEqual({ transferred: 5, pct: 100, rate: '353.10KB/s' });
  });
  test('parses GNU rsync --progress line with comma sizes', () => {
    const p = parseRsyncProgress('      1,234,567  45%    1.23MB/s    0:00:12');
    expect(p).toEqual({ transferred: 1234567, pct: 45, rate: '1.23MB/s' });
  });
  test('parses GNU final line with xfr marker', () => {
    const p = parseRsyncProgress('     2,000,000 100%   10.5MB/s    0:00:00 (xfr#1, to-chk=0/1)');
    expect(p).toEqual({ transferred: 2000000, pct: 100, rate: '10.5MB/s' });
  });
  test('returns null for non-progress lines', () => {
    expect(parseRsyncProgress('sending incremental file list')).toBeNull();
    expect(parseRsyncProgress('myfile.txt')).toBeNull();
    expect(parseRsyncProgress('')).toBeNull();
  });
});

describe('classifyRsyncFailure', () => {
  test('detects remote rsync missing', () => {
    expect(classifyRsyncFailure(127, 'bash: rsync: command not found')).toBe(
      'rsync_missing_remote'
    );
  });
  test('auth failure → connection_failed', () => {
    expect(classifyRsyncFailure(255, 'Permission denied (publickey).')).toBe('connection_failed');
  });
  test('path permission → permission_denied', () => {
    expect(classifyRsyncFailure(23, 'rsync: opendir "/root" failed: Permission denied (13)')).toBe(
      'permission_denied'
    );
  });
  test('connection errors → connection_failed', () => {
    expect(classifyRsyncFailure(255, 'ssh: connect to host x port 22: Connection refused')).toBe(
      'connection_failed'
    );
    expect(classifyRsyncFailure(255, 'Host key verification failed.')).toBe('connection_failed');
  });
  test('missing path → not_found', () => {
    expect(
      classifyRsyncFailure(23, 'rsync: link_stat "/x" failed: No such file or directory (2)')
    ).toBe('not_found');
  });
  test('timeout exit code', () => {
    expect(classifyRsyncFailure(124, '')).toBe('timeout');
  });
});
