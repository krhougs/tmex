import { createHash } from 'node:crypto';
import { access, readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export type GhosttyWasmMetadata = {
  ghosttyCommit: string;
  assetPath: string;
  wasmSha256: string;
  wasmSize: number;
};

type BuildGhosttyWasmMetadataOptions = {
  assetPath: string;
  assetPathForMetadata: string;
  ghosttyCommit: string;
};

type VerifyGhosttyWasmStateOptions = {
  wasmPath: string;
  lockedGhosttyCommit: string;
  metadata: GhosttyWasmMetadata;
};

const PACKAGE_DIR = resolve(import.meta.dir, '..');
const REPO_ROOT = resolve(PACKAGE_DIR, '..', '..');
const DEFAULT_WASM_ASSET_PATH = resolve(PACKAGE_DIR, 'src/assets/ghostty-vt.wasm');
const DEFAULT_METADATA_PATH = resolve(PACKAGE_DIR, 'src/assets/ghostty-vt.meta.json');
const DEFAULT_METADATA_ASSET_PATH = 'src/assets/ghostty-vt.wasm';

function sha256Hex(content: Uint8Array<ArrayBuffer>): string {
  return createHash('sha256').update(content).digest('hex');
}

function parseLockedGhosttyCommit(lsTreeOutput: string): string {
  const match = lsTreeOutput.match(/160000\s+commit\s+([0-9a-f]{40})\s+vendor\/ghostty/u);
  if (!match) {
    throw new Error(`failed to parse locked vendor/ghostty commit from: ${lsTreeOutput.trim()}`);
  }

  return match[1];
}

async function runGit(args: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn(['git', ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_EDITOR: ':',
      GIT_MASTER: '1',
      GIT_PAGER: 'cat',
      GIT_SEQUENCE_EDITOR: ':',
      PAGER: 'cat',
      VISUAL: '',
    },
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${stderr.trim() || stdout.trim()}`);
  }

  return stdout.trim();
}

export async function buildGhosttyWasmMetadata({
  assetPath,
  assetPathForMetadata,
  ghosttyCommit,
}: BuildGhosttyWasmMetadataOptions): Promise<GhosttyWasmMetadata> {
  const [content, fileStat] = await Promise.all([readFile(assetPath), stat(assetPath)]);
  const wasmBytes = new Uint8Array(content);

  return {
    ghosttyCommit,
    assetPath: assetPathForMetadata,
    wasmSha256: sha256Hex(wasmBytes),
    wasmSize: fileStat.size,
  };
}

export async function verifyGhosttyWasmState({
  wasmPath,
  lockedGhosttyCommit,
  metadata,
}: VerifyGhosttyWasmStateOptions): Promise<void> {
  try {
    await access(wasmPath);
  } catch {
    throw new Error(`missing packaged ghostty wasm asset: ${wasmPath}`);
  }

  if (metadata.ghosttyCommit !== lockedGhosttyCommit) {
    throw new Error(
      `packaged ghostty wasm metadata commit ${metadata.ghosttyCommit} does not match locked vendor/ghostty commit ${lockedGhosttyCommit}`
    );
  }

  const actual = await buildGhosttyWasmMetadata({
    assetPath: wasmPath,
    assetPathForMetadata: metadata.assetPath,
    ghosttyCommit: lockedGhosttyCommit,
  });

  if (actual.wasmSha256 !== metadata.wasmSha256) {
    throw new Error(
      `packaged ghostty wasm sha256 mismatch: expected ${metadata.wasmSha256}, got ${actual.wasmSha256}`
    );
  }

  if (actual.wasmSize !== metadata.wasmSize) {
    throw new Error(
      `packaged ghostty wasm size mismatch: expected ${metadata.wasmSize}, got ${actual.wasmSize}`
    );
  }
}

export async function readLockedGhosttyCommit(repoRoot = REPO_ROOT): Promise<string> {
  const output = await runGit(['ls-tree', 'HEAD', 'vendor/ghostty'], repoRoot);
  return parseLockedGhosttyCommit(output);
}

export async function readGhosttySubmoduleHead(repoRoot = REPO_ROOT): Promise<string> {
  return runGit(['-C', 'vendor/ghostty', 'rev-parse', 'HEAD'], repoRoot);
}

export async function readGhosttyWasmMetadata(
  metadataPath = DEFAULT_METADATA_PATH
): Promise<GhosttyWasmMetadata> {
  const raw = await readFile(metadataPath, 'utf8');
  return JSON.parse(raw) as GhosttyWasmMetadata;
}

export async function writeGhosttyWasmMetadata(repoRoot = REPO_ROOT): Promise<GhosttyWasmMetadata> {
  const [lockedGhosttyCommit, submoduleHead] = await Promise.all([
    readLockedGhosttyCommit(repoRoot),
    readGhosttySubmoduleHead(repoRoot),
  ]);

  if (lockedGhosttyCommit !== submoduleHead) {
    throw new Error(
      `vendor/ghostty HEAD ${submoduleHead} does not match locked superproject commit ${lockedGhosttyCommit}`
    );
  }

  const metadata = await buildGhosttyWasmMetadata({
    assetPath: DEFAULT_WASM_ASSET_PATH,
    assetPathForMetadata: DEFAULT_METADATA_ASSET_PATH,
    ghosttyCommit: lockedGhosttyCommit,
  });

  await writeFile(DEFAULT_METADATA_PATH, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
  return metadata;
}

export async function verifyPackagedGhosttyWasm(repoRoot = REPO_ROOT): Promise<GhosttyWasmMetadata> {
  const [lockedGhosttyCommit, metadata] = await Promise.all([
    readLockedGhosttyCommit(repoRoot),
    readGhosttyWasmMetadata(),
  ]);

  await verifyGhosttyWasmState({
    wasmPath: DEFAULT_WASM_ASSET_PATH,
    lockedGhosttyCommit,
    metadata,
  });

  return metadata;
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'verify';

  if (command === 'verify') {
    const metadata = await verifyPackagedGhosttyWasm();
    console.log(
      `verified ${metadata.assetPath} for vendor/ghostty ${metadata.ghosttyCommit} (${metadata.wasmSha256})`
    );
    return;
  }

  if (command === 'write-metadata') {
    const metadata = await writeGhosttyWasmMetadata();
    console.log(
      `wrote ghostty wasm metadata for ${metadata.assetPath} at ${DEFAULT_METADATA_PATH}`
    );
    return;
  }

  throw new Error(`unknown command: ${command}`);
}

if (import.meta.main) {
  await main();
}
