export interface CryptoContext {
  scope: string;
  entityId?: string;
  field?: string;
}

function contextLabel(context: CryptoContext): string {
  const parts = [context.scope];
  if (context.entityId) {
    parts.push(`id=${context.entityId}`);
  }
  if (context.field) {
    parts.push(`field=${context.field}`);
  }
  return parts.join(' ');
}

export class CryptoDecryptError extends Error {
  public readonly code = 'crypto_decrypt_failed';
  public readonly context: CryptoContext;

  constructor(context: CryptoContext, cause: unknown) {
    const causeText = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
    super(
      `解密失败（${contextLabel(context)}）。通常意味着 TMEX_MASTER_KEY 与数据库中的加密数据不匹配，或密文已损坏。原因：${causeText}`
    );
    this.name = 'CryptoDecryptError';
    this.context = context;
  }
}
