import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

const SHELL_ENV_BEGIN_MARKER = '__TMEX_SHELL_ENV_BEGIN__';
const SHELL_ENV_END_MARKER = '__TMEX_SHELL_ENV_END__';
const SHELL_ENV_PROBE_COMMAND = `printf '${SHELL_ENV_BEGIN_MARKER}\\n'; /usr/bin/env; printf '${SHELL_ENV_END_MARKER}\\n'`;

interface RunSyncResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface LocalShellPathCacheDeps {
  env: NodeJS.ProcessEnv;
  fileExists: (path: string) => boolean;
  platform: NodeJS.Platform;
  runSync: (cmd: string[]) => RunSyncResult;
}

export interface LocalShellPathCache {
  get(): string | null;
  prime(): string | null;
}

function defaultRunSync(cmd: string[]): RunSyncResult {
  const result = Bun.spawnSync(cmd, {
    env: process.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  return {
    exitCode: result.exitCode,
    stdout: Buffer.from(result.stdout).toString('utf8'),
    stderr: Buffer.from(result.stderr).toString('utf8'),
  };
}

function resolveShellFromDscl(deps: LocalShellPathCacheDeps): string | null {
  if (deps.platform !== 'darwin') {
    return null;
  }

  const username = deps.env.USER?.trim() || deps.env.LOGNAME?.trim();
  if (!username) {
    return null;
  }

  const result = deps.runSync(['/usr/bin/dscl', '.', '-read', `/Users/${username}`, 'UserShell']);
  if (result.exitCode !== 0) {
    return null;
  }

  const matched = result.stdout.match(/UserShell:\s*(\S+)/);
  const shellPath = matched?.[1]?.trim();
  if (!shellPath || !deps.fileExists(shellPath)) {
    return null;
  }

  return shellPath;
}

function resolveDefaultShell(deps: LocalShellPathCacheDeps): string | null {
  const envShell = deps.env.SHELL?.trim();
  if (envShell && deps.fileExists(envShell)) {
    return envShell;
  }

  const dsclShell = resolveShellFromDscl(deps);
  if (dsclShell) {
    return dsclShell;
  }

  const fallbackShell = deps.platform === 'darwin' ? '/bin/zsh' : '/bin/bash';
  if (deps.fileExists(fallbackShell)) {
    return fallbackShell;
  }

  return null;
}

function extractPathFromShellEnv(stdout: string): string | null {
  const beginIndex = stdout.lastIndexOf(SHELL_ENV_BEGIN_MARKER);
  if (beginIndex < 0) {
    return null;
  }

  const endIndex = stdout.indexOf(SHELL_ENV_END_MARKER, beginIndex + SHELL_ENV_BEGIN_MARKER.length);
  if (endIndex < 0) {
    return null;
  }

  const body = stdout.slice(beginIndex + SHELL_ENV_BEGIN_MARKER.length, endIndex);
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('PATH=')) {
      continue;
    }

    const value = line.slice('PATH='.length).trim();
    return value.length > 0 ? value : null;
  }

  return null;
}

function canResolveExecutableFromPath(
  resolvedPath: string,
  executableName: string,
  deps: LocalShellPathCacheDeps
): boolean {
  for (const rawDir of resolvedPath.split(delimiter)) {
    const dir = rawDir.trim();
    if (!dir) {
      continue;
    }

    if (deps.fileExists(join(dir, executableName))) {
      return true;
    }
  }

  return false;
}

function probeShellPath(shellPath: string, deps: LocalShellPathCacheDeps): string | null {
  const attempts = [
    [shellPath, '-l', '-c', SHELL_ENV_PROBE_COMMAND],
    [shellPath, '-l', '-i', '-c', SHELL_ENV_PROBE_COMMAND],
    [shellPath, '-c', SHELL_ENV_PROBE_COMMAND],
  ];
  let fallbackPath: string | null = null;

  for (const cmd of attempts) {
    const result = deps.runSync(cmd);
    if (result.exitCode !== 0) {
      continue;
    }

    const resolvedPath = extractPathFromShellEnv(result.stdout);
    if (!resolvedPath) {
      continue;
    }

    fallbackPath ??= resolvedPath;
    if (canResolveExecutableFromPath(resolvedPath, 'tmux', deps)) {
      return resolvedPath;
    }
  }

  return fallbackPath;
}

export function createLocalShellPathCache(
  input: Partial<LocalShellPathCacheDeps> = {}
): LocalShellPathCache {
  const deps: LocalShellPathCacheDeps = {
    env: input.env ?? process.env,
    fileExists: input.fileExists ?? existsSync,
    platform: input.platform ?? process.platform,
    runSync: input.runSync ?? defaultRunSync,
  };

  let initialized = false;
  let cachedPath: string | null = null;

  return {
    get() {
      return initialized ? cachedPath : null;
    },
    prime() {
      if (initialized) {
        return cachedPath;
      }

      initialized = true;
      const shellPath = resolveDefaultShell(deps);
      if (!shellPath) {
        return null;
      }

      cachedPath = probeShellPath(shellPath, deps);
      return cachedPath;
    },
  };
}

const defaultLocalShellPathCache = createLocalShellPathCache();

export function primeLocalShellPath(): string | null {
  return defaultLocalShellPathCache.prime();
}

export function getLocalShellPath(): string | null {
  return defaultLocalShellPathCache.get();
}

export function buildLocalTmuxEnv(
  resolvedPath: string | null,
  baseEnv: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const nextEnv: NodeJS.ProcessEnv = {
    ...baseEnv,
  };

  if (resolvedPath) {
    nextEnv.PATH = resolvedPath;
  }

  if (!nextEnv.LC_CTYPE && !nextEnv.LC_ALL && !nextEnv.LANG) {
    nextEnv.LC_CTYPE = 'en_US.UTF-8';
  }

  return nextEnv;
}
