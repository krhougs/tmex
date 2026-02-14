function getEnv(key: string, defaultValue: string): string {
  return process.env[key] ?? defaultValue;
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

  // 设置默认值（可被数据库中的实际设置覆盖）
  bellThrottleSecondsDefault: Number.parseInt(getEnv('TMEX_BELL_THROTTLE_SECONDS', '6'), 10),
  sshReconnectMaxRetriesDefault: Number.parseInt(getEnv('TMEX_SSH_RECONNECT_MAX_RETRIES', '2'), 10),
  sshReconnectDelaySecondsDefault: Number.parseInt(getEnv('TMEX_SSH_RECONNECT_DELAY_SECONDS', '10'), 10),
  languageDefault: getEnv('TMEX_DEFAULT_LANGUAGE', 'en_US'),

  // 环境
  isDev: getEnv('NODE_ENV', 'development') === 'development',
  isProd: getEnv('NODE_ENV', 'development') === 'production',
} as const;

// 生产环境检查
if (config.isProd && !config.masterKey) {
  throw new Error('TMEX_MASTER_KEY is required in production mode');
}
