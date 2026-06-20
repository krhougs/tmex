import { beforeEach, describe, expect, test } from 'bun:test';
import type { Device, SiteSettings } from '@tmex/shared';
import { ConnectionAlertNotifier } from './connection-alerts';

function makeDevice(id: string): Device {
  return {
    id,
    name: `dev-${id}`,
    type: 'ssh',
    host: '10.0.0.1',
    port: 22,
    username: 'root',
    session: 'tmex',
    authMode: 'password',
    sortOrder: 0,
    createdAt: '2026-04-18T00:00:00Z',
    updatedAt: '2026-04-18T00:00:00Z',
  };
}

function makeSettings(): SiteSettings {
  return {
    siteName: 'tmex',
    siteUrl: 'https://tmex.example.com',
    bellThrottleSeconds: 6,
    notificationThrottleSeconds: 3,
    enableBrowserBellToast: true,
    enableBrowserNotificationToast: true,
    enableTelegramBellPush: true,
    enableTelegramNotificationPush: true,
    enableWeixinBellPush: false,
    enableWeixinNotificationPush: false,
    sshReconnectMaxRetries: 2,
    sshReconnectDelaySeconds: 1,
    language: 'zh_CN',
    updatedAt: '2026-04-18T00:00:00Z',
  };
}

function makeNotifier() {
  const notifier = new ConnectionAlertNotifier();
  const persisted: Array<{ deviceId: string; message: string; type: string }> = [];
  const broadcasts: Array<{ deviceId: string; errorType?: string }> = [];
  const telegrams: string[] = [];

  notifier.setSettingsProvider(() => makeSettings());
  notifier.setPersister((deviceId, message, type) => {
    persisted.push({ deviceId, message, type });
  });
  notifier.setBroadcaster((deviceId, payload) => {
    broadcasts.push({ deviceId, errorType: payload.errorType });
  });
  notifier.setTelegramSender(async (text) => {
    telegrams.push(text);
  });

  return { notifier, persisted, broadcasts, telegrams };
}

describe('ConnectionAlertNotifier', () => {
  let notifier: ReturnType<typeof makeNotifier>;

  beforeEach(() => {
    notifier = makeNotifier();
  });

  test('classifies auth error and persists + broadcasts + sends telegram', async () => {
    const device = makeDevice('d1');
    const err = new Error('All configured authentication methods failed');
    const result = await notifier.notifier.notify({ device, error: err, source: 'connect' });

    expect(result.errorType).toBe('auth_failed');
    expect(notifier.persisted).toHaveLength(1);
    expect(notifier.persisted[0].type).toBe('auth_failed');
    expect(notifier.broadcasts).toHaveLength(1);
    expect(notifier.broadcasts[0].errorType).toBe('auth_failed');
    expect(notifier.telegrams).toHaveLength(1);
  });

  test('throttles telegram within same deviceId:errorType for 5 minutes', async () => {
    const device = makeDevice('d1');
    const err = new Error('Permission denied');

    await notifier.notifier.notify({ device, error: err, source: 'connect' });
    await notifier.notifier.notify({ device, error: err, source: 'connect' });
    await notifier.notifier.notify({ device, error: err, source: 'connect' });

    expect(notifier.telegrams).toHaveLength(1);
    expect(notifier.broadcasts).toHaveLength(3);
    expect(notifier.persisted).toHaveLength(3);
  });

  test('errorType switch re-sends telegram immediately', async () => {
    const device = makeDevice('d1');

    await notifier.notifier.notify({
      device,
      error: new Error('Permission denied'),
      source: 'connect',
    });
    await notifier.notifier.notify({
      device,
      error: new Error('ECONNREFUSED 10.0.0.1:22'),
      source: 'connect',
    });

    expect(notifier.telegrams).toHaveLength(2);
  });

  test('per-device throttle is independent', async () => {
    const a = makeDevice('a');
    const b = makeDevice('b');
    const err = new Error('Permission denied');

    await notifier.notifier.notify({ device: a, error: err, source: 'connect' });
    await notifier.notifier.notify({ device: b, error: err, source: 'connect' });

    expect(notifier.telegrams).toHaveLength(2);
  });

  test('silentTelegram suppresses telegram but still persists + broadcasts', async () => {
    const device = makeDevice('d1');
    const err = new Error('ECONNREFUSED');

    await notifier.notifier.notify({
      device,
      error: err,
      source: 'probe',
      silentTelegram: true,
    });

    expect(notifier.telegrams).toHaveLength(0);
    expect(notifier.persisted).toHaveLength(1);
    expect(notifier.broadcasts).toHaveLength(1);
  });

  test('classifies connection closed sentinel', async () => {
    const device = makeDevice('d1');
    const err = new Error('ssh_connection_closed');
    const result = await notifier.notifier.notify({ device, error: err, source: 'close' });
    expect(result.errorType).toBe('connection_closed');
  });

  test('persists raw error alongside the friendly message', async () => {
    const device = makeDevice('d1');
    const err = new Error('getaddrinfo ENOTFOUND /users/tester/.ssh/config');
    const result = await notifier.notifier.notify({ device, error: err, source: 'connect' });

    expect(result.errorType).toBe('host_not_found');
    expect(result.rawMessage).toBe('getaddrinfo ENOTFOUND /users/tester/.ssh/config');
    expect(notifier.persisted).toHaveLength(1);
    // 持久化文案应同时包含归类后的友好文案与真实错误
    expect(notifier.persisted[0].message).toBe(`${result.message}\n${result.rawMessage}`);
    expect(notifier.persisted[0].message).toContain('getaddrinfo ENOTFOUND');
  });

  test('does not duplicate raw when friendly message already embeds it (unknown category)', async () => {
    const device = makeDevice('d1');
    const rawText = 'some weird unclassified failure';
    const result = await notifier.notifier.notify({
      device,
      error: new Error(rawText),
      source: 'connect',
    });

    expect(result.errorType).toBe('unknown');
    // unknown 文案模板已内嵌 raw（"Connection failed: {{message}}"），不应再拼一次
    expect(notifier.persisted[0].message).toBe(result.message);
    const occurrences = notifier.persisted[0].message.split(rawText).length - 1;
    expect(occurrences).toBe(1);
  });
});
