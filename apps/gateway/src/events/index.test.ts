import { beforeAll, describe, expect, test } from 'bun:test';
import { ensureSiteSettingsInitialized, updateSiteSettings } from '../db';
import { runMigrations } from '../db/migrate';
import { telegramService } from '../telegram/service';
import { eventNotifier } from './index';

beforeAll(() => {
  runMigrations();
  ensureSiteSettingsInitialized();
});

describe('EventNotifier telegram bell settings & html formatting', () => {
  test('skips telegram bell push when disabled', async () => {
    const calls: Array<{ text: string; parseMode?: 'HTML' | 'MarkdownV2' }> = [];
    const originalSend = telegramService.sendToAuthorizedChats;
    telegramService.sendToAuthorizedChats = async (params) => {
      calls.push(params);
    };

    try {
      updateSiteSettings({
        bellThrottleSeconds: 0,
        enableTelegramBellPush: false,
      });

      await eventNotifier.notify('terminal_bell', {
        site: {
          name: 'tmex',
          url: 'https://tmex.example.com',
        },
        device: {
          id: 'device-disabled',
          name: 'dev-1',
          type: 'local',
        },
        tmux: {
          windowId: '@1',
          paneId: '%1',
          windowIndex: 1,
          paneIndex: 2,
        },
      });

      expect(calls).toHaveLength(0);
    } finally {
      telegramService.sendToAuthorizedChats = originalSend;
      updateSiteSettings({
        enableTelegramBellPush: true,
      });
    }
  });

  test('formats bell push as HTML with escaped text and link', async () => {
    const calls: Array<{ text: string; parseMode?: 'HTML' | 'MarkdownV2' }> = [];
    const originalSend = telegramService.sendToAuthorizedChats;
    telegramService.sendToAuthorizedChats = async (params) => {
      calls.push(params);
    };

    try {
      updateSiteSettings({
        bellThrottleSeconds: 0,
        enableTelegramBellPush: true,
      });

      await eventNotifier.notify('terminal_bell', {
        site: {
          name: 'tmex<prod>&',
          url: 'https://tmex.example.com',
        },
        device: {
          id: 'device-html',
          name: 'dev<1>&',
          type: 'local',
        },
        tmux: {
          windowId: '@1',
          paneId: '%1',
          windowIndex: 7,
          paneIndex: 3,
        },
      });

      expect(calls).toHaveLength(1);
      expect(calls[0]?.parseMode).toBe('HTML');
      expect(calls[0]?.text).toContain(
        '🔔 Bell from tmex&lt;prod&gt;&amp;: Window 7 · Pane 3 @ dev&lt;1&gt;&amp;'
      );
      expect(calls[0]?.text).toContain(
        '<a href="https://tmex.example.com/devices/device-html/windows/%25401/panes/%25251">Click to view</a>'
      );
    } finally {
      telegramService.sendToAuthorizedChats = originalSend;
    }
  });

  test('non-bell telegram notifications are unaffected by bell switch', async () => {
    const calls: Array<{ text: string; parseMode?: 'HTML' | 'MarkdownV2' }> = [];
    const originalSend = telegramService.sendToAuthorizedChats;
    telegramService.sendToAuthorizedChats = async (params) => {
      calls.push(params);
    };

    try {
      updateSiteSettings({
        enableTelegramBellPush: false,
      });

      await eventNotifier.notify('session_created', {
        site: {
          name: 'tmex',
          url: 'https://tmex.example.com',
        },
        device: {
          id: 'device-other',
          name: 'dev-2',
          type: 'local',
        },
      });

      expect(calls).toHaveLength(1);
      expect(calls[0]?.parseMode).toBeUndefined();
      expect(calls[0]?.text).toContain('Session Created');
    } finally {
      telegramService.sendToAuthorizedChats = originalSend;
      updateSiteSettings({
        enableTelegramBellPush: true,
      });
    }
  });

  test('skips telegram terminal notification push when disabled', async () => {
    const calls: Array<{ text: string; parseMode?: 'HTML' | 'MarkdownV2' }> = [];
    const originalSend = telegramService.sendToAuthorizedChats;
    telegramService.sendToAuthorizedChats = async (params) => {
      calls.push(params);
    };

    try {
      updateSiteSettings({
        notificationThrottleSeconds: 0,
        enableTelegramNotificationPush: false,
      });

      await eventNotifier.notify('terminal_notification', {
        site: {
          name: 'tmex',
          url: 'https://tmex.example.com',
        },
        device: {
          id: 'device-notification-disabled',
          name: 'dev-3',
          type: 'local',
        },
        tmux: {
          windowId: '@1',
          paneId: '%1',
          windowIndex: 1,
          paneIndex: 2,
        },
        payload: {
          source: 'osc777',
          title: 'Build finished',
          message: 'All 42 tests passed',
        },
      });

      expect(calls).toHaveLength(0);
    } finally {
      telegramService.sendToAuthorizedChats = originalSend;
      updateSiteSettings({
        enableTelegramNotificationPush: true,
      });
    }
  });

  test('formats terminal notification push as HTML and applies notification throttle', async () => {
    const calls: Array<{ text: string; parseMode?: 'HTML' | 'MarkdownV2' }> = [];
    const originalSend = telegramService.sendToAuthorizedChats;
    telegramService.sendToAuthorizedChats = async (params) => {
      calls.push(params);
    };

    try {
      updateSiteSettings({
        notificationThrottleSeconds: 3,
        enableTelegramNotificationPush: true,
      });

      const payload = {
        site: {
          name: 'tmex',
          url: 'https://tmex.example.com',
        },
        device: {
          id: 'device-notification-html',
          name: 'dev<4>&',
          type: 'local' as const,
        },
        tmux: {
          windowId: '@1',
          paneId: '%1',
          windowIndex: 7,
          paneIndex: 3,
        },
        payload: {
          source: 'osc777',
          title: 'Build <finished>',
          message: 'All 42 tests & checks passed',
        },
      };

      await eventNotifier.notify('terminal_notification', payload);
      await eventNotifier.notify('terminal_notification', payload);

      expect(calls).toHaveLength(1);
      expect(calls[0]?.parseMode).toBe('HTML');
      expect(calls[0]?.text).toContain('Build &lt;finished&gt;');
      expect(calls[0]?.text).toContain('All 42 tests &amp; checks passed');
      expect(calls[0]?.text).toContain('from tmex: Window 7 · Pane 3 @ dev&lt;4&gt;&amp;');
      expect(calls[0]?.text).toContain(
        '<a href="https://tmex.example.com/devices/device-notification-html/windows/%25401/panes/%25251">'
      );
    } finally {
      telegramService.sendToAuthorizedChats = originalSend;
      updateSiteSettings({
        notificationThrottleSeconds: 3,
      });
    }
  });
});
