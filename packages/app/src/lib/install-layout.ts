import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { t } from '../i18n';
import { pathExists, readText } from './fs-utils';
import {
  type GatewayTarget,
  gatewayArtifactEntry,
  gatewayTargetFor,
  parseGatewayArtifactManifest,
  verifyGatewayArtifact,
} from './gateway-artifacts';

export interface PackageLayout {
  packageRoot: string;
  cliDistPath: string;
  gatewayTarget: GatewayTarget;
  gatewayBinaryPath: string;
  resourceFePath: string;
}

export interface InstallLayout {
  installDir: string;
  binDir: string;
  gatewayBinaryPath: string;
  runtimeDir: string;
  resourcesDir: string;
  feDir: string;
  drizzleDir: string;
  envPath: string;
  runScriptPath: string;
  metaPath: string;
}

export function createInstallLayout(installDir: string): InstallLayout {
  return {
    installDir,
    binDir: join(installDir, 'bin'),
    gatewayBinaryPath: join(installDir, 'bin', 'tmex-gateway'),
    runtimeDir: join(installDir, 'runtime'),
    resourcesDir: join(installDir, 'resources'),
    feDir: join(installDir, 'resources', 'fe-dist'),
    drizzleDir: join(installDir, 'resources', 'gateway-drizzle'),
    envPath: join(installDir, 'app.env'),
    runScriptPath: join(installDir, 'run.sh'),
    metaPath: join(installDir, 'install-meta.json'),
  };
}

async function locatePackageRoot(startDir: string): Promise<string> {
  let current = startDir;

  while (true) {
    const packageJsonPath = join(current, 'package.json');
    if (await pathExists(packageJsonPath)) {
      const parsed = await readText(packageJsonPath)
        .then(
          (content) =>
            JSON.parse(content) as {
              name?: unknown;
              bin?: unknown;
            }
        )
        .catch(() => null);

      if (parsed) {
        const name = typeof parsed.name === 'string' ? parsed.name : '';
        const bin =
          typeof parsed.bin === 'object' && parsed.bin !== null
            ? (parsed.bin as Record<string, unknown>)
            : null;
        const hasTmexBin = bin !== null && typeof bin.tmex === 'string';
        const hasTmexCliBin = bin !== null && typeof bin['tmex-cli'] === 'string';

        if ((name === 'tmex-cli' || name === 'tmex') && (hasTmexBin || hasTmexCliBin)) {
          return current;
        }
      }
    }

    const parent = dirname(current);
    if (parent === current) {
      throw new Error(t('errors.layout.packageRootNotFound'));
    }

    current = parent;
  }
}

export async function resolvePackageLayout(fromModuleUrl: string): Promise<PackageLayout> {
  const currentDir = dirname(fileURLToPath(fromModuleUrl));
  const packageRoot = await locatePackageRoot(currentDir);

  const gatewayArtifactsPath = join(packageRoot, 'resources', 'gateway-artifacts');
  const gatewayManifestPath = join(gatewayArtifactsPath, 'manifest.json');
  if (!(await pathExists(gatewayManifestPath))) {
    throw new Error(t('errors.layout.gatewayManifestMissing', { path: gatewayManifestPath }));
  }
  const manifest = parseGatewayArtifactManifest(
    JSON.parse(await readText(gatewayManifestPath)) as unknown,
    { requireAllTargets: true }
  );
  const packageVersion = (
    JSON.parse(await readText(join(packageRoot, 'package.json'))) as { version?: unknown }
  ).version;
  if (typeof packageVersion !== 'string' || manifest.version !== packageVersion) {
    throw new Error(
      t('errors.layout.gatewayVersionMismatch', {
        packageVersion: String(packageVersion ?? ''),
        artifactVersion: manifest.version,
      })
    );
  }
  const gatewayTarget = gatewayTargetFor();
  const gatewayBinaryPath = await verifyGatewayArtifact(
    gatewayArtifactsPath,
    gatewayArtifactEntry(manifest, gatewayTarget)
  );

  const layout: PackageLayout = {
    packageRoot,
    cliDistPath: join(packageRoot, 'dist', 'cli-node.js'),
    gatewayTarget,
    gatewayBinaryPath,
    resourceFePath: join(packageRoot, 'resources', 'fe-dist'),
  };

  if (!(await pathExists(layout.resourceFePath))) {
    throw new Error(t('errors.layout.feMissing', { path: layout.resourceFePath }));
  }

  return layout;
}

export function resolveInstallDir(input: string): string {
  return resolve(input);
}
