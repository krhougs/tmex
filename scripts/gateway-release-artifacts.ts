import { spawn } from 'node:child_process';
import { chmod, copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { sha256Hex } from '../packages/app/src/lib/artifacts-manifest';
import {
  GATEWAY_ARTIFACT_MANIFEST_VERSION,
  GATEWAY_TARGETS,
  type GatewayArtifactEntry,
  type GatewayArtifactManifest,
  type GatewayTarget,
  bundleGatewayArtifacts,
  gatewayTargetFor,
  parseGatewayArtifactManifest,
  verifyGatewayArtifact,
} from '../packages/app/src/lib/gateway-artifacts';

const repoRoot = resolve(import.meta.dir, '..');
const packageJsonPath = join(repoRoot, 'packages', 'app', 'package.json');

export const GATEWAY_RUST_TARGETS: Record<GatewayTarget, string> = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'linux-arm64': 'aarch64-unknown-linux-gnu',
  'linux-x64': 'x86_64-unknown-linux-gnu',
};

export const GATEWAY_RELEASE_RUNNERS: Record<GatewayTarget, string> = {
  'darwin-arm64': 'macos-15',
  'darwin-x64': 'macos-15-intel',
  'linux-arm64': 'ubuntu-24.04-arm',
  'linux-x64': 'ubuntu-24.04',
};

interface CargoTarget {
  name: string;
  kind: string[];
}

interface CargoPackage {
  id: string;
  name: string;
  version: string;
  targets: CargoTarget[];
}

interface CargoMetadata {
  packages: CargoPackage[];
}

interface CargoMessage {
  reason?: string;
  package_id?: string;
  executable?: string | null;
  target?: CargoTarget;
  message?: { rendered?: string | null };
}

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface StageOptions {
  executablePath: string;
  outDir: string;
  target: GatewayTarget;
  version: string;
}

interface ParsedFlags {
  values: Map<string, string>;
}

function usage(): string {
  return [
    'usage:',
    '  bun scripts/gateway-release-artifacts.ts matrix',
    '  bun scripts/gateway-release-artifacts.ts build [--target <target>] [--version <version>] [--out-dir <dir>]',
    '  bun scripts/gateway-release-artifacts.ts assemble --input-dir <dir> [--version <version>] [--out-dir <dir>]',
  ].join('\n');
}

