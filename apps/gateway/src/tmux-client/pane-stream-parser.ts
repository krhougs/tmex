const decoder = new TextDecoder();

type Phase =
  | 'normal'
  | 'esc'
  | 'osc-params'
  | 'osc-body'
  | 'osc-body-ignore'
  | 'osc-st'
  | 'osc-st-ignore'
  | 'screen-title'
  | 'screen-title-st'
  | 'dcs-detect'
  | 'dcs-tmux'
  | 'dcs-tmux-esc'
  | 'dcs-tmux-ignore'
  | 'dcs-tmux-ignore-esc';

export type PaneStreamNotification = {
  source: 'osc9' | 'osc99' | 'osc777' | 'osc1337';
  title?: string;
  body: string;
};

// OSC 133 语义提示符标记（FinalTerm / shell 集成）：A 提示符开始 / B 命令开始 /
// C 输出开始 / D 命令结束（带退出码）。run_command 据此划分命令块。
export type PromptMarker = {
  kind: 'A' | 'B' | 'C' | 'D';
  exitCode: number | null;
  // kind 之后的分号分隔参数（如 D 的退出码、我们注入的 tmex=<nonce>）
  params: string[];
};

export interface PaneStreamParserOptions {
  onTitle: (title: string) => void;
  onBell: () => void;
  onNotification: (notification: PaneStreamNotification) => void;
  onPromptMarker?: (marker: PromptMarker) => void;
}

export interface PaneStreamParser {
  push(data: Uint8Array): Uint8Array;
}

const MAX_OSC_KIND_BYTES = 16;
const MAX_OSC_PAYLOAD_BYTES = 8 * 1024;
const MAX_DCS_PASSTHROUGH_BYTES = 64 * 1024;
const MAX_KITTY_PENDING_IDS = 16;
const TMUX_PASSTHROUGH_PREFIX = 'tmux;';

