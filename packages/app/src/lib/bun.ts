import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { MIN_BUN_VERSION } from '../constants';
import { t } from '../i18n';
import type { ParsedArgs } from '../types';
import { runCommand } from './process';
import { compareSemver } from './semver';
import { asString } from './validate';

export interface BunCheckResult {
  ok: boolean;
  path?: string;
  version?: string;
  reason?: string;
}

export interface ResolveBunOptions {
  /** 显式指定的 bun 路径（--bun-path / TMEX_BUN_PATH）。提供时尊重用户输入，无效直接报错，不静默回退。 */
  explicitPath?: string;
  /** install-meta.json 中持久化的 bun 路径。 */
  metaBunPath?: string;
}

const ESC = 27;
const CSI_OPEN = 91; // '['
const OSC_OPEN = 93; // ']'
const BEL = 7;
const ST_TAIL = 92; // '\'（配合前导 ESC 构成 String Terminator）
const LF = 10;
const CR = 13;
const DEL = 127;
const SLASH = 47; // '/'

const PROBE_TIMEOUT_MS = 5000;

/**
 * 净化来自 shell / 外部来源的路径串：剥离 ANSI 转义（CSI、OSC）与控制字符，按换行拆分后
 * 优先返回最后一个绝对路径行（应对 banner 出现在路径前/后的污染），否则返回最后一个非空行
 * （如版本号）。用码点判断实现，避免源码中出现不可见控制字符。
 * 修 issue#28：交互式 shell 的 .zshrc 会向 stdout 注入控制序列，trim() 无法清除中间的控制字符。
 */
export function sanitizeBunPath(raw: string): string {
  let stripped = '';
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i);
    if (code === ESC) {
      const next = raw.charCodeAt(i + 1);
      if (next === CSI_OPEN) {
        // CSI 序列：ESC '[' ... 终止字节(0x40-0x7e)，整段跳过。
        i += 1;
        while (i + 1 < raw.length) {
          const c = raw.charCodeAt(i + 1);
          i += 1;
          if (c >= 64 && c <= 126) {
            break;
          }
        }
      } else if (next === OSC_OPEN) {
        // OSC 序列：ESC ']' ... 以 BEL(0x07) 或 ST(ESC '\') 终止，整段跳过。
        i += 1;
        while (i + 1 < raw.length) {
          const c = raw.charCodeAt(i + 1);
          if (c === BEL) {
            i += 1;
            break;
          }
          if (c === ESC && raw.charCodeAt(i + 2) === ST_TAIL) {
            i += 2;
            break;
          }
          i += 1;
        }
      }
      // CSI/OSC 已整段跳过；裸 ESC 或其它 ESC 序列直接丢弃 ESC。
      continue;
    }
    stripped += raw[i];
  }

  const lines: string[] = [];
  let current = '';
  const flush = (): void => {
    let cleaned = '';
    for (let i = 0; i < current.length; i += 1) {
      const code = current.charCodeAt(i);
      if (code <= 31 || code === DEL) {
        continue;
      }
      cleaned += current[i];
    }
    cleaned = cleaned.trim();
    if (cleaned.length > 0) {
      lines.push(cleaned);
    }
    current = '';
  };
  for (let i = 0; i < stripped.length; i += 1) {
    const code = stripped.charCodeAt(i);
    if (code === LF || code === CR) {
      flush();
      continue;
    }
    current += stripped[i];
  }
  flush();

  if (lines.length === 0) {
    return '';
  }
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].charCodeAt(0) === SLASH) {
      return lines[i];
    }
  }
  return lines[lines.length - 1];
}

/** 从命令行 flags / 环境变量读取用户显式指定的 bun 路径（--bun-path / TMEX_BUN_PATH）。 */
export function readExplicitBunPath(flags: ParsedArgs['flags']): string | undefined {
  return asString(flags['bun-path']) || process.env.TMEX_BUN_PATH;
}

function isBunRuntime(): boolean {
  const bunVersion = (process.versions as { bun?: string }).bun;
  return typeof bunVersion === 'string' && bunVersion.length > 0;
}

function hardCandidatePaths(): string[] {
  return [
    join(homedir(), '.bun', 'bin', 'bun'),
    '/opt/homebrew/bin/bun',
    '/usr/local/bin/bun',
    '/home/linuxbrew/.linuxbrew/bin/bun',
  ];
}

async function locateBunFromShellWith(shell: string): Promise<string | null> {
  const result = await runCommand(shell, ['-lic', 'command -v bun'], {
    stdio: 'pipe',
    timeoutMs: PROBE_TIMEOUT_MS,
  }).catch(() => null);
  if (!result || result.code !== 0) {
    return null;
  }

  const bin = sanitizeBunPath(result.stdout);
  if (!bin || !isAbsolute(bin) || !existsSync(bin)) {
    return null;
  }
  return bin;
}

