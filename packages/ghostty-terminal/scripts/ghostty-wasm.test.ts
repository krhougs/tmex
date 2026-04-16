import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildGhosttyWasmMetadata,
  verifyGhosttyWasmState,
  type GhosttyWasmMetadata,
} from './ghostty-wasm';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tmex-ghostty-wasm-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { force: true, recursive: true });
    }
  }
});

describe('buildGhosttyWasmMetadata', () => {
  test('captures commit, size and sha256 for a wasm asset', async () => {
    const dir = makeTempDir();
    const wasmPath = join(dir, 'ghostty-vt.wasm');
    writeFileSync(wasmPath, new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));

    const metadata = await buildGhosttyWasmMetadata({
      assetPath: wasmPath,
      assetPathForMetadata: 'src/assets/ghostty-vt.wasm',
      ghosttyCommit: 'abc123',
    });

    expect(metadata.ghosttyCommit).toBe('abc123');
    expect(metadata.assetPath).toBe('src/assets/ghostty-vt.wasm');
    expect(metadata.wasmSize).toBe(8);
    expect(metadata.wasmSha256).toBeString();
  });
});

describe('verifyGhosttyWasmState', () => {
  test('passes when wasm asset and metadata match the locked ghostty commit', async () => {
    const dir = makeTempDir();
    const wasmPath = join(dir, 'ghostty-vt.wasm');
    writeFileSync(wasmPath, new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));

    const metadata = await buildGhosttyWasmMetadata({
      assetPath: wasmPath,
      assetPathForMetadata: 'src/assets/ghostty-vt.wasm',
      ghosttyCommit: 'locked-commit',
    });

    await expect(
      verifyGhosttyWasmState({
        wasmPath,
        lockedGhosttyCommit: 'locked-commit',
        metadata,
      })
    ).resolves.toBeUndefined();
  });

  test('fails when metadata commit does not match locked ghostty commit', async () => {
    const dir = makeTempDir();
    const wasmPath = join(dir, 'ghostty-vt.wasm');
    writeFileSync(wasmPath, new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));

    const metadata = (await buildGhosttyWasmMetadata({
      assetPath: wasmPath,
      assetPathForMetadata: 'src/assets/ghostty-vt.wasm',
      ghosttyCommit: 'old-commit',
    })) satisfies GhosttyWasmMetadata;

    await expect(
      verifyGhosttyWasmState({
        wasmPath,
        lockedGhosttyCommit: 'new-commit',
        metadata,
      })
    ).rejects.toThrow(/does not match locked vendor\/ghostty commit/);
  });

  test('fails when wasm asset is missing', async () => {
    const dir = makeTempDir();
    const wasmPath = join(dir, 'ghostty-vt.wasm');

    await expect(
      verifyGhosttyWasmState({
        wasmPath,
        lockedGhosttyCommit: 'locked-commit',
        metadata: {
          ghosttyCommit: 'locked-commit',
          assetPath: 'src/assets/ghostty-vt.wasm',
          wasmSha256: 'sha',
          wasmSize: 1,
        },
      })
    ).rejects.toThrow(/missing packaged ghostty wasm asset/);
  });
});
