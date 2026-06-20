import { type EventType, type WebhookEvent, toBCP47 } from '@tmex/shared';
import { getSiteSettings } from '../../db';
import { t } from '../../i18n';
import { weixinService } from '../../weixin/service';
import { buildPaneUrl, normalizeHttpUrl } from './pane-url';
import type { NotificationChannel } from './types';

const EMOJI_MAP: Record<EventType, string> = {
  terminal_bell: '🔔',
  terminal_notification: '🔔',
  tmux_window_close: '🪟',
  tmux_pane_close: '📱',
  device_tmux_missing: '⚠️',
  device_disconnect: '🔌',
  session_created: '🆕',
  session_closed: '🚪',
  agent_confirmation_pending: '🤖',
  agent_turn_finished: '🤖',
  agent_error: '🤖',
  watch_triggered: '👁️',
  watch_model_unavailable: '👁️',
  watch_rule_error: '👁️',
};

/**
 * 微信 (iLink) 渠道：纯文本推送（无 HTML）。
 * bell 走 enableWeixinBellPush，其余事件（含 terminal_notification）走 enableWeixinNotificationPush。
 * 实际发送语义为"半主动·最佳努力"，由 WeixinService 负责 context_token 缓存与失效标记。
 */
export class WeixinChannel implements NotificationChannel {
  readonly id = 'weixin';

  async notify(eventType: EventType, event: WebhookEvent): Promise<void> {
    const settings = getSiteSettings();

    if (eventType === 'terminal_bell') {
      if (!settings.enableWeixinBellPush) {
        return;
      }
      await weixinService.sendToAuthorizedUsers({ text: this.formatBellMessage(event) });
      return;
    }

    if (!settings.enableWeixinNotificationPush) {
      return;
    }

    const text =
      eventType === 'terminal_notification'
        ? this.formatNotificationMessage(event)
        : this.formatGenericMessage(event, settings);
    await weixinService.sendToAuthorizedUsers({ text });
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

  private buildPaneMetaLines(event: WebhookEvent): string[] {
    const lines: string[] = [];
    if (event.tmux?.paneTitle) {
      lines.push(`${t('notification.paneTitle')}：${event.tmux.paneTitle}`);
    }
    if (event.tmux?.paneCurrentCommand) {
      lines.push(`${t('notification.process')}：${event.tmux.paneCurrentCommand}`);
    }
    return lines;
  }

  private formatBellMessage(event: WebhookEvent): string {
    const lines = [
      t('notification.telegramBell.title', {
        siteName: event.site.name,
        terminalTopbarLabel: this.buildTerminalTopbarLabel(event),
      }),
    ];
    lines.push(...this.buildPaneMetaLines(event));

    const paneUrl = normalizeHttpUrl(buildPaneUrl(event));
    if (paneUrl) {
      lines.push('', paneUrl);
    }
    return lines.join('\n');
  }

  private formatNotificationMessage(event: WebhookEvent): string {
    const title = typeof event.payload?.title === 'string' ? event.payload.title : '';
    const body = typeof event.payload?.message === 'string' ? event.payload.message : '';

    const lines: string[] = [];
    if (title) {
      lines.push(title);
    }
    if (body) {
      lines.push(body);
    }
    lines.push(...this.buildPaneMetaLines(event));

    const footer = `from ${event.site.name}: ${this.buildTerminalTopbarLabel(event)}`;
    lines.push('', footer);

    const paneUrl = normalizeHttpUrl(buildPaneUrl(event));
    if (paneUrl) {
      lines.push(paneUrl);
    }
    return lines.join('\n');
  }

  private formatGenericMessage(
    event: WebhookEvent,
    settings: ReturnType<typeof getSiteSettings>
  ): string {
    const eventTypeLabel = t(`notification.eventType.${event.eventType}` as const);
    const windowLabel =
      event.tmux?.windowIndex !== undefined
        ? `${event.tmux.windowIndex} (${event.tmux.windowId ?? '-'})`
        : (event.tmux?.windowId ?? '-');
    const paneLabel =
      event.tmux?.paneIndex !== undefined
        ? `${event.tmux.paneIndex} (${event.tmux.paneId ?? '-'})`
        : (event.tmux?.paneId ?? '-');

    const lines = [
      `${EMOJI_MAP[event.eventType] ?? '📢'} ${eventTypeLabel}`,
      `${t('notification.site')}：${event.site.name}`,
      `${t('notification.time')}：${new Date(event.timestamp).toLocaleString(toBCP47(settings.language))}`,
      `${t('notification.device')}：${event.device.name} (${event.device.type})`,
      `${t('notification.window')}：${windowLabel}`,
      `${t('notification.pane')}：${paneLabel}`,
    ];

    lines.push(...this.buildPaneMetaLines(event));

    if (typeof event.payload?.message === 'string') {
      lines.push(`${t('notification.message')}：${event.payload.message}`);
    }

    const paneUrl = normalizeHttpUrl(buildPaneUrl(event));
    if (paneUrl) {
      lines.push('', paneUrl);
    }
    return lines.join('\n');
  }
}

export const weixinChannel = new WeixinChannel();
