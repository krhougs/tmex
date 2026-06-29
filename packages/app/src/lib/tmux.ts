import { MIN_TMUX_VERSION } from '../constants';
import { runCommand } from './process';

export interface TmuxVersion {
  major: number;
  minor: number;
}

export interface TmuxCheckResult {
  ok: boolean;
  path?: string;
  version?: TmuxVersion;
  versionRaw?: string;
  reason?: 'not-found' | 'version-too-low';
}

export function parseTmuxVersion(versionOutput: string): TmuxVersion | null {
  const match = versionOutput.match(/(\d+)\.(\d+)/);
  if (!match) return null;
  return {
    major: Number.parseInt(match[1] as string, 10),
    minor: Number.parseInt(match[2] as string, 10),
  };
}

export function compareTmuxVersion(
  current: TmuxVersion | null,
  min: TmuxVersion
): boolean {
  if (!current) return true;
  if (current.major !== min.major) return current.major > min.major;
  return current.minor >= min.minor;
}

export async function checkTmuxVersion(
  minVersion: TmuxVersion = MIN_TMUX_VERSION
): Promise<TmuxCheckResult> {
  const result = await runCommand('tmux', ['-V'], {
    stdio: 'pipe',
    timeoutMs: 5000,
  }).catch(() => null);

  if (!result || result.code !== 0) {
    return { ok: false, reason: 'not-found' };
  }

  const raw = result.stdout.trim();
  const version = parseTmuxVersion(raw);

  if (!compareTmuxVersion(version, minVersion)) {
    return {
      ok: false,
      version: version ?? undefined,
      versionRaw: raw,
      reason: 'version-too-low',
    };
  }

  return {
    ok: true,
    version: version ?? undefined,
    versionRaw: raw,
  };
}
