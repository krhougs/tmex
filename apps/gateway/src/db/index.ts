import { Database } from 'bun:sqlite';
import type {
  Device,
  DeviceRuntimeStatus,
  EventType,
  SiteSettings,
  TelegramBotChat,
  TelegramBotConfig,
  TelegramBotWithStats,
  TelegramChatStatus,
  TelegramChatType,
  WebhookEndpoint,
} from '@tmex/shared';
import { config } from '../config';

type SqlValue = string | number | bigint | boolean | Uint8Array | null;

let db: Database | null = null;

export function getDb(): Database {
  if (!db) {
    db = new Database(config.databaseUrl);
    db.run('PRAGMA foreign_keys = ON');
  }
  return db;
}

export function initSchema(): void {
  const database = getDb();

  database.run('DROP TABLE IF EXISTS admin');
  database.run('DROP TABLE IF EXISTS telegram_subscriptions');

  database.run(`
    CREATE TABLE IF NOT EXISTS site_settings (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      site_name TEXT NOT NULL,
      site_url TEXT NOT NULL,
      bell_throttle_seconds INTEGER NOT NULL,
      ssh_reconnect_max_retries INTEGER NOT NULL,
      ssh_reconnect_delay_seconds INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  database.run(`
    INSERT INTO site_settings (
      id,
      site_name,
      site_url,
      bell_throttle_seconds,
      ssh_reconnect_max_retries,
      ssh_reconnect_delay_seconds,
      updated_at
    )
    VALUES (1, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `, [
    config.siteNameDefault,
    config.baseUrl,
    config.bellThrottleSecondsDefault,
    config.sshReconnectMaxRetriesDefault,
    config.sshReconnectDelaySecondsDefault,
    new Date().toISOString(),
  ]);

  database.run(`
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('local', 'ssh')),
      host TEXT,
      port INTEGER DEFAULT 22,
      username TEXT,
      ssh_config_ref TEXT,
      session TEXT DEFAULT 'tmex',
      auth_mode TEXT NOT NULL CHECK(auth_mode IN ('password', 'key', 'agent', 'configRef', 'auto')),
      password_enc TEXT,
      private_key_enc TEXT,
      private_key_passphrase_enc TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  const deviceTableInfo = database.prepare('PRAGMA table_info(devices)').all() as Array<{ name: string }>;
  const deviceColumns = new Set(deviceTableInfo.map((col) => col.name));
  if (!deviceColumns.has('session')) {
    database.run("ALTER TABLE devices ADD COLUMN session TEXT DEFAULT 'tmex'");
  }

  database.run(`
    CREATE TABLE IF NOT EXISTS device_runtime_status (
      device_id TEXT PRIMARY KEY,
      last_seen_at TEXT,
      tmux_available INTEGER DEFAULT 0,
      last_error TEXT,
      FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
    )
  `);

  database.run(`
    CREATE TABLE IF NOT EXISTS webhook_endpoints (
      id TEXT PRIMARY KEY,
      enabled INTEGER DEFAULT 1,
      url TEXT NOT NULL,
      secret TEXT NOT NULL,
      event_mask TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  database.run(`
    CREATE TABLE IF NOT EXISTS telegram_bots (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      token_enc TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      allow_auth_requests INTEGER NOT NULL DEFAULT 1,
      last_update_id INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  database.run(`
    CREATE TABLE IF NOT EXISTS telegram_bot_chats (
      id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      chat_type TEXT NOT NULL,
      display_name TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending', 'authorized')),
      applied_at TEXT NOT NULL,
      authorized_at TEXT,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (bot_id) REFERENCES telegram_bots(id) ON DELETE CASCADE,
      UNIQUE(bot_id, chat_id)
    )
  `);

  console.log('Database schema initialized');
}

// ==================== Device CRUD ====================

export function createDevice(device: Device): void {
  const database = getDb();
  const stmt = database.prepare(`
    INSERT INTO devices (id, name, type, host, port, username, ssh_config_ref, session, auth_mode,
      password_enc, private_key_enc, private_key_passphrase_enc, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    device.id,
    device.name,
    device.type,
    device.host ?? null,
    device.port ?? 22,
    device.username ?? null,
    device.sshConfigRef ?? null,
    device.session ?? 'tmex',
    device.authMode,
    device.passwordEnc ?? null,
    device.privateKeyEnc ?? null,
    device.privateKeyPassphraseEnc ?? null,
    device.createdAt,
    device.updatedAt
  );

  const statusStmt = database.prepare(`
    INSERT INTO device_runtime_status (device_id, last_seen_at, tmux_available, last_error)
    VALUES (?, NULL, 0, NULL)
  `);
  statusStmt.run(device.id);
}

export function getDeviceById(id: string): Device | null {
  const database = getDb();
  const stmt = database.prepare('SELECT * FROM devices WHERE id = ?');
  const row = stmt.get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  return rowToDevice(row);
}

export function getAllDevices(): Device[] {
  const database = getDb();
  const stmt = database.prepare('SELECT * FROM devices ORDER BY created_at DESC');
  const rows = stmt.all() as Record<string, unknown>[];
  return rows.map(rowToDevice);
}

export function updateDevice(id: string, updates: Partial<Device>): void {
  const database = getDb();
  const fields: string[] = [];
  const values: SqlValue[] = [];

  if (updates.name !== undefined) {
    fields.push('name = ?');
    values.push(updates.name);
  }
  if (updates.host !== undefined) {
    fields.push('host = ?');
    values.push(updates.host);
  }
  if (updates.port !== undefined) {
    fields.push('port = ?');
    values.push(updates.port);
  }
  if (updates.username !== undefined) {
    fields.push('username = ?');
    values.push(updates.username);
  }
  if (updates.sshConfigRef !== undefined) {
    fields.push('ssh_config_ref = ?');
    values.push(updates.sshConfigRef);
  }
  if (updates.session !== undefined) {
    fields.push('session = ?');
    values.push(updates.session);
  }
  if (updates.authMode !== undefined) {
    fields.push('auth_mode = ?');
    values.push(updates.authMode);
  }
  if (updates.passwordEnc !== undefined) {
    fields.push('password_enc = ?');
    values.push(updates.passwordEnc);
  }
  if (updates.privateKeyEnc !== undefined) {
    fields.push('private_key_enc = ?');
    values.push(updates.privateKeyEnc);
  }
  if (updates.privateKeyPassphraseEnc !== undefined) {
    fields.push('private_key_passphrase_enc = ?');
    values.push(updates.privateKeyPassphraseEnc);
  }

  fields.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(id);

  const stmt = database.prepare(`UPDATE devices SET ${fields.join(', ')} WHERE id = ?`);
  stmt.run(...values);
}

export function deleteDevice(id: string): void {
  const database = getDb();
  const stmt = database.prepare('DELETE FROM devices WHERE id = ?');
  stmt.run(id);
}

// ==================== Device Runtime Status ====================

export function getDeviceRuntimeStatus(deviceId: string): DeviceRuntimeStatus | null {
  const database = getDb();
  const stmt = database.prepare('SELECT * FROM device_runtime_status WHERE device_id = ?');
  const row = stmt.get(deviceId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    deviceId: row.device_id as string,
    lastSeenAt: row.last_seen_at as string | null,
    tmuxAvailable: Boolean(row.tmux_available),
    lastError: row.last_error as string | null,
  };
}

export function updateDeviceRuntimeStatus(
  deviceId: string,
  status: Partial<DeviceRuntimeStatus>
): void {
  const database = getDb();
  const fields: string[] = [];
  const values: SqlValue[] = [];

  if (status.lastSeenAt !== undefined) {
    fields.push('last_seen_at = ?');
    values.push(status.lastSeenAt);
  }
  if (status.tmuxAvailable !== undefined) {
    fields.push('tmux_available = ?');
    values.push(status.tmuxAvailable ? 1 : 0);
  }
  if (status.lastError !== undefined) {
    fields.push('last_error = ?');
    values.push(status.lastError);
  }

  if (fields.length === 0) return;

  values.push(deviceId);
  const stmt = database.prepare(
    `UPDATE device_runtime_status SET ${fields.join(', ')} WHERE device_id = ?`
  );
  stmt.run(...values);
}

// ==================== Site Settings ====================

export function getSiteSettings(): SiteSettings {
  const database = getDb();
  const row = database
    .prepare('SELECT * FROM site_settings WHERE id = 1')
    .get() as Record<string, unknown> | undefined;

  if (!row) {
    throw new Error('site_settings not initialized');
  }

  return {
    siteName: row.site_name as string,
    siteUrl: row.site_url as string,
    bellThrottleSeconds: row.bell_throttle_seconds as number,
    sshReconnectMaxRetries: row.ssh_reconnect_max_retries as number,
    sshReconnectDelaySeconds: row.ssh_reconnect_delay_seconds as number,
    updatedAt: row.updated_at as string,
  };
}

export function updateSiteSettings(updates: Partial<Omit<SiteSettings, 'updatedAt'>>): SiteSettings {
  const current = getSiteSettings();
  const next: SiteSettings = {
    siteName: updates.siteName ?? current.siteName,
    siteUrl: updates.siteUrl ?? current.siteUrl,
    bellThrottleSeconds: updates.bellThrottleSeconds ?? current.bellThrottleSeconds,
    sshReconnectMaxRetries: updates.sshReconnectMaxRetries ?? current.sshReconnectMaxRetries,
    sshReconnectDelaySeconds: updates.sshReconnectDelaySeconds ?? current.sshReconnectDelaySeconds,
    updatedAt: new Date().toISOString(),
  };

  const database = getDb();
  database.run(
    `
      UPDATE site_settings
      SET site_name = ?,
          site_url = ?,
          bell_throttle_seconds = ?,
          ssh_reconnect_max_retries = ?,
          ssh_reconnect_delay_seconds = ?,
          updated_at = ?
      WHERE id = 1
    `,
    [
      next.siteName,
      next.siteUrl,
      next.bellThrottleSeconds,
      next.sshReconnectMaxRetries,
      next.sshReconnectDelaySeconds,
      next.updatedAt,
    ]
  );

  return next;
}

// ==================== Webhook ====================

export function createWebhookEndpoint(endpoint: WebhookEndpoint): void {
  const database = getDb();
  const stmt = database.prepare(`
    INSERT INTO webhook_endpoints (id, enabled, url, secret, event_mask, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    endpoint.id,
    endpoint.enabled ? 1 : 0,
    endpoint.url,
    endpoint.secret,
    JSON.stringify(endpoint.eventMask),
    endpoint.createdAt,
    endpoint.updatedAt
  );
}

export function getAllWebhookEndpoints(): WebhookEndpoint[] {
  const database = getDb();
  const stmt = database.prepare('SELECT * FROM webhook_endpoints ORDER BY created_at DESC');
  const rows = stmt.all() as Record<string, unknown>[];
  return rows.map((row) => ({
    id: row.id as string,
    enabled: Boolean(row.enabled),
    url: row.url as string,
    secret: row.secret as string,
    eventMask: JSON.parse(row.event_mask as string),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  }));
}

export function deleteWebhookEndpoint(id: string): void {
  const database = getDb();
  const stmt = database.prepare('DELETE FROM webhook_endpoints WHERE id = ?');
  stmt.run(id);
}

// ==================== Telegram Bots ====================

export interface TelegramBotConfigRecord extends TelegramBotConfig {
  tokenEnc: string;
  lastUpdateId: number | null;
}

export function createTelegramBot(configRecord: TelegramBotConfigRecord): void {
  const database = getDb();
  database.run(
    `
      INSERT INTO telegram_bots (
        id,
        name,
        token_enc,
        enabled,
        allow_auth_requests,
        last_update_id,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      configRecord.id,
      configRecord.name,
      configRecord.tokenEnc,
      configRecord.enabled ? 1 : 0,
      configRecord.allowAuthRequests ? 1 : 0,
      configRecord.lastUpdateId,
      configRecord.createdAt,
      configRecord.updatedAt,
    ]
  );
}

export function getTelegramBotById(botId: string): TelegramBotConfigRecord | null {
  const database = getDb();
  const row = database
    .prepare('SELECT * FROM telegram_bots WHERE id = ?')
    .get(botId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return rowToTelegramBot(row);
}

export function getAllTelegramBots(): TelegramBotConfigRecord[] {
  const database = getDb();
  const rows = database
    .prepare('SELECT * FROM telegram_bots ORDER BY created_at DESC')
    .all() as Record<string, unknown>[];
  return rows.map(rowToTelegramBot);
}

export function getTelegramBotsWithStats(): TelegramBotWithStats[] {
  const database = getDb();
  const rows = database
    .prepare(
      `
        SELECT
          b.*,
          SUM(CASE WHEN c.status = 'pending' THEN 1 ELSE 0 END) AS pending_count,
          SUM(CASE WHEN c.status = 'authorized' THEN 1 ELSE 0 END) AS authorized_count
        FROM telegram_bots b
        LEFT JOIN telegram_bot_chats c ON c.bot_id = b.id
        GROUP BY b.id
        ORDER BY b.created_at DESC
      `
    )
    .all() as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    id: row.id as string,
    name: row.name as string,
    enabled: Boolean(row.enabled),
    allowAuthRequests: Boolean(row.allow_auth_requests),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    pendingCount: Number(row.pending_count ?? 0),
    authorizedCount: Number(row.authorized_count ?? 0),
  }));
}

export function updateTelegramBot(
  botId: string,
  updates: Partial<Pick<TelegramBotConfigRecord, 'name' | 'tokenEnc' | 'enabled' | 'allowAuthRequests' | 'lastUpdateId'>>
): TelegramBotConfigRecord | null {
  const fields: string[] = [];
  const values: SqlValue[] = [];

  if (updates.name !== undefined) {
    fields.push('name = ?');
    values.push(updates.name);
  }
  if (updates.tokenEnc !== undefined) {
    fields.push('token_enc = ?');
    values.push(updates.tokenEnc);
  }
  if (updates.enabled !== undefined) {
    fields.push('enabled = ?');
    values.push(updates.enabled ? 1 : 0);
  }
  if (updates.allowAuthRequests !== undefined) {
    fields.push('allow_auth_requests = ?');
    values.push(updates.allowAuthRequests ? 1 : 0);
  }
  if (updates.lastUpdateId !== undefined) {
    fields.push('last_update_id = ?');
    values.push(updates.lastUpdateId);
  }

  fields.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(botId);

  const database = getDb();
  database.prepare(`UPDATE telegram_bots SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  return getTelegramBotById(botId);
}

export function deleteTelegramBot(botId: string): void {
  const database = getDb();
  database.prepare('DELETE FROM telegram_bots WHERE id = ?').run(botId);
}

// ==================== Telegram Chats ====================

function getTelegramChatCount(botId: string): number {
  const database = getDb();
  const row = database
    .prepare('SELECT COUNT(*) AS total FROM telegram_bot_chats WHERE bot_id = ?')
    .get(botId) as { total: number };
  return Number(row.total ?? 0);
}

export function getTelegramChatByBotAndChatId(botId: string, chatId: string): TelegramBotChat | null {
  const database = getDb();
  const row = database
    .prepare('SELECT * FROM telegram_bot_chats WHERE bot_id = ? AND chat_id = ?')
    .get(botId, chatId) as Record<string, unknown> | undefined;
  if (!row) {
    return null;
  }
  return rowToTelegramChat(row);
}

export function createOrUpdatePendingTelegramChat(params: {
  botId: string;
  chatId: string;
  chatType: TelegramChatType;
  displayName: string;
  appliedAt: string;
}): TelegramBotChat {
  const existing = getTelegramChatByBotAndChatId(params.botId, params.chatId);
  if (!existing && getTelegramChatCount(params.botId) >= 8) {
    throw new Error('每个 bot 最多允许 8 个 chat（已授权 + 待授权）');
  }

  const now = new Date().toISOString();
  const database = getDb();

  if (!existing) {
    const id = crypto.randomUUID();
    database.run(
      `
        INSERT INTO telegram_bot_chats (
          id,
          bot_id,
          chat_id,
          chat_type,
          display_name,
          status,
          applied_at,
          authorized_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, 'pending', ?, NULL, ?)
      `,
      [id, params.botId, params.chatId, params.chatType, params.displayName, params.appliedAt, now]
    );
  } else if (existing.status === 'authorized') {
    database.run(
      `
        UPDATE telegram_bot_chats
        SET chat_type = ?, display_name = ?, updated_at = ?
        WHERE id = ?
      `,
      [params.chatType, params.displayName, now, existing.id]
    );
  } else {
    database.run(
      `
        UPDATE telegram_bot_chats
        SET chat_type = ?, display_name = ?, applied_at = ?, status = 'pending', updated_at = ?
        WHERE id = ?
      `,
      [params.chatType, params.displayName, params.appliedAt, now, existing.id]
    );
  }

  const next = getTelegramChatByBotAndChatId(params.botId, params.chatId);
  if (!next) {
    throw new Error('failed to upsert telegram chat');
  }
  return next;
}

export function listTelegramChatsByBot(botId: string): TelegramBotChat[] {
  const database = getDb();
  const rows = database
    .prepare('SELECT * FROM telegram_bot_chats WHERE bot_id = ? ORDER BY applied_at DESC')
    .all(botId) as Record<string, unknown>[];
  return rows.map(rowToTelegramChat);
}

export function listAuthorizedTelegramChatsByBot(botId: string): TelegramBotChat[] {
  const database = getDb();
  const rows = database
    .prepare(
      "SELECT * FROM telegram_bot_chats WHERE bot_id = ? AND status = 'authorized' ORDER BY authorized_at DESC"
    )
    .all(botId) as Record<string, unknown>[];
  return rows.map(rowToTelegramChat);
}

export function approveTelegramChat(botId: string, chatId: string): TelegramBotChat | null {
  const existing = getTelegramChatByBotAndChatId(botId, chatId);
  if (!existing) return null;

  const now = new Date().toISOString();
  const database = getDb();
  database.run(
    `
      UPDATE telegram_bot_chats
      SET status = 'authorized', authorized_at = ?, updated_at = ?
      WHERE id = ?
    `,
    [now, now, existing.id]
  );

  return getTelegramChatByBotAndChatId(botId, chatId);
}

export function deleteTelegramChat(botId: string, chatId: string): void {
  const database = getDb();
  database.prepare('DELETE FROM telegram_bot_chats WHERE bot_id = ? AND chat_id = ?').run(botId, chatId);
}

// ==================== Helpers ====================

function rowToDevice(row: Record<string, unknown>): Device {
  return {
    id: row.id as string,
    name: row.name as string,
    type: row.type as 'local' | 'ssh',
    host: row.host as string | undefined,
    port: row.port as number | undefined,
    username: row.username as string | undefined,
    sshConfigRef: row.ssh_config_ref as string | undefined,
    session: (row.session as string | undefined) ?? 'tmex',
    authMode: row.auth_mode as 'password' | 'key' | 'agent' | 'configRef' | 'auto',
    passwordEnc: row.password_enc as string | undefined,
    privateKeyEnc: row.private_key_enc as string | undefined,
    privateKeyPassphraseEnc: row.private_key_passphrase_enc as string | undefined,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function rowToTelegramBot(row: Record<string, unknown>): TelegramBotConfigRecord {
  return {
    id: row.id as string,
    name: row.name as string,
    tokenEnc: row.token_enc as string,
    enabled: Boolean(row.enabled),
    allowAuthRequests: Boolean(row.allow_auth_requests),
    lastUpdateId: (row.last_update_id as number | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function rowToTelegramChat(row: Record<string, unknown>): TelegramBotChat {
  return {
    id: row.id as string,
    botId: row.bot_id as string,
    chatId: row.chat_id as string,
    chatType: ((row.chat_type as string) || 'unknown') as TelegramChatType,
    displayName: row.display_name as string,
    status: row.status as TelegramChatStatus,
    appliedAt: row.applied_at as string,
    authorizedAt: (row.authorized_at as string | null) ?? null,
    updatedAt: row.updated_at as string,
  };
}
