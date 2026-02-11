import type { Database } from 'bun:sqlite';
import {
  DEFAULT_LOCALE,
  type Device,
  type DeviceRuntimeStatus,
  type EventType,
  type LocaleCode,
  type SiteSettings,
  type TelegramBotChat,
  type TelegramBotConfig,
  type TelegramBotWithStats,
  type TelegramChatStatus,
  type TelegramChatType,
  type WebhookEndpoint,
} from '@tmex/shared';
import { and, count, desc, eq } from 'drizzle-orm';
import { config } from '../config';
import { i18next } from '../i18n';
import { getDb as getOrmDb, getSqliteClient } from './client';
import {
  deviceRuntimeStatus,
  devices,
  siteSettings,
  telegramBotChats,
  telegramBots,
  webhookEndpoints,
} from './schema';

export interface TelegramBotConfigRecord extends TelegramBotConfig {
  tokenEnc: string;
  lastUpdateId: number | null;
}

function optional<T>(value: T | null | undefined): T | undefined {
  return value ?? undefined;
}

function normalizeLocale(value: string | null | undefined): LocaleCode {
  return value === 'zh_CN' ? 'zh_CN' : DEFAULT_LOCALE;
}

function toDevice(row: typeof devices.$inferSelect): Device {
  return {
    id: row.id,
    name: row.name,
    type: row.type as Device['type'],
    host: optional(row.host),
    port: optional(row.port),
    username: optional(row.username),
    sshConfigRef: optional(row.sshConfigRef),
    session: row.session ?? 'tmex',
    authMode: row.authMode as Device['authMode'],
    passwordEnc: optional(row.passwordEnc),
    privateKeyEnc: optional(row.privateKeyEnc),
    privateKeyPassphraseEnc: optional(row.privateKeyPassphraseEnc),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toSiteSettings(row: typeof siteSettings.$inferSelect): SiteSettings {
  return {
    siteName: row.siteName,
    siteUrl: row.siteUrl,
    bellThrottleSeconds: row.bellThrottleSeconds,
    enableBrowserBellToast: row.enableBrowserBellToast,
    enableTelegramBellPush: row.enableTelegramBellPush,
    sshReconnectMaxRetries: row.sshReconnectMaxRetries,
    sshReconnectDelaySeconds: row.sshReconnectDelaySeconds,
    language: normalizeLocale(row.language),
    updatedAt: row.updatedAt,
  };
}

function toTelegramBotConfigRecord(row: typeof telegramBots.$inferSelect): TelegramBotConfigRecord {
  return {
    id: row.id,
    name: row.name,
    tokenEnc: row.tokenEnc,
    enabled: row.enabled,
    allowAuthRequests: row.allowAuthRequests,
    lastUpdateId: row.lastUpdateId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toTelegramChat(row: typeof telegramBotChats.$inferSelect): TelegramBotChat {
  return {
    id: row.id,
    botId: row.botId,
    chatId: row.chatId,
    chatType: (row.chatType || 'unknown') as TelegramChatType,
    displayName: row.displayName,
    status: row.status as TelegramChatStatus,
    appliedAt: row.appliedAt,
    authorizedAt: row.authorizedAt ?? null,
    updatedAt: row.updatedAt,
  };
}

function toWebhookEndpoint(row: typeof webhookEndpoints.$inferSelect): WebhookEndpoint {
  return {
    id: row.id,
    enabled: row.enabled,
    url: row.url,
    secret: row.secret,
    eventMask: Array.isArray(row.eventMask) ? (row.eventMask as EventType[]) : [],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function getDb(): Database {
  return getSqliteClient();
}

export function ensureSiteSettingsInitialized(): void {
  const orm = getOrmDb();
  const now = new Date().toISOString();

  orm
    .insert(siteSettings)
    .values({
      id: 1,
      siteName: config.siteNameDefault,
      siteUrl: config.baseUrl,
      bellThrottleSeconds: config.bellThrottleSecondsDefault,
      enableBrowserBellToast: true,
      enableTelegramBellPush: true,
      sshReconnectMaxRetries: config.sshReconnectMaxRetriesDefault,
      sshReconnectDelaySeconds: config.sshReconnectDelaySecondsDefault,
      language: normalizeLocale(config.languageDefault),
      updatedAt: now,
    })
    .onConflictDoNothing({ target: siteSettings.id })
    .run();
}

export function createDevice(device: Device): void {
  const orm = getOrmDb();

  orm.transaction((tx) => {
    tx.insert(devices)
      .values({
        id: device.id,
        name: device.name,
        type: device.type,
        host: device.host ?? null,
        port: device.port ?? 22,
        username: device.username ?? null,
        sshConfigRef: device.sshConfigRef ?? null,
        session: device.session ?? 'tmex',
        authMode: device.authMode,
        passwordEnc: device.passwordEnc ?? null,
        privateKeyEnc: device.privateKeyEnc ?? null,
        privateKeyPassphraseEnc: device.privateKeyPassphraseEnc ?? null,
        createdAt: device.createdAt,
        updatedAt: device.updatedAt,
      })
      .run();

    tx.insert(deviceRuntimeStatus)
      .values({
        deviceId: device.id,
        lastSeenAt: null,
        tmuxAvailable: false,
        lastError: null,
      })
      .onConflictDoNothing({ target: deviceRuntimeStatus.deviceId })
      .run();
  });
}

export function getDeviceById(id: string): Device | null {
  const orm = getOrmDb();
  const row = orm.select().from(devices).where(eq(devices.id, id)).get();
  if (!row) {
    return null;
  }
  return toDevice(row);
}

export function getAllDevices(): Device[] {
  const orm = getOrmDb();
  return orm.select().from(devices).orderBy(desc(devices.createdAt)).all().map(toDevice);
}

export function updateDevice(id: string, updates: Partial<Device>): void {
  const orm = getOrmDb();
  const setValues: Partial<typeof devices.$inferInsert> = {
    updatedAt: new Date().toISOString(),
  };

  if (updates.name !== undefined) {
    setValues.name = updates.name;
  }
  if (updates.host !== undefined) {
    setValues.host = updates.host;
  }
  if (updates.port !== undefined) {
    setValues.port = updates.port;
  }
  if (updates.username !== undefined) {
    setValues.username = updates.username;
  }
  if (updates.sshConfigRef !== undefined) {
    setValues.sshConfigRef = updates.sshConfigRef;
  }
  if (updates.session !== undefined) {
    setValues.session = updates.session;
  }
  if (updates.authMode !== undefined) {
    setValues.authMode = updates.authMode;
  }
  if (updates.passwordEnc !== undefined) {
    setValues.passwordEnc = updates.passwordEnc;
  }
  if (updates.privateKeyEnc !== undefined) {
    setValues.privateKeyEnc = updates.privateKeyEnc;
  }
  if (updates.privateKeyPassphraseEnc !== undefined) {
    setValues.privateKeyPassphraseEnc = updates.privateKeyPassphraseEnc;
  }

  orm.update(devices).set(setValues).where(eq(devices.id, id)).run();
}

export function deleteDevice(id: string): void {
  const orm = getOrmDb();
  orm.delete(devices).where(eq(devices.id, id)).run();
}

export function getDeviceRuntimeStatus(deviceId: string): DeviceRuntimeStatus {
  const orm = getOrmDb();
  const row = orm
    .select()
    .from(deviceRuntimeStatus)
    .where(eq(deviceRuntimeStatus.deviceId, deviceId))
    .get();

  if (!row) {
    return {
      deviceId,
      lastSeenAt: null,
      tmuxAvailable: false,
      lastError: null,
    };
  }

  return {
    deviceId: row.deviceId,
    lastSeenAt: row.lastSeenAt,
    tmuxAvailable: row.tmuxAvailable,
    lastError: row.lastError,
  };
}

export function updateDeviceRuntimeStatus(
  deviceId: string,
  status: Partial<DeviceRuntimeStatus>
): void {
  const orm = getOrmDb();
  const setValues: Partial<typeof deviceRuntimeStatus.$inferInsert> = {};

  if (status.lastSeenAt !== undefined) {
    setValues.lastSeenAt = status.lastSeenAt;
  }
  if (status.tmuxAvailable !== undefined) {
    setValues.tmuxAvailable = status.tmuxAvailable;
  }
  if (status.lastError !== undefined) {
    setValues.lastError = status.lastError;
  }

  if (Object.keys(setValues).length === 0) {
    return;
  }

  orm
    .update(deviceRuntimeStatus)
    .set(setValues)
    .where(eq(deviceRuntimeStatus.deviceId, deviceId))
    .run();
}

export function getSiteSettings(): SiteSettings {
  const orm = getOrmDb();
  let row = orm.select().from(siteSettings).where(eq(siteSettings.id, 1)).get();

  if (!row) {
    ensureSiteSettingsInitialized();
    row = orm.select().from(siteSettings).where(eq(siteSettings.id, 1)).get();
  }

  if (!row) {
    throw new Error('site_settings not initialized');
  }

  const settings = toSiteSettings(row);

  if (i18next.language !== settings.language) {
    void i18next.changeLanguage(settings.language);
  }

  return settings;
}

export function updateSiteSettings(
  updates: Partial<Omit<SiteSettings, 'updatedAt'>>
): SiteSettings {
  const current = getSiteSettings();
  const next: SiteSettings = {
    siteName: updates.siteName ?? current.siteName,
    siteUrl: updates.siteUrl ?? current.siteUrl,
    bellThrottleSeconds: updates.bellThrottleSeconds ?? current.bellThrottleSeconds,
    enableBrowserBellToast: updates.enableBrowserBellToast ?? current.enableBrowserBellToast,
    enableTelegramBellPush: updates.enableTelegramBellPush ?? current.enableTelegramBellPush,
    sshReconnectMaxRetries: updates.sshReconnectMaxRetries ?? current.sshReconnectMaxRetries,
    sshReconnectDelaySeconds: updates.sshReconnectDelaySeconds ?? current.sshReconnectDelaySeconds,
    language: updates.language ? normalizeLocale(updates.language) : current.language,
    updatedAt: new Date().toISOString(),
  };

  const orm = getOrmDb();
  orm
    .update(siteSettings)
    .set({
      siteName: next.siteName,
      siteUrl: next.siteUrl,
      bellThrottleSeconds: next.bellThrottleSeconds,
      enableBrowserBellToast: next.enableBrowserBellToast,
      enableTelegramBellPush: next.enableTelegramBellPush,
      sshReconnectMaxRetries: next.sshReconnectMaxRetries,
      sshReconnectDelaySeconds: next.sshReconnectDelaySeconds,
      language: next.language,
      updatedAt: next.updatedAt,
    })
    .where(eq(siteSettings.id, 1))
    .run();

  if (i18next.language !== next.language) {
    void i18next.changeLanguage(next.language);
  }

  return next;
}

export function createWebhookEndpoint(endpoint: WebhookEndpoint): void {
  const orm = getOrmDb();
  orm
    .insert(webhookEndpoints)
    .values({
      id: endpoint.id,
      enabled: endpoint.enabled,
      url: endpoint.url,
      secret: endpoint.secret,
      eventMask: endpoint.eventMask,
      createdAt: endpoint.createdAt,
      updatedAt: endpoint.updatedAt,
    })
    .run();
}

export function getAllWebhookEndpoints(): WebhookEndpoint[] {
  const orm = getOrmDb();
  return orm
    .select()
    .from(webhookEndpoints)
    .orderBy(desc(webhookEndpoints.createdAt))
    .all()
    .map(toWebhookEndpoint);
}

export function deleteWebhookEndpoint(id: string): void {
  const orm = getOrmDb();
  orm.delete(webhookEndpoints).where(eq(webhookEndpoints.id, id)).run();
}

export function createTelegramBot(configRecord: TelegramBotConfigRecord): void {
  const orm = getOrmDb();
  orm
    .insert(telegramBots)
    .values({
      id: configRecord.id,
      name: configRecord.name,
      tokenEnc: configRecord.tokenEnc,
      enabled: configRecord.enabled,
      allowAuthRequests: configRecord.allowAuthRequests,
      lastUpdateId: configRecord.lastUpdateId,
      createdAt: configRecord.createdAt,
      updatedAt: configRecord.updatedAt,
    })
    .run();
}

export function getTelegramBotById(botId: string): TelegramBotConfigRecord | null {
  const orm = getOrmDb();
  const row = orm.select().from(telegramBots).where(eq(telegramBots.id, botId)).get();
  if (!row) {
    return null;
  }
  return toTelegramBotConfigRecord(row);
}

export function getAllTelegramBots(): TelegramBotConfigRecord[] {
  const orm = getOrmDb();
  return orm
    .select()
    .from(telegramBots)
    .orderBy(desc(telegramBots.createdAt))
    .all()
    .map(toTelegramBotConfigRecord);
}

export function getTelegramBotsWithStats(): TelegramBotWithStats[] {
  const orm = getOrmDb();
  const bots = orm.select().from(telegramBots).orderBy(desc(telegramBots.createdAt)).all();

  const counters = new Map<string, { pending: number; authorized: number }>();
  const chatRows = orm
    .select({ botId: telegramBotChats.botId, status: telegramBotChats.status })
    .from(telegramBotChats)
    .all();

  for (const row of chatRows) {
    const current = counters.get(row.botId) ?? { pending: 0, authorized: 0 };
    if (row.status === 'pending') {
      current.pending += 1;
    }
    if (row.status === 'authorized') {
      current.authorized += 1;
    }
    counters.set(row.botId, current);
  }

  return bots.map((bot) => {
    const counter = counters.get(bot.id) ?? { pending: 0, authorized: 0 };
    return {
      id: bot.id,
      name: bot.name,
      enabled: bot.enabled,
      allowAuthRequests: bot.allowAuthRequests,
      createdAt: bot.createdAt,
      updatedAt: bot.updatedAt,
      pendingCount: counter.pending,
      authorizedCount: counter.authorized,
    };
  });
}

export function updateTelegramBot(
  botId: string,
  updates: Partial<
    Pick<
      TelegramBotConfigRecord,
      'name' | 'tokenEnc' | 'enabled' | 'allowAuthRequests' | 'lastUpdateId'
    >
  >
): TelegramBotConfigRecord | null {
  const orm = getOrmDb();
  const setValues: Partial<typeof telegramBots.$inferInsert> = {
    updatedAt: new Date().toISOString(),
  };

  if (updates.name !== undefined) {
    setValues.name = updates.name;
  }
  if (updates.tokenEnc !== undefined) {
    setValues.tokenEnc = updates.tokenEnc;
  }
  if (updates.enabled !== undefined) {
    setValues.enabled = updates.enabled;
  }
  if (updates.allowAuthRequests !== undefined) {
    setValues.allowAuthRequests = updates.allowAuthRequests;
  }
  if (updates.lastUpdateId !== undefined) {
    setValues.lastUpdateId = updates.lastUpdateId;
  }

  orm.update(telegramBots).set(setValues).where(eq(telegramBots.id, botId)).run();
  return getTelegramBotById(botId);
}

export function deleteTelegramBot(botId: string): void {
  const orm = getOrmDb();
  orm.delete(telegramBots).where(eq(telegramBots.id, botId)).run();
}

function getTelegramChatCount(botId: string): number {
  const orm = getOrmDb();
  const row = orm
    .select({ total: count() })
    .from(telegramBotChats)
    .where(eq(telegramBotChats.botId, botId))
    .get();

  return Number(row?.total ?? 0);
}

export function getTelegramChatByBotAndChatId(
  botId: string,
  chatId: string
): TelegramBotChat | null {
  const orm = getOrmDb();
  const row = orm
    .select()
    .from(telegramBotChats)
    .where(and(eq(telegramBotChats.botId, botId), eq(telegramBotChats.chatId, chatId)))
    .get();

  if (!row) {
    return null;
  }

  return toTelegramChat(row);
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
    throw new Error(i18next.t('apiError.invalidRequest'));
  }

  const now = new Date().toISOString();
  const orm = getOrmDb();

  if (!existing) {
    orm
      .insert(telegramBotChats)
      .values({
        id: crypto.randomUUID(),
        botId: params.botId,
        chatId: params.chatId,
        chatType: params.chatType,
        displayName: params.displayName,
        status: 'pending',
        appliedAt: params.appliedAt,
        authorizedAt: null,
        updatedAt: now,
      })
      .run();
  } else if (existing.status === 'authorized') {
    orm
      .update(telegramBotChats)
      .set({
        chatType: params.chatType,
        displayName: params.displayName,
        updatedAt: now,
      })
      .where(eq(telegramBotChats.id, existing.id))
      .run();
  } else {
    orm
      .update(telegramBotChats)
      .set({
        chatType: params.chatType,
        displayName: params.displayName,
        appliedAt: params.appliedAt,
        status: 'pending',
        updatedAt: now,
      })
      .where(eq(telegramBotChats.id, existing.id))
      .run();
  }

  const next = getTelegramChatByBotAndChatId(params.botId, params.chatId);
  if (!next) {
    throw new Error('failed to upsert telegram chat');
  }

  return next;
}

export function listTelegramChatsByBot(botId: string): TelegramBotChat[] {
  const orm = getOrmDb();
  return orm
    .select()
    .from(telegramBotChats)
    .where(eq(telegramBotChats.botId, botId))
    .orderBy(desc(telegramBotChats.appliedAt))
    .all()
    .map(toTelegramChat);
}

export function listAuthorizedTelegramChatsByBot(botId: string): TelegramBotChat[] {
  const orm = getOrmDb();
  return orm
    .select()
    .from(telegramBotChats)
    .where(and(eq(telegramBotChats.botId, botId), eq(telegramBotChats.status, 'authorized')))
    .orderBy(desc(telegramBotChats.authorizedAt))
    .all()
    .map(toTelegramChat);
}

export function approveTelegramChat(botId: string, chatId: string): TelegramBotChat | null {
  const existing = getTelegramChatByBotAndChatId(botId, chatId);
  if (!existing) {
    return null;
  }

  const now = new Date().toISOString();
  const orm = getOrmDb();
  orm
    .update(telegramBotChats)
    .set({
      status: 'authorized',
      authorizedAt: now,
      updatedAt: now,
    })
    .where(eq(telegramBotChats.id, existing.id))
    .run();

  return getTelegramChatByBotAndChatId(botId, chatId);
}

export function deleteTelegramChat(botId: string, chatId: string): void {
  const orm = getOrmDb();
  orm
    .delete(telegramBotChats)
    .where(and(eq(telegramBotChats.botId, botId), eq(telegramBotChats.chatId, chatId)))
    .run();
}
