import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Device } from '@tmex/shared';
import type { ConnectConfig } from 'ssh2';

import type { decryptWithContext } from '../crypto';
import { resolveSshAgentSocket, resolveSshUsername } from '../tmux/ssh-auth';

type SshAuthEnv = Partial<Record<'SSH_AUTH_SOCK' | 'USER' | 'LOGNAME', string | undefined>>;

interface RunSyncResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface ResolvedSshConfigRef {
  host: string;
  port?: number;
  username?: string;
  identityAgent?: string;
  identityFiles: string[];
}

export interface ResolveSshConnectConfigDeps {
  env: NodeJS.ProcessEnv;
  runSync: (cmd: string[]) => RunSyncResult;
  fileExists: (path: string) => boolean;
  readTextFile: (path: string) => string;
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

function expandHomePath(value: string, env: NodeJS.ProcessEnv): string {
  const trimmed = value.trim();
  if (trimmed === '~') {
    return env.HOME?.trim() || trimmed;
  }
  if (trimmed.startsWith('~/') && env.HOME?.trim()) {
    return join(env.HOME.trim(), trimmed.slice(2));
  }
  return trimmed;
}

function parseSshConfigOutput(stdout: string, env: NodeJS.ProcessEnv): ResolvedSshConfigRef {
  let host = '';
  let port: number | undefined;
  let username: string | undefined;
  let identityAgent: string | undefined;
  const identityFiles: string[] = [];

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const firstSpace = line.indexOf(' ');
    if (firstSpace <= 0) {
      continue;
    }

    const key = line.slice(0, firstSpace).trim().toLowerCase();
    const value = line.slice(firstSpace + 1).trim();
    if (!value) {
      continue;
    }

    switch (key) {
      case 'hostname':
        host = value;
        break;
      case 'port': {
        const parsedPort = Number.parseInt(value, 10);
        port = Number.isNaN(parsedPort) ? undefined : parsedPort;
        break;
      }
      case 'user':
        username = value;
        break;
      case 'identityagent':
        identityAgent = value;
        break;
      case 'identityfile':
        identityFiles.push(expandHomePath(value, env));
        break;
    }
  }

  if (!host) {
    throw new Error('ssh_config_ref_invalid: SSH Config 引用未解析到 hostname');
  }

  return {
    host,
    port,
    username,
    identityAgent,
    identityFiles,
  };
}

function toSshAuthEnv(env: NodeJS.ProcessEnv): SshAuthEnv {
  return {
    SSH_AUTH_SOCK: env.SSH_AUTH_SOCK,
    USER: env.USER,
    LOGNAME: env.LOGNAME,
  };
}

function resolveAgentFromConfig(
  identityAgent: string | undefined,
  deps: ResolveSshConnectConfigDeps
): string | undefined {
  const trimmed = identityAgent?.trim();
  if (!trimmed || trimmed.toLowerCase() === 'none') {
    return undefined;
  }
  if (trimmed === 'SSH_AUTH_SOCK' || trimmed === '$SSH_AUTH_SOCK') {
    return resolveSshAgentSocket('auto', toSshAuthEnv(deps.env));
  }

  const expanded = expandHomePath(trimmed, deps.env);
  return deps.fileExists(expanded) ? expanded : undefined;
}

function resolvePrivateKeyFromConfig(
  identityFiles: readonly string[],
  deps: ResolveSshConnectConfigDeps
): string | undefined {
  for (const identityFile of identityFiles) {
    if (!deps.fileExists(identityFile)) {
      continue;
    }
    return deps.readTextFile(identityFile);
  }

  return undefined;
}

function resolveSshConfigRef(
  device: Device,
  deps: ResolveSshConnectConfigDeps
): ResolvedSshConfigRef | null {
  const ref = device.sshConfigRef?.trim();
  if (!ref) {
    return null;
  }

  const result = deps.runSync(['ssh', '-G', ref]);
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || ref;
    throw new Error(`ssh_config_ref_resolve_failed: ${detail}`);
  }

  return parseSshConfigOutput(result.stdout, deps.env);
}

