import { describe, expect, test } from 'bun:test';
import { i18next, t } from './index';

describe('i18n', () => {
  test('exports i18next instance', () => {
    expect(i18next).toBeDefined();
    expect(typeof i18next.t).toBe('function');
  });

  test('exports t function', () => {
    expect(t).toBeDefined();
    expect(typeof t).toBe('function');
  });

  test('t function translates keys', () => {
    const result = t('apiError.notFound');
    expect(result).toBe('Not found');
  });

  test('t function handles interpolation', () => {
    const result = t('sshError.reconnecting', { delay: 5, attempt: 1, maxRetries: 3 });
    expect(result).toContain('5');
    expect(result).toContain('1');
    expect(result).toContain('3');
  });

  test('default language is en_US', () => {
    expect(i18next.language).toBe('en_US');
  });
});