export function createPaneStreamParser(options: PaneStreamParserOptions): PaneStreamParser {
  let phase: Phase = 'normal';
  let oscKind = '';
  let oscPayloadBytes: number[] = [];
  let titleBytes: number[] = [];
  let warnedOscPayloadOverflow = false;
  let warnedDcsOverflow = false;
  let dcsPrefix = '';
  let dcsBytes: number[] = [];
  const kittyPending = new Map<string, { title: string; body: string }>();

  function resetOscState(): void {
    oscKind = '';
    oscPayloadBytes = [];
  }

  function appendOscPayloadByte(byte: number): boolean {
    if (oscPayloadBytes.length >= MAX_OSC_PAYLOAD_BYTES) {
      if (!warnedOscPayloadOverflow) {
        warnedOscPayloadOverflow = true;
        console.warn('[tmex] pane stream parser dropped oversized OSC payload');
      }
      oscPayloadBytes = [];
      phase = 'osc-body-ignore';
      return false;
    }
    oscPayloadBytes.push(byte);
    return true;
  }

  function emitTitle(bytes: number[]): void {
    const title = decoder.decode(new Uint8Array(bytes)).trim();
    if (!title) {
      return;
    }
    options.onTitle(title);
  }

  function emitOsc(): void {
    const payload = decoder.decode(new Uint8Array(oscPayloadBytes));
    switch (oscKind) {
      case '0':
      case '1':
      case '2':
        emitTitle(oscPayloadBytes);
        return;
      case '9':
        if (/^4(;|$)/.test(payload)) {
          return;
        }
        options.onNotification({ source: 'osc9', body: payload });
        return;
      case '99': {
        const metadataSeparatorIndex = payload.indexOf(';');
        const metadata =
          metadataSeparatorIndex >= 0 ? payload.slice(0, metadataSeparatorIndex) : payload;
        const content =
          metadataSeparatorIndex >= 0 ? payload.slice(metadataSeparatorIndex + 1) : '';
        const fields = new Map<string, string>();
        for (const part of metadata.split(':')) {
          const equalsIndex = part.indexOf('=');
          if (equalsIndex > 0) {
            fields.set(part.slice(0, equalsIndex), part.slice(equalsIndex + 1));
          }
        }
        const id = fields.get('i') ?? '0';
        const done = fields.get('d') !== '0';
        const part = fields.get('p') ?? 'body';
        const pending = kittyPending.get(id) ?? { title: '', body: '' };
        if (part === 'title') {
          pending.title += content;
        } else if (part === 'body') {
          pending.body += content;
        }
        if (!done) {
          if (!kittyPending.has(id) && kittyPending.size >= MAX_KITTY_PENDING_IDS) {
            const oldestId = kittyPending.keys().next().value;
            if (oldestId !== undefined) {
              kittyPending.delete(oldestId);
            }
          }
          kittyPending.set(id, pending);
          return;
        }
        kittyPending.delete(id);
        if (pending.title || pending.body) {
          options.onNotification({
            source: 'osc99',
            title: pending.title || undefined,
            body: pending.body,
          });
        }
        return;
      }
      case '777': {
        const verbSeparatorIndex = payload.indexOf(';');
        const verb = verbSeparatorIndex >= 0 ? payload.slice(0, verbSeparatorIndex) : payload;
        if (verb !== 'notify') {
          return;
        }
        const rest = verbSeparatorIndex >= 0 ? payload.slice(verbSeparatorIndex + 1) : '';
        const titleSeparatorIndex = rest.indexOf(';');
        const title = titleSeparatorIndex >= 0 ? rest.slice(0, titleSeparatorIndex) : rest;
        const body = titleSeparatorIndex >= 0 ? rest.slice(titleSeparatorIndex + 1) : '';
        options.onNotification({
          source: 'osc777',
          title: title || undefined,
          body,
        });
        return;
      }
      case '1337':
        if (/^RequestAttention=(yes|once|fireworks|true)$/i.test(payload)) {
          options.onNotification({ source: 'osc1337', body: 'RequestAttention' });
        }
        return;
      case '133': {
        const parts = payload.split(';');
        const kind = parts[0];
        if (kind !== 'A' && kind !== 'B' && kind !== 'C' && kind !== 'D') {
          return;
        }
        let exitCode: number | null = null;
        if (kind === 'D' && parts[1] !== undefined && parts[1] !== '') {
          const parsed = Number.parseInt(parts[1], 10);
          exitCode = Number.isNaN(parsed) ? null : parsed;
        }
        options.onPromptMarker?.({ kind, exitCode, params: parts.slice(1) });
        return;
      }
      default:
        return;
    }
  }

  return {
    push(data) {
      const output: number[] = [];

      function flushTmuxPassthrough(): void {
        const content = dcsBytes;
        dcsBytes = [];
        dcsPrefix = '';
        phase = 'normal';
        for (const byte of content) {
          processByte(byte);
        }
      }

      function appendDcsByte(byte: number): boolean {
        if (dcsBytes.length >= MAX_DCS_PASSTHROUGH_BYTES) {
          if (!warnedDcsOverflow) {
            warnedDcsOverflow = true;
            console.warn('[tmex] pane stream parser dropped oversized tmux passthrough payload');
          }
          dcsBytes = [];
          phase = 'dcs-tmux-ignore';
          return false;
        }
        dcsBytes.push(byte);
        return true;
      }

      function processByte(byte: number): void {
        if (phase === 'normal') {
          if (byte === 0x1b) {
            phase = 'esc';
            return;
          }
          if (byte === 0x07) {
            options.onBell();
            return;
          }
          output.push(byte);
          return;
        }

        if (phase === 'esc') {
          if (byte === 0x5d) {
            resetOscState();
            phase = 'osc-params';
            return;
          }
          if (byte === 0x6b) {
            titleBytes = [];
            phase = 'screen-title';
            return;
          }
          if (byte === 0x50) {
            dcsPrefix = '';
            phase = 'dcs-detect';
            return;
          }
          output.push(0x1b, byte);
          phase = 'normal';
          return;
        }

        if (phase === 'dcs-detect') {
          const expected = TMUX_PASSTHROUGH_PREFIX.charCodeAt(dcsPrefix.length);
          if (byte === expected) {
            dcsPrefix += String.fromCharCode(byte);
            if (dcsPrefix.length === TMUX_PASSTHROUGH_PREFIX.length) {
              dcsBytes = [];
              phase = 'dcs-tmux';
            }
            return;
          }
          output.push(0x1b, 0x50);
          for (const prefixChar of dcsPrefix) {
            output.push(prefixChar.charCodeAt(0));
          }
          dcsPrefix = '';
          phase = 'normal';
          processByte(byte);
          return;
        }

        if (phase === 'dcs-tmux') {
          if (byte === 0x1b) {
            phase = 'dcs-tmux-esc';
            return;
          }
          appendDcsByte(byte);
          return;
        }

        if (phase === 'dcs-tmux-esc') {
          if (byte === 0x5c) {
            flushTmuxPassthrough();
            return;
          }
          if (byte === 0x1b) {
            phase = 'dcs-tmux';
            appendDcsByte(0x1b);
            return;
          }
          phase = 'dcs-tmux';
          if (appendDcsByte(0x1b)) {
            appendDcsByte(byte);
          }
          return;
        }

        if (phase === 'dcs-tmux-ignore') {
          if (byte === 0x1b) {
            phase = 'dcs-tmux-ignore-esc';
          }
          return;
        }

        if (phase === 'dcs-tmux-ignore-esc') {
          if (byte === 0x5c) {
            dcsBytes = [];
            dcsPrefix = '';
            phase = 'normal';
            return;
          }
          if (byte !== 0x1b) {
            phase = 'dcs-tmux-ignore';
          }
          return;
        }

        if (phase === 'osc-params') {
          if (byte === 0x3b) {
            phase =
              oscKind === '0' ||
              oscKind === '1' ||
              oscKind === '2' ||
              oscKind === '9' ||
              oscKind === '99' ||
              oscKind === '133' ||
              oscKind === '777' ||
              oscKind === '1337'
                ? 'osc-body'
                : 'osc-body-ignore';
            return;
          }
          if (byte === 0x07) {
            emitOsc();
            resetOscState();
            phase = 'normal';
            return;
          }
          if (byte === 0x1b) {
            phase = 'osc-st';
            return;
          }
          if (oscKind.length >= MAX_OSC_KIND_BYTES) {
            resetOscState();
            phase = 'osc-body-ignore';
            return;
          }
          oscKind += String.fromCharCode(byte);
          return;
        }

        if (phase === 'osc-body') {
          if (byte === 0x07) {
            emitOsc();
            resetOscState();
            phase = 'normal';
            return;
          }
          if (byte === 0x1b) {
            phase = 'osc-st';
            return;
          }
          appendOscPayloadByte(byte);
          return;
        }

        if (phase === 'osc-body-ignore') {
          if (byte === 0x07) {
            resetOscState();
            phase = 'normal';
            return;
          }
          if (byte === 0x1b) {
            phase = 'osc-st-ignore';
          }
          return;
        }

        if (phase === 'osc-st') {
          if (byte === 0x5c) {
            emitOsc();
            resetOscState();
            phase = 'normal';
            return;
          }
          phase = 'osc-body';
          if (appendOscPayloadByte(0x1b)) {
            appendOscPayloadByte(byte);
          }
          return;
        }

        if (phase === 'osc-st-ignore') {
          if (byte === 0x5c) {
            resetOscState();
            phase = 'normal';
            return;
          }
          phase = 'osc-body-ignore';
          return;
        }

        if (phase === 'screen-title') {
          if (byte === 0x07) {
            emitTitle(titleBytes);
            titleBytes = [];
            phase = 'normal';
            return;
          }
          if (byte === 0x1b) {
            phase = 'screen-title-st';
            return;
          }
          titleBytes.push(byte);
          return;
        }

        if (byte === 0x5c) {
          emitTitle(titleBytes);
          titleBytes = [];
          phase = 'normal';
          return;
        }

        titleBytes.push(0x1b, byte);
        phase = 'screen-title';
      }

      for (const byte of data) {
        processByte(byte);
      }

      return new Uint8Array(output);
    },
  };
}
