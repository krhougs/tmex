import { chmod, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { sha256Hex } from './artifacts-manifest';

export const GATEWAY_ARTIFACT_MANIFEST_VERSION = 1;
export const GATEWAY_TARGETS = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'] as const;

export type GatewayTarget = (typeof GATEWAY_TARGETS)[number];

export interface GatewayArtifactEntry {
  target: GatewayTarget;
  path: string;
  sha256: string;
}

export interface GatewayArtifactManifest {
  schemaVersion: typeof GATEWAY_ARTIFACT_MANIFEST_VERSION;
  version: string;
  artifacts: GatewayArtifactEntry[];
}

export function gatewayTargetFor(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch
): GatewayTarget {
  const target = `${platform}-${arch}`;
  if ((GATEWAY_TARGETS as readonly string[]).includes(target)) {
    return target as GatewayTarget;
  }
  throw new Error(`unsupported tmex-gateway target: ${platform}/${arch}`);
}

export function parseGatewayArtifactManifest(
  value: unknown,
  options: { requireAllTargets?: boolean } = {}
): GatewayArtifactManifest {
  if (!value || typeof value !== 'object') {
    throw new Error('Gateway artifact manifest must be an object');
  }
  const input = value as Record<string, unknown>;
  if (input.schemaVersion !== GATEWAY_ARTIFACT_MANIFEST_VERSION) {
    throw new Error(
      `unsupported Gateway artifact manifest version: ${String(input.schemaVersion)}`
    );
  }
  if (typeof input.version !== 'string' || input.version.trim().length === 0) {
    throw new Error('Gateway artifact manifest version is required');
  }
  if (!Array.isArray(input.artifacts)) {
    throw new Error('Gateway artifact manifest artifacts must be an array');
  }

  const seen = new Set<GatewayTarget>();
  const artifacts = input.artifacts.map((value, index): GatewayArtifactEntry => {
    if (!value || typeof value !== 'object') {
      throw new Error(`Gateway artifact entry ${index} must be an object`);
    }
    const entry = value as Record<string, unknown>;
    if (
      typeof entry.target !== 'string' ||
      !(GATEWAY_TARGETS as readonly string[]).includes(entry.target)
    ) {
      throw new Error(`Gateway artifact entry ${index} has an unsupported target`);
    }
    const target = entry.target as GatewayTarget;
    if (seen.has(target)) {
      throw new Error(`duplicate Gateway artifact target: ${target}`);
    }
    seen.add(target);
    if (typeof entry.path !== 'string' || entry.path.trim().length === 0) {
      throw new Error(`Gateway artifact entry ${target} has no path`);
    }
    if (typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
      throw new Error(`Gateway artifact entry ${target} has an invalid SHA-256`);
    }
    return { target, path: entry.path, sha256: entry.sha256 };
  });

  if (options.requireAllTargets) {
    const missing = GATEWAY_TARGETS.filter((target) => !seen.has(target));
    if (missing.length > 0) {
      throw new Error(`Gateway artifact manifest is missing targets: ${missing.join(', ')}`);
    }
  }

  return {
    schemaVersion: GATEWAY_ARTIFACT_MANIFEST_VERSION,
    version: input.version,
    artifacts,
  };
}

export function gatewayArtifactEntry(
  manifest: GatewayArtifactManifest,
  target: GatewayTarget
): GatewayArtifactEntry {
  const entry = manifest.artifacts.find((candidate) => candidate.target === target);
  if (!entry) {
    throw new Error(`tmex-gateway artifact is not available for target ${target}`);
  }
  return entry;
}

export function resolveGatewayArtifactPath(root: string, entry: GatewayArtifactEntry): string {
  const absoluteRoot = resolve(root);
  const absolutePath = resolve(absoluteRoot, entry.path);
  if (absolutePath === absoluteRoot || !absolutePath.startsWith(`${absoluteRoot}${sep}`)) {
    throw new Error(`Gateway artifact path escapes its manifest root: ${entry.path}`);
  }
  return absolutePath;
}

export async function verifyGatewayArtifact(
  root: string,
  entry: GatewayArtifactEntry
): Promise<string> {
  const artifactPath = resolveGatewayArtifactPath(root, entry);
  const content = await readFile(artifactPath).catch(() => null);
  if (!content) {
    throw new Error(`tmex-gateway artifact not found: ${artifactPath}`);
  }
  const actual = sha256Hex(content);
  if (actual !== entry.sha256) {
    throw new Error(`tmex-gateway artifact checksum mismatch for target ${entry.target}`);
  }
  return artifactPath;
}

export async function bundleGatewayArtifacts(
  sourceManifestPath: string,
  outputRoot: string,
  expectedVersion: string
): Promise<GatewayArtifactManifest> {
  const absoluteManifestPath = resolve(sourceManifestPath);
  const sourceRoot = dirname(absoluteManifestPath);
  const absoluteOutputRoot = resolve(outputRoot);
  const sourceManifest = parseGatewayArtifactManifest(
    JSON.parse(await readFile(absoluteManifestPath, 'utf8')) as unknown,
    { requireAllTargets: true }
  );
  if (sourceManifest.version !== expectedVersion) {
    throw new Error(
      `artifact version ${sourceManifest.version} does not match tmex-cli version ${expectedVersion}`
    );
  }

  const sources = new Map<GatewayTarget, { path: string; sha256: string }>();
  for (const target of GATEWAY_TARGETS) {
    const entry = gatewayArtifactEntry(sourceManifest, target);
    const path = await verifyGatewayArtifact(sourceRoot, entry);
    if (path === absoluteOutputRoot || path.startsWith(`${absoluteOutputRoot}${sep}`)) {
      throw new Error('Gateway release artifacts must come from outside the package output');
    }
    sources.set(target, { path, sha256: entry.sha256 });
  }

  await rm(absoluteOutputRoot, { recursive: true, force: true });
  await mkdir(absoluteOutputRoot, { recursive: true });
  const artifacts: GatewayArtifactEntry[] = [];
  for (const target of GATEWAY_TARGETS) {
    const source = sources.get(target);
    if (!source) {
      throw new Error(`tmex-gateway artifact was not validated for target ${target}`);
    }
    const outputPath = join(absoluteOutputRoot, target, 'tmex-gateway');
    await mkdir(dirname(outputPath), { recursive: true });
    await copyFile(source.path, outputPath);
    await chmod(outputPath, 0o755);
    artifacts.push({
      target,
      path: relative(absoluteOutputRoot, outputPath).split(sep).join('/'),
      sha256: source.sha256,
    });
  }

  const manifest: GatewayArtifactManifest = {
    schemaVersion: GATEWAY_ARTIFACT_MANIFEST_VERSION,
    version: expectedVersion,
    artifacts,
  };
  await writeFile(
    join(absoluteOutputRoot, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
  return manifest;
}
