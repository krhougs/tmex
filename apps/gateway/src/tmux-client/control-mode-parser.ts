const decoder = new TextDecoder();

const MAX_LINE_BYTES = 4 * 1024 * 1024;
const MAX_BLOCK_BODY_LINES = 1000;

const BYTE_LF = 0x0a;
const BYTE_SPACE = 0x20;
const BYTE_PERCENT = 0x25;
const BYTE_BACKSLASH = 0x5c;

export interface ControlModeNotification {
  type: string;
  args: string;
  raw: string;
}

export interface ControlModeBlock {
  args: string;
  isError: boolean;
  lines: string[];
}

export interface ControlModeParserCallbacks {
  onOutput: (paneId: string, data: Uint8Array) => void;
  onNotification: (notification: ControlModeNotification) => void;
  onExit: (reason: string | null) => void;
  onBlockEnd?: (block: ControlModeBlock) => void;
}

export interface ControlModeParser {
  push(chunk: Uint8Array): void;
  end(): void;
}

// 在 %begin/%end 块内也允许分发的通知类型；其余行视为命令回复正文。
const KNOWN_NOTIFICATION_TYPES = new Set([
  'client-detached',
  'client-session-changed',
  'config-error',
  'continue',
  'layout-change',
  'message',
  'pane-mode-changed',
  'paste-buffer-changed',
  'paste-buffer-deleted',
  'pause',
  'session-changed',
  'session-renamed',
  'session-window-changed',
  'sessions-changed',
  'subscription-changed',
  'unlinked-window-add',
  'unlinked-window-close',
  'unlinked-window-renamed',
  'window-add',
  'window-close',
  'window-pane-changed',
  'window-renamed',
]);

function isOctalDigit(byte: number): boolean {
  return byte >= 0x30 && byte <= 0x37;
}

// tmux control.c control_append_data：字节 <0x20 与 '\' 转义为 \ + 3 位八进制，
// >=0x80 的字节（UTF-8 等）原样输出，因此必须按字节反转义。
export function unescapeControlModeData(
  line: Uint8Array,
  start: number,
  onInvalidEscape?: () => void
): Uint8Array {
  const result = new Uint8Array(line.length - start);
  let written = 0;
  let index = start;
  while (index < line.length) {
    const byte = line[index] as number;
    if (byte !== BYTE_BACKSLASH) {
      result[written] = byte;
      written += 1;
      index += 1;
      continue;
    }
    const d1 = line[index + 1];
    const d2 = line[index + 2];
    const d3 = line[index + 3];
    if (
      d1 !== undefined &&
      d2 !== undefined &&
      d3 !== undefined &&
      isOctalDigit(d1) &&
      isOctalDigit(d2) &&
      isOctalDigit(d3)
    ) {
      result[written] = ((d1 - 0x30) << 6) | ((d2 - 0x30) << 3) | (d3 - 0x30);
      written += 1;
      index += 4;
      continue;
    }
    onInvalidEscape?.();
    result[written] = byte;
    written += 1;
    index += 1;
  }
  return result.subarray(0, written);
}

