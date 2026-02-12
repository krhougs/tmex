import { randomBytes } from 'node:crypto';
import { chmod, copyFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { InstallMeta } from '../types';
import { copyDirectory, ensureDir, pathExists, writeText } from './fs-utils';
import type { InstallLayout, PackageLayout } from './install-layout';
import { writeJsonFile } from './json-file';

export function generateMasterKey(): string {
  return randomBytes(32).toString('base64');
}

export interface AppEnvInput {
  host: string;
  port: number;
  databasePath: string;
  masterKey: string;
}

export function buildAppEnvValues(input: AppEnvInput): Record<string, string> {
  return {
    NODE_ENV: 'production',
    TMEX_BIND_HOST: input.host,
    GATEWAY_PORT: String(input.port),
    DATABASE_URL: input.databasePath,
    TMEX_MASTER_KEY: input.masterKey,
    TMEX_BASE_URL: `http://${input.host}:${input.port}`,
    TMEX_SITE_NAME: 'tmex',
  };
}

export async function ensureInstallDir(installDir: string, force: boolean): Promise<void> {
  if (!(await pathExists(installDir))) {
    await ensureDir(installDir);
    return;
  }

  if (!force) {
    return;
  }

  await rm(installDir, { recursive: true, force: true });
  await ensureDir(installDir);
}

export async function deployRuntimeFiles(
  packageLayout: PackageLayout,
  installLayout: InstallLayout
): Promise<void> {
  await rm(installLayout.runtimeDir, { recursive: true, force: true });
  await rm(installLayout.feDir, { recursive: true, force: true });
  await rm(installLayout.drizzleDir, { recursive: true, force: true });

  await ensureDir(installLayout.runtimeDir);
  await ensureDir(installLayout.resourcesDir);

  await copyDirectory(packageLayout.runtimeDirPath, installLayout.runtimeDir);
  await copyDirectory(packageLayout.resourceFePath, installLayout.feDir);
  await copyDirectory(packageLayout.resourceDrizzlePath, installLayout.drizzleDir);
}

export async function writeRunScript(installLayout: InstallLayout, bunPath: string): Promise<void> {
  const lines = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    '',
    'SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"',
    'while IFS= read -r line || [[ -n "$line" ]]; do',
    "  line=\"${line%$'\\r'}\"",
    "  [[ \"$line\" =~ ^[[:space:]]*$ ]] && continue",
    "  [[ \"$line\" =~ ^[[:space:]]*# ]] && continue",
    '  export "$line"',
    `done < "${installLayout.envPath}"`,
    '',
    'if [[ -n "${HOME:-}" ]] && [[ -d "${HOME}/.bun/bin" ]]; then',
    '  export PATH="${HOME}/.bun/bin:${PATH:-}"',
    'fi',
    '',
    `export TMEX_FE_DIST_DIR="${installLayout.feDir}"`,
    `export TMEX_MIGRATIONS_DIR="${installLayout.drizzleDir}"`,
    '',
    `exec "${bunPath}" "${installLayout.runtimeServerPath}"`,
    '',
  ];
  const script = lines.join('\n');

  await writeText(installLayout.runScriptPath, script, 0o755);
  await chmod(installLayout.runScriptPath, 0o755);
}

export async function writeInstallMeta(
  installLayout: InstallLayout,
  meta: InstallMeta
): Promise<void> {
  await writeJsonFile(installLayout.metaPath, meta, 0o600);
}

export async function backupInstallArtifacts(
  installLayout: InstallLayout,
  backupDir: string
): Promise<void> {
  await ensureDir(backupDir);

  if (await pathExists(installLayout.runtimeDir)) {
    await copyDirectory(installLayout.runtimeDir, resolve(backupDir, 'runtime'));
  }

  if (await pathExists(installLayout.resourcesDir)) {
    await copyDirectory(installLayout.resourcesDir, resolve(backupDir, 'resources'));
  }

  if (await pathExists(installLayout.runScriptPath)) {
    await copyFile(installLayout.runScriptPath, resolve(backupDir, 'run.sh'));
  }

  if (await pathExists(installLayout.metaPath)) {
    await copyFile(installLayout.metaPath, resolve(backupDir, 'install-meta.json'));
  }
}

export async function restoreInstallArtifacts(
  installLayout: InstallLayout,
  backupDir: string
): Promise<void> {
  const runtimeBackup = resolve(backupDir, 'runtime');
  const resourcesBackup = resolve(backupDir, 'resources');
  const runScriptBackup = resolve(backupDir, 'run.sh');
  const metaBackup = resolve(backupDir, 'install-meta.json');

  await rm(installLayout.runtimeDir, { recursive: true, force: true });
  await rm(installLayout.resourcesDir, { recursive: true, force: true });

  if (await pathExists(runtimeBackup)) {
    await copyDirectory(runtimeBackup, installLayout.runtimeDir);
  }

  if (await pathExists(resourcesBackup)) {
    await copyDirectory(resourcesBackup, installLayout.resourcesDir);
  }

  if (await pathExists(runScriptBackup)) {
    await copyFile(runScriptBackup, installLayout.runScriptPath);
  }

  if (await pathExists(metaBackup)) {
    await copyFile(metaBackup, installLayout.metaPath);
  }
}
