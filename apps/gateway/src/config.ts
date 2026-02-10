import { existsSync } from 'fs';

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function getEnv(key: string, defaultValue: string): string {
  return process.env[key] ?? defaultValue;
}

export const config = {
  // 核心安全配置
  masterKey: process.env.TMEX_MASTER_KEY,
  adminPassword: requireEnv('TMEX_ADMIN_PASSWORD'),
  
  // 服务配置
  port: parseInt(getEnv('GATEWAY_PORT', '8080'), 10),
  baseUrl: getEnv('TMEX_BASE_URL', 'http://localhost:8080'),
  
  // 数据库
  databaseUrl: getEnv('DATABASE_URL', '/data/tmex.db'),
  
  // JWT
  jwtSecret: requireEnv('JWT_SECRET'),
  jwtExpiresIn: getEnv('JWT_EXPIRES_IN', '24h'),
  
  // Telegram
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
  telegramDefaultChatIds: process.env.TELEGRAM_DEFAULT_CHAT_IDS?.split(',').filter(Boolean) ?? [],
  
  // 环境
  isDev: getEnv('NODE_ENV', 'development') === 'development',
  isProd: getEnv('NODE_ENV', 'development') === 'production',
} as const;

// 生产环境检查
if (config.isProd && !config.masterKey) {
  throw new Error('TMEX_MASTER_KEY is required in production mode');
}