function concatChunks(chunks: Uint8Array[], totalLength: number): Uint8Array {
  if (chunks.length === 1) {
    return chunks[0] as Uint8Array;
  }
  const merged = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

export function createControlModeParser(callbacks: ControlModeParserCallbacks): ControlModeParser {
  let pendingChunks: Uint8Array[] = [];
  let pendingLength = 0;
  let discardingOversizedLine = false;
  let warnedOversizedLine = false;
  let warnedInvalidEscape = false;
  let warnedUnexpectedLine = false;
  let currentBlock: ControlModeBlock | null = null;

  function warnInvalidEscape(): void {
    if (!warnedInvalidEscape) {
      warnedInvalidEscape = true;
      console.warn('[tmex] control mode parser met invalid escape sequence, passing through');
    }
  }

  function findByte(line: Uint8Array, byte: number, from: number): number {
    for (let index = from; index < line.length; index += 1) {
      if (line[index] === byte) {
        return index;
      }
    }
    return -1;
  }

  function decodeRange(line: Uint8Array, start: number, end: number): string {
    return decoder.decode(line.subarray(start, end));
  }

  function handleOutputLine(line: Uint8Array, payloadStart: number): void {
    const paneEnd = findByte(line, BYTE_SPACE, payloadStart);
    if (paneEnd < 0) {
      return;
    }
    const paneId = decodeRange(line, payloadStart, paneEnd);
    callbacks.onOutput(paneId, unescapeControlModeData(line, paneEnd + 1, warnInvalidEscape));
  }

  function handleExtendedOutputLine(line: Uint8Array, payloadStart: number): void {
    const paneEnd = findByte(line, BYTE_SPACE, payloadStart);
    if (paneEnd < 0) {
      return;
    }
    const paneId = decodeRange(line, payloadStart, paneEnd);
    // 格式：%extended-output %<pane> <age> [...] : <data>，宽容查找首个 " : " 分隔符。
    for (let index = paneEnd; index + 2 < line.length; index += 1) {
      if (
        line[index] === BYTE_SPACE &&
        line[index + 1] === 0x3a &&
        line[index + 2] === BYTE_SPACE
      ) {
        callbacks.onOutput(paneId, unescapeControlModeData(line, index + 3, warnInvalidEscape));
        return;
      }
    }
  }

  function handleLine(line: Uint8Array): void {
    if (line.length === 0) {
      return;
    }

    if (line[0] !== BYTE_PERCENT) {
      if (currentBlock) {
        if (currentBlock.lines.length < MAX_BLOCK_BODY_LINES) {
          currentBlock.lines.push(decoder.decode(line));
        }
        return;
      }
      if (!warnedUnexpectedLine) {
        warnedUnexpectedLine = true;
        console.warn(
          `[tmex] control mode parser ignored unexpected line: ${decoder.decode(line.subarray(0, 80))}`
        );
      }
      return;
    }

    const typeEnd = findByte(line, BYTE_SPACE, 0);
    const type = typeEnd < 0 ? decodeRange(line, 1, line.length) : decodeRange(line, 1, typeEnd);
    const argsStart = typeEnd < 0 ? line.length : typeEnd + 1;

    switch (type) {
      case 'output':
        handleOutputLine(line, argsStart);
        return;
      case 'extended-output':
        handleExtendedOutputLine(line, argsStart);
        return;
      case 'begin': {
        if (currentBlock) {
          callbacks.onBlockEnd?.(currentBlock);
        }
        currentBlock = {
          args: decodeRange(line, argsStart, line.length),
          isError: false,
          lines: [],
        };
        return;
      }
      case 'end':
      case 'error': {
        if (!currentBlock) {
          return;
        }
        const args = decodeRange(line, argsStart, line.length);
        if (args !== currentBlock.args) {
          console.warn(
            `[tmex] control mode block guard mismatch: begin "${currentBlock.args}" vs ${type} "${args}"`
          );
        }
        currentBlock.isError = type === 'error';
        callbacks.onBlockEnd?.(currentBlock);
        currentBlock = null;
        return;
      }
      case 'exit': {
        const reason = argsStart < line.length ? decodeRange(line, argsStart, line.length) : null;
        callbacks.onExit(reason);
        return;
      }
      default: {
        if (currentBlock && !KNOWN_NOTIFICATION_TYPES.has(type)) {
          if (currentBlock.lines.length < MAX_BLOCK_BODY_LINES) {
            currentBlock.lines.push(decoder.decode(line));
          }
          return;
        }
        callbacks.onNotification({
          type,
          args: decodeRange(line, argsStart, line.length),
          raw: decoder.decode(line),
        });
        return;
      }
    }
  }

  function takePendingLine(tail: Uint8Array): Uint8Array {
    if (pendingLength === 0) {
      return tail;
    }
    pendingChunks.push(tail);
    const line = concatChunks(pendingChunks, pendingLength + tail.length);
    pendingChunks = [];
    pendingLength = 0;
    return line;
  }

  return {
    push(chunk) {
      let start = 0;
      while (start <= chunk.length) {
        const newlineIndex = findByte(chunk, BYTE_LF, start);
        if (newlineIndex < 0) {
          break;
        }
        const tail = chunk.subarray(start, newlineIndex);
        if (discardingOversizedLine) {
          discardingOversizedLine = false;
          pendingChunks = [];
          pendingLength = 0;
        } else {
          handleLine(takePendingLine(tail));
        }
        start = newlineIndex + 1;
      }

      if (start < chunk.length) {
        const rest = chunk.subarray(start);
        if (discardingOversizedLine) {
          return;
        }
        if (pendingLength + rest.length > MAX_LINE_BYTES) {
          if (!warnedOversizedLine) {
            warnedOversizedLine = true;
            console.warn('[tmex] control mode parser dropped oversized line');
          }
          discardingOversizedLine = true;
          pendingChunks = [];
          pendingLength = 0;
          return;
        }
        pendingChunks.push(rest);
        pendingLength += rest.length;
      }
    },
    end() {
      if (discardingOversizedLine || pendingLength === 0) {
        discardingOversizedLine = false;
        pendingChunks = [];
        pendingLength = 0;
        return;
      }
      const line = concatChunks(pendingChunks, pendingLength);
      pendingChunks = [];
      pendingLength = 0;
      handleLine(line);
    },
  };
}