/**
 * 通过登录交互式 shell 解析 bun 路径。依次尝试 $SHELL / zsh / bash，
 * 不再硬依赖 zsh（Linux 默认 bash 且常无 zsh）。输出经 sanitizeBunPath 净化并校验存在性。
 */
async function locateBunFromShell(): Promise<string | null> {
  const shells: string[] = [];
  const envShell = process.env.SHELL?.trim();
  if (envShell) {
    shells.push(envShell);
  }
  for (const fallbackShell of ['zsh', 'bash']) {
    if (!shells.includes(fallbackShell)) {
      shells.push(fallbackShell);
    }
  }

  for (const shell of shells) {
    const found = await locateBunFromShellWith(shell);
    if (found) {
      return found;
    }
  }
  return null;
}

/**
 * 按优先级收集 bun 候选路径（不含显式路径，显式路径单独处理）：
 * #2 process.execPath（cli 被 bun 拉起，自更新链路）→ #3 meta →
 * #4 动态探测（登录 shell 解析 → 当前进程 PATH，反映用户实际环境）→
 * #5 硬编码常见安装路径（homebrew / linuxbrew / ~/.bun，仅作 fallback 兜底）。
 * 所有候选统一过 sanitizeBunPath（对干净的系统路径幂等无害，统一防御外部来源污染）。
 */
async function probeBunCandidates(metaBunPath?: string): Promise<string[]> {
  const candidates: string[] = [];
  const add = (value: string | null | undefined): void => {
    if (!value) {
      return;
    }
    const sanitized = sanitizeBunPath(value);
    if (sanitized && !candidates.includes(sanitized)) {
      candidates.push(sanitized);
    }
  };

  if (isBunRuntime()) {
    add(process.execPath);
  }
  add(metaBunPath);
  // 动态探测优先（反映用户实际在用的 bun）：登录 shell 解析 → 当前进程 PATH。
  add(await locateBunFromShell());
  candidates.push('bun');
  // 硬编码常见安装路径仅作 fallback：仅当动态探测全部失败时兜底。
  for (const candidate of hardCandidatePaths()) {
    add(candidate);
  }

  return candidates;
}

async function validateBunAt(candidate: string, minVersion: string): Promise<BunCheckResult> {
  const versionResult = await runCommand(candidate, ['--version'], {
    stdio: 'pipe',
    timeoutMs: PROBE_TIMEOUT_MS,
  }).catch(() => null);
  if (!versionResult || versionResult.code !== 0) {
    return { ok: false, path: candidate, reason: t('bun.versionExecFailed') };
  }

  const version = sanitizeBunPath(versionResult.stdout);
  if (compareSemver(version, minVersion) < 0) {
    return {
      ok: false,
      path: candidate,
      version,
      reason: t('bun.versionTooLow', { version, minVersion }),
    };
  }

  return { ok: true, path: candidate, version };
}

/**
 * 解析并校验 bun 可执行路径。
 * 优先级：#1 显式 → #2 process.execPath（bun 运行时）→ #3 meta → #4 动态探测 → #5 硬编码 fallback。
 * 显式路径必须是「存在的绝对路径」，否则直接报 explicitInvalid，不静默回退，以免掩盖用户输入错误。
 */
export async function checkBunVersion(
  minVersion = MIN_BUN_VERSION,
  opts: ResolveBunOptions = {}
): Promise<BunCheckResult> {
  if (opts.explicitPath !== undefined && opts.explicitPath !== '') {
    const explicit = sanitizeBunPath(opts.explicitPath);
    if (!explicit || !isAbsolute(explicit) || !existsSync(explicit)) {
      const reported = explicit || opts.explicitPath;
      return {
        ok: false,
        path: reported,
        reason: t('bun.explicitInvalid', { path: reported }),
      };
    }
    return await validateBunAt(explicit, minVersion);
  }

  const candidates = await probeBunCandidates(opts.metaBunPath);
  let firstFailure: BunCheckResult | null = null;
  for (const candidate of candidates) {
    if (candidate !== 'bun' && isAbsolute(candidate) && !existsSync(candidate)) {
      continue;
    }
    const result = await validateBunAt(candidate, minVersion);
    if (result.ok) {
      return result;
    }
    if (!firstFailure) {
      firstFailure = result;
    }
  }

  return firstFailure ?? { ok: false, reason: t('bun.notFound') };
}
