import { config } from './config';
import { hashPassword, verifyPassword } from './crypto';
import { getAdminPasswordHash, setAdminPasswordHash } from './db';

/**
 * 初始化管理员账户
 * 如果数据库中没有管理员，则使用环境变量中的密码创建
 */
export async function initAdmin(): Promise<void> {
  const existingHash = getAdminPasswordHash();
  if (!existingHash) {
    const hash = await hashPassword(config.adminPassword);
    setAdminPasswordHash(hash);
    console.log('Admin account initialized');
  }
}

/**
 * 验证管理员登录
 */
export async function verifyAdmin(password: string): Promise<boolean> {
  const hash = getAdminPasswordHash();
  if (!hash) return false;
  return verifyPassword(password, hash);
}

/**
 * 修改管理员密码
 */
export async function changeAdminPassword(newPassword: string): Promise<void> {
  const hash = await hashPassword(newPassword);
  setAdminPasswordHash(hash);
}

// JWT 相关（使用 jose 库或 Web Crypto）
const JWT_ALGORITHM = 'HS256';

export interface JwtPayload {
  sub: string; // user id
  iat: number;
  exp: number;
}

/**
 * 创建 JWT token
 */
export async function createJwtToken(): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(config.jwtSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const now = Math.floor(Date.now() / 1000);
  const exp = now + parseDuration(config.jwtExpiresIn);

  const header = { alg: JWT_ALGORITHM, typ: 'JWT' };
  const payload: JwtPayload = {
    sub: 'admin',
    iat: now,
    exp,
  };

  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;

  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(signingInput));

  const signatureB64 = base64UrlEncodeBuffer(new Uint8Array(signature));
  return `${headerB64}.${payloadB64}.${signatureB64}`;
}

/**
 * 验证 JWT token
 */
export async function verifyJwtToken(token: string): Promise<JwtPayload | null> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(config.jwtSecret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );

    const signingInput = `${parts[0]}.${parts[1]}`;
    const signature = base64UrlDecode(parts[2]);

    const valid = await crypto.subtle.verify('HMAC', key, signature, encoder.encode(signingInput));

    if (!valid) return null;

    const payload = JSON.parse(base64UrlDecodeString(parts[1])) as JwtPayload;

    // 检查过期
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp < now) return null;

    return payload;
  } catch {
    return null;
  }
}

// ==================== Helpers ====================

function base64UrlEncode(str: string): string {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function base64UrlEncodeBuffer(buffer: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < buffer.length; i++) {
    binary += String.fromCharCode(buffer[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function base64UrlDecodeString(str: string): string {
  const padding = '='.repeat((4 - (str.length % 4)) % 4);
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/') + padding;
  return atob(base64);
}

function base64UrlDecode(str: string): Uint8Array {
  const padding = '='.repeat((4 - (str.length % 4)) % 4);
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/') + padding;
  const binary = atob(base64);
  const buffer = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    buffer[i] = binary.charCodeAt(i);
  }
  return buffer;
}

function parseDuration(duration: string): number {
  const match = duration.match(/^(\d+)([smhd])$/);
  if (!match) return 86400; // 默认 24 小时

  const value = Number.parseInt(match[1], 10);
  const unit = match[2];

  const multipliers: Record<string, number> = {
    s: 1,
    m: 60,
    h: 3600,
    d: 86400,
  };

  return value * (multipliers[unit] ?? 3600);
}
