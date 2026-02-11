// tmex 前后端共享类型定义

// ==================== i18n ====================

export type LocaleCode = 'en_US' | 'zh_CN';

export const DEFAULT_LOCALE: LocaleCode = 'en_US';

export function toBCP47(locale: LocaleCode): string {
  return locale.replace('_', '-');
}

// ==================== Device ====================

export type DeviceType = 'local' | 'ssh';
export type AuthMode = 'password' | 'key' | 'agent' | 'configRef' | 'auto';

export interface Device {
  id: string;
  name: string;
  type: DeviceType;
  host?: string;
  port?: number;
  username?: string;
  sshConfigRef?: string;
  session?: string;
  authMode: AuthMode;
  passwordEnc?: string;
  privateKeyEnc?: string;
  privateKeyPassphraseEnc?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DeviceRuntimeStatus {
  deviceId: string;
  lastSeenAt: string | null;
  tmuxAvailable: boolean;
  lastError: string | null;
}

// ==================== Site Settings ====================

export interface SiteSettings {
  siteName: string;
  siteUrl: string;
  bellThrottleSeconds: number;
  enableBrowserBellToast: boolean;
  enableTelegramBellPush: boolean;
  sshReconnectMaxRetries: number;
  sshReconnectDelaySeconds: number;
  language: LocaleCode;
  updatedAt: string;
}

// ==================== Telegram ====================

export interface TelegramBotConfig {
  id: string;
  name: string;
  enabled: boolean;
  allowAuthRequests: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TelegramBotWithStats extends TelegramBotConfig {
  pendingCount: number;
  authorizedCount: number;
}

export type TelegramChatStatus = 'pending' | 'authorized';

export type TelegramChatType = 'private' | 'group' | 'supergroup' | 'channel' | 'unknown';

export interface TelegramBotChat {
  id: string;
  botId: string;
  chatId: string;
  chatType: TelegramChatType;
  displayName: string;
  status: TelegramChatStatus;
  appliedAt: string;
  authorizedAt: string | null;
  updatedAt: string;
}

// ==================== WebSocket 消息 ====================

export type WsMessageType =
  | 'connected'
  | 'error'
  | 'device/connect'
  | 'device/disconnect'
  | 'device/connected'
  | 'device/disconnected'
  | 'tmux/select'
  | 'tmux/select-window'
  | 'tmux/create-window'
  | 'tmux/close-window'
  | 'tmux/close-pane'
  | 'term/input'
  | 'term/resize'
  | 'term/sync-size'
  | 'term/paste'
  | 'term/history'
  | 'state/snapshot'
  | 'event/tmux'
  | 'event/device'
  | 'term/output';

export interface WsMessage<T = unknown> {
  type: WsMessageType;
  payload: T;
  timestamp: string;
}

export interface DeviceConnectPayload {
  deviceId: string;
}

export interface DeviceDisconnectPayload {
  deviceId: string;
}

export interface TmuxSelectPayload {
  deviceId: string;
  windowId?: string;
  paneId?: string;
}

export interface TmuxSelectWindowPayload {
  deviceId: string;
  windowId: string;
}

export interface TermInputPayload {
  deviceId: string;
  paneId: string;
  data: string;
  isComposing?: boolean;
}

export interface TermResizePayload {
  deviceId: string;
  paneId: string;
  cols: number;
  rows: number;
}

export interface TermPastePayload {
  deviceId: string;
  paneId: string;
  data: string;
}

export interface TermHistoryPayload {
  deviceId: string;
  paneId: string;
  data: string;
}

export interface CreateWindowPayload {
  deviceId: string;
  name?: string;
}

export interface CloseWindowPayload {
  deviceId: string;
  windowId: string;
}

export interface ClosePanePayload {
  deviceId: string;
  paneId: string;
}

export interface TmuxWindow {
  id: string;
  name: string;
  index: number;
  active: boolean;
  panes: TmuxPane[];
}

export interface TmuxPane {
  id: string;
  windowId: string;
  index: number;
  title?: string;
  active: boolean;
  width: number;
  height: number;
}

export interface TmuxSession {
  id: string;
  name: string;
  windows: TmuxWindow[];
}

export interface StateSnapshotPayload {
  deviceId: string;
  session: TmuxSession | null;
}

export interface TmuxBellEventData {
  windowId?: string;
  paneId?: string;
  windowIndex?: number;
  paneIndex?: number;
  paneUrl?: string;
}

export type TmuxEventType =
  | 'window-add'
  | 'window-close'
  | 'window-renamed'
  | 'window-active'
  | 'pane-add'
  | 'pane-close'
  | 'pane-active'
  | 'layout-change'
  | 'bell'
  | 'output';

export interface EventTmuxPayload {
  deviceId: string;
  type: TmuxEventType;
  data: unknown;
}

export type DeviceEventType = 'tmux-missing' | 'disconnected' | 'error' | 'reconnected';

export interface EventDevicePayload {
  deviceId: string;
  type: DeviceEventType;
  errorType?: string;
  message?: string;
  rawMessage?: string;
}

// ==================== Webhook & Notification ====================

export type EventType =
  | 'terminal_bell'
  | 'tmux_window_close'
  | 'tmux_pane_close'
  | 'device_tmux_missing'
  | 'device_disconnect'
  | 'session_created'
  | 'session_closed';

export interface WebhookEndpoint {
  id: string;
  enabled: boolean;
  url: string;
  secret: string;
  eventMask: EventType[];
  createdAt: string;
  updatedAt: string;
}

export interface WebhookEvent {
  eventType: EventType;
  timestamp: string;
  site: {
    name: string;
    url: string;
  };
  device: {
    id: string;
    name: string;
    type: DeviceType;
    host?: string;
  };
  tmux?: {
    sessionName?: string;
    windowId?: string;
    windowIndex?: number;
    paneId?: string;
    paneIndex?: number;
    paneUrl?: string;
  };
  payload?: Record<string, unknown>;
}

// ==================== REST API ====================

export interface CreateDeviceRequest {
  name: string;
  type: DeviceType;
  host?: string;
  port?: number;
  username?: string;
  sshConfigRef?: string;
  session?: string;
  authMode: AuthMode;
  password?: string;
  privateKey?: string;
  privateKeyPassphrase?: string;
}

export interface UpdateDeviceRequest {
  name?: string;
  host?: string;
  port?: number;
  username?: string;
  sshConfigRef?: string;
  session?: string;
  authMode?: AuthMode;
  password?: string;
  privateKey?: string;
  privateKeyPassphrase?: string;
}

export interface TestConnectionResult {
  success: boolean;
  tmuxAvailable: boolean;
  error?: string;
}

export interface GetSiteSettingsResponse {
  settings: SiteSettings;
}

export interface UpdateSiteSettingsRequest {
  siteName?: string;
  siteUrl?: string;
  bellThrottleSeconds?: number;
  enableBrowserBellToast?: boolean;
  enableTelegramBellPush?: boolean;
  sshReconnectMaxRetries?: number;
  sshReconnectDelaySeconds?: number;
  language?: LocaleCode;
}

export interface UpdateSiteSettingsResponse {
  settings: SiteSettings;
}

export interface ListTelegramBotsResponse {
  bots: TelegramBotWithStats[];
}

export interface CreateTelegramBotRequest {
  name: string;
  token: string;
  enabled?: boolean;
  allowAuthRequests?: boolean;
}

export interface UpdateTelegramBotRequest {
  name?: string;
  token?: string;
  enabled?: boolean;
  allowAuthRequests?: boolean;
}

export interface ListTelegramBotChatsResponse {
  chats: TelegramBotChat[];
}

export interface RestartGatewayResponse {
  success: boolean;
  message: string;
}

// ==================== i18n Resources ====================

export { I18N_RESOURCES } from './i18n/resources.js';
