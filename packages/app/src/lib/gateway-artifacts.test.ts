import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256Hex } from './artifacts-manifest';
import {
  GATEWAY_ARTIFACT_MANIFEST_VERSION,
  GATEWAY_TARGETS,
  bundleGatewayArtifacts,
  gatewayArtifactEntry,
  gatewayTargetFor,
  parseGatewayArtifactManifest,
  verifyGatewayArtifact,
} from './gateway-artifacts';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('Gateway artifact package contract', () => {
  test('maps every supported npm host to an explicit Rust target', () => {
    expect(gatewayTargetFor('darwin', 'arm64')).toBe('darwin-arm64');
    expect(gatewayTargetFor('darwin', 'x64')).toBe('darwin-x64');
    expect(gatewayTargetFor('linux', 'arm64')).toBe('linux-arm64');
    expect(gatewayTargetFor('linux', 'x64')).toBe('linux-x64');
    expect(() => gatewayTargetFor('win32', 'x64')).toThrow('unsupported tmex-gateway target');
  });

  test('requires a complete unique release matrix but selects only the current target', () => {
    const manifest = parseGatewayArtifactManifest(
      {
        schemaVersion: GATEWAY_ARTIFACT_MANIFEST_VERSION,
        version: '1.2.3',
        artifacts: GATEWAY_TARGETS.map((target) => ({
          target,
          path: `${target}/tmex-gateway`,
          sha256: '0'.repeat(64),
        })),
      },
      { requireAllTargets: true }
    );
    expect(gatewayArtifactEntry(manifest, 'linux-arm64').path).toBe('linux-arm64/tmex-gateway');
    expect(() =>
      parseGatewayArtifactManifest(
        { ...manifest, artifacts: manifest.artifacts.slice(1) },
        { requireAllTargets: true }
      )
    ).toThrow('missing targets: darwin-arm64');
  });

  test('rejects traversal and checksum mismatch before installation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tmex-gateway-artifacts-'));
    tempDirs.push(root);
    const artifactPath = join(root, 'tmex-gateway');
    await writeFile(artifactPath, 'rust-binary');

    await expect(
      verifyGatewayArtifact(root, {
        target: 'darwin-arm64',
        path: '../tmex-gateway',
        sha256: sha256Hex('rust-binary'),
      })
    ).rejects.toThrow('escapes its manifest root');
    await expect(
      verifyGatewayArtifact(root, {
        target: 'darwin-arm64',
        path: 'tmex-gateway',
        sha256: '0'.repeat(64),
      })
    ).rejects.toThrow('checksum mismatch');
  });

  test('bundles the release-declared matrix without depending on source filenames', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tmex-gateway-bundle-'));
    tempDirs.push(root);
    const source = join(root, 'release');
    const output = join(root, 'package');
    await mkdir(source, { recursive: true });
    const artifacts = [];
    for (const target of GATEWAY_TARGETS) {
      const path = `signed-${target}.bin`;
      const content = `binary:${target}`;
      await writeFile(join(source, path), content);
      artifacts.push({ target, path, sha256: sha256Hex(content) });
    }
    const sourceManifestPath = join(source, 'manifest.json');
    await writeFile(
      sourceManifestPath,
      JSON.stringify({
        schemaVersion: GATEWAY_ARTIFACT_MANIFEST_VERSION,
        version: '1.2.3',
        artifacts,
      })
    );

    const manifest = await bundleGatewayArtifacts(sourceManifestPath, output, '1.2.3');

    expect(manifest.artifacts.map((artifact) => artifact.target)).toEqual(GATEWAY_TARGETS);
    for (const target of GATEWAY_TARGETS) {
      expect(await readFile(join(output, target, 'tmex-gateway'), 'utf8')).toBe(`binary:${target}`);
    }
  });
});
