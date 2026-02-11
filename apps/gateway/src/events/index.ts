import type { EventType, WebhookEndpoint, WebhookEvent } from '@tmex/shared';
import { getAllWebhookEndpoints, getSiteSettings } from '../db';
import { telegramService } from '../telegram/service';

function sanitizeMarkdownV2(input: string): string {
  return input.replace(/([_\*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

function trimTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

function buildPaneUrl(event: WebhookEvent): string | null {
  if (!event.tmux?.windowId || !event.tmux?.paneId) {
    return null;
  }

  const base = trimTrailingSlash(event.site.url);
  const paneId = encodeURIComponent(event.tmux.paneId);
  return `${base}/devices/${event.device.id}/windows/${event.tmux.windowId}/panes/${paneId}`;
}

export class EventNotifier {
  private webhooks: WebhookEndpoint[] = [];
  private lastRefresh = 0;
  private readonly REFRESH_INTERVAL = 60_000;
  private bellThrottleMap = new Map<string, number>();

  refreshConfig(): void {
    const now = Date.now();
    if (now - this.lastRefresh < this.REFRESH_INTERVAL) return;

    this.webhooks = getAllWebhookEndpoints().filter((w) => w.enabled);
    this.lastRefresh = now;

    console.log(`[events] refreshed config: ${this.webhooks.length} webhooks`);
  }

  async notify(eventType: EventType, event: Omit<WebhookEvent, 'eventType' | 'timestamp'>): Promise<void> {
    this.refreshConfig();

    const fullEvent: WebhookEvent = {
      ...event,
      eventType,
      timestamp: new Date().toISOString(),
    };

    if (eventType === 'terminal_bell' && !this.shouldPassBellThrottle(fullEvent)) {
      return;
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

  private async sendTelegramNotifications(_eventType: EventType, event: WebhookEvent): Promise<void> {
    const message = this.formatTelegramMessage(event);
    await telegramService.sendToAuthorizedChats({ text: message });
  }

  private formatTelegramMessage(event: WebhookEvent): string {
    const emojiMap: Record<EventType, string> = {
      terminal_bell: '🔔',
      tmux_window_close: '🪟',
      tmux_pane_close: '📱',
      device_tmux_missing: '⚠️',
      device_disconnect: '🔌',
      session_created: '🆕',
      session_closed: '🚪',
    };

    const paneUrl = buildPaneUrl(event);

    const lines = [
      `${emojiMap[event.eventType] ?? '📢'} ${event.eventType}`,
      `站点：${event.site.name}`,
      `时间：${new Date(event.timestamp).toLocaleString('zh-CN')}`,
      `设备：${event.device.name} (${event.device.type})`,
      event.tmux?.windowIndex !== undefined
        ? `窗口：${event.tmux.windowIndex} (${event.tmux.windowId ?? '-'})`
        : event.tmux?.windowId
          ? `窗口：${event.tmux.windowId}`
          : '窗口：-',
      event.tmux?.paneIndex !== undefined
        ? `Pane：${event.tmux.paneIndex} (${event.tmux.paneId ?? '-'})`
        : event.tmux?.paneId
          ? `Pane：${event.tmux.paneId}`
          : 'Pane：-',
    ];

    if (paneUrl) {
      lines.push(`直达：${paneUrl}`);
    }

     if (event.payload?.message && typeof event.payload.message === 'string') {
       lines.push(`信息：${event.payload.message}`);
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
