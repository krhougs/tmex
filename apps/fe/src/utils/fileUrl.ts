// 文件查看路由 ref：把 {rootId, path} 编成 URL 安全的 base64url（兼容 UTF-8 路径）。
// 文件操作按 rootId 路由（rootId 决定设备 + 白名单根，后端据此做本地/ssh-rsync 与路径校验）。

function base64urlEncode(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(ref: string): string {
  const b64 = ref.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
  const bin = atob(b64 + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export interface FileRef {
  rootId: string;
  path: string;
}

export function encodeFileRef(rootId: string, path: string): string {
  return base64urlEncode(`${rootId}\n${path}`);
}

export function decodeFileRef(ref: string): FileRef | null {
  try {
    const s = base64urlDecode(ref);
    const i = s.indexOf('\n');
    if (i < 0) return null;
    return { rootId: s.slice(0, i), path: s.slice(i + 1) };
  } catch {
    return null;
  }
}

export function fileRoute(rootId: string, path: string): string {
  return `/file/${encodeFileRef(rootId, path)}`;
}

export function filesApiUrl(
  endpoint: 'list' | 'content' | 'stat',
  rootId: string,
  path?: string
): string {
  const params = new URLSearchParams({ rootId });
  if (path != null) params.set('path', path);
  return `/api/files/${endpoint}?${params.toString()}`;
}

export function fileRawUrl(rootId: string, path: string, download = false): string {
  const params = new URLSearchParams({ rootId, path });
  if (download) params.set('download', '1');
  return `/api/files/raw?${params.toString()}`;
}
