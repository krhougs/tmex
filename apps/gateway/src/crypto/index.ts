import { config } from '../config';
import { CryptoDecryptError, type CryptoContext } from './errors';

// 使用 Web Crypto API (Bun 支持)
const ALGORITHM = 'AES-GCM';
const IV_LENGTH = 12;
const TAG_LENGTH = 128;

let masterKey: CryptoKey | null = null;

async function getMasterKey(): Promise<CryptoKey> {
  if (masterKey) return masterKey;

  const keyData = config.masterKey ? Buffer.from(config.masterKey, 'base64') : Buffer.alloc(32, 0); // 开发模式使用零填充密钥（不安全，仅开发）

  masterKey = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: ALGORITHM, length: 256 },
    false,
    ['encrypt', 'decrypt']
  );

  return masterKey;
}

/**
 * 加密明文，返回 base64 格式的密文
 * 格式: iv:ciphertext:tag (base64)
 */
export async function encrypt(plaintext: string): Promise<string> {
  const key = await getMasterKey();
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const encoder = new TextEncoder();
  const data = encoder.encode(plaintext);

  const encrypted = await crypto.subtle.encrypt(
    { name: ALGORITHM, iv, tagLength: TAG_LENGTH },
    key,
    data
  );

  // 组合 IV + ciphertext
  const result = new Uint8Array(iv.length + encrypted.byteLength);
  result.set(iv, 0);
  result.set(new Uint8Array(encrypted), iv.length);

  return Buffer.from(result).toString('base64');
}

/**
 * 解密 base64 格式的密文
 */
export async function decrypt(ciphertext: string): Promise<string> {
  const key = await getMasterKey();
  const data = Buffer.from(ciphertext, 'base64');

  if (data.length < IV_LENGTH) {
    throw new Error('Invalid ciphertext: too short');
  }

  const iv = data.slice(0, IV_LENGTH);
  const encrypted = data.slice(IV_LENGTH);

  const decrypted = await crypto.subtle.decrypt(
    { name: ALGORITHM, iv, tagLength: TAG_LENGTH },
    key,
    encrypted
  );

  const decoder = new TextDecoder();
  return decoder.decode(decrypted);
}

export async function decryptWithContext(
  ciphertext: string,
  context: CryptoContext
): Promise<string> {
  try {
    return await decrypt(ciphertext);
  } catch (error) {
    throw new CryptoDecryptError(context, error);
  }
}