export async function resolveSshConnectConfig(
  device: Device,
  decrypt: typeof decryptWithContext,
  inputDeps: Partial<ResolveSshConnectConfigDeps> = {}
): Promise<ConnectConfig> {
  const deps: ResolveSshConnectConfigDeps = {
    env: inputDeps.env ?? process.env,
    runSync: inputDeps.runSync ?? defaultRunSync,
    fileExists: inputDeps.fileExists ?? existsSync,
    readTextFile: inputDeps.readTextFile ?? ((path) => readFileSync(path, 'utf8')),
  };
  const sshEnv = toSshAuthEnv(deps.env);

  const resolvedConfig = resolveSshConfigRef(device, deps);
  const host = resolvedConfig?.host ?? device.host;
  const port = resolvedConfig?.port ?? device.port ?? 22;
  const username = resolvedConfig?.username ?? resolveSshUsername(device.username, device.authMode, sshEnv);

  if (!host) {
    throw new Error('SSH device missing host');
  }

  const authConfig: ConnectConfig = {
    host,
    port,
    username,
  };

  const configAgent = resolveAgentFromConfig(resolvedConfig?.identityAgent, deps);
  const envAgent = resolveSshAgentSocket('auto', sshEnv);
  const configPrivateKey = resolvePrivateKeyFromConfig(resolvedConfig?.identityFiles ?? [], deps);

  switch (device.authMode) {
    case 'password': {
      if (!device.passwordEnc) {
        throw new Error('auth_password_missing: 密码认证未提供密码');
      }
      authConfig.password = await decrypt(device.passwordEnc, {
        scope: 'device',
        entityId: device.id,
        field: 'password_enc',
      });
      break;
    }
    case 'key': {
      if (!device.privateKeyEnc) {
        throw new Error('auth_key_missing: 私钥认证未提供私钥');
      }
      authConfig.privateKey = await decrypt(device.privateKeyEnc, {
        scope: 'device',
        entityId: device.id,
        field: 'private_key_enc',
      });
      if (device.privateKeyPassphraseEnc) {
        authConfig.passphrase = await decrypt(device.privateKeyPassphraseEnc, {
          scope: 'device',
          entityId: device.id,
          field: 'private_key_passphrase_enc',
        });
      }
      break;
    }
    case 'agent': {
      authConfig.agent = configAgent ?? resolveSshAgentSocket('agent', sshEnv);
      break;
    }
    case 'configRef': {
      if (!resolvedConfig) {
        throw new Error('ssh_config_ref_missing: SSH Config 引用不能为空');
      }
      if (configAgent ?? envAgent) {
        authConfig.agent = configAgent ?? envAgent;
      }
      if (configPrivateKey) {
        authConfig.privateKey = configPrivateKey;
      }
      if (!authConfig.agent && !authConfig.privateKey) {
        throw new Error(
          'ssh_config_ref_auth_missing: SSH Config 引用未解析到可用认证方式（IdentityAgent / IdentityFile / SSH_AUTH_SOCK）'
        );
      }
      break;
    }
    case 'auto': {
      if (configAgent ?? envAgent) {
        authConfig.agent = configAgent ?? envAgent;
      }
      if (device.privateKeyEnc) {
        authConfig.privateKey = await decrypt(device.privateKeyEnc, {
          scope: 'device',
          entityId: device.id,
          field: 'private_key_enc',
        });
      } else if (configPrivateKey) {
        authConfig.privateKey = configPrivateKey;
      } else if (device.passwordEnc) {
        authConfig.password = await decrypt(device.passwordEnc, {
          scope: 'device',
          entityId: device.id,
          field: 'password_enc',
        });
      }
      break;
    }
  }

  if (
    device.authMode === 'auto' &&
    !authConfig.agent &&
    !authConfig.privateKey &&
    !authConfig.password
  ) {
    throw new Error('auth_auto_missing: auto 模式下未找到可用认证方式（SSH_AUTH_SOCK / 私钥 / 密码）');
  }

  return authConfig;
}
