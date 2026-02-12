import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { t } from '../i18n';
import { pathExists, readText } from './fs-utils';

export interface PackageLayout {
  packageRoot: string;
  cliDistPath: string;
  runtimeDirPath: string;
  resourceFePath: string;
  resourceDrizzlePath: string;
}

export interface InstallLayout {
  installDir: string;
  runtimeDir: string;
  runtimeServerPath: string;
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
    runtimeDir: join(installDir, 'runtime'),
    runtimeServerPath: join(installDir, 'runtime', 'server.js'),
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

  const layout: PackageLayout = {
    packageRoot,
    cliDistPath: join(packageRoot, 'dist', 'cli-node.js'),
    runtimeDirPath: join(packageRoot, 'dist', 'runtime'),
    resourceFePath: join(packageRoot, 'resources', 'fe-dist'),
    resourceDrizzlePath: join(packageRoot, 'resources', 'gateway-drizzle'),
  };

  if (!(await pathExists(join(layout.runtimeDirPath, 'server.js')))) {
    throw new Error(
      t('errors.layout.runtimeMissing', { path: join(layout.runtimeDirPath, 'server.js') })
    );
  }

  if (!(await pathExists(layout.resourceFePath))) {
    throw new Error(t('errors.layout.feMissing', { path: layout.resourceFePath }));
  }

  if (!(await pathExists(layout.resourceDrizzlePath))) {
    throw new Error(t('errors.layout.drizzleMissing', { path: layout.resourceDrizzlePath }));
  }

  return layout;
}

export function resolveInstallDir(input: string): string {
  return resolve(input);
}
