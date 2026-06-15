import { describe, expect, test } from 'bun:test';
import { checkBunVersion, sanitizeBunPath } from './bun';

const ESC = String.fromCharCode(27);
const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);
const BEL = String.fromCharCode(7);

describe('sanitizeBunPath', () => {
  test('passes through a clean path', () => {
    expect(sanitizeBunPath(`/opt/homebrew/bin/bun${LF}`)).toBe('/opt/homebrew/bin/bun');
    expect(sanitizeBunPath('/opt/homebrew/bin/bun')).toBe('/opt/homebrew/bin/bun');
  });

  test('strips ANSI CSI escapes and control chars (issue #28 regression)', () => {
    // 模拟交互式 zsh 因 .zshrc 污染的输出：ESC[2K \r ESC[1m <path>
    const polluted = `${ESC}[2K${CR}${ESC}[1m/opt/homebrew/bin/bun${LF}`;
    expect(sanitizeBunPath(polluted)).toBe('/opt/homebrew/bin/bun');
  });

  test('strips ANSI OSC escapes (window title pollution)', () => {
    const polluted = `${ESC}]0;mytitle${BEL}/opt/homebrew/bin/bun${LF}`;
    expect(sanitizeBunPath(polluted)).toBe('/opt/homebrew/bin/bun');
  });

  test('picks the absolute-path line with a leading banner', () => {
    expect(sanitizeBunPath(`Welcome to my shell${LF}/Users/me/.bun/bin/bun`)).toBe(
      '/Users/me/.bun/bin/bun'
    );
  });

  test('picks the absolute-path line with a trailing banner', () => {
    expect(sanitizeBunPath(`/opt/homebrew/bin/bun${LF}Welcome to Zsh!`)).toBe(
      '/opt/homebrew/bin/bun'
    );
  });

  test('falls back to the last non-empty line when no absolute path (e.g. version)', () => {
    expect(sanitizeBunPath(`1.3.12${LF}`)).toBe('1.3.12');
    expect(sanitizeBunPath(`${ESC}[1m1.3.12${ESC}[0m${LF}`)).toBe('1.3.12');
  });

  test('returns empty string for blank or garbage-only input', () => {
    expect(sanitizeBunPath(`${ESC}[0m${CR}${LF}`)).toBe('');
    expect(sanitizeBunPath('')).toBe('');
    expect(sanitizeBunPath(`   ${LF}  `)).toBe('');
  });
});

describe('checkBunVersion', () => {
  // bun:test 运行于 bun，process.execPath 即真实 bun 二进制
  const realBun = process.execPath;

  test('resolves an explicit valid path', async () => {
    const result = await checkBunVersion(undefined, { explicitPath: realBun });
    expect(result.ok).toBe(true);
    expect(result.path).toBe(realBun);
    expect(result.version).toBeTruthy();
  });

  test('sanitizes a polluted explicit path then resolves (issue #28)', async () => {
    const result = await checkBunVersion(undefined, { explicitPath: `${ESC}[2K${CR}${realBun}` });
    expect(result.ok).toBe(true);
    expect(result.path).toBe(realBun);
  });

  test('fails an explicit nonexistent absolute path without silent fallback', async () => {
    const result = await checkBunVersion(undefined, { explicitPath: '/nonexistent/path/to/bun' });
    expect(result.ok).toBe(false);
    expect(result.path).toBe('/nonexistent/path/to/bun');
  });

  test('rejects an explicit relative path (must be absolute)', async () => {
    const result = await checkBunVersion(undefined, { explicitPath: 'bun' });
    expect(result.ok).toBe(false);
    expect(result.path).toBe('bun');
    expect(result.version).toBeUndefined();
  });

  test('resolves bun with no options under bun runtime (#2 process.execPath)', async () => {
    const result = await checkBunVersion();
    expect(result.ok).toBe(true);
    expect(result.path).toBeTruthy();
    expect(result.version).toBeTruthy();
  });

  test('uses a valid meta path', async () => {
    const result = await checkBunVersion(undefined, { metaBunPath: realBun });
    expect(result.ok).toBe(true);
    expect(result.path).toBe(realBun);
  });

  test('falls back past a stale (nonexistent) meta path', async () => {
    const result = await checkBunVersion(undefined, { metaBunPath: '/nonexistent/meta/bun' });
    expect(result.ok).toBe(true);
    // #2 process.execPath（bun 运行时）应在 stale meta 之前命中
    expect(result.path).toBe(realBun);
  });

  test('reports version too low', async () => {
    const result = await checkBunVersion('999.0.0', { explicitPath: realBun });
    expect(result.ok).toBe(false);
    expect(result.version).toBeTruthy();
    expect(result.reason).toContain('999.0.0');
  });
});
