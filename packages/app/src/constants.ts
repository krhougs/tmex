import { homedir } from 'node:os';
import { resolve } from 'node:path';

export const MIN_BUN_VERSION = '1.3.0';
export const DEFAULT_SERVICE_NAME = 'tmex';

export function defaultInstallDir(platform: NodeJS.Platform): string {
  if (platform === 'darwin') {
    return resolve(homedir(), 'Library', 'Application Support', 'tmex');
  }

  return resolve(homedir(), '.local', 'share', 'tmex');
}

export function defaultDatabasePath(installDir: string): string {
  return resolve(installDir, 'data', 'tmex.db');
}

export function defaultHost(): string {
  return '127.0.0.1';
}

export function defaultPort(): number {
  return 9883;
}
