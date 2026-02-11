export function classifySshError(error: Error): { type: string; messageKey: string; messageParams?: Record<string, unknown> } {
  const msg = error.message.toLowerCase();

  if (msg.includes('ssh_config_ref_not_supported')) {
    return {
      type: 'ssh_config_ref_not_supported',
      messageKey: 'sshError.configRefNotSupported',
    };
  }
  if (msg.includes('ssh_auth_sock') || msg.includes('auth_sock')) {
    return {
      type: 'agent_unavailable',
      messageKey: 'sshError.agentUnavailable',
    };
  }
  if (msg.includes('agent') && (msg.includes('no identities') || msg.includes('failure'))) {
    return {
      type: 'agent_no_identity',
      messageKey: 'sshError.agentNoIdentities',
    };
  }
  if (msg.includes('permission denied')) {
    return {
      type: 'auth_failed',
      messageKey: 'sshError.authFailed',
    };
  }
  if (msg.includes('all configured authentication methods failed')) {
    return {
      type: 'auth_failed',
      messageKey: 'sshError.authFailedGeneric',
    };
  }
  if (msg.includes('enetunreach') || msg.includes('ehostunreach')) {
    return {
      type: 'network_unreachable',
      messageKey: 'sshError.networkUnreachable',
    };
  }
  if (msg.includes('connect refused') || msg.includes('connection refused') || msg.includes('econnrefused')) {
    return {
      type: 'connection_refused',
      messageKey: 'sshError.connectionRefused',
    };
  }
  if (msg.includes('timeout') || msg.includes('etimedout')) {
    return {
      type: 'timeout',
      messageKey: 'sshError.connectionTimeout',
    };
  }
  if (msg.includes('host not found') || msg.includes('getaddrinfo') || msg.includes('enotfound')) {
    return {
      type: 'host_not_found',
      messageKey: 'sshError.hostNotFound',
    };
  }
  if (msg.includes('handshake failed') || msg.includes('unable to verify')) {
    return {
      type: 'handshake_failed',
      messageKey: 'sshError.handshakeFailed',
    };
  }
  if (
    msg.includes('tmux: command not found') ||
    msg.includes('tmux control mode not ready') ||
    msg.includes('tmux exited') ||
    msg.includes('tmux_exec_failed')
  ) {
    return {
      type: 'tmux_unavailable',
      messageKey: 'sshError.tmuxUnavailable',
    };
  }

  return {
    type: 'unknown',
    messageKey: 'sshError.unknown',
    messageParams: { message: error.message },
  };
}
