import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('published CLI identity', () => {
  test('keeps tmex-cli with both command bins and no JavaScript Gateway build', () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(import.meta.dir, '../package.json'), 'utf8')
    ) as {
      name: string;
      bin: Record<string, string>;
      scripts: Record<string, string>;
    };
    expect(packageJson.name).toBe('tmex-cli');
    expect(packageJson.bin).toEqual({
      tmex: './bin/tmex.js',
      'tmex-cli': './bin/tmex.js',
    });
    expect(packageJson.scripts.build).not.toContain('server.ts');
    expect(packageJson.scripts['build:runtime']).not.toContain('bun build');
  });
});