function parseFlags(argv: string[], allowed: readonly string[]): ParsedFlags {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (!flag?.startsWith('--') || !allowed.includes(flag)) {
      throw new Error(`unknown argument: ${String(flag)}\n${usage()}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`${flag} requires a value`);
    }
    if (values.has(flag)) {
      throw new Error(`${flag} may only be provided once`);
    }
    values.set(flag, value);
    index++;
  }
  return { values };
}

function gatewayTarget(value: string): GatewayTarget {
  if (!(GATEWAY_TARGETS as readonly string[]).includes(value)) {
    throw new Error(`unsupported Gateway release target: ${value}`);
  }
  return value as GatewayTarget;
}

async function run(command: string, args: string[]): Promise<CommandResult> {
  const child = spawn(command, args, {
    cwd: repoRoot,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  const code = await new Promise<number>((resolveCode, reject) => {
    child.once('error', reject);
    child.once('close', (status) => resolveCode(status ?? 1));
  });
  return {
    code,
    stdout: Buffer.concat(stdout).toString('utf8'),
    stderr: Buffer.concat(stderr).toString('utf8'),
  };
}

async function readPackageVersion(): Promise<string> {
  const value = JSON.parse(await readFile(packageJsonPath, 'utf8')) as { version?: unknown };
  if (typeof value.version !== 'string' || value.version.length === 0) {
    throw new Error('tmex-cli package version is missing');
  }
  return value.version;
}

async function resolveVersion(requested?: string): Promise<string> {
  const packageVersion = await readPackageVersion();
  if (requested !== undefined && requested !== packageVersion) {
    throw new Error(
      `requested release version ${requested} does not match tmex-cli version ${packageVersion}`
    );
  }
  return packageVersion;
}

async function loadCargoMetadata(): Promise<{
  binName: string;
  packageId: string;
  version: string;
}> {
  const cargo = process.env.CARGO || 'cargo';
  const result = await run(cargo, ['metadata', '--locked', '--no-deps', '--format-version', '1']);
  if (result.code !== 0) {
    throw new Error(`cargo metadata failed (${result.code}): ${result.stderr.trim()}`);
  }
  const metadata = JSON.parse(result.stdout) as CargoMetadata;
  const gatewayPackage = metadata.packages.find((candidate) => candidate.name === 'tmex-gateway');
  if (!gatewayPackage) {
    throw new Error('cargo metadata does not contain package tmex-gateway');
  }
  const bins = gatewayPackage.targets.filter((target) => target.kind.includes('bin'));
  if (bins.length !== 1 || bins[0]?.name !== 'tmex-gateway') {
    throw new Error('tmex-gateway package must expose exactly one bin named tmex-gateway');
  }
  return {
    binName: bins[0].name,
    packageId: gatewayPackage.id,
    version: gatewayPackage.version,
  };
}

async function rustHostTriple(): Promise<string> {
  const rustc = process.env.RUSTC || 'rustc';
  const result = await run(rustc, ['-vV']);
  if (result.code !== 0) {
    throw new Error(`rustc -vV failed (${result.code}): ${result.stderr.trim()}`);
  }
  const host = result.stdout.match(/^host:\s*(\S+)$/m)?.[1];
  if (!host) {
    throw new Error('rustc -vV did not report a host triple');
  }
  return host;
}

export function assertNativeGatewayTarget(
  target: GatewayTarget,
  rustHost: string,
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch
): void {
  const hostTarget = gatewayTargetFor(platform, arch);
  if (target !== hostTarget) {
    throw new Error(
      `cross compilation is not allowed: requested ${target}, current host is ${hostTarget}`
    );
  }
  const expectedRustHost = GATEWAY_RUST_TARGETS[target];
  if (rustHost !== expectedRustHost) {
    throw new Error(
      `Rust host ${rustHost} does not match ${target} (${expectedRustHost}); use a native runner`
    );
  }
}

export function cargoExecutableFromMessages(
  output: string,
  packageId: string,
  binName: string
): string {
  const executables: string[] = [];
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    let message: CargoMessage;
    try {
      message = JSON.parse(line) as CargoMessage;
    } catch {
      throw new Error('cargo emitted a non-JSON line while locating the Gateway executable');
    }
    if (message.reason === 'compiler-message' && message.message?.rendered) {
      process.stderr.write(message.message.rendered);
    }
    if (
      message.reason === 'compiler-artifact' &&
      message.package_id === packageId &&
      message.target?.name === binName &&
      message.target.kind.includes('bin') &&
      typeof message.executable === 'string'
    ) {
      executables.push(message.executable);
    }
  }
  const unique = [...new Set(executables.map((path) => resolve(path)))];
  if (unique.length !== 1) {
    throw new Error(
      `cargo reported ${unique.length} executable paths for ${binName}; expected exactly one`
    );
  }
  return unique[0] as string;
}

export async function stageGatewayArtifact(
  options: StageOptions
): Promise<GatewayArtifactManifest> {
  const executablePath = resolve(options.executablePath);
  const executable = await stat(executablePath).catch(() => null);
  if (!executable?.isFile()) {
    throw new Error(`Cargo Gateway executable not found: ${executablePath}`);
  }
  const targetDir = resolve(options.outDir, options.target);
  const outputPath = join(targetDir, 'tmex-gateway');
  if (executablePath === outputPath) {
    throw new Error('Gateway staging output must be outside Cargo executable path');
  }
  const content = await readFile(executablePath);
  const sha256 = sha256Hex(content);

  await rm(targetDir, { recursive: true, force: true });
  await mkdir(targetDir, { recursive: true });
  await copyFile(executablePath, outputPath);
  await chmod(outputPath, 0o755);
  if (sha256Hex(await readFile(outputPath)) !== sha256) {
    throw new Error(`Gateway artifact changed while staging ${options.target}`);
  }

  const manifest: GatewayArtifactManifest = {
    schemaVersion: GATEWAY_ARTIFACT_MANIFEST_VERSION,
    version: options.version,
    artifacts: [{ target: options.target, path: 'tmex-gateway', sha256 }],
  };
  await writeFile(join(targetDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

async function buildGatewayArtifact(
  target: GatewayTarget,
  version: string,
  outDir: string
): Promise<GatewayArtifactManifest> {
  const metadata = await loadCargoMetadata();
  if (metadata.version !== version) {
    throw new Error(
      `Cargo Gateway version ${metadata.version} does not match tmex-cli version ${version}`
    );
  }
  assertNativeGatewayTarget(target, await rustHostTriple());

  const cargo = process.env.CARGO || 'cargo';
  const result = await run(cargo, [
    'build',
    '--locked',
    '--release',
    '--package',
    'tmex-gateway',
    '--bin',
    metadata.binName,
    '--message-format=json-render-diagnostics',
  ]);
  const executablePath = cargoExecutableFromMessages(
    result.stdout,
    metadata.packageId,
    metadata.binName
  );
  if (result.code !== 0) {
    throw new Error(`cargo build failed (${result.code}): ${result.stderr.trim()}`);
  }
  if (result.stderr.trim()) {
    process.stderr.write(result.stderr);
  }
  return stageGatewayArtifact({ executablePath, outDir, target, version });
}

function posixRelative(root: string, path: string): string {
  return relative(root, path).split(sep).join('/');
}

export async function assembleGatewayArtifacts(
  inputDir: string,
  outDir: string,
  version: string
): Promise<GatewayArtifactManifest> {
  const inputRoot = resolve(inputDir);
  const outputRoot = resolve(outDir);
  const artifacts: GatewayArtifactEntry[] = [];

  for (const target of GATEWAY_TARGETS) {
    const targetRoot = join(inputRoot, target);
    const manifestPath = join(targetRoot, 'manifest.json');
    const manifest = parseGatewayArtifactManifest(
      JSON.parse(await readFile(manifestPath, 'utf8')) as unknown
    );
    if (manifest.version !== version) {
      throw new Error(
        `Gateway fragment ${target} version ${manifest.version} does not match ${version}`
      );
    }
    if (manifest.artifacts.length !== 1 || manifest.artifacts[0]?.target !== target) {
      throw new Error(`Gateway fragment ${target} must contain exactly its own target`);
    }
    const entry = manifest.artifacts[0];
    const artifactPath = await verifyGatewayArtifact(targetRoot, entry);
    artifacts.push({
      target,
      path: posixRelative(inputRoot, artifactPath),
      sha256: entry.sha256,
    });
  }

  const sourceManifestPath = join(inputRoot, `.gateway-release-source-${process.pid}.json`);
  const sourceManifest: GatewayArtifactManifest = {
    schemaVersion: GATEWAY_ARTIFACT_MANIFEST_VERSION,
    version,
    artifacts,
  };
  await writeFile(sourceManifestPath, `${JSON.stringify(sourceManifest, null, 2)}\n`);
  try {
    return await bundleGatewayArtifacts(sourceManifestPath, outputRoot, version);
  } finally {
    await rm(sourceManifestPath, { force: true });
  }
}

export function gatewayReleaseMatrix(): Array<{
  target: GatewayTarget;
  rustTarget: string;
  runner: string;
}> {
  return GATEWAY_TARGETS.map((target) => ({
    target,
    rustTarget: GATEWAY_RUST_TARGETS[target],
    runner: GATEWAY_RELEASE_RUNNERS[target],
  }));
}

async function main(): Promise<void> {
  const [command, ...argv] = process.argv.slice(2);
  if (command === 'matrix') {
    if (argv.length > 0) throw new Error(`matrix does not accept arguments\n${usage()}`);
    console.log(JSON.stringify({ include: gatewayReleaseMatrix() }));
    return;
  }
  if (command === 'build') {
    const flags = parseFlags(argv, ['--target', '--version', '--out-dir']);
    const target = gatewayTarget(flags.values.get('--target') ?? gatewayTargetFor());
    const version = await resolveVersion(flags.values.get('--version'));
    const outDir = resolve(
      flags.values.get('--out-dir') ?? join(repoRoot, 'dist', 'gateway-input')
    );
    const manifest = await buildGatewayArtifact(target, version, outDir);
    const artifact = manifest.artifacts[0];
    console.log(
      `[gateway-release] built ${target}: ${join(outDir, target, artifact?.path ?? '')} (${artifact?.sha256})`
    );
    return;
  }
  if (command === 'assemble') {
    const flags = parseFlags(argv, ['--input-dir', '--version', '--out-dir']);
    const inputDir = flags.values.get('--input-dir');
    if (!inputDir) throw new Error(`assemble requires --input-dir\n${usage()}`);
    const version = await resolveVersion(flags.values.get('--version'));
    const outDir = resolve(
      flags.values.get('--out-dir') ?? join(repoRoot, 'dist', 'gateway-release')
    );
    const manifest = await assembleGatewayArtifacts(inputDir, outDir, version);
    console.log(
      `[gateway-release] assembled ${manifest.artifacts.length} targets at ${join(outDir, 'manifest.json')}`
    );
    return;
  }
  throw new Error(usage());
}

if (import.meta.main) {
  await main();
}
