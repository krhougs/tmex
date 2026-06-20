import type { EventType, WebhookEndpoint, WebhookEvent } from '@tmex/shared';
import { getAllWebhookEndpoints } from '../../db';
import type { NotificationChannel } from './types';

export class WebhookChannel implements NotificationChannel {
  readonly id = 'webhook';

  private webhooks: WebhookEndpoint[] = [];
  private lastRefresh = 0;
  private readonly REFRESH_INTERVAL = 60_000;

  private refreshConfig(): void {
    const now = Date.now();
    if (now - this.lastRefresh < this.REFRESH_INTERVAL) return;

    this.webhooks = getAllWebhookEndpoints().filter((w) => w.enabled);
    this.lastRefresh = now;

    console.log(`[events] refreshed config: ${this.webhooks.length} webhooks`);
  }

  async notify(eventType: EventType, event: WebhookEvent): Promise<void> {
    this.refreshConfig();
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

export const webhookChannel = new WebhookChannel();
