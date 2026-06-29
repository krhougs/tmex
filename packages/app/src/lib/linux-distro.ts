import { readFile } from 'node:fs/promises';

export interface LinuxDistroInfo {
  id: string;
  idLike: string[];
  versionId?: string;
  name?: string;
}

export type PackageManagerFamily = 'apt' | 'dnf' | 'pacman' | 'apk' | 'zypper' | 'brew' | 'unknown';

export function parseOsRelease(content: string): LinuxDistroInfo | null {
  const lines = content.split('\n');
  const fields: Record<string, string> = {};

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex < 0) continue;
    const key = trimmed.slice(0, eqIndex);
    let value = trimmed.slice(eqIndex + 1);
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    fields[key] = value;
  }

  const id = fields.ID;
  if (!id) return null;

  const idLikeRaw = fields.ID_LIKE;
  const idLike = idLikeRaw ? idLikeRaw.split(/\s+/).filter(Boolean) : [];

  return {
    id,
    idLike,
    versionId: fields.VERSION_ID,
    name: fields.NAME,
  };
}

export async function detectLinuxDistro(): Promise<LinuxDistroInfo | null> {
  try {
    const content = await readFile('/etc/os-release', 'utf-8');
    return parseOsRelease(content);
  } catch {
    return null;
  }
}

export function detectPackageManager(
  distro: LinuxDistroInfo | null,
  platform: NodeJS.Platform = process.platform
): PackageManagerFamily {
  if (platform === 'darwin') return 'brew';
  if (platform !== 'linux') return 'unknown';
  if (!distro) return 'unknown';

  const allIds = [distro.id, ...distro.idLike];

  for (const id of allIds) {
    const lower = id.toLowerCase();
    if (lower === 'debian' || lower === 'ubuntu') return 'apt';
    if (lower === 'fedora' || lower === 'rhel' || lower === 'centos') return 'dnf';
    if (lower === 'arch' || lower === 'manjaro') return 'pacman';
    if (lower === 'alpine') return 'apk';
    if (lower.startsWith('opensuse') || lower === 'suse') return 'zypper';
  }

  return 'unknown';
}
