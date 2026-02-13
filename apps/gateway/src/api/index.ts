import type {
  CreateDeviceRequest,
  CreateTelegramBotRequest,
  Device,
  LocaleCode,
  SiteSettings,
  TelegramBotChat,
  TelegramBotConfig,
  UpdateDeviceRequest,
  UpdateSiteSettingsRequest,
  UpdateTelegramBotRequest,
  WebhookEndpoint,
} from '@tmex/shared';
import { toBCP47 } from '@tmex/shared';
import type { Server } from 'bun';
import { v4 as uuidv4 } from 'uuid';
import { runtimeController } from '../control/runtime';
import { decrypt, encrypt } from '../crypto';
import {
  approveTelegramChat,
  createDevice,
  createTelegramBot,
  createWebhookEndpoint,
  deleteDevice,
  deleteTelegramBot,
  deleteTelegramChat,
  deleteWebhookEndpoint,
  getAllDevices,
  getAllWebhookEndpoints,
  getDeviceById,
  getSiteSettings,
  getTelegramBotById,
  getTelegramBotsWithStats,
  listTelegramChatsByBot,
  updateDevice,
  updateSiteSettings,
  updateTelegramBot,
} from '../db';
import { t } from '../i18n';
import { pushSupervisor } from '../push/supervisor';
import { telegramService } from '../telegram/service';

function shouldReconnectPushSupervisor(existing: Device, updates: Partial<Device>): boolean {
  if (updates.type !== undefined && updates.type !== existing.type) return true;
  if (updates.host !== undefined && updates.host !== existing.host) return true;
  if (updates.port !== undefined && updates.port !== existing.port) return true;
  if (updates.username !== undefined && updates.username !== existing.username) return true;
  if (updates.sshConfigRef !== undefined && updates.sshConfigRef !== existing.sshConfigRef)
    return true;
  if (updates.session !== undefined && updates.session !== existing.session) return true;
  if (updates.authMode !== undefined && updates.authMode !== existing.authMode) return true;
  if (updates.passwordEnc !== undefined) return true;
  if (updates.privateKeyEnc !== undefined) return true;
  if (updates.privateKeyPassphraseEnc !== undefined) return true;

  return false;
}

function normalizeSiteSettingsInput(
  body: UpdateSiteSettingsRequest
): Partial<Omit<SiteSettings, 'updatedAt'>> {
  const updates: Partial<Omit<SiteSettings, 'updatedAt'>> = {};

  if (body.siteName !== undefined) {
    const value = body.siteName.trim();
    if (!value) throw new Error(t('apiError.siteNameRequired'));
    updates.siteName = value;
  }

  if (body.siteUrl !== undefined) {
    const value = body.siteUrl.trim();
    if (!/^https?:\/\//i.test(value)) {
      throw new Error(t('apiError.siteUrlInvalid'));
    }
    updates.siteUrl = value;
  }

  if (body.bellThrottleSeconds !== undefined) {
    const value = Math.floor(Number(body.bellThrottleSeconds));
    if (Number.isNaN(value) || value < 0 || value > 300) {
      throw new Error(t('apiError.bellThrottleInvalid'));
    }
    updates.bellThrottleSeconds = value;
  }

  if (body.enableBrowserBellToast !== undefined) {
    if (typeof body.enableBrowserBellToast !== 'boolean') {
      throw new Error(t('apiError.invalidRequest'));
    }
    updates.enableBrowserBellToast = body.enableBrowserBellToast;
  }

  if (body.enableTelegramBellPush !== undefined) {
    if (typeof body.enableTelegramBellPush !== 'boolean') {
      throw new Error(t('apiError.invalidRequest'));
    }
    updates.enableTelegramBellPush = body.enableTelegramBellPush;
  }

  if (body.sshReconnectMaxRetries !== undefined) {
    const value = Math.floor(Number(body.sshReconnectMaxRetries));
    if (Number.isNaN(value) || value < 0 || value > 20) {
      throw new Error(t('apiError.sshRetriesInvalid'));
    }
    updates.sshReconnectMaxRetries = value;
  }

  if (body.sshReconnectDelaySeconds !== undefined) {
    const value = Math.floor(Number(body.sshReconnectDelaySeconds));
    if (Number.isNaN(value) || value < 1 || value > 300) {
      throw new Error(t('apiError.sshDelayInvalid'));
    }
    updates.sshReconnectDelaySeconds = value;
  }

  if (body.language !== undefined) {
    const value = body.language.trim();
    if (value !== 'en_US' && value !== 'zh_CN') {
      throw new Error(t('apiError.languageInvalid'));
    }
    updates.language = value as LocaleCode;
  }

  return updates;
}

