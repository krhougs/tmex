import type {
  CreateFileRootRequest,
  FileErrorCode,
  FileRootDto,
  UpdateFileRootRequest,
} from '@tmex/shared';
import { config } from '../config';
import { getDeviceById } from '../db';
import {
  type FileRootRecord,
  createFileRoot,
  deleteFileRoot,
  getFileRootById,
  getFileRoots,
  updateFileRoot,
} from '../db/file-roots';
import {
  listDirectory,
  pullFileFromDevice,
  pushFileToDevice,
  readRawFile,
  readTextFile,
  sanitizeUploadName,
  statFile,
} from '../files/device-storage';
import {
  appendUploadChunk,
  createUploadSession,
  getUploadSession,
  removeUploadSession,
} from '../files/transfer-session';
import { t } from '../i18n';

// 分块上传的 chunk 大小（前端按此切片，每个 PUT body ≤ 此值，远低于 Bun 默认 128MB body 上限）
const UPLOAD_CHUNK_SIZE = 8 * 1024 * 1024;

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

// 上传第一步：校验目标目录 + 大小上限，建会话与临时文件。
async function handleUploadInit(req: Request): Promise<Response> {
  let body: { rootId?: unknown; path?: unknown; name?: unknown; size?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ error: t('apiError.invalidRequest') }, 400);
  }
  const rootId = typeof body.rootId === 'string' ? body.rootId : '';
  const destDir = typeof body.path === 'string' ? body.path : '';
  const rawName = typeof body.name === 'string' ? body.name : '';
  const size = typeof body.size === 'number' && Number.isFinite(body.size) ? body.size : -1;
  if (!rootId || !destDir || !rawName || size < 0) {
    return json({ error: t('apiError.invalidRequest') }, 400);
  }
  const name = sanitizeUploadName(rawName);
  if (!name) return codeError('invalid');
  if (size > config.transferMaxBytes) return codeError('too_large');

  // fail-fast：上传前确认 destDir 落在 root 内且为已存在目录
  const stat = await statFile(rootId, destDir);
  if (!stat.ok) return codeError(stat.code, stat.detail);
  if (stat.data.type !== 'dir') return codeError('not_a_directory');

  const session = createUploadSession({ rootId, destDir, name, size });
  return json({ uploadId: session.id, chunkSize: UPLOAD_CHUNK_SIZE });
}

// 上传第二步：顺序追加 chunk。
async function handleUploadChunk(req: Request, id: string, url: URL): Promise<Response> {
  const offset = Number.parseInt(url.searchParams.get('offset') ?? '', 10);
  if (Number.isNaN(offset) || offset < 0) return json({ error: t('apiError.invalidRequest') }, 400);
  const bytes = new Uint8Array(await req.arrayBuffer());
  const res = appendUploadChunk(id, offset, bytes);
  if (!res.ok) {
    if (res.reason === 'not_found') return codeError('not_found');
    if (res.reason === 'too_large') return codeError('too_large');
    return json({ error: t('apiError.invalidRequest') }, 409); // bad_offset
  }
  return json({ received: res.received });
}

// 上传第三步：rsync 推送，流式 NDJSON 回传进度；完成/失败/取消后清理会话。
function handleUploadCommit(id: string): Response {
  const session = getUploadSession(id);
  if (!session) return codeError('not_found');
  if (session.received !== session.size) return codeError('invalid', 'incomplete upload');
  session.committing = true;

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const emit = (obj: unknown) => {
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(obj)}\n`));
        } catch {
          // 控制器已关闭（客户端断开）
        }
      };
      pushFileToDevice(session.rootId, session.destDir, session.tmpPath, session.name, {
        signal: session.abort.signal,
        onProgress: (p) => emit({ type: 'progress', ...p }),
      })
        .then((res) => {
          if (res.ok) emit({ type: 'done', uploaded: res.data.uploaded });
          else emit({ type: 'error', code: res.code, detail: res.detail });
        })
        .catch((e) => emit({ type: 'error', code: 'unknown', detail: String(e) }))
        .finally(() => {
          try {
            controller.close();
          } catch {
            // 已关闭
          }
          removeUploadSession(id);
        });
    },
    cancel() {
      // 客户端中断 commit 流 → 中止 rsync + 清理
      removeUploadSession(id);
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function handleUploadCancel(id: string): Response {
  removeUploadSession(id);
  return json({ success: true });
}

// 下载：rsync 拉到本机临时文件 → 从磁盘流式返回（有界内存，支持大文件）。
async function handleDownload(req: Request, url: URL): Promise<Response> {
  const rootId = url.searchParams.get('rootId');
  const path = url.searchParams.get('path');
  if (!rootId || !path) return json({ error: t('apiError.invalidRequest') }, 400);

  const result = await pullFileFromDevice(rootId, path, { signal: req.signal });
  if (!result.ok) return codeError(result.code, result.detail);
  const { tmpPath, size, name, mime, cleanup } = result.data;

  // 拉取已成功（临时文件已建）：此后任何同步失败都必须清理，避免泄漏
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = Bun.file(tmpPath).stream().getReader();
  } catch {
    cleanup();
    return codeError('unknown');
  }
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          cleanup();
          return;
        }
        controller.enqueue(value);
      } catch (e) {
        controller.error(e);
        cleanup();
      }
    },
    cancel() {
      void reader.cancel();
      cleanup();
    },
  });

  const encoded = encodeURIComponent(name);
  const ascii = name.replace(/["\\\r\n]/g, '_');
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': mime ?? 'application/octet-stream',
      'Content-Length': String(size),
      'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`,
      'Cache-Control': 'no-store',
    },
  });
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
  if (path === '/api/files/download' && req.method === 'GET') return handleDownload(req, url);

  // 分块上传：init / chunk(PUT) / commit(POST 流式) / cancel(DELETE)
  if (path === '/api/files/upload/init' && req.method === 'POST') return handleUploadInit(req);
  const commitMatch = path.match(/^\/api\/files\/upload\/([^/]+)\/commit$/);
  if (commitMatch && req.method === 'POST') {
    return handleUploadCommit(decodeURIComponent(commitMatch[1]));
  }
  const uploadMatch = path.match(/^\/api\/files\/upload\/([^/]+)$/);
  if (uploadMatch && req.method === 'PUT') {
    return handleUploadChunk(req, decodeURIComponent(uploadMatch[1]), url);
  }
  if (uploadMatch && req.method === 'DELETE') {
    return handleUploadCancel(decodeURIComponent(uploadMatch[1]));
  }

  return undefined;
}
