export type ServiceManagerKind = 'systemd-user' | 'launchd' | 'none';

export function detectServiceManager(
  platform: NodeJS.Platform = process.platform
): ServiceManagerKind {
  if (platform === 'linux') return 'systemd-user';
  if (platform === 'darwin') return 'launchd';
  return 'none';
}

export function isSupportedPlatform(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'linux' || platform === 'darwin';
}