export function handleApiRequest(
  req: Request,
  _server: Server<unknown>
): Response | Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  if (path === '/api/devices' && req.method === 'GET') {
    return handleGetDevices();
  }
  if (path === '/api/devices' && req.method === 'POST') {
    return handleCreateDevice(req);
  }
  if (path.match(/^\/api\/devices\/[^/]+$/) && req.method === 'GET') {
    return handleGetDevice(path.split('/')[3]);
  }
  if (path.match(/^\/api\/devices\/[^/]+$/) && req.method === 'PATCH') {
    return handleUpdateDevice(req, path.split('/')[3]);
  }
  if (path.match(/^\/api\/devices\/[^/]+$/) && req.method === 'DELETE') {
    return handleDeleteDevice(path.split('/')[3]);
  }
  if (path.match(/^\/api\/devices\/[^/]+\/test-connection$/) && req.method === 'POST') {
    return handleTestConnection(path.split('/')[3]);
  }

  if (path === '/api/settings/site' && req.method === 'GET') {
    return handleGetSiteSettings();
  }
  if (path === '/api/settings/site' && req.method === 'PATCH') {
    return handleUpdateSiteSettings(req);
  }
  if (path === '/api/settings/restart' && req.method === 'POST') {
    return handleRestartGateway();
  }

  if (path === '/api/settings/telegram/bots' && req.method === 'GET') {
    return handleGetTelegramBots();
  }
  if (path === '/api/settings/telegram/bots' && req.method === 'POST') {
    return handleCreateTelegramBot(req);
  }
  if (path.match(/^\/api\/settings\/telegram\/bots\/[^/]+$/) && req.method === 'PATCH') {
    return handleUpdateTelegramBot(req, path.split('/')[5]);
  }
  if (path.match(/^\/api\/settings\/telegram\/bots\/[^/]+$/) && req.method === 'DELETE') {
    return handleDeleteTelegramBot(path.split('/')[5]);
  }
  if (path.match(/^\/api\/settings\/telegram\/bots\/[^/]+\/chats$/) && req.method === 'GET') {
    return handleListTelegramChats(path.split('/')[5]);
  }
  if (
    path.match(/^\/api\/settings\/telegram\/bots\/[^/]+\/chats\/[^/]+\/approve$/) &&
    req.method === 'POST'
  ) {
    return handleApproveTelegramChat(path.split('/')[5], decodeURIComponent(path.split('/')[7]));
  }
  if (
    path.match(/^\/api\/settings\/telegram\/bots\/[^/]+\/chats\/[^/]+\/test$/) &&
    req.method === 'POST'
  ) {
    return handleTestTelegramChat(path.split('/')[5], decodeURIComponent(path.split('/')[7]));
  }
  if (
    path.match(/^\/api\/settings\/telegram\/bots\/[^/]+\/chats\/[^/]+$/) &&
    req.method === 'DELETE'
  ) {
    return handleDeleteTelegramChat(path.split('/')[5], decodeURIComponent(path.split('/')[7]));
  }

  if (path === '/api/webhooks' && req.method === 'GET') {
    return handleGetWebhooks();
  }
  if (path === '/api/webhooks' && req.method === 'POST') {
    return handleCreateWebhook(req);
  }
  if (path.match(/^\/api\/webhooks\/[^/]+$/) && req.method === 'DELETE') {
    return handleDeleteWebhook(path.split('/')[3]);
  }

  if (path === '/api/manifest.webmanifest' && (req.method === 'GET' || req.method === 'HEAD')) {
    return handleGetManifest(req.method);
  }

  if (path === '/healthz' && req.method === 'GET') {
    return json({ status: 'ok', restarting: runtimeController.isRestarting() });
  }

  return json({ error: t('apiError.notFound') }, 404);
}

async function handleGetDevices(): Promise<Response> {
  const devices = getAllDevices();
  return json({ devices });
}

async function handleGetDevice(id: string): Promise<Response> {
  const device = getDeviceById(id);
  if (!device) {
    return json({ error: t('apiError.deviceNotFound') }, 404);
  }
  return json({ device });
}

