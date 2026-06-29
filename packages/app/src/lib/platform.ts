import { runCommand } from './process';

export type ServiceManagerKind = 'systemd-user' | 'launchd' | 'none';

export async function detectServiceManager(
  platform: NodeJS.Platform = process.platform
): Promise<ServiceManagerKind> {
  if (platform === 'darwin') return 'launchd';
  if (platform === 'linux') {
    const result = await runCommand('systemctl', ['--version'], {
      stdio: 'pipe',
      timeoutMs: 5000,
    }).catch(() => null);
    if (result && result.code === 0) return 'systemd-user';
    return 'none';
  }
  return 'none';
}

export function isSupportedPlatform(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'linux' || platform === 'darwin';
}
