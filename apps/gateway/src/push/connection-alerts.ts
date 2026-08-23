import type {
  Device,
  EventDevicePayload,
  EventType,
  SiteSettings,
  WebhookEvent,
} from '@tmex/shared';
import { getSiteSettings, updateDeviceRuntimeStatus } from '../db';
import { t } from '../i18n';
import { telegramService } from '../telegram/service';
import { classifySshError } from '../ws/error-classify';

export type ConnectionAlertSource = 'connect' | 'runtime' | 'close' | 'probe';

export type ConnectionEventEmitter = (
  eventType: EventType,
  event: Omit<WebhookEvent, 'eventType' | 'timestamp'>
) => void;

// 桥接进事件系统的错误分类：连接级断开 → device_disconnect；tmux 不可用 → device_tmux_missing。
// 认证/agent/配置类错误不属于设备连接生命周期，不桥接。
const DISCONNECT_ERROR_TYPES = new Set([
  'connection_closed',
  'network_unreachable',
  'connection_refused',
  'timeout',
  'host_not_found',
  'handshake_failed',
]);
// runtime 来源是 tmux 命令级失败（高频且 session gone 另有 session_closed 事件），不桥接。
const BRIDGE_EVENT_SOURCES = new Set<ConnectionAlertSource>(['close', 'connect', 'probe']);

export interface ConnectionAlertInput {
  device: Device;
  error: unknown;
  source: ConnectionAlertSource;
  silentTelegram?: boolean;
  persist?: boolean;
  // 本次断开前连接已因 session gone 发出 session_closed（同一物理事件不再发 device_disconnect）。
  // 由持有连接实例的调用方显式传入；持久化的 tmuxAvailable 状态位被大量无关路径写入，不可作此信号。
  sessionClosedEmitted?: boolean;
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
  private readonly bridgeThrottleMap = new Map<string, number>();
  private broadcaster: ConnectionAlertBroadcaster | null = null;
  private eventEmitter: ConnectionEventEmitter | null = null;
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

  setEventEmitter(emitter: ConnectionEventEmitter | null): void {
    this.eventEmitter = emitter;
  }

  setSettingsProvider(provider: () => SiteSettings): void {
    this.settingsProvider = provider;
  }

  setPersister(
    persister: (deviceId: string, friendlyMessage: string, errorType: string) => void
  ): void {
    this.persister = persister;
  }

  setTelegramSender(sender: TelegramSender): void {
    this.telegramSender = sender;
  }

  async notify(alert: ConnectionAlertInput): Promise<ClassifiedConnectionAlert> {
    const {
      device,
      error,
      source,
      silentTelegram = false,
      persist = true,
      sessionClosedEmitted = false,
    } = alert;
    const errObj = toErrorObject(error);
    const classified = classifySshError(errObj);
    const friendlyMessage = t(classified.messageKey, { ...classified.messageParams });
    const rawMessage = errObj.message;
    // 持久化时把真实错误一并保留，避免设备页只看到归类后的兜底文案（刷新后 raw 不丢）；
    // unknown 类的友好文案模板已内嵌 raw（"Connection failed: {{message}}"），用 includes 去重避免重复拼接
    const persistedMessage =
      rawMessage && !friendlyMessage.includes(rawMessage)
        ? `${friendlyMessage}\n${rawMessage}`
        : friendlyMessage;

    console.error(
      `[conn-alert] device ${device.id} (${device.name}) source=${source} type=${classified.type}: ${rawMessage}`
    );

    if (persist) {
      try {
        this.persister(device.id, persistedMessage, classified.type);
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

    this.maybeEmitEvent(device, source, classified.type, friendlyMessage, sessionClosedEmitted);

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
    for (const key of this.bridgeThrottleMap.keys()) {
      if (key.startsWith(`${deviceId}:`)) {
        this.bridgeThrottleMap.delete(key);
      }
    }
  }

  private maybeEmitEvent(
    device: Device,
    source: ConnectionAlertSource,
    errorType: string,
    friendlyMessage: string,
    sessionClosedEmitted: boolean
  ): void {
    if (!this.eventEmitter || !BRIDGE_EVENT_SOURCES.has(source)) {
      return;
    }
    let eventType: EventType | null = null;
    if (errorType === 'tmux_unavailable') {
      eventType = 'device_tmux_missing';
    } else if (DISCONNECT_ERROR_TYPES.has(errorType)) {
      eventType = 'device_disconnect';
    }
    if (!eventType) {
      return;
    }
    // session gone 路径已另发 session_closed，跳过 device_disconnect 避免同一物理事件双发。
    if (eventType === 'device_disconnect' && sessionClosedEmitted) {
      return;
    }
    const key = `${device.id}:${eventType}`;
    const now = Date.now();
    if (now - (this.bridgeThrottleMap.get(key) ?? 0) < NOTIFY_THROTTLE_MS) {
      return;
    }

    let settings: SiteSettings;
    try {
      settings = this.settingsProvider();
    } catch {
      return;
    }
    try {
      this.eventEmitter(eventType, {
        site: { name: settings.siteName, url: settings.siteUrl },
        device: { id: device.id, name: device.name, type: device.type, host: device.host },
        // 与连接类的 session 名解析口径一致（未配置时缺省 'tmex'），便于消费端跨事件关联
        tmux: { sessionName: device.session?.trim() || 'tmex' },
        payload: { message: friendlyMessage, errorType, errorDetail: friendlyMessage },
      });
    } catch (emitErr) {
      console.error('[conn-alert] event emit failed:', emitErr);
      return;
    }
    // 成功发射才消耗节流窗口（settings 读取或发射失败不白耗 5 分钟）；顺带惰性清理同设备过期键
    this.bridgeThrottleMap.set(key, now);
    for (const [otherKey, ts] of this.bridgeThrottleMap) {
      if (
        otherKey !== key &&
        otherKey.startsWith(`${device.id}:`) &&
        now - ts >= NOTIFY_THROTTLE_MS
      ) {
        this.bridgeThrottleMap.delete(otherKey);
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
      if (
        otherKey !== key &&
        otherKey.startsWith(`${deviceId}:`) &&
        now - ts >= NOTIFY_THROTTLE_MS
      ) {
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
