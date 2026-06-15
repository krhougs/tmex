function getEnv(key: string, defaultValue: string): string {
  return process.env[key] ?? defaultValue;
}

function getBooleanEnv(key: string, defaultValue: boolean): boolean {
  const value = process.env[key];
  if (value === undefined) {
    return defaultValue;
  }
  return value === '1' || value.toLowerCase() === 'true' || value.toLowerCase() === 'yes';
}

export const config = {
  // 核心安全配置（生产环境建议配置，用于加密敏感字段）
  masterKey: process.env.TMEX_MASTER_KEY,

  // 服务配置
  port: Number.parseInt(getEnv('GATEWAY_PORT', '9663'), 10),
  baseUrl: getEnv('TMEX_BASE_URL', 'http://127.0.0.1:8085'),
  siteNameDefault: getEnv('TMEX_SITE_NAME', 'tmex'),

  // 数据库
  databaseUrl: getEnv('DATABASE_URL', './tmex.db'),

  // 文件传输（上传/下载）单文件字节上限，默认 2GB；后端校验 + 前端上传前预校验共用
  transferMaxBytes: Number.parseInt(getEnv('TMEX_TRANSFER_MAX_BYTES', '2147483648'), 10),

  // 设置默认值（可被数据库中的实际设置覆盖）
  bellThrottleSecondsDefault: Number.parseInt(getEnv('TMEX_BELL_THROTTLE_SECONDS', '6'), 10),
  notificationThrottleSecondsDefault: Number.parseInt(
    getEnv('TMEX_NOTIFICATION_THROTTLE_SECONDS', '3'),
    10
  ),
  tmuxAllowPassthrough: getBooleanEnv('TMEX_TMUX_ALLOW_PASSTHROUGH', false),
  tmuxTermProgram: getEnv('TMEX_TMUX_TERM_PROGRAM', 'ghostty'),
  // 受管 session 的 window-style，用于 tmux 代答 pane 内 OSC 10/11 颜色查询；
  // 默认与前端 seoul256 dark 主题一致，设为 off 关闭
  tmuxWindowStyle: getEnv('TMEX_TMUX_WINDOW_STYLE', 'fg=#d0d0d0,bg=#262626'),
  // local 设备的 tmux socket（tmux -L <name>）。仅 e2e 注入 TMEX_TMUX_SOCKET=tmex-e2e
  // 以与生产默认 socket 隔离；生产/普通运行不设 → 空串 → 不加 -L → 用默认 socket。
  tmuxSocket: getEnv('TMEX_TMUX_SOCKET', ''),
  sshReconnectMaxRetriesDefault: Number.parseInt(getEnv('TMEX_SSH_RECONNECT_MAX_RETRIES', '2'), 10),
  sshReconnectDelaySecondsDefault: Number.parseInt(
    getEnv('TMEX_SSH_RECONNECT_DELAY_SECONDS', '10'),
    10
  ),
  languageDefault: getEnv('TMEX_DEFAULT_LANGUAGE', 'en_US'),

  // 环境
  isDev: getEnv('NODE_ENV', 'development') === 'development',
  isTest: getEnv('NODE_ENV', 'development') === 'test',
  isProd: getEnv('NODE_ENV', 'development') === 'production',
} as const;

// 生产环境检查
if (config.isProd && !config.masterKey) {
  throw new Error('TMEX_MASTER_KEY is required in production mode');
}
