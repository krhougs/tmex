// run_command 核心：在绑定 pane 里执行一条命令并拿到完整输出。
// 数据全部走实时流（emulator tap）：字节累积命令输出、OSC133 标记判完成、render 判 alternate。
// 三类目标（详见 docs）：
//  - POSIX：注入隐形 OSC133 + nonce 包裹命令，等带 nonce 的 D 标记 → 精确输出 + 退出码。
//  - CLI（网络设备）：学提示符 / 提示符重现判完成 / --More-- 自动续翻 / 错误串启发（无退出码）。
//  - TUI/alternate：拒绝（entered_tui），交回交互式读写屏。

import type { PromptMarker } from '../../tmux-client/pane-stream-parser';

export type RunCommandMode = 'auto' | 'posix' | 'cli';
export type RunCommandShell = 'bash' | 'zsh' | 'sh' | 'fish' | 'powershell';

export type RunCommandStatus =
  | 'completed'
  | 'timeout'
  | 'entered_tui'
  | 'expect_matched'
  | 'paused_pager';

export interface RunCommandResult {
  output: string;
  exitCode: number | null;
  status: RunCommandStatus;
  likelyError: boolean;
  errorLine?: string;
  truncated: boolean;
}

/** run_command 所需的 emulator 能力子集（便于以 fake 单测）。 */
export interface RunCommandEmulator {
  isAlternateScreen(): boolean;
  render(): string;
  tap(tap: { onBytes?: (data: Uint8Array) => void; onMarker?: (marker: PromptMarker) => void }): () => void;
}

export interface RunCommandParams {
  command: string;
  mode?: RunCommandMode;
  shell?: RunCommandShell;
  /** cli 提示符正则（不传则从当前屏末行学习） */
  prompt?: string;
  /** 命中即早返回（密码提示 / [y/N] 等） */
  expect?: string;
  timeoutMs?: number;
  /** cli：先发该平台关分页命令 */
  disablePagingCommand?: string;
}

export interface RunCommandDeps {
  emulator: RunCommandEmulator;
  sendInput: (data: string) => void;
  sleepMs?: (ms: number) => Promise<void>;
  /** 注入 nonce（默认基于计数器；避免直接用 Math.random，便于测试） */
  makeNonce?: () => string;
  now?: () => number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const OUTPUT_MAX_BYTES = 256 * 1024;
const POLL_MS = 50;
const MORE_MARKERS = [/--More--/, /---\(more[^)]*\)---/i, /<--- More --->/i, /\bMore: <space>/i];
const ERROR_PATTERNS = [
  /%\s*Invalid input/i,
  /%\s*Ambiguous command/i,
  /%\s*Incomplete command/i,
  /^\s*\^\s*$/m,
  /syntax error/i,
  /unknown command/i,
];

const decoder = new TextDecoder();

function exitCodeExpr(shell: RunCommandShell | undefined): string | null {
  switch (shell) {
    case 'fish':
      return '$status';
    case 'powershell':
      return null; // pwsh 转义不同，退回无退出码路径
    default:
      return '$?'; // bash/zsh/sh 及未知
  }
}

// 去 ANSI/控制序列 + 处理 \r 覆盖 + 整理空白，得到干净文本。
export function cleanTerminalText(raw: string): string {
  let text = raw
    // OSC: ESC ] ... (BEL | ESC \)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    // CSI: ESC [ ... letter
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    // 其它两字节/字符集切换转义
    .replace(/\x1b[()][AB0-9]/g, '')
    .replace(/\x1b[=>NOcDEHM]/g, '')
    // 退格
    .replace(/.\x08/g, '');
  // 处理 \r：行内回车覆盖，保留最后一段
  text = text
    .split('\n')
    .map((line) => {
      if (!line.includes('\r')) {
        return line.replace(/\s+$/, '');
      }
      const segs = line.split('\r').filter((s) => s.length > 0);
      return (segs[segs.length - 1] ?? '').replace(/\s+$/, '');
    })
    .join('\n');
  return text;
}

function lastNonEmptyLine(text: string): string {
  const lines = cleanTerminalText(text).split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].trim().length > 0) {
      return lines[i];
    }
  }
  return '';
}

// 从累积原始字节里剥掉第一行（命令回显），返回干净输出。
function extractOutput(raw: string): { text: string; truncated: boolean } {
  const truncated = raw.length >= OUTPUT_MAX_BYTES;
  const cleaned = cleanTerminalText(raw);
  const newlineIdx = cleaned.indexOf('\n');
  // 第一行是 shell 对输入行的回显（含我们注入的 wrapper），剥掉
  const body = newlineIdx >= 0 ? cleaned.slice(newlineIdx + 1) : '';
  return { text: body.replace(/\n+$/, ''), truncated };
}

function detectError(text: string): { likelyError: boolean; errorLine?: string } {
  for (const pattern of ERROR_PATTERNS) {
    const match = pattern.exec(text);
    if (match) {
      const line = text.split('\n').find((l) => pattern.test(l)) ?? match[0];
      return { likelyError: true, errorLine: line.trim() };
    }
  }
  return { likelyError: false };
}

