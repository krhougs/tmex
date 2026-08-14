import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  backupInstallArtifacts,
  deployRuntimeFiles,
  restoreInstallArtifacts,
  writeRunScript,
} from './install';
import { type PackageLayout, createInstallLayout } from './install-layout';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('writeRunScript', () => {
  test('writes executable script with safe shell variables', async () => {
    const installDir = await mkdtemp(join(tmpdir(), 'tmex-install-'));
    tempDirs.push(installDir);

    const installLayout = createInstallLayout(installDir);
    await writeRunScript(installLayout);

    const script = await readFile(installLayout.runScriptPath, 'utf8');
    expect(script).toContain('#!/usr/bin/env bash');
    expect(script).toContain('SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"');
    expect(script).toContain('while IFS= read -r line || [[ -n "$line" ]]; do');
    expect(script).toContain('export "$line"');
    expect(script).toContain('done < "${SCRIPT_DIR}/app.env"');
    expect(script).not.toContain('source ');
    expect(script).toContain('export TMEX_FE_DIST_DIR=');
    expect(script).not.toContain('TMEX_MIGRATIONS_DIR');
    expect(script).not.toContain('bun');
    expect(script).toContain('exec "${SCRIPT_DIR}/bin/tmex-gateway"');
    expect(script).not.toContain('BASH_SOURCE');
  });
});

describe('native Gateway deployment and rollback', () => {
  test('installs only the selected binary and removes legacy runtime materialization', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tmex-native-install-'));
    tempDirs.push(root);
    const packageRoot = join(root, 'package');
    const installDir = join(root, 'install');
    const gatewayBinaryPath = join(packageRoot, 'tmex-gateway');
    const resourceFePath = join(packageRoot, 'fe-dist');
    await mkdir(resourceFePath, { recursive: true });
    await writeFile(gatewayBinaryPath, 'native-gateway');
    await writeFile(join(resourceFePath, 'index.html'), '<html></html>');
    const installLayout = createInstallLayout(installDir);
    await mkdir(installLayout.runtimeDir, { recursive: true });
    await mkdir(installLayout.drizzleDir, { recursive: true });
    await writeFile(join(installLayout.runtimeDir, 'server.js'), 'legacy');
    await writeFile(join(installLayout.drizzleDir, '0000.sql'), 'legacy');
    const packageLayout: PackageLayout = {
      packageRoot,
      cliDistPath: join(packageRoot, 'cli-node.js'),
      gatewayTarget: 'darwin-arm64',
      gatewayBinaryPath,
      resourceFePath,
    };

    await deployRuntimeFiles(packageLayout, installLayout);

    expect(await readFile(installLayout.gatewayBinaryPath, 'utf8')).toBe('native-gateway');
    expect((await stat(installLayout.gatewayBinaryPath)).mode & 0o111).not.toBe(0);
    expect(await readFile(join(installLayout.feDir, 'index.html'), 'utf8')).toBe('<html></html>');
    await expect(stat(installLayout.runtimeDir)).rejects.toThrow();
    await expect(stat(installLayout.drizzleDir)).rejects.toThrow();
  });

  test('restores an old JavaScript installation when native upgrade fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tmex-native-rollback-'));
    tempDirs.push(root);
    const installLayout = createInstallLayout(join(root, 'install'));
    const backupDir = join(root, 'backup');
    await mkdir(installLayout.runtimeDir, { recursive: true });
    await mkdir(installLayout.drizzleDir, { recursive: true });
    await writeFile(join(installLayout.runtimeDir, 'server.js'), 'legacy-runtime');
    await writeFile(join(installLayout.drizzleDir, '0000.sql'), 'legacy-migration');
    await writeFile(installLayout.runScriptPath, 'legacy-run');

    await backupInstallArtifacts(installLayout, backupDir);
    await rm(installLayout.runtimeDir, { recursive: true, force: true });
    await rm(installLayout.resourcesDir, { recursive: true, force: true });
    await mkdir(installLayout.binDir, { recursive: true });
    await writeFile(installLayout.gatewayBinaryPath, 'broken-native');
    await writeFile(installLayout.runScriptPath, 'native-run');
    await restoreInstallArtifacts(installLayout, backupDir);

    expect(await readFile(join(installLayout.runtimeDir, 'server.js'), 'utf8')).toBe(
      'legacy-runtime'
    );
    expect(await readFile(join(installLayout.drizzleDir, '0000.sql'), 'utf8')).toBe(
      'legacy-migration'
    );
    expect(await readFile(installLayout.runScriptPath, 'utf8')).toBe('legacy-run');
    await expect(stat(installLayout.binDir)).rejects.toThrow();
  });
});
