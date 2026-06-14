import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Device } from '@tmex/shared';
import { checkAndNormalize } from './device-storage';

const LOCAL = { type: 'local' } as Device;
const SSH = { type: 'ssh' } as Device;

let sandbox: string;
let root: string;
let outside: string;

beforeAll(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'tmex-pathsafe-')));
  root = join(sandbox, 'root');
  outside = join(sandbox, 'outside');
  mkdirSync(root);
  mkdirSync(outside);
  mkdirSync(join(root, 'sub'));
  writeFileSync(join(root, 'hello.txt'), 'hi');
  writeFileSync(join(outside, 'secret.txt'), 'secret');
  symlinkSync(join(outside, 'secret.txt'), join(root, 'escape'));
});

afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

describe('checkAndNormalize — local (realpath enforced)', () => {
  test('allows files inside root', () => {
    const r = checkAndNormalize(LOCAL, root, join(root, 'hello.txt'));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.path).toBe(join(root, 'hello.txt'));
  });
  test('allows nested dir', () => {
    expect(checkAndNormalize(LOCAL, root, join(root, 'sub')).ok).toBe(true);
  });
  test('rejects relative path', () => {
    expect(checkAndNormalize(LOCAL, root, 'hello.txt')).toEqual({ ok: false, code: 'invalid' });
  });
  test('rejects traversal escaping root', () => {
    expect(checkAndNormalize(LOCAL, root, `${root}/../outside/secret.txt`)).toEqual({
      ok: false,
      code: 'outside_roots',
    });
  });
  test('rejects symlink escaping root (realpath)', () => {
    expect(checkAndNormalize(LOCAL, root, join(root, 'escape'))).toEqual({
      ok: false,
      code: 'outside_roots',
    });
  });
  test('reports not_found for missing path', () => {
    expect(checkAndNormalize(LOCAL, root, join(root, 'nope'))).toEqual({
      ok: false,
      code: 'not_found',
    });
  });
});

describe('checkAndNormalize — ssh (textual containment, no realpath)', () => {
  test('allows path inside root', () => {
    const r = checkAndNormalize(SSH, '/home/u', '/home/u/code/app.ts');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.path).toBe('/home/u/code/app.ts');
  });
  test('normalizes . and ..', () => {
    const r = checkAndNormalize(SSH, '/home/u', '/home/u/a/../b/./c');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.path).toBe('/home/u/b/c');
  });
  test('rejects traversal escaping root', () => {
    expect(checkAndNormalize(SSH, '/home/u', '/home/u/../root')).toEqual({
      ok: false,
      code: 'outside_roots',
    });
  });
  test('rejects sibling-prefix path (no false containment)', () => {
    // /home/user2 must NOT be treated as inside /home/user
    expect(checkAndNormalize(SSH, '/home/user', '/home/user2/x')).toEqual({
      ok: false,
      code: 'outside_roots',
    });
  });
  test('rejects relative path', () => {
    expect(checkAndNormalize(SSH, '/home/u', 'rel')).toEqual({ ok: false, code: 'invalid' });
  });
});
