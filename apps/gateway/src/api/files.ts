import type {
  CreateFileRootRequest,
  FileErrorCode,
  FileRootDto,
  UpdateFileRootRequest,
} from '@tmex/shared';
import { getDeviceById } from '../db';
import {
  type FileRootRecord,
  createFileRoot,
  deleteFileRoot,
  getFileRootById,
  getFileRoots,
  updateFileRoot,
} from '../db/file-roots';
import { listDirectory, readRawFile, readTextFile, statFile } from '../files/device-storage';
import { t } from '../i18n';

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

const CODE_STATUS: Record<FileErrorCode, number> = {
  invalid: 400,
  outside_roots: 403,
  not_found: 404,
  not_a_directory: 400,
  is_directory: 400,
  too_large: 413,
  binary: 415,
  permission_denied: 403,
  device_not_found: 404,
  root_not_found: 404,
  root_disabled: 403,
  connection_failed: 502,
  auth_unsupported: 400,
  rsync_missing_local: 502,
  rsync_missing_remote: 502,
  timeout: 504,
  unknown: 500,
};

// 文件操作错误统一返回 { error, code }；前端按 code 渲染本地化错误态与安装流程。
function codeError(code: FileErrorCode, detail?: string): Response {
  return json({ error: code, code, detail }, CODE_STATUS[code]);
}

function rootDisplayName(p: string): string {
  if (p === '/') return '/';
  const i = p.replace(/\/$/, '').lastIndexOf('/');
  const base = i >= 0 ? p.replace(/\/$/, '').slice(i + 1) : p;
  return base || p;
}

function toRootDto(root: FileRootRecord): FileRootDto {
  const device = getDeviceById(root.deviceId);
  return {
    id: root.id,
    deviceId: root.deviceId,
    deviceName: device?.name ?? null,
    deviceType: device?.type ?? null,
    path: root.path,
    name: rootDisplayName(root.path),
    enabled: root.enabled,
    sortOrder: root.sortOrder,
  };
}

function handleListRoots(): Response {
  return json({ roots: getFileRoots().map(toRootDto) });
}

async function handleCreateRoot(req: Request): Promise<Response> {
  let body: CreateFileRootRequest;
  try {
    body = (await req.json()) as CreateFileRootRequest;
  } catch {
    return json({ error: t('apiError.invalidRequest') }, 400);
  }

  const deviceId = typeof body.deviceId === 'string' ? body.deviceId : '';
  const path = typeof body.path === 'string' ? body.path.trim() : '';
  if (!deviceId || !getDeviceById(deviceId)) {
    return json({ error: t('apiError.fileRootDeviceInvalid') }, 400);
  }
  if (!path || !path.startsWith('/')) {
    return json({ error: t('apiError.fileRootInvalid') }, 400);
  }

  const existing = getFileRoots().find((r) => r.deviceId === deviceId && r.path === path);
  if (existing) {
    return json({ error: t('apiError.fileRootDuplicate') }, 400);
  }

  const record = createFileRoot({ deviceId, path, enabled: body.enabled ?? true });
  return json({ root: toRootDto(record) }, 201);
}

async function handleUpdateRoot(req: Request, id: string): Promise<Response> {
  const existing = getFileRootById(id);
  if (!existing) return json({ error: t('apiError.notFound') }, 404);

  let body: UpdateFileRootRequest;
  try {
    body = (await req.json()) as UpdateFileRootRequest;
  } catch {
    return json({ error: t('apiError.invalidRequest') }, 400);
  }

  const updates: UpdateFileRootRequest = {};
  if (body.path !== undefined) {
    const path = typeof body.path === 'string' ? body.path.trim() : '';
    if (!path || !path.startsWith('/')) return json({ error: t('apiError.fileRootInvalid') }, 400);
    const dup = getFileRoots().find(
      (r) => r.id !== id && r.deviceId === existing.deviceId && r.path === path
    );
    if (dup) return json({ error: t('apiError.fileRootDuplicate') }, 400);
    updates.path = path;
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean')
      return json({ error: t('apiError.invalidRequest') }, 400);
    updates.enabled = body.enabled;
  }
  if (body.sortOrder !== undefined) {
    if (typeof body.sortOrder !== 'number')
      return json({ error: t('apiError.invalidRequest') }, 400);
    updates.sortOrder = body.sortOrder;
  }

  const updated = updateFileRoot(id, updates);
  if (!updated) return json({ error: t('apiError.notFound') }, 404);
  return json({ root: toRootDto(updated) });
}

function handleDeleteRoot(id: string): Response {
  const okDelete = deleteFileRoot(id);
  if (!okDelete) return json({ error: t('apiError.notFound') }, 404);
  return json({ success: true });
}

async function handleList(url: URL): Promise<Response> {
  const rootId = url.searchParams.get('rootId');
  if (!rootId) return json({ error: t('apiError.invalidRequest') }, 400);
  const path = url.searchParams.get('path');
  const result = await listDirectory(rootId, path);
  if (!result.ok) return codeError(result.code, result.detail);
  return json(result.data);
}

async function handleContent(url: URL): Promise<Response> {
  const rootId = url.searchParams.get('rootId');
  const path = url.searchParams.get('path');
  if (!rootId || !path) return json({ error: t('apiError.invalidRequest') }, 400);
  const result = await readTextFile(rootId, path);
  if (!result.ok) return codeError(result.code, result.detail);
  return json(result.data);
}

async function handleStat(url: URL): Promise<Response> {
  const rootId = url.searchParams.get('rootId');
  const path = url.searchParams.get('path');
  if (!rootId || !path) return json({ error: t('apiError.invalidRequest') }, 400);
  const result = await statFile(rootId, path);
  if (!result.ok) return codeError(result.code, result.detail);
  return json(result.data);
}

async function handleRaw(url: URL): Promise<Response> {
  const rootId = url.searchParams.get('rootId');
  const path = url.searchParams.get('path');
  if (!rootId || !path) return json({ error: t('apiError.invalidRequest') }, 400);
  const result = await readRawFile(rootId, path);
  if (!result.ok) return codeError(result.code, result.detail);

  const headers: Record<string, string> = {
    'Content-Type': result.data.mime ?? 'application/octet-stream',
  };
  const download = url.searchParams.get('download');
  if (download === '1' || download === 'true') {
    const encoded = encodeURIComponent(result.data.name);
    const ascii = result.data.name.replace(/["\\\r\n]/g, '_');
    headers['Content-Disposition'] = `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
  }
  return new Response(result.data.data, { status: 200, headers });
}

export function handleFilesApiRequest(
  req: Request,
  path: string
): Response | Promise<Response> | undefined {
  const url = new URL(req.url);

  if (path === '/api/files/roots' && req.method === 'GET') return handleListRoots();
  if (path === '/api/files/roots' && req.method === 'POST') return handleCreateRoot(req);
  if (path.match(/^\/api\/files\/roots\/[^/]+$/) && req.method === 'PATCH') {
    return handleUpdateRoot(req, decodeURIComponent(path.split('/')[4]));
  }
  if (path.match(/^\/api\/files\/roots\/[^/]+$/) && req.method === 'DELETE') {
    return handleDeleteRoot(decodeURIComponent(path.split('/')[4]));
  }

  if (path === '/api/files/list' && req.method === 'GET') return handleList(url);
  if (path === '/api/files/content' && req.method === 'GET') return handleContent(url);
  if (path === '/api/files/stat' && req.method === 'GET') return handleStat(url);
  if (path === '/api/files/raw' && req.method === 'GET') return handleRaw(url);

  return undefined;
}
