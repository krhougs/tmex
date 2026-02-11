/**
 * tmux -CC 控制模式协议解析器
 *
 * tmux -CC 输出格式：
 * - %window-add <id>
 * - %window-close <id>
 * - %window-renamed <id> <name>
 * - %pane-mode-changed <id>
 * - %pane-close <id>
 * - %session-changed <id> <name>
 * - %sessions-changed
 * - %layout-change <window-id> <layout>
 * - %output <pane-id> <data>
 * - %bell <window-id>
 * - ... 等等
 *
 * 同时会输出普通终端数据（直接发送到 pane）
 */

import type { TmuxEventType } from '@tmex/shared';

export interface TmuxEvent {
  type: TmuxEventType;
  data: unknown;
}

export interface TmuxOutputBlock {
  time: number;
  commandNo: number;
  flags: number;
  lines: string[];
  isError: boolean;
}

export interface TmuxControlParserOptions {
  onEvent: (event: TmuxEvent) => void;
  onTerminalOutput: (paneId: string, data: Uint8Array) => void;
  onPaneTitle?: (paneId: string, title: string) => void;
  onOutputBlock?: (block: TmuxOutputBlock) => void;
  onNonControlOutput?: (line: string) => void;
  onExit?: (reason: string | null) => void;
  onReady?: () => void;
}

interface TitleParseState {
  phase: 'normal' | 'esc' | 'title' | 'titleEsc';
  titleBytes: number[];
}

function isSameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) {
      return false;
    }
  }
  return true;
}

export function decodeTmuxEscapedValue(value: string): Uint8Array {
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  let cursor = 0;

  for (let i = 0; i < value.length; i++) {
    if (value[i] !== '\\') {
      continue;
    }

    const octal = value.slice(i + 1, i + 4);
    if (!/^[0-7]{3}$/.test(octal)) {
      continue;
    }

    if (cursor < i) {
      bytes.push(...encoder.encode(value.slice(cursor, i)));
    }

    bytes.push(Number.parseInt(octal, 8));
    i += 3;
    cursor = i + 1;
  }

  if (cursor < value.length) {
    bytes.push(...encoder.encode(value.slice(cursor)));
  }

  return new Uint8Array(bytes);
}

function stripTmuxDcsWrapper(line: string): string {
  let cleanLine = line;

  cleanLine = cleanLine.replace(/^\u001bP\d+p/, '');

  if (cleanLine.endsWith('\u001b\\')) {
    cleanLine = cleanLine.slice(0, -2);
  } else if (cleanLine.endsWith('\u009c')) {
    cleanLine = cleanLine.slice(0, -1);
  }

  return cleanLine;
}

export class TmuxControlParser {
  private buffer = '';
  private onEvent: (event: TmuxEvent) => void;
  private onTerminalOutput: (paneId: string, data: Uint8Array) => void;
  private onPaneTitle?: (paneId: string, title: string) => void;
  private onOutputBlock?: (block: TmuxOutputBlock) => void;
  private onNonControlOutput?: (line: string) => void;
  private onExit?: (reason: string | null) => void;
  private onReady?: () => void;

  private inOutputBlock = false;
  private outputBlockMeta: { time: number; commandNo: number; flags: number } | null = null;
  private outputBlockLines: string[] = [];
  private readyNotified = false;
  private lastOutputEndedWithCR = false;
  private lastOutputFrame: { mode: 'output' | 'extended'; paneId: string; data: Uint8Array } | null =
    null;
  private outputTitleStates = new Map<string, TitleParseState>();

  constructor(options: TmuxControlParserOptions) {
    this.onEvent = options.onEvent;
    this.onTerminalOutput = options.onTerminalOutput;
    this.onPaneTitle = options.onPaneTitle;
    this.onOutputBlock = options.onOutputBlock;
    this.onNonControlOutput = options.onNonControlOutput;
    this.onExit = options.onExit;
    this.onReady = options.onReady;
  }

  /**
   * 处理从 tmux -CC 接收到的数据
   */
  processData(data: Uint8Array | string): void {
    const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
    this.buffer += text;
    this.parseBuffer();
  }

  private parseBuffer(): void {
    // tmux -CC 协议按换行分隔控制消息；保留行内的 \r，避免破坏 TUI 重绘序列
    while (true) {
      const nlIndex = this.buffer.indexOf('\n');
      if (nlIndex === -1) break;

      let line = this.buffer.slice(0, nlIndex);
      this.buffer = this.buffer.slice(nlIndex + 1);

      if (line.endsWith('\r')) {
        line = line.slice(0, -1);
      }

      // 忽略空行
      if (line) {
        this.parseLine(line);
      }
    }
  }

