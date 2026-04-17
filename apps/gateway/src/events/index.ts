import { type EventType, type WebhookEndpoint, type WebhookEvent, toBCP47 } from '@tmex/shared';
import { getAllWebhookEndpoints, getSiteSettings } from '../db';
import { t } from '../i18n';
import { telegramService } from '../telegram/service';

function sanitizeMarkdownV2(input: string): string {
  return input.replace(/([_\*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

function escapeTelegramHtmlText(input: string): string {
  return input.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeTelegramHtmlAttribute(input: string): string {
  return escapeTelegramHtmlText(input).replace(/"/g, '&quot;');
}

function trimTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

function buildPaneUrl(event: WebhookEvent): string | null {
  if (!event.tmux?.windowId || !event.tmux?.paneId) {
    return null;
  }

  const base = trimTrailingSlash(event.site.url);
  const deviceId = encodeURIComponent(event.device.id);
  const windowId = encodeURIComponent(event.tmux.windowId);
  const paneId = encodeURIComponent(event.tmux.paneId);
  return `${base}/devices/${deviceId}/windows/${windowId}/panes/${paneId}`;
}

function normalizeHttpUrl(input: string | null): string | null {
  if (!input) {
    return null;
  }

  try {
    const parsed = new URL(input);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.toString();
    }
    return null;
  } catch {
    return null;
  }
}

function encodePercentForTelegramUrl(url: string): string {
  return url.replace(/%/g, '%25');
}

export class EventNotifier {
  private webhooks: WebhookEndpoint[] = [];
  private lastRefresh = 0;
  private readonly REFRESH_INTERVAL = 60_000;
  private bellThrottleMap = new Map<string, number>();
  private notificationThrottleMap = new Map<string, number>();

  refreshConfig(): void {
    const now = Date.now();
    if (now - this.lastRefresh < this.REFRESH_INTERVAL) return;

    this.webhooks = getAllWebhookEndpoints().filter((w) => w.enabled);
    this.lastRefresh = now;

    console.log(`[events] refreshed config: ${this.webhooks.length} webhooks`);
  }

  async notify(
    eventType: EventType,
    event: Omit<WebhookEvent, 'eventType' | 'timestamp'>
  ): Promise<void> {
    this.refreshConfig();

    const fullEvent: WebhookEvent = {
      ...event,
      eventType,
      timestamp: new Date().toISOString(),
    };

    if (eventType === 'terminal_bell') {
      if (!this.shouldPassBellThrottle(fullEvent)) {
        return;
      }
    } else if (eventType === 'terminal_notification') {
      if (!this.shouldPassNotificationThrottle(fullEvent)) {
        return;
      }
    }

    await Promise.all([
      this.sendWebhooks(eventType, fullEvent),
      this.sendTelegramNotifications(eventType, fullEvent),
    ]);
  }

  private shouldPassBellThrottle(event: WebhookEvent): boolean {
    const settings = getSiteSettings();
    const throttleMs = Math.max(0, settings.bellThrottleSeconds) * 1000;
    if (throttleMs === 0) {
      return true;
    }

    const key = `${event.device.id}:${event.tmux?.paneId ?? '-'}:${event.eventType}`;
    const now = Date.now();
    const previous = this.bellThrottleMap.get(key) ?? 0;

    if (now - previous < throttleMs) {
      return false;
    }

    this.bellThrottleMap.set(key, now);
    return true;
  }

  private shouldPassNotificationThrottle(event: WebhookEvent): boolean {
    const settings = getSiteSettings();
    const throttleMs = Math.max(0, settings.notificationThrottleSeconds) * 1000;
    if (throttleMs === 0) {
      return true;
    }

    const source = typeof event.payload?.source === 'string' ? event.payload.source : 'unknown';
    const key = `${event.device.id}:${event.tmux?.paneId ?? '-'}:notification:${source}`;
    const now = Date.now();
    const previous = this.notificationThrottleMap.get(key) ?? 0;

    if (now - previous < throttleMs) {
      return false;
    }

    this.notificationThrottleMap.set(key, now);
    return true;
  }

  private async sendWebhooks(eventType: EventType, event: WebhookEvent): Promise<void> {
    const targets = this.webhooks.filter((w) => w.eventMask.includes(eventType));

    await Promise.all(
      targets.map(async (webhook) => {
        try {
          await this.sendWebhook(webhook, event);
        } catch (err) {
          console.error(`[webhook] failed to send to ${webhook.url}:`, err);
        }
      })
    );
  }

  private async sendWebhook(webhook: WebhookEndpoint, event: WebhookEvent): Promise<void> {
    const body = JSON.stringify(event);
    const signature = await this.generateHmac(webhook.secret, body);

    const response = await fetch(webhook.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Tmex-Signature': `sha256=${signature}`,
        'X-Tmex-Event': event.eventType,
        'X-Tmex-Timestamp': event.timestamp,
      },
      body,
    });

    if (!response.ok) {
      console.error(`[webhook] ${webhook.url} returned ${response.status}`);
    }
  }

  private async sendTelegramNotifications(
    eventType: EventType,
    event: WebhookEvent
  ): Promise<void> {
    const settings = getSiteSettings();

    if (eventType === 'terminal_bell') {
      if (!settings.enableTelegramBellPush) {
        return;
      }
      const bellMessage = this.formatTelegramBellMessage(event);
      await telegramService.sendToAuthorizedChats({ text: bellMessage, parseMode: 'HTML' });
      return;
    }

    if (eventType === 'terminal_notification') {
      if (!settings.enableTelegramNotificationPush) {
        return;
      }
      const notificationMessage = this.formatTelegramNotificationMessage(event);
      await telegramService.sendToAuthorizedChats({ text: notificationMessage, parseMode: 'HTML' });
      return;
    }

    const message = this.formatTelegramMessage(event, settings);
    await telegramService.sendToAuthorizedChats({ text: message });
  }

  private buildTerminalTopbarLabel(event: WebhookEvent): string {
    const windowLabel =
      typeof event.tmux?.windowIndex === 'number'
        ? `${event.tmux.windowIndex}`
        : (event.tmux?.windowId ?? '?');
    const paneLabel =
      typeof event.tmux?.paneIndex === 'number'
        ? `${event.tmux.paneIndex}`
        : (event.tmux?.paneId ?? '?');

    return t('notification.telegramBell.terminalTopbarLabel', {
      window: windowLabel,
      pane: paneLabel,
      device: event.device.name,
    });
  }

  private formatTelegramBellMessage(event: WebhookEvent): string {
    const title = t('notification.telegramBell.title', {
      siteName: event.site.name,
      terminalTopbarLabel: this.buildTerminalTopbarLabel(event),
    });

    const lines = [escapeTelegramHtmlText(title)];

    const paneUrl = normalizeHttpUrl(buildPaneUrl(event));
    if (paneUrl) {
      const tgSafePaneUrl = encodePercentForTelegramUrl(paneUrl);
      lines.push(
        '',
        `<a href="${escapeTelegramHtmlAttribute(tgSafePaneUrl)}">${escapeTelegramHtmlText(t('notification.telegramBell.viewLink'))}</a>`
      );
    }

    return lines.join('\n');
  }

  private formatTelegramNotificationMessage(event: WebhookEvent): string {
    const title = typeof event.payload?.title === 'string' ? event.payload.title : '';
    const body = typeof event.payload?.message === 'string' ? event.payload.message : '';

    const lines: string[] = [];

    if (title) {
      lines.push(escapeTelegramHtmlText(title));
    }

    if (body) {
      lines.push(escapeTelegramHtmlText(body));
    }

    const paneUrl = normalizeHttpUrl(buildPaneUrl(event));
    const topbarLabel = this.buildTerminalTopbarLabel(event);
    const footer = `from ${event.site.name}: ${topbarLabel}`;

    if (paneUrl) {
      const tgSafePaneUrl = encodePercentForTelegramUrl(paneUrl);
      lines.push(
        '',
        `<a href="${escapeTelegramHtmlAttribute(tgSafePaneUrl)}">${escapeTelegramHtmlText(footer)}</a>`
      );
    } else {
      lines.push('', escapeTelegramHtmlText(footer));
    }

    return lines.join('\n');
  }

  private formatTelegramMessage(
    event: WebhookEvent,
    settings: ReturnType<typeof getSiteSettings>
  ): string {
    const emojiMap: Record<EventType, string> = {
      terminal_bell: '🔔',
      terminal_notification: '🔔',
      tmux_window_close: '🪟',
      tmux_pane_close: '📱',
      device_tmux_missing: '⚠️',
      device_disconnect: '🔌',
      session_created: '🆕',
      session_closed: '🚪',
    };

    const paneUrl = buildPaneUrl(event);

    const eventTypeLabel = t(`notification.eventType.${event.eventType}` as const);

    const lines = [
      `${emojiMap[event.eventType] ?? '📢'} ${eventTypeLabel}`,
      `${t('notification.site')}：${event.site.name}`,
      `${t('notification.time')}：${new Date(event.timestamp).toLocaleString(toBCP47(settings.language))}`,
      `${t('notification.device')}：${event.device.name} (${event.device.type})`,
      event.tmux?.windowIndex !== undefined
        ? `${t('notification.window')}：${event.tmux.windowIndex} (${event.tmux.windowId ?? '-'})`
        : event.tmux?.windowId
          ? `${t('notification.window')}：${event.tmux.windowId}`
          : `${t('notification.window')}：-`,
      event.tmux?.paneIndex !== undefined
        ? `${t('notification.pane')}：${event.tmux.paneIndex} (${event.tmux.paneId ?? '-'})`
        : event.tmux?.paneId
          ? `${t('notification.pane')}：${event.tmux.paneId}`
          : `${t('notification.pane')}：-`,
    ];

    if (paneUrl) {
      lines.push(`${t('notification.directLink')}：${paneUrl}`);
    }

    if (event.payload?.message && typeof event.payload.message === 'string') {
      lines.push(`${t('notification.message')}：${event.payload.message}`);
    }

    return lines.map((line) => sanitizeMarkdownV2(line)).join('\n');
  }

  private async generateHmac(secret: string, message: string): Promise<string> {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );

    const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
    return Buffer.from(signature).toString('hex');
  }
}

export const eventNotifier = new EventNotifier();