async function handleCreateDevice(req: Request): Promise<Response> {
  const body = (await req.json()) as CreateDeviceRequest;

  if (!body.name || !body.type || !body.authMode) {
    return json({ error: t('apiError.missingFields') }, 400);
  }

  if (body.type === 'ssh' && !body.host && !body.sshConfigRef) {
    return json({ error: t('apiError.sshRequiresHost') }, 400);
  }

  const now = new Date().toISOString();
  const device: Device = {
    id: uuidv4(),
    name: body.name,
    type: body.type,
    host: body.host,
    port: body.port ?? 22,
    username: body.username,
    sshConfigRef: body.sshConfigRef,
    session: body.session ?? 'tmex',
    authMode: body.authMode,
    passwordEnc: body.password ? await encrypt(body.password) : undefined,
    privateKeyEnc: body.privateKey ? await encrypt(body.privateKey) : undefined,
    privateKeyPassphraseEnc: body.privateKeyPassphrase
      ? await encrypt(body.privateKeyPassphrase)
      : undefined,
    createdAt: now,
    updatedAt: now,
  };

  createDevice(device);
  await pushSupervisor.upsert(device.id);

  return json({ device }, 201);
}

async function handleUpdateDevice(req: Request, id: string): Promise<Response> {
  const existing = getDeviceById(id);
  if (!existing) {
    return json({ error: t('apiError.deviceNotFound') }, 404);
  }

  const body = (await req.json()) as UpdateDeviceRequest;
  const updates: Partial<Device> = {};

  if (body.name !== undefined) updates.name = body.name;
  if (body.host !== undefined) updates.host = body.host;
  if (body.port !== undefined) updates.port = body.port;
  if (body.username !== undefined) updates.username = body.username;
  if (body.sshConfigRef !== undefined) updates.sshConfigRef = body.sshConfigRef;
  if (body.session !== undefined) updates.session = body.session;
  if (body.authMode !== undefined) updates.authMode = body.authMode;
  if (body.password !== undefined) updates.passwordEnc = await encrypt(body.password);
  if (body.privateKey !== undefined) updates.privateKeyEnc = await encrypt(body.privateKey);
  if (body.privateKeyPassphrase !== undefined) {
    updates.privateKeyPassphraseEnc = await encrypt(body.privateKeyPassphrase);
  }

  updateDevice(id, updates);

  if (shouldReconnectPushSupervisor(existing, updates)) {
    await pushSupervisor.reconnect(id);
  }

  const device = getDeviceById(id);
  return json({ device });
}

async function handleDeleteDevice(id: string): Promise<Response> {
  const existing = getDeviceById(id);
  if (!existing) {
    return json({ error: t('apiError.deviceNotFound') }, 404);
  }

  deleteDevice(id);
  pushSupervisor.remove(id);
  return json({ success: true });
}

async function handleTestConnection(id: string): Promise<Response> {
  const device = getDeviceById(id);
  if (!device) {
    return json({ error: t('apiError.deviceNotFound') }, 404);
  }

  return json({
    success: true,
    tmuxAvailable: false,
    message: 'Connection test not fully implemented yet',
  });
}

async function handleGetSiteSettings(): Promise<Response> {
  return json({ settings: getSiteSettings() });
}

async function handleUpdateSiteSettings(req: Request): Promise<Response> {
  try {
    const body = (await req.json()) as UpdateSiteSettingsRequest;
    const updates = normalizeSiteSettingsInput(body);
    const settings = updateSiteSettings(updates);

    return json({ settings });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : t('apiError.invalidRequest') }, 400);
  }
}

async function handleRestartGateway(): Promise<Response> {
  setTimeout(() => {
    void runtimeController.requestRestart();
  }, 50);

  return json({
    success: true,
    message: t('settings.restartScheduled'),
  });
}

async function handleGetTelegramBots(): Promise<Response> {
  const bots = getTelegramBotsWithStats();
  return json({ bots });
}

async function handleCreateTelegramBot(req: Request): Promise<Response> {
  const body = (await req.json()) as CreateTelegramBotRequest;

  if (!body.name?.trim()) {
    return json({ error: t('apiError.botNameRequired') }, 400);
  }
  if (!body.token?.trim()) {
    return json({ error: t('apiError.botTokenRequired') }, 400);
  }

  const now = new Date().toISOString();
  createTelegramBot({
    id: uuidv4(),
    name: body.name.trim(),
    tokenEnc: await encrypt(body.token.trim()),
    enabled: body.enabled ?? true,
    allowAuthRequests: body.allowAuthRequests ?? true,
    lastUpdateId: null,
    createdAt: now,
    updatedAt: now,
  });

  await telegramService.refresh();

  return json({ success: true }, 201);
}