export async function executeRunCommand(
  params: RunCommandParams,
  deps: RunCommandDeps
): Promise<RunCommandResult> {
  const sleepMs = deps.sleepMs ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => performance.now());
  let nonceCounter = 0;
  const makeNonce = deps.makeNonce ?? (() => `n${++nonceCounter}${(now() | 0).toString(36)}`);
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const mode: RunCommandMode = params.mode ?? 'auto';

  if (deps.emulator.isAlternateScreen()) {
    return {
      output: '',
      exitCode: null,
      status: 'entered_tui',
      likelyError: false,
      truncated: false,
    };
  }

  // 累积流字节 + 标记
  const chunks: number[] = [];
  let receivedMarker: PromptMarker | null = null;
  let nonce = '';
  const untap = deps.emulator.tap({
    onBytes: (data) => {
      for (const byte of data) {
        if (chunks.length < OUTPUT_MAX_BYTES) {
          chunks.push(byte);
        }
      }
    },
    onMarker: (marker) => {
      if (marker.kind === 'D' && (!nonce || marker.params.includes(`tmex=${nonce}`))) {
        receivedMarker = marker;
      }
    },
  });

  const accumulated = (): string => decoder.decode(new Uint8Array(chunks));
  const finish = (result: RunCommandResult): RunCommandResult => {
    untap();
    return result;
  };

  try {
    const usePosix =
      mode === 'posix' || (mode === 'auto' && exitCodeExpr(params.shell) !== null);

    // cli：可选先关分页
    if (mode === 'cli' && params.disablePagingCommand) {
      deps.sendInput(`${params.disablePagingCommand}\r`);
      await sleepMs(200);
      chunks.length = 0;
    }

    // 学习 cli 提示符（用于完成判定）
    const promptRegex = params.prompt
      ? new RegExp(params.prompt)
      : mode === 'cli'
        ? buildPromptRegex(lastNonEmptyLine(deps.emulator.render()))
        : null;

    // 发送命令（POSIX 包裹隐形 OSC133 + nonce）
    if (usePosix) {
      nonce = makeNonce();
      const expr = exitCodeExpr(params.shell) ?? '$?';
      const marker = `printf '\\033]133;D;%s;tmex=${nonce}\\033\\\\' "${expr}"`;
      deps.sendInput(`${params.command}; ${marker}\r`);
    } else {
      deps.sendInput(`${params.command}\r`);
    }

    const expectRegex = params.expect ? new RegExp(params.expect) : null;
    const deadline = now() + timeoutMs;
    let idleStableSince = 0;
    let lastLen = 0;

    while (now() < deadline) {
      await sleepMs(POLL_MS);

      // alternate 屏（命令切进 TUI，如 vim/less）
      if (deps.emulator.isAlternateScreen()) {
        return finish({
          output: extractOutput(accumulated()).text,
          exitCode: null,
          status: 'entered_tui',
          likelyError: false,
          truncated: false,
        });
      }

      const rawNow = accumulated();
      const cleanedNow = cleanTerminalText(rawNow);

      // expect 命中
      if (expectRegex?.test(cleanedNow)) {
        const out = extractOutput(rawNow);
        return finish({
          output: out.text,
          exitCode: null,
          status: 'expect_matched',
          likelyError: false,
          truncated: out.truncated,
        });
      }

      // POSIX：等到带 nonce 的 D 标记
      if (usePosix && receivedMarker) {
        const out = extractOutput(rawNow);
        const err = detectError(out.text);
        return finish({
          output: out.text,
          exitCode: (receivedMarker as PromptMarker).exitCode,
          status: 'completed',
          ...err,
          truncated: out.truncated,
        });
      }

      // 分页：遇 --More-- 自动续翻
      if (MORE_MARKERS.some((re) => re.test(cleanedNow.slice(-200)))) {
        deps.sendInput(' ');
        idleStableSince = 0;
        continue;
      }

      // CLI / 非 POSIX：提示符在末尾重现 = 完成
      if (promptRegex) {
        const tail = lastNonEmptyLine(rawNow);
        const out = extractOutput(rawNow);
        if (promptRegex.test(tail) && out.text.length > 0) {
          const err = detectError(out.text);
          return finish({
            output: out.text,
            exitCode: null,
            status: 'completed',
            ...err,
            truncated: out.truncated,
          });
        }
      }

      // 输出静默判定（auto/posix 无标记回退）
      if (rawNow.length === lastLen) {
        if (idleStableSince === 0) {
          idleStableSince = now();
        } else if (now() - idleStableSince >= 600) {
          const out = extractOutput(rawNow);
          if (out.text.length > 0 || now() - idleStableSince >= 1500) {
            const err = detectError(out.text);
            return finish({
              output: out.text,
              exitCode: null,
              status: 'completed',
              ...err,
              truncated: out.truncated,
            });
          }
        }
      } else {
        idleStableSince = 0;
        lastLen = rawNow.length;
      }
    }

    // 超时
    const out = extractOutput(accumulated());
    return finish({
      output: out.text,
      exitCode: null,
      status: 'timeout',
      ...detectError(out.text),
      truncated: out.truncated,
    });
  } finally {
    untap();
  }
}

function buildPromptRegex(promptLine: string): RegExp | null {
  const trimmed = promptLine.trim();
  if (!trimmed) {
    return null;
  }
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${escaped}\\s*$`);
}
