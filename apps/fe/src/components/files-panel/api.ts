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
} from '@tmex/shared';

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
