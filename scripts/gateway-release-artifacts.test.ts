import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GATEWAY_RUST_TARGETS,
  assembleGatewayArtifacts,
  assertNativeGatewayTarget,
  cargoExecutableFromMessages,
  gatewayReleaseMatrix,
  stageGatewayArtifact,
} from './gateway-release-artifacts';
import { replaceWorkspacePackageVersion } from './release';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('Gateway Rust release producer', () => {
  test('keeps the workflow native, attested, smoke-gated, and publish-free', async () => {
    const workflow = await readFile(
      join(import.meta.dir, '..', '.github', 'workflows', 'tmex-cli-rust-gateway.yml'),
      'utf8'
    );
    const packageSmoke = await readFile(
      join(import.meta.dir, '..', 'packages', 'app', 'scripts', 'build-artifacts.ts'),
      'utf8'
    );
    for (const entry of gatewayReleaseMatrix()) {
      expect(workflow).toContain(`- target: ${entry.target}`);
      expect(workflow).toContain(`rust-target: ${entry.rustTarget}`);
      expect(workflow).toContain(`runner: ${entry.runner}`);
    }
    expect(workflow).toContain('uses: actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6');
    expect(workflow).toContain('--smoke');
    expect(workflow).not.toContain('npm publish');
    expect(packageSmoke).toContain("writeFileSync(fakeTmux, '#!/usr/bin/env sh\\nexit 127\\n')");
    expect(packageSmoke).toContain('cwd: workDir');
    expect(packageSmoke).toContain('TMEX_TMUX_BIN: fakeTmux');
    expect(packageSmoke).toContain("'--tmux-namespace', 'tmex-artifact-smoke'");
  });

  test('keeps the npm and Rust workspace release versions coupled', () => {
    const cargoToml = [
      '[workspace]',
      'resolver = "2"',
      '',
      '[workspace.package]',
      'version = "0.17.0"',
      'edition = "2021"',
      '',
      '[workspace.dependencies]',
      'example = { version = "1" }',
      '',
    ].join('\n');

    const updated = replaceWorkspacePackageVersion(cargoToml, '0.18.0');
    expect(updated).toContain('[workspace.package]\nversion = "0.18.0"');
    expect(updated).toContain('example = { version = "1" }');
  });

  test('defines four native runner and Rust target pairs', () => {
    expect(gatewayReleaseMatrix()).toEqual([
      {
        target: 'darwin-arm64',
        rustTarget: 'aarch64-apple-darwin',
        runner: 'macos-15',
      },
      {
        target: 'darwin-x64',
        rustTarget: 'x86_64-apple-darwin',
        runner: 'macos-15-intel',
      },
      {
        target: 'linux-arm64',
        rustTarget: 'aarch64-unknown-linux-gnu',
        runner: 'ubuntu-24.04-arm',
      },
      {
        target: 'linux-x64',
        rustTarget: 'x86_64-unknown-linux-gnu',
        runner: 'ubuntu-24.04',
      },
    ]);
  });

  test('rejects cross compilation and mismatched Rust hosts', () => {
    expect(() =>
      assertNativeGatewayTarget('linux-arm64', GATEWAY_RUST_TARGETS['linux-arm64'], 'linux', 'x64')
    ).toThrow('cross compilation is not allowed');
    expect(() =>
      assertNativeGatewayTarget('linux-x64', 'aarch64-unknown-linux-gnu', 'linux', 'x64')
    ).toThrow('use a native runner');
  });

  test('takes the executable path from Cargo JSON rather than its output layout', () => {
    const packageId = 'path+file:///repo/apps/gateway#tmex-gateway@0.17.0';
    const output = [
      JSON.stringify({
        reason: 'compiler-artifact',
        package_id: packageId,
        target: { name: 'tmex-gateway', kind: ['lib'] },
        executable: null,
      }),
      JSON.stringify({
        reason: 'compiler-artifact',
        package_id: packageId,
        target: { name: 'tmex-gateway', kind: ['bin'] },
        executable: '/nonstandard/cargo/output/gateway-native',
      }),
      JSON.stringify({ reason: 'build-finished', success: true }),
    ].join('\n');

    expect(cargoExecutableFromMessages(output, packageId, 'tmex-gateway')).toBe(
      '/nonstandard/cargo/output/gateway-native'
    );
  });

  test('assembles only a complete checksum-valid four-target matrix', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tmex-rust-gateway-release-'));
    tempDirs.push(root);
    const executables = join(root, 'executables');
    const fragments = join(root, 'fragments');
    const release = join(root, 'release');
    await mkdir(executables, { recursive: true });

    for (const target of Object.keys(GATEWAY_RUST_TARGETS) as Array<
      keyof typeof GATEWAY_RUST_TARGETS
    >) {
      const executable = join(executables, target);
      await writeFile(executable, `native:${target}`);
      await stageGatewayArtifact({
        executablePath: executable,
        outDir: fragments,
        target,
        version: '1.2.3',
      });
    }

    const manifest = await assembleGatewayArtifacts(fragments, release, '1.2.3');
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.version).toBe('1.2.3');
    expect(manifest.artifacts.map((entry) => entry.target)).toEqual([
      'darwin-arm64',
      'darwin-x64',
      'linux-arm64',
      'linux-x64',
    ]);
    for (const entry of manifest.artifacts) {
      expect(entry.path).toBe(`${entry.target}/tmex-gateway`);
      expect(await readFile(join(release, entry.path), 'utf8')).toBe(`native:${entry.target}`);
    }

    await writeFile(join(fragments, 'linux-x64', 'tmex-gateway'), 'tampered');
    await expect(assembleGatewayArtifacts(fragments, release, '1.2.3')).rejects.toThrow(
      'checksum mismatch'
    );
  });
});
