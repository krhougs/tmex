import { filesApiUrl } from '@/utils/fileUrl';
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
import { formatBytes, formatRate } from './format';

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

// 传输有两段（leg）；toast 同时显示两条进度。
// 上传：leg1 浏览器→tmex，leg2 tmex→服务器；下载：leg1 服务器→tmex，leg2 tmex→浏览器。
export interface LegProgress {
  /** 0-100 */
  pct: number;
  /** 速度文本（如 1.23 MB/s） */
  rate?: string;
  /** 字节明细（如 1.2 MB / 64 MB） */
  detail?: string;
}
export type OnLeg = (leg: 1 | 2, p: LegProgress) => void;

interface TransferOpts {
  onLeg?: OnLeg;
  signal?: AbortSignal;
}

interface DownloadPrepareEvent {
  type: 'progress' | 'done' | 'error';
  transferred?: number;
  pct?: number;
  rate?: string;
  downloadId?: string;
  size?: number;
  name?: string;
  code?: FileErrorCode;
  detail?: string;
}

const UPLOAD_CHUNK_FALLBACK = 8 * 1024 * 1024;

// 分块上传：init → 顺序 PUT 各 chunk（leg1 浏览器→tmex）→ commit 流式 NDJSON（leg2 tmex→服务器 rsync）。
export async function uploadFileChunked(
  rootId: string,
  destDir: string,
  file: File,
  opts: TransferOpts = {}
): Promise<void> {
  const { onLeg, signal } = opts;
  const ensureNotAborted = () => {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  };
  const total = file.size;
  const bytes = (n: number) => `${formatBytes(n)} / ${formatBytes(total)}`;
  const initBody: UploadInitRequest = { rootId, path: destDir, name: file.name, size: total };
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
    // leg1：浏览器 → tmex（分块上传，进度客户端本地计算）
    onLeg?.(1, { pct: total === 0 ? 100 : 0, detail: bytes(0) });
    const startedAt = performance.now();
    let offset = 0;
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
      onLeg?.(1, {
        pct: Math.round((offset / total) * 100),
        rate: elapsed > 0 ? formatRate(offset / elapsed) : undefined,
        detail: bytes(offset),
      });
    }
    onLeg?.(1, { pct: 100, detail: bytes(total) });

    // leg2：tmex → 服务器（rsync 推送，commit 流式 NDJSON 回传进度）
    ensureNotAborted();
    onLeg?.(2, { pct: 0, detail: bytes(0) });
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
          onLeg?.(2, { pct: ev.pct, rate: ev.rate, detail: bytes(ev.transferred) });
        } else if (ev.type === 'done') {
          done = true;
        } else if (ev.type === 'error') {
          throw new FileApiError(500, ev.detail ?? ev.code, ev.code);
        }
      }
    }
    if (!done) throw new FileApiError(500, 'unknown', 'unknown');
    onLeg?.(2, { pct: 100, detail: bytes(total) });
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

// 两步下载：prepare（leg1 服务器→tmex rsync，流式 NDJSON 进度，期间持续有数据避免空闲超时）
// → content（leg2 tmex→浏览器，读流计速）→ Blob 触发保存。支持 AbortSignal 取消。
export async function downloadFileWithProgress(
  rootId: string,
  path: string,
  name: string,
  opts: TransferOpts = {}
): Promise<void> {
  const { onLeg, signal } = opts;

  // leg1：服务器 → tmex（rsync）
  onLeg?.(1, { pct: 0 });
  const prep = await fetch('/api/files/download/prepare', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rootId, path }),
    signal,
  });
  if (!prep.ok || !prep.body) throw await parseError(prep);
  const preader = prep.body.getReader();
  const pdec = new TextDecoder();
  let pbuf = '';
  let downloadId = '';
  let size = 0;
  let dlName = name;
  let prepErr: FileApiError | null = null;
  for (;;) {
    const { done, value } = await preader.read();
    if (done) break;
    pbuf += pdec.decode(value, { stream: true });
    const lines = pbuf.split('\n');
    pbuf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      const ev = JSON.parse(line) as DownloadPrepareEvent;
      if (ev.type === 'progress') {
        onLeg?.(1, {
          pct: ev.pct ?? 0,
          rate: ev.rate,
          detail: ev.transferred != null ? formatBytes(ev.transferred) : undefined,
        });
      } else if (ev.type === 'done') {
        downloadId = ev.downloadId ?? '';
        size = ev.size ?? 0;
        dlName = ev.name ?? name;
      } else if (ev.type === 'error') {
        prepErr = new FileApiError(500, ev.detail ?? ev.code ?? 'unknown', ev.code);
      }
    }
  }
  if (prepErr) throw prepErr;
  if (!downloadId) throw new FileApiError(500, 'unknown', 'unknown');
  onLeg?.(1, { pct: 100, detail: formatBytes(size) });

  // leg2：tmex → 浏览器（接收并保存）
  try {
    const bytes = (n: number) => `${formatBytes(n)} / ${formatBytes(size)}`;
    onLeg?.(2, { pct: 0, detail: bytes(0) });
    const res = await fetch(`/api/files/download/${downloadId}/content`, { signal });
    if (!res.ok || !res.body) throw await parseError(res);
    const total = Number(res.headers.get('Content-Length') ?? String(size));
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    const startedAt = performance.now();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.byteLength;
      const elapsed = (performance.now() - startedAt) / 1000;
      onLeg?.(2, {
        pct: total > 0 ? Math.round((received / total) * 100) : 0,
        rate: elapsed > 0 ? formatRate(received / elapsed) : undefined,
        detail: `${formatBytes(received)} / ${formatBytes(total)}`,
      });
    }
    const blob = new Blob(chunks as BlobPart[]);
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = dlName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(objectUrl);
    onLeg?.(2, { pct: 100, detail: bytes(size) });
  } catch (e) {
    try {
      await fetch(`/api/files/download/${downloadId}`, { method: 'DELETE' });
    } catch {
      // 忽略
    }
    throw e;
  }
}
