import { t } from '../i18n';

export interface Semver {
  major: number;
  minor: number;
  patch: number;
}

export function parseSemver(input: string): Semver {
  const match = input.trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    throw new Error(t('errors.version.invalid', { input }));
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

export function compareSemver(left: string, right: string): number {
  const a = parseSemver(left);
  const b = parseSemver(right);

  if (a.major !== b.major) return a.major > b.major ? 1 : -1;
  if (a.minor !== b.minor) return a.minor > b.minor ? 1 : -1;
  if (a.patch !== b.patch) return a.patch > b.patch ? 1 : -1;
  return 0;
}
