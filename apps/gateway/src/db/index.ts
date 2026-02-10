import { Database } from 'bun:sqlite';
import type {
  Device,
  DeviceRuntimeStatus,
  TelegramSubscription,
  WebhookEndpoint,
} from '@tmex/shared';
import { config } from '../config';

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

  // 设备表
  database.run(`
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('local', 'ssh')),
      host TEXT,
      port INTEGER DEFAULT 22,
      username TEXT,
      ssh_config_ref TEXT,
      auth_mode TEXT NOT NULL CHECK(auth_mode IN ('password', 'key', 'agent', 'configRef', 'auto')),
      password_enc TEXT,
      private_key_enc TEXT,
      private_key_passphrase_enc TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  // 设备运行时状态表
  database.run(`
    CREATE TABLE IF NOT EXISTS device_runtime_status (
      device_id TEXT PRIMARY KEY,
      last_seen_at TEXT,
      tmux_available INTEGER DEFAULT 0,
      last_error TEXT,
      FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
    )
  `);

  // Webhook 端点表
  database.run(`
    CREATE TABLE IF NOT EXISTS webhook_endpoints (
      id TEXT PRIMARY KEY,
      enabled INTEGER DEFAULT 1,
      url TEXT NOT NULL,
      secret TEXT NOT NULL,
      event_mask TEXT NOT NULL, -- JSON array
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  // Telegram 订阅表
  database.run(`
    CREATE TABLE IF NOT EXISTS telegram_subscriptions (
      id TEXT PRIMARY KEY,
      enabled INTEGER DEFAULT 1,
      chat_id TEXT NOT NULL,
      event_mask TEXT NOT NULL, -- JSON array
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  // 管理员表（单用户）
  database.run(`
    CREATE TABLE IF NOT EXISTS admin (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      password_hash TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  console.log('Database schema initialized');
}

// ==================== Device CRUD ====================

export function createDevice(device: Device): void {
  const database = getDb();
  const stmt = database.prepare(`
    INSERT INTO devices (id, name, type, host, port, username, ssh_config_ref, auth_mode,
      password_enc, private_key_enc, private_key_passphrase_enc, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    device.id,
    device.name,
    device.type,
    device.host ?? null,
    device.port ?? 22,
    device.username ?? null,
    device.sshConfigRef ?? null,
    device.authMode,
    device.passwordEnc ?? null,
    device.privateKeyEnc ?? null,
    device.privateKeyPassphraseEnc ?? null,
    device.createdAt,
    device.updatedAt
  );

  // 初始化运行时状态
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
  const values: unknown[] = [];

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
  const values: unknown[] = [];

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

// ==================== Telegram ====================

export function createTelegramSubscription(sub: TelegramSubscription): void {
  const database = getDb();
  const stmt = database.prepare(`
    INSERT INTO telegram_subscriptions (id, enabled, chat_id, event_mask, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    sub.id,
    sub.enabled ? 1 : 0,
    sub.chatId,
    JSON.stringify(sub.eventMask),
    sub.createdAt,
    sub.updatedAt
  );
}

export function getAllTelegramSubscriptions(): TelegramSubscription[] {
  const database = getDb();
  const stmt = database.prepare('SELECT * FROM telegram_subscriptions ORDER BY created_at DESC');
  const rows = stmt.all() as Record<string, unknown>[];
  return rows.map((row) => ({
    id: row.id as string,
    enabled: Boolean(row.enabled),
    chatId: row.chat_id as string,
    eventMask: JSON.parse(row.event_mask as string),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  }));
}

export function deleteTelegramSubscription(id: string): void {
  const database = getDb();
  const stmt = database.prepare('DELETE FROM telegram_subscriptions WHERE id = ?');
  stmt.run(id);
}

// ==================== Admin ====================

export function getAdminPasswordHash(): string | null {
  const database = getDb();
  const stmt = database.prepare('SELECT password_hash FROM admin WHERE id = 1');
  const row = stmt.get() as { password_hash: string } | undefined;
  return row?.password_hash ?? null;
}

export function setAdminPasswordHash(hash: string): void {
  const database = getDb();
  const stmt = database.prepare(`
    INSERT INTO admin (id, password_hash, updated_at)
    VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      password_hash = excluded.password_hash,
      updated_at = excluded.updated_at
  `);
  stmt.run(hash, new Date().toISOString());
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
    authMode: row.auth_mode as 'password' | 'key' | 'agent' | 'configRef' | 'auto',
    passwordEnc: row.password_enc as string | undefined,
    privateKeyEnc: row.privateKeyEnc as string | undefined,
    privateKeyPassphraseEnc: row.private_key_passphrase_enc as string | undefined,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}
