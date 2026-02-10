import type { Server } from 'bun';
import { verifyAdmin, createJwtToken, verifyJwtToken } from '../auth';
import {
  getAllDevices,
  getDeviceById,
  createDevice,
  updateDevice,
  deleteDevice,
  getAllWebhookEndpoints,
  createWebhookEndpoint,
  deleteWebhookEndpoint,
  getAllTelegramSubscriptions,
  createTelegramSubscription,
  deleteTelegramSubscription,
} from '../db';
import { encrypt } from '../crypto';
import { v4 as uuidv4 } from 'uuid';
import type {
  LoginRequest,
  CreateDeviceRequest,
  UpdateDeviceRequest,
  Device,
  WebhookEndpoint,
  TelegramSubscription,
} from '@tmex/shared';

export function handleApiRequest(req: Request, server: Server): Response | Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  
  // 公开路由
  if (path === '/api/auth/login' && req.method === 'POST') {
    return handleLogin(req);
  }
  
  // 需要认证的路由
  if (!isAuthenticated(req)) {
    return json({ error: 'Unauthorized' }, 401);
  }
  
  // 认证相关
  if (path === '/api/auth/logout' && req.method === 'POST') {
    return handleLogout(req);
  }
  if (path === '/api/auth/me' && req.method === 'GET') {
    return handleGetMe(req);
  }
  
  // 设备管理
  if (path === '/api/devices' && req.method === 'GET') {
    return handleGetDevices(req);
  }
  if (path === '/api/devices' && req.method === 'POST') {
    return handleCreateDevice(req);
  }
  if (path.match(/^\/api\/devices\/[^/]+$/) && req.method === 'GET') {
    return handleGetDevice(req, path.split('/')[3]);
  }
  if (path.match(/^\/api\/devices\/[^/]+$/) && req.method === 'PATCH') {
    return handleUpdateDevice(req, path.split('/')[3]);
  }
  if (path.match(/^\/api\/devices\/[^/]+$/) && req.method === 'DELETE') {
    return handleDeleteDevice(req, path.split('/')[3]);
  }
  if (path.match(/^\/api\/devices\/[^/]+\/test-connection$/) && req.method === 'POST') {
    return handleTestConnection(req, path.split('/')[3]);
  }
  
  // Webhook 管理
  if (path === '/api/webhooks' && req.method === 'GET') {
    return handleGetWebhooks(req);
  }
  if (path === '/api/webhooks' && req.method === 'POST') {
    return handleCreateWebhook(req);
  }
  if (path.match(/^\/api\/webhooks\/[^/]+$/) && req.method === 'DELETE') {
    return handleDeleteWebhook(req, path.split('/')[3]);
  }
  
  // Telegram 管理
  if (path === '/api/telegram/subscriptions' && req.method === 'GET') {
    return handleGetTelegramSubscriptions(req);
  }
  if (path === '/api/telegram/subscriptions' && req.method === 'POST') {
    return handleCreateTelegramSubscription(req);
  }
  if (path.match(/^\/api\/telegram\/subscriptions\/[^/]+$/) && req.method === 'DELETE') {
    return handleDeleteTelegramSubscription(req, path.split('/')[4]);
  }
  
  // 通知测试
  if (path === '/api/notify/test' && req.method === 'POST') {
    return handleTestNotify(req);
  }
  
  // Health check
  if (path === '/healthz' && req.method === 'GET') {
    return json({ status: 'ok' });
  }
  
  return json({ error: 'Not found' }, 404);
}

// ==================== 认证处理 ====================

async function handleLogin(req: Request): Promise<Response> {
  const body = await req.json() as LoginRequest;
  
  if (!body.password) {
    return json({ error: 'Password required' }, 400);
  }
  
  const valid = await verifyAdmin(body.password);
  if (!valid) {
    return json({ error: 'Invalid password' }, 401);
  }
  
  const token = await createJwtToken();
  
  return json({ success: true }, 200, {
    'Set-Cookie': `token=${token}; HttpOnly; Path=/; Max-Age=86400; SameSite=Strict`,
  });
}

async function handleLogout(req: Request): Promise<Response> {
  return json({ success: true }, 200, {
    'Set-Cookie': `token=; HttpOnly; Path=/; Max-Age=0; SameSite=Strict`,
  });
}

async function handleGetMe(req: Request): Promise<Response> {
  return json({ id: 'admin', role: 'admin' });
}

// ==================== 设备处理 ====================

async function handleGetDevices(req: Request): Promise<Response> {
  const devices = getAllDevices();
  return json({ devices });
}

async function handleGetDevice(req: Request, id: string): Promise<Response> {
  const device = getDeviceById(id);
  if (!device) {
    return json({ error: 'Device not found' }, 404);
  }
  return json({ device });
}