async function handleUpdateTelegramBot(req: Request, botId: string): Promise<Response> {
  const existing = getTelegramBotById(botId);
  if (!existing) {
    return json({ error: t('apiError.botNotFound') }, 404);
  }

  const body = (await req.json()) as UpdateTelegramBotRequest;
  const updates: Partial<{
    name: string;
    tokenEnc: string;
    enabled: boolean;
    allowAuthRequests: boolean;
  }> = {};

  if (body.name !== undefined) {
    const value = body.name.trim();
    if (!value) {
      return json({ error: t('apiError.botNameRequired') }, 400);
    }
    updates.name = value;
  }

  if (body.token !== undefined) {
    const token = body.token.trim();
    if (!token) {
      return json({ error: t('apiError.botTokenRequired') }, 400);
    }
    updates.tokenEnc = await encrypt(token);
  }

  if (body.enabled !== undefined) {
    updates.enabled = body.enabled;
  }

  if (body.allowAuthRequests !== undefined) {
    updates.allowAuthRequests = body.allowAuthRequests;
  }

  updateTelegramBot(botId, updates);
  await telegramService.refresh();

  return json({ success: true });
}

async function handleDeleteTelegramBot(botId: string): Promise<Response> {
  const existing = getTelegramBotById(botId);
  if (!existing) {
    return json({ error: t('apiError.botNotFound') }, 404);
  }

  deleteTelegramBot(botId);
  await telegramService.refresh();

  return json({ success: true });
}

async function handleListTelegramChats(botId: string): Promise<Response> {
  const existing = getTelegramBotById(botId);
  if (!existing) {
    return json({ error: t('apiError.botNotFound') }, 404);
  }

  const chats = listTelegramChatsByBot(botId);
  return json({ chats });
}

async function handleApproveTelegramChat(botId: string, chatId: string): Promise<Response> {
  const existing = getTelegramBotById(botId);
  if (!existing) {
    return json({ error: t('apiError.botNotFound') }, 404);
  }

  const chat = approveTelegramChat(botId, chatId);
  if (!chat) {
    return json({ error: t('apiError.chatNotFound') }, 404);
  }

  const settings = getSiteSettings();
  await telegramService.sendTestMessage(
    botId,
    chatId,
    t('telegram.approveMessageTemplate', {
      botName: existing.name,
      time: new Date().toLocaleString(toBCP47(settings.language)),
    })
  );

  return json({ chat });
}

async function handleDeleteTelegramChat(botId: string, chatId: string): Promise<Response> {
  const existing = getTelegramBotById(botId);
  if (!existing) {
    return json({ error: t('apiError.botNotFound') }, 404);
  }

  deleteTelegramChat(botId, chatId);
  return json({ success: true });
}

async function handleTestTelegramChat(botId: string, chatId: string): Promise<Response> {
  const bot = getTelegramBotById(botId);
  if (!bot) {
    return json({ error: t('apiError.botNotFound') }, 404);
  }

  const settings = getSiteSettings();

  await telegramService.sendTestMessage(
    botId,
    chatId,
    t('telegram.testMessageTemplate', {
      siteName: settings.siteName,
      time: new Date().toLocaleString(toBCP47(settings.language)),
    })
  );

  return json({ success: true });
}

async function handleGetWebhooks(): Promise<Response> {
  const webhooks = getAllWebhookEndpoints();
  return json({ webhooks });
}

async function handleCreateWebhook(req: Request): Promise<Response> {
  const body = await req.json();

  if (!body.url || !body.secret) {
    return json({ error: t('apiError.urlAndSecretRequired') }, 400);
  }

  const now = new Date().toISOString();
  const endpoint: WebhookEndpoint = {
    id: uuidv4(),
    enabled: body.enabled ?? true,
    url: body.url,
    secret: body.secret,
    eventMask: body.eventMask ?? [],
    createdAt: now,
    updatedAt: now,
  };

  createWebhookEndpoint(endpoint);

  return json({ webhook: endpoint }, 201);
}

async function handleDeleteWebhook(id: string): Promise<Response> {
  deleteWebhookEndpoint(id);
  return json({ success: true });
}

async function handleGetManifest(method: 'GET' | 'HEAD'): Promise<Response> {
  const settings = getSiteSettings();

  const manifest = {
    id: '/',
    name: settings.siteName,
    short_name: settings.siteName,
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#0b1020',
    theme_color: '#0b1020',
    icons: [
      {
        src: '/tmex.png',
        sizes: '768x768',
        type: 'image/png',
        purpose: 'any maskable',
      },
    ],
  };

  return manifestJson(manifest, method);
}

function manifestJson(data: unknown, method: 'GET' | 'HEAD'): Response {
  return new Response(method === 'HEAD' ? null : JSON.stringify(data), {
    status: 200,
    headers: {
      'Content-Type': 'application/manifest+json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
  });
}
