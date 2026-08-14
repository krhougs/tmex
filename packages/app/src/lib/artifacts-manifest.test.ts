import { describe, expect, test } from 'bun:test';
import { buildManifest, sha256Hex } from './artifacts-manifest';

describe('sha256Hex', () => {
  test('已知向量', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('hello')).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
    );
    expect(sha256Hex(new TextEncoder().encode('hello'))).toBe(sha256Hex('hello'));
  });
});

describe('buildManifest', () => {
  test('空文件列表', () => {
    const manifest = buildManifest('1.2.3', '2026-07-05T00:00:00.000Z', []);
    expect(manifest).toEqual({
      version: '1.2.3',
      builtAt: '2026-07-05T00:00:00.000Z',
      files: [],
    });
  });

  test('files 按 path 字典序排序且带内容 hash', () => {
    const manifest = buildManifest('0.16.5', '2026-07-05T01:02:03.000Z', [
      { path: 'gateway-artifacts/darwin-arm64/tmex-gateway', content: 'gateway' },
      { path: 'fe-dist/index.html', content: '<html></html>' },
      { path: 'gateway-artifacts/manifest.json', content: '{}' },
    ]);

    expect(manifest.version).toBe('0.16.5');
    expect(manifest.builtAt).toBe('2026-07-05T01:02:03.000Z');
    expect(manifest.files.map((file) => file.path)).toEqual([
      'fe-dist/index.html',
      'gateway-artifacts/darwin-arm64/tmex-gateway',
      'gateway-artifacts/manifest.json',
    ]);
    for (const file of manifest.files) {
      expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(manifest.files[1]?.sha256).toBe(sha256Hex('gateway'));
  });

  test('相同输入输出稳定（与传入顺序无关）', () => {
    const a = buildManifest('1.0.0', 't', [
      { path: 'b', content: 'B' },
      { path: 'a', content: 'A' },
    ]);
    const b = buildManifest('1.0.0', 't', [
      { path: 'a', content: 'A' },
      { path: 'b', content: 'B' },
    ]);
    expect(a).toEqual(b);
  });
});
