import type { EventType, TelegramSubscription, WebhookEndpoint, WebhookEvent } from '@tmex/shared';
import { decrypt, encrypt } from '../crypto';
import { getAllTelegramSubscriptions, getAllWebhookEndpoints } from '../db';

export class EventNotifier {
  private webhooks: WebhookEndpoint[] = [];
  private telegramSubs: TelegramSubscription[] = [];
  private lastRefresh = 0;
  private readonly REFRESH_INTERVAL = 60000; // 60秒刷新一次配置

  constructor() {
    this.refreshConfig();
  }

  /**
   * 刷新配置
   */
  refreshConfig(): void {
    const now = Date.now();
    if (now - this.lastRefresh < this.REFRESH_INTERVAL) return;

    this.webhooks = getAllWebhookEndpoints().filter((w) => w.enabled);
    this.telegramSubs = getAllTelegramSubscriptions().filter((s) => s.enabled);
    this.lastRefresh = now;

    console.log(
      `[events] refreshed config: ${this.webhooks.length} webhooks, ${this.telegramSubs.length} telegram subs`
    );
  }

  /**
   * 发送事件通知
   */
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

    // 并发发送 webhook 和 telegram
    await Promise.all([
      this.sendWebhooks(eventType, fullEvent),
      this.sendTelegramNotifications(eventType, fullEvent),
    ]);
  }

  /**
   * 发送 Webhook
   */
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
    } else {
      console.log(`[webhook] sent to ${webhook.url}`);
    }
  }

  /**
   * 发送 Telegram 通知
   */
  private async sendTelegramNotifications(
    eventType: EventType,
    event: WebhookEvent
  ): Promise<void> {
    const targets = this.telegramSubs.filter((s) => s.eventMask.includes(eventType));
    if (targets.length === 0) return;

    const message = this.formatTelegramMessage(event);
    const botToken = await this.getBotToken();

    if (!botToken) {
      console.error('[telegram] no bot token configured');
      return;
    }

    await Promise.all(
      targets.map(async (sub) => {
        try {
          await this.sendTelegramMessage(botToken, sub.chatId, message);
        } catch (err) {
          console.error(`[telegram] failed to send to ${sub.chatId}:`, err);
        }
      })
    );
  }

  private async sendTelegramMessage(botToken: string, chatId: string, text: string): Promise<void> {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'Markdown',
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Telegram API error: ${error}`);
    }

    console.log(`[telegram] sent to ${chatId}`);
  }

  /**
   * 格式化 Telegram 消息
   */
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

    const lines = [
      `${emojiMap[event.eventType] || '📢'} **${event.eventType}**`,
      '',
      `📅 ${new Date(event.timestamp).toLocaleString('zh-CN')}`,
      `🖥️ **Device**: ${event.device.name} (${event.device.type})`,
    ];

    if (event.device.host) {
      lines.push(`🌐 **Host**: ${event.device.host}`);
    }

    if (event.tmux?.sessionName) {
      lines.push(`📟 **Session**: ${event.tmux.sessionName}`);
    }

    if (event.tmux?.windowId) {
      lines.push(`🪟 **Window**: ${event.tmux.windowId}`);
    }

    if (event.tmux?.paneId) {
      lines.push(`📱 **Pane**: ${event.tmux.paneId}`);
    }

    if (event.payload && typeof event.payload === 'object') {
      const payload = event.payload as Record<string, unknown>;
      if (payload.message) {
        lines.push(`💬 **Message**: ${payload.message}`);
      }
      if (payload.exitCode !== undefined) {
        lines.push(`🔢 **Exit Code**: ${payload.exitCode}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * 生成 HMAC 签名
   */
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

  /**
   * 获取 Telegram Bot Token
   */
  private async getBotToken(): Promise<string | null> {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) return null;

    // 如果 token 是加密的，需要解密
    // 这里假设环境变量中的 token 是明文的
    return token;
  }
}

// 全局事件通知器实例
export const eventNotifier = new EventNotifier();