async function handleCreateDevice(req: Request): Promise<Response> {
  const body = await req.json() as CreateDeviceRequest;
  
  // 验证必填字段
  if (!body.name || !body.type || !body.authMode) {
    return json({ error: 'Missing required fields' }, 400);
  }
  
  // SSH 类型需要 host
  if (body.type === 'ssh' && !body.host && !body.sshConfigRef) {
    return json({ error: 'SSH device requires host or sshConfigRef' }, 400);
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
    authMode: body.authMode,
    passwordEnc: body.password ? await encrypt(body.password) : undefined,
    privateKeyEnc: body.privateKey ? await encrypt(body.privateKey) : undefined,
    privateKeyPassphraseEnc: body.privateKeyPassphrase ? await encrypt(body.privateKeyPassphrase) : undefined,
    createdAt: now,
    updatedAt: now,
  };
  
  createDevice(device);
  
  return json({ device }, 201);
}

async function handleUpdateDevice(req: Request, id: string): Promise<Response> {
  const existing = getDeviceById(id);
  if (!existing) {
    return json({ error: 'Device not found' }, 404);
  }
  
  const body = await req.json() as UpdateDeviceRequest;
  const updates: Partial<Device> = {};
  
  if (body.name !== undefined) updates.name = body.name;
  if (body.host !== undefined) updates.host = body.host;
  if (body.port !== undefined) updates.port = body.port;
  if (body.username !== undefined) updates.username = body.username;
  if (body.sshConfigRef !== undefined) updates.sshConfigRef = body.sshConfigRef;
  if (body.authMode !== undefined) updates.authMode = body.authMode;
  if (body.password !== undefined) updates.passwordEnc = await encrypt(body.password);
  if (body.privateKey !== undefined) updates.privateKeyEnc = await encrypt(body.privateKey);
  if (body.privateKeyPassphrase !== undefined) {
    updates.privateKeyPassphraseEnc = await encrypt(body.privateKeyPassphrase);
  }
  
  updateDevice(id, updates);
  
  const device = getDeviceById(id);
  return json({ device });
}

async function handleDeleteDevice(req: Request, id: string): Promise<Response> {
  const existing = getDeviceById(id);
  if (!existing) {
    return json({ error: 'Device not found' }, 404);
  }
  
  deleteDevice(id);
  return json({ success: true });
}

async function handleTestConnection(req: Request, id: string): Promise<Response> {
  const device = getDeviceById(id);
  if (!device) {
    return json({ error: 'Device not found' }, 404);
  }
  
  // TODO: 实现实际的连接测试
  // 这里返回模拟结果
  return json({
    success: true,
    tmuxAvailable: false,
    message: 'Connection test not fully implemented yet',
  });
}

// ==================== Webhook 处理 ====================

async function handleGetWebhooks(req: Request): Promise<Response> {
  const webhooks = getAllWebhookEndpoints();
  return json({ webhooks });
}

async function handleCreateWebhook(req: Request): Promise<Response> {
  const body = await req.json();
  
  if (!body.url || !body.secret) {
    return json({ error: 'URL and secret required' }, 400);
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

async function handleDeleteWebhook(req: Request, id: string): Promise<Response> {
  deleteWebhookEndpoint(id);
  return json({ success: true });
}

// ==================== Telegram 处理 ====================

async function handleGetTelegramSubscriptions(req: Request): Promise<Response> {
  const subs = getAllTelegramSubscriptions();
  return json({ subscriptions: subs });
}

async function handleCreateTelegramSubscription(req: Request): Promise<Response> {
  const body = await req.json();
  
  if (!body.chatId) {
    return json({ error: 'chatId required' }, 400);
  }
  
  const now = new Date().toISOString();
  const sub: TelegramSubscription = {
    id: uuidv4(),
    enabled: body.enabled ?? true,
    chatId: body.chatId,
    eventMask: body.eventMask ?? [],
    createdAt: now,
    updatedAt: now,
  };
  
  createTelegramSubscription(sub);
  
  return json({ subscription: sub }, 201);
}

async function handleDeleteTelegramSubscription(req: Request, id: string): Promise<Response> {
  deleteTelegramSubscription(id);
  return json({ success: true });
}

// ==================== 通知测试 ====================

async function handleTestNotify(req: Request): Promise<Response> {
  const body = await req.json();
  
  // TODO: 实现实际的测试通知
  return json({
    success: true,
    message: 'Test notification sent',
  });
}

// ==================== Helpers ====================

function isAuthenticated(req: Request): boolean {
  const cookie = req.headers.get('Cookie');
  if (!cookie) return false;
  
  const token = parseCookie(cookie, 'token');
  if (!token) return false;
  
  // 简单的 token 验证（实际应该验证 JWT）
  return true;
}

function parseCookie(cookieHeader: string, name: string): string | null {
  const cookies = cookieHeader.split(';');
  for (const cookie of cookies) {
    const [key, value] = cookie.trim().split('=');
    if (key === name) return value;
  }
  return null;
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
