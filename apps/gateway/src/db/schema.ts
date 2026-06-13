import type { AgentSearchProvider, EventType, LlmProviderProtocol } from '@tmex/shared';
import { sql } from 'drizzle-orm';
import { check, integer, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core';

export type { AgentSearchProvider, LlmProviderProtocol } from '@tmex/shared';
export type AgentWriteMode = 'confirm' | 'auto';
export type AgentSessionStatus = 'idle' | 'running' | 'waiting_confirmation' | 'stopped' | 'error';
export type AgentMessageRole = 'system' | 'user' | 'assistant' | 'tool';
export type AgentConfirmationStatus = 'pending' | 'approved' | 'denied' | 'cancelled';
export type WatchTriggerType = 'match' | 'unchanged' | 'llm';
export type WatchNoMatchBehavior = 'reset' | 'ignore';
export type WatchFireMode = 'once' | 'repeat';

export const siteSettings = sqliteTable(
  'site_settings',
  {
    id: integer('id').primaryKey(),
    siteName: text('site_name').notNull(),
    siteUrl: text('site_url').notNull(),
    bellThrottleSeconds: integer('bell_throttle_seconds').notNull(),
    notificationThrottleSeconds: integer('notification_throttle_seconds').notNull().default(3),
    enableBrowserBellToast: integer('enable_browser_bell_toast', { mode: 'boolean' })
      .notNull()
      .default(true),
    enableBrowserNotificationToast: integer('enable_browser_notification_toast', {
      mode: 'boolean',
    })
      .notNull()
      .default(true),
    enableTelegramBellPush: integer('enable_telegram_bell_push', { mode: 'boolean' })
      .notNull()
      .default(true),
    enableTelegramNotificationPush: integer('enable_telegram_notification_push', {
      mode: 'boolean',
    })
      .notNull()
      .default(true),
    sshReconnectMaxRetries: integer('ssh_reconnect_max_retries').notNull(),
    sshReconnectDelaySeconds: integer('ssh_reconnect_delay_seconds').notNull(),
    language: text('language').notNull().default('en_US'),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [check('site_settings_singleton_check', sql`${table.id} = 1`)]
);

export const devices = sqliteTable(
  'devices',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    type: text('type').notNull(),
    host: text('host'),
    port: integer('port').default(22),
    username: text('username'),
    sshConfigRef: text('ssh_config_ref'),
    session: text('session').default('tmex'),
    authMode: text('auth_mode').notNull(),
    passwordEnc: text('password_enc'),
    privateKeyEnc: text('private_key_enc'),
    privateKeyPassphraseEnc: text('private_key_passphrase_enc'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    check('devices_type_check', sql`${table.type} in ('local', 'ssh')`),
    check(
      'devices_auth_mode_check',
      sql`${table.authMode} in ('password', 'key', 'agent', 'configRef', 'auto')`
    ),
  ]
);

export const deviceRuntimeStatus = sqliteTable('device_runtime_status', {
  deviceId: text('device_id')
    .primaryKey()
    .references(() => devices.id, { onDelete: 'cascade' }),
  lastSeenAt: text('last_seen_at'),
  tmuxAvailable: integer('tmux_available', { mode: 'boolean' }).notNull().default(false),
  lastError: text('last_error'),
  lastErrorType: text('last_error_type'),
});

export const webhookEndpoints = sqliteTable('webhook_endpoints', {
  id: text('id').primaryKey(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  url: text('url').notNull(),
  secret: text('secret').notNull(),
  eventMask: text('event_mask', { mode: 'json' }).$type<EventType[]>().notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const telegramBots = sqliteTable('telegram_bots', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  tokenEnc: text('token_enc').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  allowAuthRequests: integer('allow_auth_requests', { mode: 'boolean' }).notNull().default(true),
  lastUpdateId: integer('last_update_id'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const llmProviders = sqliteTable(
  'llm_providers',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    protocol: text('protocol').$type<LlmProviderProtocol>().notNull(),
    baseUrl: text('base_url').notNull(),
    apiKeyEnc: text('api_key_enc').notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    modelsCache: text('models_cache', { mode: 'json' }).$type<string[]>(),
    modelsFetchedAt: text('models_fetched_at'),
    // 用户手动添加的模型 id（不会被刷新覆盖）
    manualModels: text('manual_models', { mode: 'json' }).$type<string[]>().notNull().default([]),
    // 被用户禁用的模型 id（来自 modelsCache 或 manualModels），从可选列表中剔除
    disabledModels: text('disabled_models', { mode: 'json' })
      .$type<string[]>()
      .notNull()
      .default([]),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    check(
      'llm_providers_protocol_check',
      sql`${table.protocol} in ('openai-chat', 'openai-responses')`
    ),
  ]
);

export const agentSettings = sqliteTable(
  'agent_settings',
  {
    id: integer('id').primaryKey(),
    searchProvider: text('search_provider').$type<AgentSearchProvider>().notNull().default('none'),
    tavilyApiKeyEnc: text('tavily_api_key_enc'),
    braveApiKeyEnc: text('brave_api_key_enc'),
    defaultProviderId: text('default_provider_id').references(() => llmProviders.id, {
      onDelete: 'set null',
    }),
    defaultModelId: text('default_model_id'),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    check('agent_settings_singleton_check', sql`${table.id} = 1`),
    check(
      'agent_settings_search_provider_check',
      sql`${table.searchProvider} in ('none', 'tavily', 'brave')`
    ),
  ]
);

export const agentSessions = sqliteTable(
  'agent_sessions',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    deviceId: text('device_id').references(() => devices.id, { onDelete: 'set null' }),
    paneId: text('pane_id'),
    providerId: text('provider_id').references(() => llmProviders.id, { onDelete: 'set null' }),
    modelId: text('model_id').notNull(),
    systemPrompt: text('system_prompt'),
    writeMode: text('write_mode').$type<AgentWriteMode>().notNull().default('confirm'),
    useProviderWebSearch: integer('use_provider_web_search', { mode: 'boolean' })
      .notNull()
      .default(false),
    // 启用的 provider 原生 hosted 工具 key 列表（如 image_generation；仅 openai-responses 生效）
    providerHostedTools: text('provider_hosted_tools', { mode: 'json' })
      .$type<string[]>()
      .notNull()
      .default([]),
    // 起源元数据：创建会话时绑定 pane 的终端标题与进程名（旧记录为 null，前端不显示）
    originPaneTitle: text('origin_pane_title'),
    originProcessName: text('origin_process_name'),
    status: text('status').$type<AgentSessionStatus>().notNull().default('idle'),
    lastError: text('last_error'),
    maxStepsPerTurn: integer('max_steps_per_turn').notNull().default(25),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    check('agent_sessions_write_mode_check', sql`${table.writeMode} in ('confirm', 'auto')`),
    check(
      'agent_sessions_status_check',
      sql`${table.status} in ('idle', 'running', 'waiting_confirmation', 'stopped', 'error')`
    ),
  ]
);

export const agentMessages = sqliteTable(
  'agent_messages',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => agentSessions.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    role: text('role').$type<AgentMessageRole>().notNull(),
    content: text('content', { mode: 'json' }).$type<unknown>().notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [unique('agent_messages_session_seq_unique').on(table.sessionId, table.seq)]
);

// 运行中排队的用户消息（step 边界注入 / 手动 steer）；可编辑/撤回；落库保证多端同步 + 重启不丢
export const agentQueuedMessages = sqliteTable('agent_queued_messages', {
  id: text('id').primaryKey(),
  sessionId: text('session_id')
    .notNull()
    .references(() => agentSessions.id, { onDelete: 'cascade' }),
  seq: integer('seq').notNull(),
  text: text('text').notNull(),
  createdAt: text('created_at').notNull(),
});

export const agentConfirmations = sqliteTable(
  'agent_confirmations',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => agentSessions.id, { onDelete: 'cascade' }),
    toolName: text('tool_name').notNull(),
    toolCallId: text('tool_call_id').notNull(),
    inputJson: text('input_json', { mode: 'json' }).$type<unknown>().notNull(),
    status: text('status').$type<AgentConfirmationStatus>().notNull().default('pending'),
    reason: text('reason'),
    decidedAt: text('decided_at'),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    check(
      'agent_confirmations_status_check',
      sql`${table.status} in ('pending', 'approved', 'denied', 'cancelled')`
    ),
  ]
);

export const watchRules = sqliteTable(
  'watch_rules',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    deviceId: text('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    paneId: text('pane_id').notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    triggerType: text('trigger_type').$type<WatchTriggerType>().notNull(),
    pattern: text('pattern'),
    patternFlags: text('pattern_flags').notNull().default(''),
    extractGroup: integer('extract_group').notNull().default(0),
    conditionPrompt: text('condition_prompt'),
    providerId: text('provider_id').references(() => llmProviders.id, { onDelete: 'set null' }),
    modelId: text('model_id'),
    confirmWithLlm: integer('confirm_with_llm', { mode: 'boolean' }).notNull().default(false),
    summarizeWithLlm: integer('summarize_with_llm', { mode: 'boolean' }).notNull().default(false),
    intervalSeconds: integer('interval_seconds').notNull().default(30),
    unchangedMinutes: integer('unchanged_minutes'),
    noMatchBehavior: text('no_match_behavior')
      .$type<WatchNoMatchBehavior>()
      .notNull()
      .default('reset'),
    fireMode: text('fire_mode').$type<WatchFireMode>().notNull().default('once'),
    cooldownSeconds: integer('cooldown_seconds').notNull().default(600),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    check(
      'watch_rules_trigger_type_check',
      sql`${table.triggerType} in ('match', 'unchanged', 'llm')`
    ),
    check(
      'watch_rules_no_match_behavior_check',
      sql`${table.noMatchBehavior} in ('reset', 'ignore')`
    ),
    check('watch_rules_fire_mode_check', sql`${table.fireMode} in ('once', 'repeat')`),
  ]
);

export const watchRuleState = sqliteTable('watch_rule_state', {
  ruleId: text('rule_id')
    .primaryKey()
    .references(() => watchRules.id, { onDelete: 'cascade' }),
  lastSampledAt: text('last_sampled_at'),
  lastValue: text('last_value'),
  lastValueChangedAt: text('last_value_changed_at'),
  triggeredSinceChange: integer('triggered_since_change', { mode: 'boolean' })
    .notNull()
    .default(false),
  lastTriggeredAt: text('last_triggered_at'),
  consecutiveErrors: integer('consecutive_errors').notNull().default(0),
  lastError: text('last_error'),
  modelUnavailableNotified: integer('model_unavailable_notified', { mode: 'boolean' })
    .notNull()
    .default(false),
});

export const telegramBotChats = sqliteTable(
  'telegram_bot_chats',
  {
    id: text('id').primaryKey(),
    botId: text('bot_id')
      .notNull()
      .references(() => telegramBots.id, { onDelete: 'cascade' }),
    chatId: text('chat_id').notNull(),
    chatType: text('chat_type').notNull(),
    displayName: text('display_name').notNull(),
    status: text('status').notNull(),
    appliedAt: text('applied_at').notNull(),
    authorizedAt: text('authorized_at'),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    unique('telegram_bot_chats_bot_chat_unique').on(table.botId, table.chatId),
    check('telegram_bot_chats_status_check', sql`${table.status} in ('pending', 'authorized')`),
    check(
      'telegram_bot_chats_chat_type_check',
      sql`${table.chatType} in ('private', 'group', 'supergroup', 'channel', 'unknown')`
    ),
  ]
);
