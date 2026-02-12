import { describe, expect, test } from 'bun:test';
import { decryptWithContext } from './index';

function encodeBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

describe('crypto decryptWithContext', () => {
  test('wraps OperationError with readable context', async () => {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const garbage = crypto.getRandomValues(new Uint8Array(32));
    const payload = new Uint8Array(iv.length + garbage.length);
    payload.set(iv, 0);
    payload.set(garbage, iv.length);

    try {
      await decryptWithContext(encodeBase64(payload), {
        scope: 'telegram_bot',
        entityId: 'bot-1',
        field: 'token_enc',
      });
      throw new Error('expected decrypt to fail');
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      expect(error.name).toBe('CryptoDecryptError');
      expect(error.message).toContain('telegram_bot');
      expect(error.message).toContain('bot-1');
      expect(error.message).toContain('token_enc');
      expect(error.message).toContain('TMEX_MASTER_KEY');
    }
  });
});

