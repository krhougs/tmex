import { describe, expect, test } from 'bun:test';
import { classifyRsyncFailure, parseListOnly, parseRsyncProgress, unescapeOctal } from './rsync';

describe('unescapeOctal', () => {
  test('pure ASCII unchanged', () => {
    expect(unescapeOctal('hello.txt')).toBe('hello.txt');
  });

  test('single CJK character', () => {
    expect(unescapeOctal('\\344\\270\\211.md')).toBe('三.md');
  });

  test('multiple CJK characters', () => {
    expect(unescapeOctal('\\344\\270\\211\\347\\224\\263.md')).toBe('三申.md');
  });

  test('mixed ASCII and CJK', () => {
    expect(unescapeOctal('2022-\\346\\274\\224\\347\\244\\272.md')).toBe('2022-演示.md');
  });

  test('full issue sample', () => {
    expect(
      unescapeOctal(
        '\\344\\270\\211\\347\\224\\263\\346\\234\\272\\345\\236\\2132022-\\346\\274\\224\\347\\244\\272\\346\\265\\201\\347\\250\\213\\350\\256\\276\\350\\256\\241.md'
      )
    ).toBe('三申机型2022-演示流程设计.md');
  });

  test('Japanese katakana', () => {
    expect(unescapeOctal('\\343\\203\\206\\343\\202\\271\\343\\203\\210.txt')).toBe('テスト.txt');
  });

  test('Korean syllables', () => {
    expect(unescapeOctal('\\355\\205\\214\\354\\212\\244\\355\\212\\270.txt')).toBe('테스트.txt');
  });

  test('CJK with spaces (space is ASCII, not escaped)', () => {
    expect(unescapeOctal('\\346\\226\\207\\344\\273\\266 \\345\\244\\271')).toBe('文件 夹');
  });

  test('escaped backslash (\\\\) restored to single backslash', () => {
    expect(unescapeOctal('a\\\\b')).toBe('a\\b');
  });

  test('invalid octal digits preserved as-is', () => {
    expect(unescapeOctal('\\999')).toBe('\\999');
  });

  test('empty string', () => {
    expect(unescapeOctal('')).toBe('');
  });

  test('incomplete escape (2 digits) preserved as-is', () => {
    expect(unescapeOctal('\\34x')).toBe('\\34x');
  });

  test('symlink name with CJK', () => {
    expect(unescapeOctal('\\344\\270\\211 -> /target')).toBe('三 -> /target');
  });
});

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

  test('parses GNU rsync output with octal-escaped CJK names', () => {
    const out = [
      'drwxr-xr-x        4,096 2024/01/15 10:30:00 .',
      '-rw-r--r--        1,234 2024/01/15 10:30:00 \\344\\270\\211\\347\\224\\263.md',
    ].join('\n');
    const entries = parseListOnly(out);
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('三申.md');
    expect(entries[0].type).toBe('file');
    expect(entries[0].size).toBe(1234);
    expect(entries[0].modifiedAt).toBe('2024-01-15T10:30:00');
  });

  test('parses mixed ASCII and escaped names in same listing', () => {
    const out = [
      'drwxr-xr-x        4,096 2024/01/15 10:30:00 .',
      '-rw-r--r--          100 2024/01/15 10:30:00 readme.txt',
      '-rw-r--r--        2,048 2024/01/15 10:30:00 2022-\\346\\274\\224\\347\\244\\272.md',
    ].join('\n');
    const entries = parseListOnly(out);
    expect(entries.map((e) => e.name)).toEqual(['readme.txt', '2022-演示.md']);
  });

  test('handles escaped directory names', () => {
    const out =
      'drwxr-xr-x        4,096 2024/01/15 10:30:00 \\346\\226\\207\\344\\273\\266 \\345\\244\\271';
    const entries = parseListOnly(out);
    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe('dir');
    expect(entries[0].name).toBe('文件 夹');
    expect(entries[0].size).toBeNull();
  });

  test('handles escaped symlink names with arrow', () => {
    const out =
      'lrwxrwxrwx           10 2024/01/15 10:30:00 \\344\\270\\211 -> /etc/hosts';
    const entries = parseListOnly(out);
    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe('symlink');
    expect(entries[0].name).toBe('三');
  });

  test('handles already-decoded UTF-8 names (openrsync)', () => {
    const out = [
      'drwxr-xr-x          160 2026/06/14 15:06:34 .',
      '-rw-r--r--            5 2026/06/14 15:06:34 三申机型2022-演示流程设计.md',
      '-rw-r--r--           10 2026/06/14 15:06:34 テスト.txt',
    ].join('\n');
    const entries = parseListOnly(out);
    expect(entries.map((e) => e.name)).toEqual(['三申机型2022-演示流程设计.md', 'テスト.txt']);
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
