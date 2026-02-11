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
});
