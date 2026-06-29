import type { FileErrorCode } from '@tmex/shared';

export interface RsyncResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface RsyncProgress {
  /** 已传输字节数 */
  transferred: number;
  /** 0-100 整数百分比 */
  pct: number;
  /** rsync 原样速率串，如 "1.23MB/s" */
  rate: string;
}

// rsync --progress 进度行（openrsync 与 GNU 共有格式）：
//   <bytes>[千分位逗号] <pct>% <rate>/s <time>[ (xfer#.. )]
// 例：openrsync "              5 100%  353.10KB/s   00:00:00 (xfer#1, to-check=0/1)"
//     GNU       "      1,234,567  45%    1.23MB/s    0:00:12"
const PROGRESS_RE = /^\s*([\d,]+)\s+(\d+)%\s+([\d.]+[KMGT]?B\/s)/;

export function parseRsyncProgress(line: string): RsyncProgress | null {
  const m = PROGRESS_RE.exec(line);
  if (!m) return null;
  const transferred = Number.parseInt(m[1].replace(/,/g, ''), 10);
  const pct = Number.parseInt(m[2], 10);
  if (Number.isNaN(transferred) || Number.isNaN(pct)) return null;
  return { transferred, pct, rate: m[3] };
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

// 增量读取 stdout 流，按 \r/\n 切行解析 rsync --progress 进度；每收到数据块调用 resetIdle。
// 仍累积完整文本返回（与一次性读取语义一致）。
async function readStdoutWithProgress(
  stream: ReadableStream<Uint8Array>,
  onProgress: (p: RsyncProgress) => void,
  resetIdle: () => void
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let full = '';
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    resetIdle();
    const text = decoder.decode(value, { stream: true });
    full += text;
    buf += text;
    const parts = buf.split(/[\r\n]/);
    buf = parts.pop() ?? '';
    for (const line of parts) {
      const p = parseRsyncProgress(line);
      if (p) onProgress(p);
    }
  }
  const tail = parseRsyncProgress(buf);
  if (tail) onProgress(tail);
  return full;
}

export async function runRsync(
  argv: string[],
  opts: {
    env?: Record<string, string>;
    timeoutMs?: number;
    signal?: AbortSignal;
    // 提供时：增量读 stdout 解析 --progress 进度行，并改用「空闲超时」（有数据就重置计时器）
    onProgress?: (p: RsyncProgress) => void;
    // 空闲超时（仅 onProgress 模式生效）：无任何 stdout 数据持续该时长则判超时 kill
    idleTimeoutMs?: number;
  } = {}
): Promise<RsyncResult> {
  const streaming = typeof opts.onProgress === 'function';
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const idleTimeoutMs = opts.idleTimeoutMs ?? 120_000;

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
  const killProc = () => {
    try {
      proc.kill();
    } catch {
      // 已退出
    }
  };

  // 非流式：固定总超时；流式：空闲超时（有进度重置）
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const armFixed = () => {
    killTimer = setTimeout(() => {
      timedOut = true;
      killProc();
    }, timeoutMs);
  };
  const resetIdle = () => {
    if (killTimer) clearTimeout(killTimer);
    killTimer = setTimeout(() => {
      timedOut = true;
      killProc();
    }, idleTimeoutMs);
  };
  if (streaming) resetIdle();
  else armFixed();

  const onAbort = () => killProc();
  opts.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const stdoutPromise = streaming
      ? readStdoutWithProgress(
          proc.stdout as ReadableStream<Uint8Array>,
          // biome-ignore lint/style/noNonNullAssertion: streaming 为真时 onProgress 必存在
          opts.onProgress!,
          resetIdle
        )
      : new Response(proc.stdout as ReadableStream<Uint8Array>).text();
    const [stdout, stderr, exitCode] = await Promise.all([
      stdoutPromise,
      new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
      proc.exited,
    ]);
    if (timedOut) {
      return { stdout, stderr: `${stderr}\n[tmex] rsync timed out`, exitCode: 124 };
    }
    return { stdout, stderr, exitCode };
  } finally {
    if (killTimer) clearTimeout(killTimer);
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

// 将 GNU rsync（LC_ALL=C）的八进制转义序列还原为原始 UTF-8 字符。
// 连续的 \NNN 字节先收集再统一 UTF-8 解码，避免多字节字符被截断。
// \\ 还原为单个 \；不合法的转义（非 [0-7] 或值 > 255）原样保留。
export function unescapeOctal(input: string): string {
  if (!input.includes('\\')) return input;

  const result: string[] = [];
  let pendingBytes: number[] = [];

  const flushBytes = () => {
    if (pendingBytes.length === 0) return;
    result.push(new TextDecoder().decode(new Uint8Array(pendingBytes)));
    pendingBytes = [];
  };

  let i = 0;
  while (i < input.length) {
    if (input[i] !== '\\') {
      flushBytes();
      result.push(input[i]);
      i++;
      continue;
    }

    if (input[i + 1] === '\\') {
      flushBytes();
      result.push('\\');
      i += 2;
      continue;
    }

    if (i + 3 < input.length) {
      const digits = input.slice(i + 1, i + 4);
      if (/^[0-7]{3}$/.test(digits)) {
        const val = parseInt(digits, 8);
        if (val <= 255) {
          pendingBytes.push(val);
          i += 4;
          continue;
        }
      }
    }

    flushBytes();
    result.push('\\');
    i++;
  }

  flushBytes();
  return result.join('');
}

export function parseListOnly(stdout: string): RsyncEntry[] {
  const entries: RsyncEntry[] = [];
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    const m = LIST_RE.exec(line);
    if (!m) continue;

    const type = typeFromPerms(m[1]);
    let name = unescapeOctal(m[9]);
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
