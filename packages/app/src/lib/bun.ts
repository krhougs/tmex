import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { MIN_BUN_VERSION } from '../constants';
import { t } from '../i18n';
import { runCommand } from './process';
import { compareSemver } from './semver';

const ANSI_ESCAPE_REGEX = /\x1b\[[\x30-\x3F]*[\x20-\x2F]*[\x40-\x7E]|\x1b\].*?(?:\x07|\x1b\\)/g;

export function stripAnsi(text: string): string {
  // 移除 CSI 序列 \x1b[... 和 OSC 序列 \x1b]...（以 \x07 或 \x1b\ 结尾）
  return text.replace(ANSI_ESCAPE_REGEX, '');
}

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

  const bin = stripAnsi(result.stdout).trim();
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
