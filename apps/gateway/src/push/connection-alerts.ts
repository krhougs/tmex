import type { Device, EventDevicePayload, SiteSettings } from '@tmex/shared';
import { getSiteSettings, updateDeviceRuntimeStatus } from '../db';
import { t } from '../i18n';
import { telegramService } from '../telegram/service';
import { classifySshError } from '../ws/error-classify';

export type ConnectionAlertSource = 'connect' | 'runtime' | 'close' | 'probe';

export interface ConnectionAlertInput {
  device: Device;
  error: unknown;
  source: ConnectionAlertSource;
  silentTelegram?: boolean;
  persist?: boolean;
}

export interface ClassifiedConnectionAlert {
  errorType: string;
  messageKey: string;
  message: string;
  rawMessage: string;
}

export type ConnectionAlertBroadcaster = (deviceId: string, payload: EventDevicePayload) => void;

export type TelegramSender = (text: string) => Promise<void>;

const NOTIFY_THROTTLE_MS = 5 * 60 * 1000;

function toErrorObject(err: unknown): Error {
  if (err instanceof Error) {
    return err;
  }
  if (typeof err === 'string') {
    return new Error(err);
  }
  try {
    return new Error(JSON.stringify(err));
  } catch {
    return new Error(String(err));
  }
}

export class ConnectionAlertNotifier {
  private readonly throttleMap = new Map<string, number>();
  private broadcaster: ConnectionAlertBroadcaster | null = null;
  private settingsProvider: () => SiteSettings = () => getSiteSettings();
  private persister: (deviceId: string, friendlyMessage: string, errorType: string) => void = (
    deviceId,
    friendlyMessage,
    errorType
  ) => {
    updateDeviceRuntimeStatus(deviceId, {
      lastSeenAt: new Date().toISOString(),
      lastError: friendlyMessage,
      lastErrorType: errorType,
    });
  };
  private telegramSender: TelegramSender = (text) =>
    telegramService.sendToAuthorizedChats({ text });

  setBroadcaster(broadcaster: ConnectionAlertBroadcaster | null): void {
    this.broadcaster = broadcaster;
  }

  setSettingsProvider(provider: () => SiteSettings): void {
    this.settingsProvider = provider;
  }

  setPersister(persister: (deviceId: string, friendlyMessage: string, errorType: string) => void): void {
    this.persister = persister;
  }

  setTelegramSender(sender: TelegramSender): void {
    this.telegramSender = sender;
  }

  async notify(alert: ConnectionAlertInput): Promise<ClassifiedConnectionAlert> {
    const { device, error, source, silentTelegram = false, persist = true } = alert;
    const errObj = toErrorObject(error);
    const classified = classifySshError(errObj);
    const friendlyMessage = t(classified.messageKey, { ...classified.messageParams });
    const rawMessage = errObj.message;

    console.error(
      `[conn-alert] device ${device.id} (${device.name}) source=${source} type=${classified.type}: ${rawMessage}`
    );

    if (persist) {
      try {
        this.persister(device.id, friendlyMessage, classified.type);
      } catch (dbErr) {
        console.error('[conn-alert] failed to persist runtime status:', dbErr);
      }
    }

    if (this.broadcaster) {
      try {
        this.broadcaster(device.id, {
          deviceId: device.id,
          type: 'error',
          errorType: classified.type,
          message: friendlyMessage,
          rawMessage,
        });
      } catch (broadcastErr) {
        console.error('[conn-alert] failed to broadcast:', broadcastErr);
      }
    }

    if (!silentTelegram && this.shouldSendTelegram(device.id, classified.type)) {
      await this.sendTelegram(device, classified.type, friendlyMessage, rawMessage);
    }

    return {
      errorType: classified.type,
      messageKey: classified.messageKey,
      message: friendlyMessage,
      rawMessage,
    };
  }

  clear(deviceId: string): void {
    for (const key of this.throttleMap.keys()) {
      if (key.startsWith(`${deviceId}:`)) {
        this.throttleMap.delete(key);
      }
    }
  }

  private shouldSendTelegram(deviceId: string, errorType: string): boolean {
    const key = `${deviceId}:${errorType}`;
    const now = Date.now();
    const last = this.throttleMap.get(key) ?? 0;
    if (now - last < NOTIFY_THROTTLE_MS) {
      return false;
    }
    this.throttleMap.set(key, now);
    for (const [otherKey, ts] of this.throttleMap) {
      if (otherKey !== key && otherKey.startsWith(`${deviceId}:`) && now - ts >= NOTIFY_THROTTLE_MS) {
        this.throttleMap.delete(otherKey);
      }
    }
    return true;
  }

  private async sendTelegram(
    device: Device,
    errorType: string,
    friendlyMessage: string,
    rawMessage: string
  ): Promise<void> {
    let settings: SiteSettings;
    try {
      settings = this.settingsProvider();
    } catch (err) {
      console.error('[conn-alert] failed to read site settings:', err);
      return;
    }

    const categoryKey = `deviceStatus.errorBadge.${toBadgeKey(errorType)}`;
    const translatedCategory = t(categoryKey, { defaultValue: errorType });
    const text = t('telegram.deviceConnectionError', {
      siteName: settings.siteName,
      deviceName: device.name,
      host: device.host ?? '-',
      category: translatedCategory,
      error: friendlyMessage || rawMessage,
    });

    try {
      await this.telegramSender(text);
    } catch (notifyErr) {
      console.error('[conn-alert] telegram send failed:', notifyErr);
    }
  }
}

function toBadgeKey(errorType: string): string {
  switch (errorType) {
    case 'auth_failed':
      return 'authFailed';
    case 'agent_unavailable':
      return 'agentUnavailable';
    case 'agent_no_identity':
      return 'agentNoIdentity';
    case 'ssh_config_ref_not_supported':
      return 'configRefNotSupported';
    case 'network_unreachable':
      return 'networkUnreachable';
    case 'connection_refused':
      return 'connectionRefused';
    case 'timeout':
      return 'timeout';
    case 'host_not_found':
      return 'hostNotFound';
    case 'handshake_failed':
      return 'handshakeFailed';
    case 'tmux_unavailable':
      return 'tmuxUnavailable';
    case 'connection_closed':
      return 'connectionClosed';
    default:
      return 'unknown';
  }
}

export const connectionAlertNotifier = new ConnectionAlertNotifier();
