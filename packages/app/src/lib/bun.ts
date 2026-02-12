import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { MIN_BUN_VERSION } from '../constants';
import { t } from '../i18n';
import { runCommand } from './process';
import { compareSemver } from './semver';

export interface BunCheckResult {
  ok: boolean;
  path?: string;
  version?: string;
  reason?: string;
}

async function locateBunFromShell(): Promise<string | null> {
  const result = await runCommand('zsh', ['-lic', 'command -v bun'], { stdio: 'pipe' }).catch(
    () => null
  );

  if (!result || result.code !== 0) {
    return null;
  }

  const bin = result.stdout.trim();
  if (!bin) {
    return null;
  }

  return bin;
}

export async function findBunBinary(): Promise<string | null> {
  const zshBin = await locateBunFromShell();
  if (zshBin) {
    return zshBin;
  }

  const fallback = join(homedir(), '.bun', 'bin', 'bun');
  if (existsSync(fallback)) {
    return fallback;
  }

  const direct = await runCommand('bun', ['--version'], { stdio: 'pipe' }).catch(() => null);
  if (direct?.code === 0) {
    return 'bun';
  }

  return null;
}

export async function checkBunVersion(minVersion = MIN_BUN_VERSION): Promise<BunCheckResult> {
  const bunPath = await findBunBinary();
  if (!bunPath) {
    return {
      ok: false,
      reason: t('bun.notFound'),
    };
  }

  const versionResult = await runCommand(bunPath, ['--version'], { stdio: 'pipe' }).catch(
    () => null
  );
  if (!versionResult || versionResult.code !== 0) {
    return {
      ok: false,
      reason: t('bun.versionExecFailed'),
      path: bunPath,
    };
  }

  const version = versionResult.stdout.trim();

  if (compareSemver(version, minVersion) < 0) {
    return {
      ok: false,
      path: bunPath,
      version,
      reason: t('bun.versionTooLow', { version, minVersion }),
    };
  }

  return {
    ok: true,
    path: bunPath,
    version,
  };
}
