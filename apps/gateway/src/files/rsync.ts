import type { FileErrorCode } from '@tmex/shared';

export interface RsyncResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface RsyncEntry {
  name: string;
  type: 'dir' | 'file' | 'symlink' | 'other';
  size: number | null;
  /** 本地时区的 ISO-ish 串（无时区后缀）；解析失败为 null */
  modifiedAt: string | null;
}

// 宿主机本地 rsync 二进制不存在（Bun.spawn 抛 ENOENT）
export class RsyncMissingLocalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RsyncMissingLocalError';
  }
}

const SENSITIVE_ENV_KEYS = new Set(['DATABASE_URL', 'NODE_ENV', 'GATEWAY_PORT', 'FE_PORT']);

// 子进程基础环境：保留 PATH/HOME/SSH_AUTH_SOCK 等，剔除 TMEX_* 与接线键，强制 LC_ALL=C
function baseSubprocessEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k.startsWith('TMEX_')) continue;
    if (SENSITIVE_ENV_KEYS.has(k)) continue;
    out[k] = v;
  }
  out.LC_ALL = 'C';
  return out;
}

export async function runRsync(
  argv: string[],
  opts: { env?: Record<string, string>; timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<RsyncResult> {
  const timeoutMs = opts.timeoutMs ?? 20_000;

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(['rsync', ...argv], {
      env: { ...baseSubprocessEnv(), ...opts.env },
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'ignore',
    });
  } catch (error) {
    // rsync 不在 PATH → 本地缺 rsync
    throw new RsyncMissingLocalError(error instanceof Error ? error.message : String(error));
  }

  let timedOut = false;
  const killTimer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill();
    } catch {
      // 已退出
    }
  }, timeoutMs);

  const onAbort = () => {
    try {
      proc.kill();
    } catch {
      // 已退出
    }
  };
  opts.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
      new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
      proc.exited,
    ]);
    if (timedOut) {
      return { stdout, stderr: `${stderr}\n[tmex] rsync timed out`, exitCode: 124 };
    }
    return { stdout, stderr, exitCode };
  } finally {
    clearTimeout(killTimer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

// rsync --list-only 行：<perms(10)>[acl] <size> <YYYY/MM/DD> <HH:MM:SS> <name>[ -> target]
// 兼容 openrsync（macOS）与 GNU rsync（Linux）；size 可能含千分位逗号。
const LIST_RE =
  /^([dlspbc-][rwxsStT-]{9}[.+@]?)\s+([\d,]+)\s+(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2}):(\d{2})\s+(.*)$/;

function typeFromPerms(perms: string): RsyncEntry['type'] {
  switch (perms[0]) {
    case 'd':
      return 'dir';
    case 'l':
      return 'symlink';
    case '-':
      return 'file';
    default:
      return 'other';
  }
}

export function parseListOnly(stdout: string): RsyncEntry[] {
  const entries: RsyncEntry[] = [];
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    const m = LIST_RE.exec(line);
    if (!m) continue;

    const type = typeFromPerms(m[1]);
    let name = m[9];
    if (type === 'symlink') {
      const arrow = name.indexOf(' -> ');
      if (arrow >= 0) name = name.slice(0, arrow);
    }
    if (name === '' || name === '.' || name === '..') continue;

    const sizeNum = Number.parseInt(m[2].replace(/,/g, ''), 10);
    const size = type === 'dir' ? null : Number.isNaN(sizeNum) ? null : sizeNum;
    const modifiedAt = `${m[3]}-${m[4]}-${m[5]}T${m[6]}:${m[7]}:${m[8]}`;
    entries.push({ name, type, size, modifiedAt });
  }
  return entries;
}

// 根据退出码 + stderr 推断错误类别。
export function classifyRsyncFailure(exitCode: number, stderr: string): FileErrorCode {
  const s = stderr.toLowerCase();

  if (exitCode === 124) return 'timeout';
  if (
    /command not found|rsync: not found|rsync error: error in rsync protocol.*\(code 127\)/.test(s)
  ) {
    return 'rsync_missing_remote';
  }
  if (/rsync: not found|exec: rsync: not found|bash: rsync/.test(s)) return 'rsync_missing_remote';
  if (
    /host key verification failed|could not resolve hostname|connection refused|connection timed out|no route to host|operation timed out|ssh: connect to host/.test(
      s
    )
  ) {
    return 'connection_failed';
  }
  // 认证失败（ssh）：括号内是认证方式名而非 errno
  if (
    /permission denied \((publickey|password|keyboard-interactive|gssapi|hostbased)/.test(s) ||
    /too many authentication failures|authentication failed/.test(s)
  ) {
    return 'connection_failed';
  }
  // 路径权限不足（如 Permission denied (13)）
  if (/permission denied/.test(s)) return 'permission_denied';
  if (/no such file or directory|change_dir.*failed|link_stat.*failed|failed to stat/.test(s)) {
    return 'not_found';
  }
  return 'unknown';
}
