import { type EventType, type WebhookEvent, toBCP47 } from '@tmex/shared';
import { getSiteSettings } from '../../db';
import { t } from '../../i18n';
import { telegramService } from '../../telegram/service';
import { buildPaneUrl, normalizeHttpUrl } from './pane-url';
import type { NotificationChannel } from './types';

function escapeTelegramHtmlText(input: string): string {
  return input.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeTelegramHtmlAttribute(input: string): string {
  return escapeTelegramHtmlText(input).replace(/"/g, '&quot;');
}

export class TelegramChannel implements NotificationChannel {
  readonly id = 'telegram';

  async notify(eventType: EventType, event: WebhookEvent): Promise<void> {
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
    await telegramService.sendToAuthorizedChats({ text: message, parseMode: 'HTML' });
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

  /** pane 当前标题 / 进程行（HTML 转义；仅在快照有值时输出），三类通知共用 */
  private buildPaneMetaLines(event: WebhookEvent): string[] {
    const lines: string[] = [];
    if (event.tmux?.paneTitle) {
      lines.push(
        `${escapeTelegramHtmlText(t('notification.paneTitle'))}：${escapeTelegramHtmlText(event.tmux.paneTitle)}`
      );
    }
    if (event.tmux?.paneCurrentCommand) {
      lines.push(
        `${escapeTelegramHtmlText(t('notification.process'))}：${escapeTelegramHtmlText(event.tmux.paneCurrentCommand)}`
      );
    }
    return lines;
  }

  private formatTelegramBellMessage(event: WebhookEvent): string {
    const title = t('notification.telegramBell.title', {
      siteName: event.site.name,
      terminalTopbarLabel: this.buildTerminalTopbarLabel(event),
    });

    const lines = [escapeTelegramHtmlText(title)];
    lines.push(...this.buildPaneMetaLines(event));

    const paneUrl = normalizeHttpUrl(buildPaneUrl(event));
    if (paneUrl) {
      lines.push(
        '',
        `<a href="${escapeTelegramHtmlAttribute(paneUrl)}">${escapeTelegramHtmlText(t('notification.telegramBell.viewLink'))}</a>`
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

    lines.push(...this.buildPaneMetaLines(event));

    const paneUrl = normalizeHttpUrl(buildPaneUrl(event));
    const topbarLabel = this.buildTerminalTopbarLabel(event);
    const footer = `from ${event.site.name}: ${topbarLabel}`;

    if (paneUrl) {
      lines.push(
        '',
        `<a href="${escapeTelegramHtmlAttribute(paneUrl)}">${escapeTelegramHtmlText(footer)}</a>`
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
      agent_confirmation_pending: '🤖',
      agent_turn_finished: '🤖',
      agent_error: '🤖',
      watch_triggered: '👁️',
      watch_model_unavailable: '👁️',
      watch_rule_error: '👁️',
    };

    const esc = escapeTelegramHtmlText;
    const eventTypeLabel = t(`notification.eventType.${event.eventType}` as const);

    const lines = [
      `${emojiMap[event.eventType] ?? '📢'} ${esc(eventTypeLabel)}`,
      `${esc(t('notification.site'))}：${esc(event.site.name)}`,
      `${esc(t('notification.time'))}：${esc(new Date(event.timestamp).toLocaleString(toBCP47(settings.language)))}`,
      `${esc(t('notification.device'))}：${esc(event.device.name)} (${esc(event.device.type)})`,
      event.tmux?.windowIndex !== undefined
        ? `${esc(t('notification.window'))}：${event.tmux.windowIndex} (${esc(event.tmux.windowId ?? '-')})`
        : event.tmux?.windowId
          ? `${esc(t('notification.window'))}：${esc(event.tmux.windowId)}`
          : `${esc(t('notification.window'))}：-`,
      event.tmux?.paneIndex !== undefined
        ? `${esc(t('notification.pane'))}：${event.tmux.paneIndex} (${esc(event.tmux.paneId ?? '-')})`
        : event.tmux?.paneId
          ? `${esc(t('notification.pane'))}：${esc(event.tmux.paneId)}`
          : `${esc(t('notification.pane'))}：-`,
    ];

    lines.push(...this.buildPaneMetaLines(event));

    if (event.payload?.message && typeof event.payload.message === 'string') {
      lines.push(`${esc(t('notification.message'))}：${esc(event.payload.message)}`);
    }

    const paneUrl = normalizeHttpUrl(buildPaneUrl(event));
    if (paneUrl) {
      lines.push(
        '',
        `<a href="${escapeTelegramHtmlAttribute(paneUrl)}">${esc(t('notification.directLink'))}</a>`
      );
    }

    return lines.join('\n');
  }
}

export const telegramChannel = new TelegramChannel();
