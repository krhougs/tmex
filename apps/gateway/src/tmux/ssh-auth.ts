import type { AuthMode } from '@tmex/shared';

type EnvLike = Partial<Record<'SSH_AUTH_SOCK' | 'USER' | 'LOGNAME', string | undefined>>;

function normalizeEnvValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function resolveSshUsername(
  configuredUsername: string | undefined,
  authMode: AuthMode,
  env: EnvLike = process.env
): string {
  const explicitUsername = normalizeEnvValue(configuredUsername);
  if (explicitUsername) {
    return explicitUsername;
  }

  if (authMode === 'agent' || authMode === 'auto') {
    const currentUser = normalizeEnvValue(env.USER) ?? normalizeEnvValue(env.LOGNAME);
    if (currentUser) {
      return currentUser;
    }
  }

  return 'root';
}

export function resolveSshAgentSocket(
  authMode: AuthMode,
  env: EnvLike = process.env
): string | undefined {
  if (authMode !== 'agent' && authMode !== 'auto') {
    return undefined;
  }

  const socket = normalizeEnvValue(env.SSH_AUTH_SOCK);
  if (socket) {
    return socket;
  }

  if (authMode === 'agent') {
    throw new Error('SSH_AUTH_SOCK 未设置，无法使用 SSH Agent 认证');
  }

  return undefined;
}
