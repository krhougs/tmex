import { describe, expect, test } from 'bun:test';
import { sanitizeUploadName } from './device-storage';

describe('sanitizeUploadName', () => {
  test('keeps a plain file name', () => {
    expect(sanitizeUploadName('photo.png')).toBe('photo.png');
  });
  test('strips leading directories, keeps last segment', () => {
    expect(sanitizeUploadName('a/b/c.txt')).toBe('c.txt');
  });
  test('rejects traversal that resolves to ..', () => {
    expect(sanitizeUploadName('..')).toBeNull();
    expect(sanitizeUploadName('a/..')).toBeNull();
  });
  test('rejects empty / dot', () => {
    expect(sanitizeUploadName('')).toBeNull();
    expect(sanitizeUploadName('.')).toBeNull();
    expect(sanitizeUploadName('foo/')).toBeNull();
  });
  test('rejects backslash and NUL injection', () => {
    expect(sanitizeUploadName('a\\b')).toBeNull();
    expect(sanitizeUploadName('a\0b')).toBeNull();
  });
  test('traversal payload keeps only the safe basename', () => {
    expect(sanitizeUploadName('../../etc/passwd')).toBe('passwd');
  });
});
