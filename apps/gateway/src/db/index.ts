import type { Database } from 'bun:sqlite';
import {
  DEFAULT_LOCALE,
  DEFAULT_TERMINAL_SHORTCUTS,
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
  type TerminalShortcutItem,
  type TerminalShortcutSettings,
  type WebhookEndpoint,
  type WeixinAccountConfig,
  type WeixinAccountUser,
  type WeixinAccountWithStats,
  type WeixinUserStatus,
} from '@tmex/shared';
import { and, asc, count, desc, eq, max } from 'drizzle-orm';
import { config } from '../config';
import { i18next } from '../i18n';
import { getDb as getOrmDb, getSqliteClient } from './client';
import {
  deviceRuntimeStatus,
  deviceTreeOrder,
  devices,
  siteSettings,
  telegramBotChats,
  telegramBots,
  terminalShortcutSettings,
  webhookEndpoints,
  weixinAccountUsers,
  weixinAccounts,
} from './schema';

export interface DeviceTreeOrderRecord {
  deviceId: string;
  windows: string[];
  panes: Record<string, string[]>;
}

export interface TelegramBotConfigRecord extends TelegramBotConfig {
  tokenEnc: string;
  lastUpdateId: number | null;
}

export interface WeixinAccountConfigRecord extends WeixinAccountConfig {
  weixinUin: string | null;
  botTokenEnc: string | null;
  baseUrl: string | null;
  syncBuf: string | null;
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
    defaultWorkingDir: optional(row.defaultWorkingDir),
    sortOrder: row.sortOrder,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toSiteSettings(row: typeof siteSettings.$inferSelect): SiteSettings {
  return {
    siteName: row.siteName,
    siteUrl: row.siteUrl,
    bellThrottleSeconds: row.bellThrottleSeconds,
    notificationThrottleSeconds: row.notificationThrottleSeconds,
    enableBrowserBellToast: row.enableBrowserBellToast,
    enableBrowserNotificationToast: row.enableBrowserNotificationToast,
    enableTelegramBellPush: row.enableTelegramBellPush,
    enableTelegramNotificationPush: row.enableTelegramNotificationPush,
    enableWeixinBellPush: row.enableWeixinBellPush,
    enableWeixinNotificationPush: row.enableWeixinNotificationPush,
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

function toWeixinAccountRecord(row: typeof weixinAccounts.$inferSelect): WeixinAccountConfigRecord {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    allowAuthRequests: row.allowAuthRequests,
    loggedIn: row.botTokenEnc != null,
    weixinUin: row.weixinUin ?? null,
    botTokenEnc: row.botTokenEnc ?? null,
    baseUrl: row.baseUrl ?? null,
    syncBuf: row.syncBuf ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toWeixinAccountUser(row: typeof weixinAccountUsers.$inferSelect): WeixinAccountUser {
  return {
    id: row.id,
    accountId: row.accountId,
    userId: row.userId,
    displayName: row.displayName,
    status: row.status as WeixinUserStatus,
    needsReactivation: row.needsReactivation,
    lastInboundAt: row.lastInboundAt ?? null,
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
      notificationThrottleSeconds: config.notificationThrottleSecondsDefault,
      enableBrowserBellToast: true,
      enableBrowserNotificationToast: true,
      enableTelegramBellPush: true,
      enableTelegramNotificationPush: true,
      enableWeixinBellPush: false,
      enableWeixinNotificationPush: false,
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
    // 新设备排到末尾：sort_order = 当前最大值 + 1
    const maxRow = tx
      .select({ value: max(devices.sortOrder) })
      .from(devices)
      .get();
    const nextSortOrder = (maxRow?.value ?? -1) + 1;

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
        defaultWorkingDir: device.defaultWorkingDir ?? null,
        sortOrder: nextSortOrder,
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
        lastErrorType: null,
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
  // 统一排序源：先按自定义 sort_order，迁移后全 0 时按 created_at 兜底稳定排序
  return orm
    .select()
    .from(devices)
    .orderBy(asc(devices.sortOrder), desc(devices.createdAt))
    .all()
    .map(toDevice);
}

// 按给定的全量有序 id 列表重排设备：单事务按下标写 sort_order
export function reorderDevices(orderedIds: string[]): void {
  const orm = getOrmDb();
  const now = new Date().toISOString();
  orm.transaction((tx) => {
    orderedIds.forEach((id, index) => {
      tx.update(devices).set({ sortOrder: index, updatedAt: now }).where(eq(devices.id, id)).run();
    });
  });
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
  if (updates.defaultWorkingDir !== undefined) {
    setValues.defaultWorkingDir = updates.defaultWorkingDir || null;
  }

  orm.update(devices).set(setValues).where(eq(devices.id, id)).run();
}

export function deleteDevice(id: string): void {
  const orm = getOrmDb();
  orm.delete(devices).where(eq(devices.id, id)).run();
}

export function getDeviceTreeOrder(deviceId: string): DeviceTreeOrderRecord {
  const orm = getOrmDb();
  const row = orm
    .select()
    .from(deviceTreeOrder)
    .where(eq(deviceTreeOrder.deviceId, deviceId))
    .get();

  if (!row) {
    return { deviceId, windows: [], panes: {} };
  }

  return {
    deviceId: row.deviceId,
    windows: Array.isArray(row.windows) ? row.windows : [],
    panes: row.panes && typeof row.panes === 'object' ? row.panes : {},
  };
}

export function setWindowOrder(deviceId: string, windowIds: string[]): void {
  const orm = getOrmDb();
  const now = new Date().toISOString();
  orm
    .insert(deviceTreeOrder)
    .values({ deviceId, windows: windowIds, panes: {}, updatedAt: now })
    .onConflictDoUpdate({
      target: deviceTreeOrder.deviceId,
      set: { windows: windowIds, updatedAt: now },
    })
    .run();
}

export function setPaneOrder(deviceId: string, windowId: string, paneIds: string[]): void {
  const current = getDeviceTreeOrder(deviceId);
  const nextPanes = { ...current.panes, [windowId]: paneIds };
  const orm = getOrmDb();
  const now = new Date().toISOString();
  orm
    .insert(deviceTreeOrder)
    .values({ deviceId, windows: current.windows, panes: nextPanes, updatedAt: now })
    .onConflictDoUpdate({
      target: deviceTreeOrder.deviceId,
      set: { panes: nextPanes, updatedAt: now },
    })
    .run();
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
      lastErrorType: null,
    };
  }

  return {
    deviceId: row.deviceId,
    lastSeenAt: row.lastSeenAt,
    tmuxAvailable: row.tmuxAvailable,
    lastError: row.lastError,
    lastErrorType: row.lastErrorType,
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
  if (status.lastErrorType !== undefined) {
    setValues.lastErrorType = status.lastErrorType;
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
    notificationThrottleSeconds:
      updates.notificationThrottleSeconds ?? current.notificationThrottleSeconds,
    enableBrowserBellToast: updates.enableBrowserBellToast ?? current.enableBrowserBellToast,
    enableBrowserNotificationToast:
      updates.enableBrowserNotificationToast ?? current.enableBrowserNotificationToast,
    enableTelegramBellPush: updates.enableTelegramBellPush ?? current.enableTelegramBellPush,
    enableTelegramNotificationPush:
      updates.enableTelegramNotificationPush ?? current.enableTelegramNotificationPush,
    enableWeixinBellPush: updates.enableWeixinBellPush ?? current.enableWeixinBellPush,
    enableWeixinNotificationPush:
      updates.enableWeixinNotificationPush ?? current.enableWeixinNotificationPush,
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
      notificationThrottleSeconds: next.notificationThrottleSeconds,
      enableBrowserBellToast: next.enableBrowserBellToast,
      enableBrowserNotificationToast: next.enableBrowserNotificationToast,
      enableTelegramBellPush: next.enableTelegramBellPush,
      enableTelegramNotificationPush: next.enableTelegramNotificationPush,
      enableWeixinBellPush: next.enableWeixinBellPush,
      enableWeixinNotificationPush: next.enableWeixinNotificationPush,
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

function toTerminalShortcutSettings(
  row: typeof terminalShortcutSettings.$inferSelect
): TerminalShortcutSettings {
  return {
    items: Array.isArray(row.items) ? row.items : DEFAULT_TERMINAL_SHORTCUTS,
    useIcons: row.useIcons,
    updatedAt: row.updatedAt,
  };
}

export function ensureTerminalShortcutSettingsInitialized(): void {
  const orm = getOrmDb();
  orm
    .insert(terminalShortcutSettings)
    .values({
      id: 1,
      items: DEFAULT_TERMINAL_SHORTCUTS,
      useIcons: false,
      updatedAt: new Date().toISOString(),
    })
    .onConflictDoNothing({ target: terminalShortcutSettings.id })
    .run();
}

export function getTerminalShortcutSettings(): TerminalShortcutSettings {
  const orm = getOrmDb();
  let row = orm
    .select()
    .from(terminalShortcutSettings)
    .where(eq(terminalShortcutSettings.id, 1))
    .get();

  if (!row) {
    ensureTerminalShortcutSettingsInitialized();
    row = orm
      .select()
      .from(terminalShortcutSettings)
      .where(eq(terminalShortcutSettings.id, 1))
      .get();
  }

  if (!row) {
    throw new Error('terminal_shortcut_settings not initialized');
  }

  return toTerminalShortcutSettings(row);
}

export function updateTerminalShortcutSettings(updates: {
  items: TerminalShortcutItem[];
  useIcons: boolean;
}): TerminalShortcutSettings {
  ensureTerminalShortcutSettingsInitialized();
  const next: TerminalShortcutSettings = {
    items: updates.items,
    useIcons: updates.useIcons,
    updatedAt: new Date().toISOString(),
  };

  const orm = getOrmDb();
  orm
    .update(terminalShortcutSettings)
    .set({
      items: next.items,
      useIcons: next.useIcons,
      updatedAt: next.updatedAt,
    })
    .where(eq(terminalShortcutSettings.id, 1))
    .run();

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

// ==================== 微信 (iLink) ====================

const WEIXIN_USER_CAP = 16;

export function createWeixinAccount(record: WeixinAccountConfigRecord): void {
  const orm = getOrmDb();
  orm
    .insert(weixinAccounts)
    .values({
      id: record.id,
      name: record.name,
      enabled: record.enabled,
      allowAuthRequests: record.allowAuthRequests,
      weixinUin: record.weixinUin,
      botTokenEnc: record.botTokenEnc,
      baseUrl: record.baseUrl,
      syncBuf: record.syncBuf,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    })
    .run();
}

export function getWeixinAccountById(accountId: string): WeixinAccountConfigRecord | null {
  const orm = getOrmDb();
  const row = orm.select().from(weixinAccounts).where(eq(weixinAccounts.id, accountId)).get();
  if (!row) {
    return null;
  }
  return toWeixinAccountRecord(row);
}

export function getAllWeixinAccounts(): WeixinAccountConfigRecord[] {
  const orm = getOrmDb();
  return orm
    .select()
    .from(weixinAccounts)
    .orderBy(desc(weixinAccounts.createdAt))
    .all()
    .map(toWeixinAccountRecord);
}

export function getWeixinAccountsWithStats(): WeixinAccountWithStats[] {
  const orm = getOrmDb();
  const accounts = orm.select().from(weixinAccounts).orderBy(desc(weixinAccounts.createdAt)).all();

  const counters = new Map<
    string,
    { pending: number; authorized: number; needsReactivation: number }
  >();
  const userRows = orm
    .select({
      accountId: weixinAccountUsers.accountId,
      status: weixinAccountUsers.status,
      needsReactivation: weixinAccountUsers.needsReactivation,
    })
    .from(weixinAccountUsers)
    .all();

  for (const row of userRows) {
    const current = counters.get(row.accountId) ?? {
      pending: 0,
      authorized: 0,
      needsReactivation: 0,
    };
    if (row.status === 'pending') {
      current.pending += 1;
    }
    if (row.status === 'authorized') {
      current.authorized += 1;
      if (row.needsReactivation) {
        current.needsReactivation += 1;
      }
    }
    counters.set(row.accountId, current);
  }

  return accounts.map((account) => {
    const counter = counters.get(account.id) ?? {
      pending: 0,
      authorized: 0,
      needsReactivation: 0,
    };
    return {
      id: account.id,
      name: account.name,
      enabled: account.enabled,
      allowAuthRequests: account.allowAuthRequests,
      loggedIn: account.botTokenEnc != null,
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
      pendingCount: counter.pending,
      authorizedCount: counter.authorized,
      needsReactivationCount: counter.needsReactivation,
    };
  });
}

export function updateWeixinAccount(
  accountId: string,
  updates: Partial<
    Pick<
      WeixinAccountConfigRecord,
      'name' | 'enabled' | 'allowAuthRequests' | 'weixinUin' | 'botTokenEnc' | 'baseUrl' | 'syncBuf'
    >
  >
): WeixinAccountConfigRecord | null {
  const orm = getOrmDb();
  const setValues: Partial<typeof weixinAccounts.$inferInsert> = {
    updatedAt: new Date().toISOString(),
  };

  if (updates.name !== undefined) {
    setValues.name = updates.name;
  }
  if (updates.enabled !== undefined) {
    setValues.enabled = updates.enabled;
  }
  if (updates.allowAuthRequests !== undefined) {
    setValues.allowAuthRequests = updates.allowAuthRequests;
  }
  if (updates.weixinUin !== undefined) {
    setValues.weixinUin = updates.weixinUin;
  }
  if (updates.botTokenEnc !== undefined) {
    setValues.botTokenEnc = updates.botTokenEnc;
  }
  if (updates.baseUrl !== undefined) {
    setValues.baseUrl = updates.baseUrl;
  }
  if (updates.syncBuf !== undefined) {
    setValues.syncBuf = updates.syncBuf;
  }

  orm.update(weixinAccounts).set(setValues).where(eq(weixinAccounts.id, accountId)).run();
  return getWeixinAccountById(accountId);
}

export function deleteWeixinAccount(accountId: string): void {
  const orm = getOrmDb();
  orm.delete(weixinAccounts).where(eq(weixinAccounts.id, accountId)).run();
}

function getWeixinUserCount(accountId: string): number {
  const orm = getOrmDb();
  const row = orm
    .select({ total: count() })
    .from(weixinAccountUsers)
    .where(eq(weixinAccountUsers.accountId, accountId))
    .get();

  return Number(row?.total ?? 0);
}

export function getWeixinUserByAccountAndUserId(
  accountId: string,
  userId: string
): WeixinAccountUser | null {
  const orm = getOrmDb();
  const row = orm
    .select()
    .from(weixinAccountUsers)
    .where(and(eq(weixinAccountUsers.accountId, accountId), eq(weixinAccountUsers.userId, userId)))
    .get();

  if (!row) {
    return null;
  }

  return toWeixinAccountUser(row);
}

/** 收到 inbound 消息时落库：已存在则刷新会话（缓存 context_token、清除 needsReactivation）；
 * 新用户在 allowAuthRequests 时建 pending 行，否则忽略（返回 null）。 */
export function upsertWeixinUserOnInbound(params: {
  accountId: string;
  userId: string;
  displayName: string;
  contextToken: string | null;
  allowAuthRequests: boolean;
  at: string;
}): WeixinAccountUser | null {
  const existing = getWeixinUserByAccountAndUserId(params.accountId, params.userId);
  const orm = getOrmDb();

  if (existing) {
    const setValues: Partial<typeof weixinAccountUsers.$inferInsert> = {
      displayName: params.displayName,
      lastInboundAt: params.at,
      needsReactivation: false,
      updatedAt: params.at,
    };
    if (params.contextToken != null) {
      setValues.lastContextToken = params.contextToken;
    }
    orm
      .update(weixinAccountUsers)
      .set(setValues)
      .where(eq(weixinAccountUsers.id, existing.id))
      .run();
    return getWeixinUserByAccountAndUserId(params.accountId, params.userId);
  }

  if (!params.allowAuthRequests) {
    return null;
  }
  if (getWeixinUserCount(params.accountId) >= WEIXIN_USER_CAP) {
    throw new Error(i18next.t('apiError.invalidRequest'));
  }

  orm
    .insert(weixinAccountUsers)
    .values({
      id: crypto.randomUUID(),
      accountId: params.accountId,
      userId: params.userId,
      displayName: params.displayName,
      status: 'pending',
      lastContextToken: params.contextToken,
      lastInboundAt: params.at,
      needsReactivation: false,
      appliedAt: params.at,
      authorizedAt: null,
      updatedAt: params.at,
    })
    .run();

  return getWeixinUserByAccountAndUserId(params.accountId, params.userId);
}

export function listWeixinUsersByAccount(accountId: string): WeixinAccountUser[] {
  const orm = getOrmDb();
  return orm
    .select()
    .from(weixinAccountUsers)
    .where(eq(weixinAccountUsers.accountId, accountId))
    .orderBy(desc(weixinAccountUsers.appliedAt))
    .all()
    .map(toWeixinAccountUser);
}

export function listAuthorizedWeixinUsersByAccount(accountId: string): WeixinAccountUser[] {
  const orm = getOrmDb();
  return orm
    .select()
    .from(weixinAccountUsers)
    .where(
      and(eq(weixinAccountUsers.accountId, accountId), eq(weixinAccountUsers.status, 'authorized'))
    )
    .orderBy(desc(weixinAccountUsers.authorizedAt))
    .all()
    .map(toWeixinAccountUser);
}

/** 注水 WeixinClient 的 context_token 缓存：返回该账号下持有缓存 token 的所有用户。 */
export function getWeixinUserContextTokens(
  accountId: string
): Array<{ userId: string; contextToken: string }> {
  const orm = getOrmDb();
  return orm
    .select({
      userId: weixinAccountUsers.userId,
      contextToken: weixinAccountUsers.lastContextToken,
    })
    .from(weixinAccountUsers)
    .where(eq(weixinAccountUsers.accountId, accountId))
    .all()
    .filter((row): row is { userId: string; contextToken: string } => row.contextToken != null);
}

export function approveWeixinUser(accountId: string, userId: string): WeixinAccountUser | null {
  const existing = getWeixinUserByAccountAndUserId(accountId, userId);
  if (!existing) {
    return null;
  }

  const now = new Date().toISOString();
  const orm = getOrmDb();
  orm
    .update(weixinAccountUsers)
    .set({
      status: 'authorized',
      authorizedAt: now,
      updatedAt: now,
    })
    .where(eq(weixinAccountUsers.id, existing.id))
    .run();

  return getWeixinUserByAccountAndUserId(accountId, userId);
}

export function deleteWeixinUser(accountId: string, userId: string): void {
  const orm = getOrmDb();
  orm
    .delete(weixinAccountUsers)
    .where(and(eq(weixinAccountUsers.accountId, accountId), eq(weixinAccountUsers.userId, userId)))
    .run();
}

/** 标记/清除「会话过期、需重新激活」（发送失败置 true，inbound 恢复置 false）。 */
export function setWeixinUserNeedsReactivation(
  accountId: string,
  userId: string,
  value: boolean
): void {
  const orm = getOrmDb();
  orm
    .update(weixinAccountUsers)
    .set({ needsReactivation: value, updatedAt: new Date().toISOString() })
    .where(and(eq(weixinAccountUsers.accountId, accountId), eq(weixinAccountUsers.userId, userId)))
    .run();
}
