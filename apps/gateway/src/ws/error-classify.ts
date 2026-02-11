export function classifySshError(error: Error): { type: string; message: string } {
  const msg = error.message.toLowerCase();

  if (msg.includes('ssh_config_ref_not_supported')) {
    return {
      type: 'ssh_config_ref_not_supported',
      message: '当前版本暂不支持 SSH Config 引用，请改为填写 host + username，并选择 Agent/私钥/密码认证',
    };
  }
  if (msg.includes('ssh_auth_sock') || msg.includes('auth_sock')) {
    return {
      type: 'agent_unavailable',
      message: 'SSH Agent 不可用：未检测到 SSH_AUTH_SOCK，请检查 agent 环境',
    };
  }
  if (msg.includes('agent') && (msg.includes('no identities') || msg.includes('failure'))) {
    return {
      type: 'agent_no_identity',
      message: 'SSH Agent 未加载可用密钥，请先执行 ssh-add',
    };
  }
  if (msg.includes('permission denied')) {
    return {
      type: 'auth_failed',
      message: '认证失败：服务器拒绝该用户认证，请检查用户名、密钥与 authorized_keys',
    };
  }
  if (msg.includes('all configured authentication methods failed')) {
    return {
      type: 'auth_failed',
      message: '认证失败：用户名、密码或密钥不正确，请检查设备配置',
    };
  }
  if (msg.includes('enetunreach') || msg.includes('ehostunreach')) {
    return {
      type: 'network_unreachable',
      message: '网络不可达：请检查路由、防火墙或 VPN 配置',
    };
  }
  if (msg.includes('connect refused') || msg.includes('connection refused') || msg.includes('econnrefused')) {
    return {
      type: 'connection_refused',
      message: '连接被拒绝：无法连接到目标主机，请检查主机地址和端口是否正确',
    };
  }
  if (msg.includes('timeout') || msg.includes('etimedout')) {
    return {
      type: 'timeout',
      message: '连接超时：无法连接到设备，请检查网络或防火墙设置',
    };
  }
  if (msg.includes('host not found') || msg.includes('getaddrinfo') || msg.includes('enotfound')) {
    return {
      type: 'host_not_found',
      message: '主机未找到：无法解析主机地址，请检查 DNS 或主机名是否正确',
    };
  }
  if (msg.includes('handshake failed') || msg.includes('unable to verify')) {
    return {
      type: 'handshake_failed',
      message: '握手失败：无法建立安全连接，可能是密钥交换算法不兼容',
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
      message: '远端 tmux 不可用或启动失败，请检查远端是否已安装 tmux 且支持 -CC',
    };
  }

  return {
    type: 'unknown',
    message: `连接失败：${error.message}`,
  };
}

