// tmex 前后端共享类型定义
//
// 注意：环境变量加载器 loadEnv 是 Node-only（依赖 node:fs/node:url），
// 不能从本浏览器侧主入口导出——否则会被打进客户端 bundle 触发
// "Module node:fs has been externalized" 运行时错误。
// Node 侧消费者请直接 import './env/load-env'（相对路径）。

// ==================== i18n ====================

import type { LocaleCode as _LocaleCode } from './i18n/resources';

// Types
export type { LocaleInfo, Manifest, TranslationKey } from './i18n/types';
export type LocaleCode = _LocaleCode;

// Runtime values (generated from manifest)
export {
  I18N_RESOURCES,
  I18N_MANIFEST,
  DEFAULT_LOCALE,
  AVAILABLE_LOCALES as SUPPORTED_LOCALES,
  toBCP47,
} from './i18n/resources';

// ==================== Version ====================

export { formatDisplayVersion } from './version';

// ==================== System / Update ====================

/** 部署方式：launchd（macOS）/ systemd（Linux）/ none（非 CLI 安装，如 docker/手动/dev） */
export type GatewayDeployment = 'launchd' | 'systemd' | 'none';

/** 升级状态机：仅这三态 */
export type UpgradeState = 'idle' | 'downloading' | 'executing';

/** 系统信息（gateway 权威），用于设置页版本 section */
export interface SystemInfo {
  /** 展示版本（非 production 带 _dev 后缀） */
  version: string;
  /** 原始版本号（不带后缀），用于检查更新比较 */
  baseVersion: string;
  /** 是否 production 环境 */
  isProd: boolean;
  /** 是否通过 CLI（tmex init）安装 */
  installedViaCli: boolean;
  /** 部署方式 */
  deployment: GatewayDeployment;
  /** 是否允许程序内自更新：isProd && installedViaCli && deployment!=='none' */
  canSelfUpdate: boolean;
  /** 服务名（CLI 安装时来自 install-meta，否则 null） */
  serviceName: string | null;
  /** 文件传输（上传/下载）单文件字节上限（前端据此做上传前预校验） */
  transferMaxBytes: number;
}

/** 检查更新结果 */
export interface UpdateCheckResult {
  /** 当前版本（base） */
  currentVersion: string;
  /** npm 上的最新版本（查询失败为 null） */
  latestVersion: string | null;
  /** 是否有可用更新 */
  hasUpdate: boolean;
  /** 目标版本 changelog（markdown，拉取不到为 null） */
  changelog: string | null;
  /** 最新版本发布时间 ISO 串（无则 null） */
  publishedAt: string | null;
}

/** 升级状态（轮询） */
export interface UpgradeStatus {
  state: UpgradeState;
  /** 目标版本（非 idle 时） */
  targetVersion: string | null;
  /** 最近一次错误（下载阶段失败时上报） */
  error: string | null;
  /** 本次升级开始时间 ISO 串 */
  startedAt: string | null;
}

