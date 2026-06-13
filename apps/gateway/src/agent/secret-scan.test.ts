import { describe, expect, test } from 'bun:test';
import { detectSecrets, hasSecret, redactSecrets } from './secret-scan';

describe('secret-scan 正样本', () => {
  test('私钥块整体消毒', () => {
    const key = [
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gt',
      'AAAEC2xR',
      '-----END OPENSSH PRIVATE KEY-----',
    ].join('\n');
    const { text, matches } = redactSecrets(`before\n${key}\nafter`);
    expect(text).toContain('[REDACTED:private-key]');
    expect(text).not.toContain('BEGIN OPENSSH');
    expect(text).toContain('before');
    expect(text).toContain('after');
    expect(matches.some((m) => m.type === 'private-key')).toBe(true);
  });

  test('已知前缀 token', () => {
    expect(redactSecrets('export KEY=sk-abcdefABCDEF0123456789xyz').text).toContain(
      '[REDACTED:token]'
    );
    expect(redactSecrets('token ghp_0123456789abcdefghijABCDEFGHIJ0123').text).toContain(
      '[REDACTED:token]'
    );
    expect(redactSecrets('aws AKIAIOSFODNN7EXAMPLE here').text).toContain('[REDACTED:token]');
    expect(redactSecrets('slack xoxb-1234567890-abcdef').text).toContain('[REDACTED:token]');
  });

  test('Authorization Bearer 保留前缀仅抹 token', () => {
    const { text } = redactSecrets('Authorization: Bearer eyJabc.def-ghi_jkl');
    expect(text).toBe('Authorization: Bearer [REDACTED:token]');
  });

  test('含密码连接串只抹密码', () => {
    const { text } = redactSecrets('redis://admin:s3cr3tP@ss@10.0.0.5:6379');
    expect(text).toContain('redis://admin:[REDACTED:password]@');
    expect(text).not.toContain('s3cr3tP');
  });

  test('网络设备 typed 口令 / enable secret / snmp community', () => {
    expect(redactSecrets('  password 7 0822455D0A16').text).toBe(
      '  password 7 [REDACTED:device-secret]'
    );
    expect(redactSecrets('enable secret 5 $1$mERr$hash').text).toContain(
      'enable secret [REDACTED:device-secret]'
    );
    expect(redactSecrets('enable secret MyPlainPass').text).toBe(
      'enable secret [REDACTED:device-secret]'
    );
    expect(redactSecrets('snmp-server community pr1vateRO ro').text).toContain(
      'snmp-server community [REDACTED:device-secret]'
    );
  });

  test('detectSecrets / hasSecret', () => {
    expect(hasSecret('Authorization: Bearer abcdef12345')).toBe(true);
    expect(detectSecrets('nothing secret here').length).toBe(0);
  });
});

describe('secret-scan 负样本（不误伤）', () => {
  const benign = [
    'the password is required to continue',
    'please enter your secret when prompted',
    'we visited the community garden today',
    'see https://example.com/docs/password-reset for help',
    'Authorization is handled by the gateway',
    'run `git push` to publish',
    'set the timeout to 30 seconds',
  ];
  for (const sample of benign) {
    test(`不消毒：${sample}`, () => {
      const { text, matches } = redactSecrets(sample);
      expect(text).toBe(sample);
      expect(matches.length).toBe(0);
    });
  }
});