  private parseLine(line: string): void {
    const cleanLine = stripTmuxDcsWrapper(line);

    if (this.inOutputBlock) {
      if (cleanLine.startsWith('%end') || cleanLine.startsWith('%error')) {
        this.finishOutputBlock(cleanLine);
        return;
      }
      this.outputBlockLines.push(cleanLine);
      return;
    }

    // 非输出块时忽略空行
    if (!cleanLine.trim()) return;

    if (cleanLine.startsWith('%begin')) {
      this.startOutputBlock(cleanLine);
      return;
    }

    // 检查是否以 % 开头（tmux 控制序列）
    if (cleanLine.startsWith('%')) {
      this.parseControlLine(cleanLine);
      this.notifyReady();
      return;
    }

    // 普通输出：通常来自 SSH shell 回显或异常信息
    this.onNonControlOutput?.(cleanLine);
    console.log('[tmux] non-control output:', cleanLine);
  }

  private notifyReady(): void {
    if (this.readyNotified) return;
    this.readyNotified = true;
    this.onReady?.();
  }

  private startOutputBlock(line: string): void {
    const meta = this.parseOutputBlockMeta(line);
    if (!meta) {
      return;
    }

    this.inOutputBlock = true;
    this.outputBlockMeta = meta;
    this.outputBlockLines = [];
  }

  private finishOutputBlock(line: string): void {
    const meta = this.parseOutputBlockMeta(line);
    const currentMeta = this.outputBlockMeta;

    this.inOutputBlock = false;
    this.outputBlockMeta = null;

    if (currentMeta && meta) {
      this.onOutputBlock?.({
        time: currentMeta.time,
        commandNo: currentMeta.commandNo,
        flags: currentMeta.flags,
        lines: this.outputBlockLines,
        isError: line.startsWith('%error'),
      });
    }

    this.outputBlockLines = [];
    this.notifyReady();
  }

  private parseOutputBlockMeta(line: string): { time: number; commandNo: number; flags: number } | null {
    const spaceIndex = line.indexOf(' ');
    if (spaceIndex === -1) return null;
    const args = line.slice(spaceIndex + 1).trim();
    const parts = args.split(/\s+/);
    if (parts.length < 3) return null;
    const time = Number(parts[0]);
    const commandNo = Number(parts[1]);
    const flags = Number(parts[2]);
    if (Number.isNaN(time) || Number.isNaN(commandNo) || Number.isNaN(flags)) return null;
    return { time, commandNo, flags };
  }

  private normalizeTerminalOutputNewline(data: Uint8Array): Uint8Array {
    const startWithCR = this.lastOutputEndedWithCR;
    let previousWasCR = startWithCR;
    let extraCRCount = 0;

    for (const byte of data) {
      if (byte === 0x0a && !previousWasCR) {
        extraCRCount += 1;
      }
      previousWasCR = byte === 0x0d;
    }

    this.lastOutputEndedWithCR = previousWasCR;

    if (extraCRCount === 0) {
      return data;
    }

    const normalized = new Uint8Array(data.length + extraCRCount);
    let writeIndex = 0;
    previousWasCR = startWithCR;

    for (const byte of data) {
      if (byte === 0x0a && !previousWasCR) {
        normalized[writeIndex] = 0x0d;
        writeIndex += 1;
      }
      normalized[writeIndex] = byte;
      writeIndex += 1;
      previousWasCR = byte === 0x0d;
    }

    return normalized;
  }

  private getTitleParseState(paneId: string): TitleParseState {
    const existing = this.outputTitleStates.get(paneId);
    if (existing) {
      return existing;
    }

    const created: TitleParseState = {
      phase: 'normal',
      titleBytes: [],
    };
    this.outputTitleStates.set(paneId, created);
    return created;
  }

  private emitPaneTitleIfNeeded(paneId: string, titleBytes: number[]): void {
    if (titleBytes.length === 0) {
      return;
    }

    const title = new TextDecoder().decode(new Uint8Array(titleBytes)).trim();
    if (!title) {
      return;
    }

    this.onPaneTitle?.(paneId, title);
  }

  private stripScreenTitleSequence(paneId: string, data: Uint8Array): Uint8Array {
    if (data.length === 0) {
      return data;
    }

    const parseState = this.getTitleParseState(paneId);
    const output: number[] = [];
    let phase = parseState.phase;
    const titleBytes = parseState.titleBytes;

    for (const byte of data) {
      if (phase === 'normal') {
        if (byte === 0x1b) {
          phase = 'esc';
        } else {
          output.push(byte);
        }
        continue;
      }

      if (phase === 'esc') {
        if (byte === 0x6b) {
          phase = 'title';
          titleBytes.length = 0;
          continue;
        }

        output.push(0x1b);
        if (byte === 0x1b) {
          phase = 'esc';
        } else {
          output.push(byte);
          phase = 'normal';
        }
        continue;
      }

      if (phase === 'title') {
        if (byte === 0x1b) {
          phase = 'titleEsc';
        } else {
          titleBytes.push(byte);
        }
        continue;
      }

      if (byte === 0x5c) {
        this.emitPaneTitleIfNeeded(paneId, titleBytes);
        titleBytes.length = 0;
        phase = 'normal';
      } else if (byte === 0x1b) {
        phase = 'titleEsc';
      } else {
        titleBytes.push(0x1b, byte);
        phase = 'title';
      }
    }

    parseState.phase = phase;
    return new Uint8Array(output);
  }

