import { afterEach, describe, expect, test } from 'bun:test';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInstallLayout } from './install-layout';
import { writeRunScript } from './install';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

describe('writeRunScript', () => {
  test('writes executable script with safe shell variables', async () => {
    const installDir = await mkdtemp(join(tmpdir(), 'tmex-install-'));
    tempDirs.push(installDir);

    const installLayout = createInstallLayout(installDir);
    await writeRunScript(installLayout, '/usr/bin/bun');

    const script = await readFile(installLayout.runScriptPath, 'utf8');
    expect(script).toContain('#!/usr/bin/env bash');
    expect(script).toContain('SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"');
    expect(script).toContain('while IFS= read -r line || [[ -n "$line" ]]; do');
    expect(script).toContain('export "$line"');
    expect(script).toContain(`done < "${installLayout.envPath}"`);
    expect(script).not.toContain('source ');
    expect(script).toContain('export PATH="${HOME}/.bun/bin:${PATH:-}"');
    expect(script).toContain('export TMEX_FE_DIST_DIR=');
    expect(script).toContain('export TMEX_MIGRATIONS_DIR=');
    expect(script).toContain(`exec "/usr/bin/bun" "${installLayout.runtimeServerPath}"`);
    expect(script).not.toContain('BASH_SOURCE');
  });
});
