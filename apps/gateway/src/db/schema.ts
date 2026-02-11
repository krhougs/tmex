import type { EventType } from '@tmex/shared';
import { sql } from 'drizzle-orm';
import { check, integer, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core';

export const siteSettings = sqliteTable(
  'site_settings',
  {
    id: integer('id').primaryKey(),
    siteName: text('site_name').notNull(),
    siteUrl: text('site_url').notNull(),
    bellThrottleSeconds: integer('bell_throttle_seconds').notNull(),
    sshReconnectMaxRetries: integer('ssh_reconnect_max_retries').notNull(),
    sshReconnectDelaySeconds: integer('ssh_reconnect_delay_seconds').notNull(),
    language: text('language').notNull().default('en_US'),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    check('site_settings_singleton_check', sql`${table.id} = 1`),
    check('site_settings_language_check', sql`${table.language} in ('en_US', 'zh_CN')`),
  ]
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
    check('devices_auth_mode_check', sql`${table.authMode} in ('password', 'key', 'agent', 'configRef', 'auto')`),
  ]
);

export const deviceRuntimeStatus = sqliteTable('device_runtime_status', {
  deviceId: text('device_id')
    .primaryKey()
    .references(() => devices.id, { onDelete: 'cascade' }),
  lastSeenAt: text('last_seen_at'),
  tmuxAvailable: integer('tmux_available', { mode: 'boolean' }).notNull().default(false),
  lastError: text('last_error'),
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
