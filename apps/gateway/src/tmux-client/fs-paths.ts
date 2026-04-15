import { join } from 'node:path';

const DEFAULT_ROOT_DIR = '/tmp/tmex';

export interface RuntimeFsPathsOptions {
  deviceId: string;
  gatewayPid: number;
  rootDir?: string;
}

export interface RuntimeFsPaths {
  rootDir: string;
  panesDir: string;
  hooksDir: string;
  hookFifoPath: string;
  paneFifoPath: (paneId: string) => string;
}

export function toSafePathSegment(value: string): string {
  return Array.from(value)
    .map((char) => {
      if (/^[A-Za-z0-9._-]$/.test(char)) {
        return char;
      }
      return `_${char.codePointAt(0)?.toString(16) ?? '00'}_`;
    })
    .join('');
}

export function createRuntimeFsPaths(options: RuntimeFsPathsOptions): RuntimeFsPaths {
  const baseRootDir = options.rootDir ?? DEFAULT_ROOT_DIR;
  const runtimeDirName = `${toSafePathSegment(options.deviceId)}-${options.gatewayPid}`;
  const runtimeRootDir = join(baseRootDir, runtimeDirName);
  const panesDir = join(runtimeRootDir, 'panes');
  const hooksDir = join(runtimeRootDir, 'hooks');

  return {
    rootDir: runtimeRootDir,
    panesDir,
    hooksDir,
    hookFifoPath: join(hooksDir, 'events.fifo'),
    paneFifoPath(paneId) {
      return join(panesDir, `${toSafePathSegment(paneId)}.fifo`);
    },
  };
}
