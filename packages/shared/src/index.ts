// tmex 前后端共享类型定义

// ==================== Device ====================

export type DeviceType = 'local' | 'ssh';
export type AuthMode = 'password' | 'key' | 'agent' | 'configRef' | 'auto';

export interface Device {
  id: string;
  name: string;
  type: DeviceType;
  // SSH 相关
  host?: string;
  port?: number;
  username?: string;
  sshConfigRef?: string;
  session?: string; // tmux 会话名称，默认为 'tmex'
  // 认证
  authMode: AuthMode;
  // 加密字段（存储时加密）
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

// ==================== WebSocket 消息 ====================

export type WsMessageType =
  | 'connected'
  | 'error'
  | 'auth/hello'
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

// 客户端 -> 服务端
export interface AuthHelloPayload {
  token?: string;
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

// 服务端 -> 客户端
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

export type TmuxEventType =
  | 'window-add'
  | 'window-close'
  | 'window-renamed'
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

// ==================== Webhook & Telegram ====================

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
  secret: string; // 用于 HMAC
  eventMask: EventType[];
  createdAt: string;
  updatedAt: string;
}

export interface TelegramSubscription {
  id: string;
  enabled: boolean;
  chatId: string;
  eventMask: EventType[];
  createdAt: string;
  updatedAt: string;
}

export interface WebhookEvent {
  eventType: EventType;
  timestamp: string;
  device: {
    id: string;
    name: string;
    type: DeviceType;
    host?: string;
  };
  tmux?: {
    sessionName?: string;
    windowId?: string;
    paneId?: string;
  };
  payload?: Record<string, unknown>;
}

// ==================== REST API ====================

export interface LoginRequest {
  password: string;
}

export interface LoginResponse {
  success: boolean;
  error?: string;
}

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
