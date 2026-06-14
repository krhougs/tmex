import { fileDownloadUrl, filesApiUrl } from '@/utils/fileUrl';
import type {
  CreateFileRootRequest,
  FileContentResponse,
  FileErrorCode,
  FileRootResponse,
  FileStatResponse,
  ListFileRootsResponse,
  ListFilesResponse,
  UpdateFileRootRequest,
  UploadCommitEvent,
  UploadInitRequest,
  UploadInitResponse,
} from '@tmex/shared';
import { formatRate } from './format';

export class FileApiError extends Error {
  status: number;
  code?: FileErrorCode;
  constructor(status: number, message: string, code?: FileErrorCode) {
    super(message);
    this.name = 'FileApiError';
    this.status = status;
    this.code = code;
  }
}

async function parseError(res: Response): Promise<FileApiError> {
  let message = `HTTP ${res.status}`;
  let code: FileErrorCode | undefined;
  try {
    const body = (await res.json()) as { error?: string; code?: FileErrorCode };
    if (body.error) message = body.error;
    code = body.code;
  } catch {
    // 非 JSON 响应
  }
  return new FileApiError(res.status, message, code);
}

export async function fetchFileRoots(): Promise<ListFileRootsResponse> {
  const res = await fetch('/api/files/roots');
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as ListFileRootsResponse;
}

export async function createFileRoot(body: CreateFileRootRequest): Promise<FileRootResponse> {
  const res = await fetch('/api/files/roots', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as FileRootResponse;
}

export async function updateFileRoot(
  id: string,
  body: UpdateFileRootRequest
): Promise<FileRootResponse> {
  const res = await fetch(`/api/files/roots/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as FileRootResponse;
}

export async function deleteFileRoot(id: string): Promise<void> {
  const res = await fetch(`/api/files/roots/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok) throw await parseError(res);
}

export async function fetchFileList(rootId: string, path?: string): Promise<ListFilesResponse> {
  const res = await fetch(filesApiUrl('list', rootId, path));
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as ListFilesResponse;
}

export async function fetchFileStat(rootId: string, path: string): Promise<FileStatResponse> {
  const res = await fetch(filesApiUrl('stat', rootId, path));
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as FileStatResponse;
}

export async function fetchFileContent(rootId: string, path: string): Promise<FileContentResponse> {
  const res = await fetch(filesApiUrl('content', rootId, path));
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as FileContentResponse;
}

export type TransferPhase = 'upload' | 'device' | 'preparing' | 'download';
export interface TransferProgress {
  phase: TransferPhase;
  sent: number;
  total: number;
  /** 速度文本：device 段来自 rsync；upload/download 段客户端计算 */
  rate?: string;
}

interface TransferOpts {
  onProgress?: (p: TransferProgress) => void;
  signal?: AbortSignal;
}

const UPLOAD_CHUNK_FALLBACK = 8 * 1024 * 1024;

// 分块上传：init → 顺序 PUT 各 chunk（阶段一 浏览器→服务器）→ commit 流式 NDJSON（阶段二 服务器→设备 rsync）。
export async function uploadFileChunked(
  rootId: string,
  destDir: string,
  file: File,
  opts: TransferOpts = {}
): Promise<void> {
  const { onProgress, signal } = opts;
  const ensureNotAborted = () => {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  };
  const initBody: UploadInitRequest = {
    rootId,
    path: destDir,
    name: file.name,
    size: file.size,
  };
  const initRes = await fetch('/api/files/upload/init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(initBody),
    signal,
  });
  if (!initRes.ok) throw await parseError(initRes);
  const { uploadId, chunkSize } = (await initRes.json()) as UploadInitResponse;
  const step = chunkSize > 0 ? chunkSize : UPLOAD_CHUNK_FALLBACK;

  try {
    const total = file.size;
    const startedAt = performance.now();
    let offset = 0;
    onProgress?.({ phase: 'upload', sent: 0, total });
    while (offset < total) {
      ensureNotAborted();
      const end = Math.min(offset + step, total);
      const res = await fetch(`/api/files/upload/${uploadId}?offset=${offset}`, {
        method: 'PUT',
        body: file.slice(offset, end),
        signal,
      });
      if (!res.ok) throw await parseError(res);
      offset = end;
      const elapsed = (performance.now() - startedAt) / 1000;
      const rate = elapsed > 0 ? formatRate(offset / elapsed) : undefined;
      onProgress?.({ phase: 'upload', sent: offset, total, rate });
    }

    // 进入 commit（rsync 推送）前再次确认未取消：避免分块阶段刚取消却仍触发推送
    ensureNotAborted();
    const commitRes = await fetch(`/api/files/upload/${uploadId}/commit`, {
      method: 'POST',
      signal,
    });
    if (!commitRes.ok || !commitRes.body) throw await parseError(commitRes);

    const reader = commitRes.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let done = false;
    for (;;) {
      const { done: rdone, value } = await reader.read();
      if (rdone) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const ev = JSON.parse(line) as UploadCommitEvent;
        if (ev.type === 'progress') {
          onProgress?.({ phase: 'device', sent: ev.transferred, total, rate: ev.rate });
        } else if (ev.type === 'done') {
          done = true;
        } else if (ev.type === 'error') {
          throw new FileApiError(500, ev.detail ?? ev.code, ev.code);
        }
      }
    }
    if (!done) throw new FileApiError(500, 'unknown', 'unknown');
  } catch (e) {
    // 失败/取消：通知后端中止 rsync + 清理临时会话（best-effort）
    try {
      await fetch(`/api/files/upload/${uploadId}`, { method: 'DELETE' });
    } catch {
      // 忽略
    }
    throw e;
  }
}

// 流式下载：fetch → 读响应流（阶段二 服务器→浏览器，含速度）→ Blob 触发保存。
// resolve 前为"准备中"（阶段一 设备→服务器 rsync）。支持 AbortSignal 取消。
export async function downloadFileWithProgress(
  rootId: string,
  path: string,
  name: string,
  opts: TransferOpts = {}
): Promise<void> {
  const { onProgress, signal } = opts;
  onProgress?.({ phase: 'preparing', sent: 0, total: 0 });
  const res = await fetch(fileDownloadUrl(rootId, path), { signal });
  if (!res.ok || !res.body) throw await parseError(res);
  const total = Number(res.headers.get('Content-Length') ?? '0');

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  const startedAt = performance.now();
  onProgress?.({ phase: 'download', sent: 0, total });
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    const elapsed = (performance.now() - startedAt) / 1000;
    const rate = elapsed > 0 ? formatRate(received / elapsed) : undefined;
    onProgress?.({ phase: 'download', sent: received, total, rate });
  }

  const blob = new Blob(chunks as BlobPart[]);
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(objectUrl);
}