  private emitTerminalOutput(
    mode: 'output' | 'extended',
    paneId: string,
    data: Uint8Array
  ): void {
    const last = this.lastOutputFrame;
    const isCrossModeDuplicate =
      last !== null &&
      last.mode !== mode &&
      last.paneId === paneId &&
      isSameBytes(last.data, data);

    if (!isCrossModeDuplicate) {
      this.onTerminalOutput(paneId, data);
    }

    this.lastOutputFrame = {
      mode,
      paneId,
      data: data.slice(),
    };
  }

  private parseControlLine(line: string): void {
    // 解析格式: %command args...
    const spaceIndex = line.indexOf(' ');
    const command = spaceIndex === -1 ? line : line.slice(0, spaceIndex);
    const args = spaceIndex === -1 ? '' : line.slice(spaceIndex + 1);

    switch (command) {
      case '%window-add':
      case '%unlinked-window-add':
        this.onEvent({ type: 'window-add', data: { windowId: args } });
        break;

      case '%window-close':
      case '%unlinked-window-close':
        this.onEvent({ type: 'window-close', data: { windowId: args } });
        break;

      case '%window-renamed':
      case '%unlinked-window-renamed': {
        const parts = this.parseArgs(args);
        this.onEvent({
          type: 'window-renamed',
          data: { windowId: parts[0], name: parts[1] },
        });
        break;
      }

      case '%window-pane-changed': {
        const parts = this.parseArgs(args);
        this.onEvent({
          type: 'pane-active',
          data: { windowId: parts[0], paneId: parts[1] },
        });
        break;
      }

      case '%pane-close':
        this.onEvent({ type: 'pane-close', data: { paneId: args } });
        break;

      case '%pane-add': {
        const parts = this.parseArgs(args);
        this.onEvent({
          type: 'pane-add',
          data: {
            paneId: parts[0] ?? args,
            windowId: parts[1],
          },
        });
        break;
      }

      case '%pane-mode-changed':
        // Pane 模式变化（如进入/退出复制模式）
        break;

      case '%session-changed': {
        const parts = this.parseArgs(args);
        this.onEvent({
          type: 'window-add', // 映射到 window-add 或创建新类型
          data: { sessionId: parts[0], name: parts[1] },
        });
        break;
      }

      case '%sessions-changed':
        // 会话列表变化
        break;

      case '%session-window-changed': {
        // 当前会话的活跃窗口变化
        const parts = this.parseArgs(args);
        this.onEvent({
          type: 'window-active',
          data: { sessionId: parts[0], windowId: parts[1] },
        });
        break;
      }

      case '%layout-change': {
        const parts = this.parseArgs(args);
        this.onEvent({
          type: 'layout-change',
          data: { windowId: parts[0], layout: parts[1] },
        });
        break;
      }

      case '%output': {
        // 格式: %output <pane-id> <value>
        // value escapes non-printable characters and backslash as octal \xxx
        const firstSpace = args.indexOf(' ');
        if (firstSpace !== -1) {
          const paneId = args.slice(0, firstSpace);
          const value = args.slice(firstSpace + 1);
          const decoded = decodeTmuxEscapedValue(value);
          const stripped = this.stripScreenTitleSequence(paneId, decoded);
          const normalized = this.normalizeTerminalOutputNewline(stripped);
          this.emitTerminalOutput('output', paneId, normalized);
        }
        break;
      }

      case '%extended-output': {
        // 格式: %extended-output <pane-id> <age> ... : <value>
        const firstSpace = args.indexOf(' ');
        if (firstSpace === -1) break;
        const paneId = args.slice(0, firstSpace);
        const colonIndex = args.indexOf(' : ');
        if (colonIndex === -1) break;
        const value = args.slice(colonIndex + 3);
        const decoded = decodeTmuxEscapedValue(value);
        const stripped = this.stripScreenTitleSequence(paneId, decoded);
        const normalized = this.normalizeTerminalOutputNewline(stripped);
        this.emitTerminalOutput('extended', paneId, normalized);
        break;
      }

      case '%exit':
        this.onExit?.(args.trim() ? args : null);
        break;

      case '%bell':
        break;

      case '%pause':
      case '%resume':
        // 暂停/恢复输出
        break;

      case '%client-session-changed':
      case '%client-detached':
      case 'lient-session-changed':
      case 'lient-detached':
        // 处理 %client-* 事件（包括可能被截断的情况）
        break;

      default:
        console.log('[tmux] unknown control sequence:', command, args);
    }
  }

  /**
   * 解析带引号的参数
   * 支持格式: arg1 "arg with spaces" arg3
   */
  private parseArgs(args: string): string[] {
    const result: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < args.length; i++) {
      const char = args[i];

      if (char === '"' && args[i - 1] !== '\\') {
        inQuotes = !inQuotes;
      } else if (char === ' ' && !inQuotes) {
        if (current) {
          result.push(current);
          current = '';
        }
      } else {
        current += char;
      }
    }

    if (current) {
      result.push(current);
    }

    return result;
  }

  /**
   * 清空缓冲区
   */
  flush(): void {
    this.buffer = '';
    this.lastOutputEndedWithCR = false;
    this.lastOutputFrame = null;
    this.outputTitleStates.clear();
  }
}