/** 触发升级请求体 */
export interface StartUpgradeRequest {
  version: string;
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
  // device tree 中的自定义显示顺序，升序；越小越靠前
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface DeviceRuntimeStatus {
  deviceId: string;
  lastSeenAt: string | null;
  tmuxAvailable: boolean;
  lastError: string | null;
  lastErrorType: string | null;
}

// ==================== Site Settings ====================

export interface SiteSettings {
  siteName: string;
  siteUrl: string;
  bellThrottleSeconds: number;
  notificationThrottleSeconds: number;
  enableBrowserBellToast: boolean;
  enableBrowserNotificationToast: boolean;
  enableTelegramBellPush: boolean;
  enableTelegramNotificationPush: boolean;
  enableWeixinBellPush: boolean;
  enableWeixinNotificationPush: boolean;
  sshReconnectMaxRetries: number;
  sshReconnectDelaySeconds: number;
  language: LocaleCode;
  updatedAt: string;
}

// ==================== Terminal Shortcuts ====================

/** 终端快捷键的特殊动作（非发送字符序列，而是触发前端行为）。 */
export type TerminalShortcutAction =
  | 'paste'
  | 'toggleKeyboard'
  | 'newAgentSession'
  | 'scrollToBottom';

/** 终端快捷键栏的单个按钮。 */
export interface TerminalShortcutItem {
  /** 稳定 id（拖拽排序 / React key）；自定义项用 crypto.randomUUID 生成 */
  id: string;
  /** send=向终端发送 payload；action=触发前端特殊动作 */
  type: 'send' | 'action';
  /** 显示文字（可编辑）；action 项为空时前端回退到内置 i18n 名 */
  label: string;
  /** type==='send' 时：发送到终端的原始控制序列 */
  payload?: string;
  /** type==='action' 时：要触发的动作 */
  action?: TerminalShortcutAction;
}

/** 终端快捷键设置（服务器单例，多端共享）。 */
export interface TerminalShortcutSettings {
  items: TerminalShortcutItem[];
  /** 是否用苹果风格符号替代 send 类按键的文字 */
  useIcons: boolean;
  updatedAt: string;
}

/** 更新终端快捷键设置请求体。 */
export interface UpdateTerminalShortcutSettingsRequest {
  items: TerminalShortcutItem[];
  useIcons: boolean;
}

/** 全部合法的特殊动作（服务端校验 + 前端枚举用）。 */
export const TERMINAL_SHORTCUT_ACTIONS: readonly TerminalShortcutAction[] = [
  'paste',
  'toggleKeyboard',
  'newAgentSession',
  'scrollToBottom',
];

/**
 * 默认快捷键列表（migration 直接写入单例行）。
 * payload 沿用历史终端栏取值；SHIFT-TAB 用 reverse-tab CSI Z。
 */
export const DEFAULT_TERMINAL_SHORTCUTS: TerminalShortcutItem[] = [
  { id: 'paste', type: 'action', action: 'paste', label: '' },
  { id: 'enter', type: 'send', label: 'Enter', payload: '\r' },
  { id: 'shift-tab', type: 'send', label: 'SHIFT-TAB', payload: '\x1b[Z' },
  { id: 'esc', type: 'send', label: 'ESC', payload: '\x1b' },
  { id: 'ctrl-c', type: 'send', label: 'CTRL-C', payload: '\x03' },
  { id: 'ctrl-d', type: 'send', label: 'CTRL-D', payload: '\x04' },
  { id: 'arrow-up', type: 'send', label: '↑', payload: '\x1b[A' },
  { id: 'arrow-down', type: 'send', label: '↓', payload: '\x1b[B' },
  { id: 'arrow-left', type: 'send', label: '←', payload: '\x1b[D' },
  { id: 'arrow-right', type: 'send', label: '→', payload: '\x1b[C' },
  { id: 'shift-enter', type: 'send', label: 'SHIFT-Enter', payload: '\x1b[13;2u' },
  { id: 'backspace', type: 'send', label: 'Backspace', payload: '\x08' },
];

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

// ==================== 微信 (iLink) ====================

export interface WeixinAccountConfig {
  id: string;
  name: string;
  enabled: boolean;
  allowAuthRequests: boolean;
  /** 是否已扫码登录（持有 iLink 凭证）。 */
  loggedIn: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface WeixinAccountWithStats extends WeixinAccountConfig {
  pendingCount: number;
  authorizedCount: number;
  /** 会话已过期、需用户重新发消息激活的授权用户数。 */
  needsReactivationCount: number;
}

export type WeixinUserStatus = 'pending' | 'authorized';

export interface WeixinAccountUser {
  id: string;
  accountId: string;
  userId: string;
  displayName: string;
  status: WeixinUserStatus;
  /** 半主动推送语义：iLink 会话已过期、需用户重新发消息激活。 */
  needsReactivation: boolean;
  lastInboundAt: string | null;
  appliedAt: string;
  authorizedAt: string | null;
  updatedAt: string;
}

export type WeixinLoginStatus = 'pending' | 'confirmed' | 'expired' | 'error';

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
  | 'tmux/rename-window'
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

export { b } from './ws-borsh';
export * as wsBorsh from './ws-borsh';

// Agent/Watch WS 事件 payload 类型（JSON 形状约定，前后端共用）
export type {
  AgentSessionWireStatus,
  AgentConfirmationWireStatus,
  AgentPendingConfirmation,
  AgentQueuedMessageWire,
  AgentQueueUpdatedPayload,
  AgentSyncEventPayload,
  AgentStatusEventPayload,
  AgentTextDeltaPayload,
  AgentReasoningDeltaPayload,
  AgentToolCallPayload,
  AgentToolResultPayload,
  AgentConfirmationRequestPayload,
  AgentConfirmationResolvedPayload,
  AgentMessagePersistedPayload,
  AgentErrorEventPayload,
  AgentTurnFinishedPayload,
  AgentCredentialWarningPayload,
  WatchTriggeredPayload,
  WatchModelUnavailablePayload,
  WatchRuleErrorPayload,
  AgentEventPayloadMap,
  WatchEventPayloadMap,
  AgentEventType,
  WatchEventType,
} from './ws-borsh/agent';

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
  alternateScreen?: boolean;
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

export interface RenameWindowPayload {
  deviceId: string;
  windowId: string;
  name: string;
}

export interface TmuxWindow {
  id: string;
  name: string;
  customName?: string;
  index: number;
  active: boolean;
  panes: TmuxPane[];
}

export interface TmuxPane {
  id: string;
  windowId: string;
  index: number;
  title?: string;
  /** pane 当前运行的进程名（tmux #{pane_current_command}） */
  currentCommand?: string;
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
  paneTitle?: string;
  paneCurrentCommand?: string;
}

export type NotificationSource = 'osc9' | 'osc99' | 'osc777' | 'osc1337';

export interface TmuxNotificationEventData {
  source: NotificationSource;
  title?: string;
  body: string;
  windowId?: string;
  paneId?: string;
  windowIndex?: number;
  paneIndex?: number;
  paneUrl?: string;
  paneTitle?: string;
  paneCurrentCommand?: string;
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
  | 'notification'
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
  | 'terminal_notification'
  | 'tmux_window_close'
  | 'tmux_pane_close'
  | 'device_tmux_missing'
  | 'device_disconnect'
  | 'session_created'
  | 'session_closed'
  | 'agent_confirmation_pending'
  | 'agent_turn_finished'
  | 'agent_error'
  | 'watch_triggered'
  | 'watch_model_unavailable'
  | 'watch_rule_error';

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
    paneTitle?: string;
    paneCurrentCommand?: string;
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
  phase: 'connect' | 'bootstrap' | 'ready';
  errorType?: string;
  message?: string;
  rawMessage?: string;
}

export interface GetSiteSettingsResponse {
  settings: SiteSettings;
}

export interface UpdateSiteSettingsRequest {
  siteName?: string;
  siteUrl?: string;
  bellThrottleSeconds?: number;
  notificationThrottleSeconds?: number;
  enableBrowserBellToast?: boolean;
  enableBrowserNotificationToast?: boolean;
  enableTelegramBellPush?: boolean;
  enableTelegramNotificationPush?: boolean;
  enableWeixinBellPush?: boolean;
  enableWeixinNotificationPush?: boolean;
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

export interface ListWeixinAccountsResponse {
  accounts: WeixinAccountWithStats[];
}

export interface CreateWeixinAccountRequest {
  name: string;
  enabled?: boolean;
  allowAuthRequests?: boolean;
}

export interface UpdateWeixinAccountRequest {
  name?: string;
  enabled?: boolean;
  allowAuthRequests?: boolean;
}

export interface ListWeixinAccountUsersResponse {
  users: WeixinAccountUser[];
}

export interface StartWeixinLoginResponse {
  /** 二维码内容（前端渲染成二维码图）。 */
  qrcodeUrl: string;
  /** 轮询扫码状态用的标识。 */
  qrcodeId: string;
}

export interface WeixinLoginStatusResponse {
  status: WeixinLoginStatus;
  loggedIn: boolean;
  message?: string;
}

export interface RestartGatewayResponse {
  success: boolean;
  message: string;
}

// ==================== LLM / Agent ====================

export type LlmProviderProtocol = 'openai-chat' | 'openai-responses';

export type AgentSearchProvider = 'none' | 'tavily' | 'brave';

export type LlmModelSource = 'fetched' | 'manual';

export interface LlmModelInfo {
  id: string;
  source: LlmModelSource;
  enabled: boolean;
}

export interface LlmProviderDto {
  id: string;
  name: string;
  protocol: LlmProviderProtocol;
  baseUrl: string;
  hasApiKey: boolean;
  enabled: boolean;
  /** effective 启用模型列表 =（拉取 ∪ 手动）− 禁用，供 Agent/默认模型选择器使用 */
  models: string[];
  /** 全量模型（含来源与启用态），供设置页逐个启停 */
  modelDetails: LlmModelInfo[];
  modelsFetchedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ListLlmProvidersResponse {
  providers: LlmProviderDto[];
}

export interface CreateLlmProviderRequest {
  name: string;
  protocol: LlmProviderProtocol;
  baseUrl: string;
  apiKey: string;
  enabled?: boolean;
}

export interface CreateLlmProviderResponse {
  provider: LlmProviderDto;
  modelsError?: string;
}

export interface UpdateLlmProviderRequest {
  name?: string;
  protocol?: LlmProviderProtocol;
  baseUrl?: string;
  /** 留空或缺省表示不修改 */
  apiKey?: string;
  enabled?: boolean;
  /** 手动添加的模型 id 全量覆盖 */
  manualModels?: string[];
  /** 被禁用的模型 id 全量覆盖 */
  disabledModels?: string[];
}

export interface UpdateLlmProviderResponse {
  provider: LlmProviderDto;
  modelsError?: string;
}

export interface RefreshLlmProviderModelsResponse {
  models: string[];
}

export interface AgentLlmSettingsDto {
  searchProvider: AgentSearchProvider;
  hasTavilyApiKey: boolean;
  hasBraveApiKey: boolean;
  defaultProviderId: string | null;
  defaultModelId: string | null;
  updatedAt: string;
}

export interface GetAgentLlmSettingsResponse {
  settings: AgentLlmSettingsDto;
}

export interface UpdateAgentLlmSettingsRequest {
  searchProvider?: AgentSearchProvider;
  defaultProviderId?: string | null;
  defaultModelId?: string | null;
  /** 缺省表示不修改，空串表示清除 */
  tavilyApiKey?: string;
  /** 缺省表示不修改，空串表示清除 */
  braveApiKey?: string;
}

export interface UpdateAgentLlmSettingsResponse {
  settings: AgentLlmSettingsDto;
}

// ==================== Agent Sessions ====================

export type AgentWriteMode = 'confirm' | 'auto';

export type AgentSessionStatus = 'idle' | 'running' | 'waiting_confirmation' | 'stopped' | 'error';

export type AgentConfirmationStatus = 'pending' | 'approved' | 'denied' | 'cancelled';

export type AgentMessageRole = 'system' | 'user' | 'assistant' | 'tool';

/** 新建 session 的默认标题，标题仍为该值时服务端会在首回合结束后自动生成 */
export const DEFAULT_AGENT_SESSION_TITLE = 'New Session';

export interface AgentSessionDto {
  id: string;
  title: string;
  deviceId: string | null;
  paneId: string | null;
  providerId: string | null;
  modelId: string;
  systemPrompt: string | null;
  writeMode: AgentWriteMode;
  useProviderWebSearch: boolean;
  /** 启用的 provider 原生 hosted 工具 key（如 image_generation） */
  providerHostedTools: string[];
  /** 起源元数据：创建时绑定 pane 的终端标题/进程名（旧记录为 null） */
  originPaneTitle: string | null;
  originProcessName: string | null;
  status: AgentSessionStatus;
  lastError: string | null;
  maxStepsPerTurn: number;
  createdAt: string;
  updatedAt: string;
}

export interface AgentQueuedMessageDto {
  id: string;
  sessionId: string;
  seq: number;
  text: string;
  createdAt: string;
}

export interface AgentMessageDto {
  id: string;
  sessionId: string;
  seq: number;
  role: AgentMessageRole;
  /** AI SDK ModelMessage 原样 JSON */
  content: unknown;
  createdAt: string;
}

export interface AgentConfirmationDto {
  id: string;
  sessionId: string;
  toolName: string;
  toolCallId: string;
  input: unknown;
  status: AgentConfirmationStatus;
  reason: string | null;
  decidedAt: string | null;
  createdAt: string;
}

export interface ListAgentSessionsResponse {
  sessions: AgentSessionDto[];
}

export interface CreateAgentSessionRequest {
  deviceId: string;
  paneId: string;
  providerId?: string | null;
  modelId?: string | null;
  systemPrompt?: string | null;
  writeMode?: AgentWriteMode;
  useProviderWebSearch?: boolean;
  providerHostedTools?: string[];
  /** 前端可附带 snapshot 的 pane 标题作为起源元数据兜底（进程名由后端采集） */
  originPaneTitle?: string | null;
  maxStepsPerTurn?: number;
}

export interface UpdateAgentSessionRequest {
  title?: string;
  paneId?: string;
  providerId?: string | null;
  modelId?: string;
  systemPrompt?: string | null;
  writeMode?: AgentWriteMode;
  useProviderWebSearch?: boolean;
  providerHostedTools?: string[];
  maxStepsPerTurn?: number;
}

export interface AgentSessionResponse {
  session: AgentSessionDto;
}

export interface ListAgentMessagesResponse {
  messages: AgentMessageDto[];
}

export interface PostAgentMessageRequest {
  text: string;
}

export interface ListAgentQueuedMessagesResponse {
  queued: AgentQueuedMessageDto[];
}

export interface EnqueueAgentMessageRequest {
  text: string;
  /** true 表示立即 steer（中断当前 step 注入）；缺省/false 为等下一 step 边界注入 */
  steer?: boolean;
}

export interface EditQueuedAgentMessageRequest {
  text: string;
}

export interface ListAgentConfirmationsResponse {
  confirmations: AgentConfirmationDto[];
}

export interface DecideAgentConfirmationRequest {
  approved: boolean;
  reason?: string;
}

export interface DecideAgentConfirmationResponse {
  confirmation: AgentConfirmationDto;
}

// ==================== Watch Rules ====================

export type WatchTriggerType = 'match' | 'unchanged' | 'llm';

export type WatchNoMatchBehavior = 'reset' | 'ignore';

export type WatchFireMode = 'once' | 'repeat';

export interface WatchRuleDto {
  id: string;
  name: string;
  deviceId: string;
  paneId: string;
  enabled: boolean;
  triggerType: WatchTriggerType;
  pattern: string | null;
  patternFlags: string;
  extractGroup: number;
  conditionPrompt: string | null;
  providerId: string | null;
  modelId: string | null;
  confirmWithLlm: boolean;
  summarizeWithLlm: boolean;
  intervalSeconds: number;
  unchangedMinutes: number | null;
  noMatchBehavior: WatchNoMatchBehavior;
  fireMode: WatchFireMode;
  cooldownSeconds: number;
  createdAt: string;
  updatedAt: string;
}

export interface WatchRuleStateDto {
  ruleId: string;
  lastSampledAt: string | null;
  lastValue: string | null;
  lastValueChangedAt: string | null;
  triggeredSinceChange: boolean;
  lastTriggeredAt: string | null;
  consecutiveErrors: number;
  lastError: string | null;
  modelUnavailableNotified: boolean;
}

/** 内存 ring buffer 中的近期采样点（不持久化） */
export interface WatchRuleSampleDto {
  at: string;
  value: string | null;
  hit: boolean;
}

export interface ListWatchRulesResponse {
  rules: WatchRuleDto[];
}

export interface CreateWatchRuleRequest {
  name: string;
  deviceId: string;
  paneId: string;
  enabled?: boolean;
  triggerType: WatchTriggerType;
  pattern?: string | null;
  patternFlags?: string;
  extractGroup?: number;
  conditionPrompt?: string | null;
  providerId?: string | null;
  modelId?: string | null;
  confirmWithLlm?: boolean;
  summarizeWithLlm?: boolean;
  intervalSeconds?: number;
  unchangedMinutes?: number | null;
  noMatchBehavior?: WatchNoMatchBehavior;
  fireMode?: WatchFireMode;
  cooldownSeconds?: number;
}

export interface UpdateWatchRuleRequest {
  name?: string;
  paneId?: string;
  enabled?: boolean;
  triggerType?: WatchTriggerType;
  pattern?: string | null;
  patternFlags?: string;
  extractGroup?: number;
  conditionPrompt?: string | null;
  providerId?: string | null;
  modelId?: string | null;
  confirmWithLlm?: boolean;
  summarizeWithLlm?: boolean;
  intervalSeconds?: number;
  unchangedMinutes?: number | null;
  noMatchBehavior?: WatchNoMatchBehavior;
  fireMode?: WatchFireMode;
  cooldownSeconds?: number;
}

export interface WatchRuleResponse {
  rule: WatchRuleDto;
  state: WatchRuleStateDto | null;
}

export interface WatchRuleStateResponse {
  state: WatchRuleStateDto | null;
  samples: WatchRuleSampleDto[];
}

export interface AssistRegexRequest {
  description: string;
  deviceId?: string;
  paneId?: string;
  providerId?: string | null;
  modelId?: string | null;
}

export interface AssistRegexResponse {
  pattern: string;
  flags: string;
  extractGroup: number;
  explanation: string;
  /** 在屏幕样本上的试跑命中（无屏幕上下文时为空数组） */
  preview: string[];
}

// ==================== Files ====================

/** 文件类别：决定前端用哪个查看器与图标 */
export type FileCategory =
  | 'directory'
  | 'code'
  | 'markdown'
  | 'image'
  | 'pdf'
  | 'text'
  | 'archive'
  | 'audio'
  | 'video'
  | 'binary'
  | 'other';

/** 目录条目种类（symlink 单列，便于前端标注；category 反映链接目标的种类） */
export type FileEntryType = 'dir' | 'file' | 'symlink' | 'other';

/** 文件访问错误码（前后端共享，前端据此渲染节点错误态 / 触发安装流程） */
export type FileErrorCode =
  | 'invalid'
  | 'outside_roots'
  | 'not_found'
  | 'not_a_directory'
  | 'is_directory'
  | 'too_large'
  | 'binary'
  | 'permission_denied'
  | 'device_not_found'
  | 'root_not_found'
  | 'root_disabled'
  | 'connection_failed'
  | 'auth_unsupported'
  | 'rsync_missing_local'
  | 'rsync_missing_remote'
  | 'timeout'
  | 'unknown';

/** 白名单根目录（绑定到具体设备） */
export interface FileRootDto {
  id: string;
  /** 绑定设备 id */
  deviceId: string;
  /** 设备展示名（设备不存在时为 null） */
  deviceName: string | null;
  /** 设备类型（设备不存在时为 null） */
  deviceType: DeviceType | null;
  /** 绝对路径 */
  path: string;
  /** 展示名：路径 basename（根 '/' 显示为 /） */
  name: string;
  /** 是否启用 */
  enabled: boolean;
  sortOrder: number;
}

export interface CreateFileRootRequest {
  deviceId: string;
  path: string;
  enabled?: boolean;
}

export interface UpdateFileRootRequest {
  path?: string;
  enabled?: boolean;
  sortOrder?: number;
}

/** 目录中的一个条目 */
export interface FileEntryDto {
  name: string;
  /** 绝对路径 */
  path: string;
  type: FileEntryType;
  category: FileCategory;
  /** 字节数；目录为 null */
  size: number | null;
  /** 最后修改时间 ISO 串；无法获取为 null */
  modifiedAt: string | null;
  /** 是否为符号链接 */
  isSymlink: boolean;
}

export interface ListFileRootsResponse {
  roots: FileRootDto[];
}

export interface FileRootResponse {
  root: FileRootDto;
}

export interface ListFilesResponse {
  /** 被列出的目录绝对路径 */
  path: string;
  entries: FileEntryDto[];
  /** 条目数超过上限被截断 */
  truncated: boolean;
}

export type FileContentEncoding = 'utf-8';

export interface FileContentResponse {
  path: string;
  name: string;
  category: FileCategory;
  encoding: FileContentEncoding;
  content: string;
  /** 文件实际字节数 */
  size: number;
  /** 内容因超限被截断 */
  truncated: boolean;
}

export interface FileStatResponse {
  path: string;
  name: string;
  type: FileEntryType;
  category: FileCategory;
  size: number;
  modifiedAt: string | null;
  mime: string | null;
  isSymlink: boolean;
}

// ---- 分块上传协议 ----
export interface UploadInitRequest {
  rootId: string;
  /** 目标目录绝对路径（须落在 root 内且为已存在目录） */
  path: string;
  name: string;
  size: number;
}

export interface UploadInitResponse {
  uploadId: string;
  chunkSize: number;
}

/** commit 阶段流式返回的 NDJSON 事件（rsync 推送进度 / 完成 / 失败） */
export type UploadCommitEvent =
  | { type: 'progress'; transferred: number; pct: number; rate: string }
  | { type: 'done'; uploaded: string }
  | { type: 'error'; code: FileErrorCode; detail?: string };
