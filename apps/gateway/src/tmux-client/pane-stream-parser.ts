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
  | 'screen-title-st';

export type PaneStreamNotification = {
  source: 'osc9' | 'osc777' | 'osc1337';
  title?: string;
  body: string;
};

export interface PaneStreamParserOptions {
  onTitle: (title: string) => void;
  onBell: () => void;
  onNotification: (notification: PaneStreamNotification) => void;
}

export interface PaneStreamParser {
  push(data: Uint8Array): Uint8Array;
}

const MAX_OSC_KIND_BYTES = 16;
const MAX_OSC_PAYLOAD_BYTES = 8 * 1024;

export function createPaneStreamParser(options: PaneStreamParserOptions): PaneStreamParser {
  let phase: Phase = 'normal';
  let oscKind = '';
  let oscPayloadBytes: number[] = [];
  let titleBytes: number[] = [];
  let warnedOscPayloadOverflow = false;

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
      default:
        return;
    }
  }

  return {
    push(data) {
      const output: number[] = [];

      for (const byte of data) {
        if (phase === 'normal') {
          if (byte === 0x1b) {
            phase = 'esc';
            continue;
          }
          if (byte === 0x07) {
            options.onBell();
            continue;
          }
          output.push(byte);
          continue;
        }

        if (phase === 'esc') {
          if (byte === 0x5d) {
            resetOscState();
            phase = 'osc-params';
            continue;
          }
          if (byte === 0x6b) {
            titleBytes = [];
            phase = 'screen-title';
            continue;
          }
          output.push(0x1b, byte);
          phase = 'normal';
          continue;
        }

        if (phase === 'osc-params') {
          if (byte === 0x3b) {
            phase = oscKind === '0' || oscKind === '1' || oscKind === '2' || oscKind === '9' || oscKind === '777' || oscKind === '1337'
              ? 'osc-body'
              : 'osc-body-ignore';
            continue;
          }
          if (byte === 0x07) {
            emitOsc();
            resetOscState();
            phase = 'normal';
            continue;
          }
          if (byte === 0x1b) {
            phase = 'osc-st';
            continue;
          }
          if (oscKind.length >= MAX_OSC_KIND_BYTES) {
            resetOscState();
            phase = 'osc-body-ignore';
            continue;
          }
          oscKind += String.fromCharCode(byte);
          continue;
        }

        if (phase === 'osc-body') {
          if (byte === 0x07) {
            emitOsc();
            resetOscState();
            phase = 'normal';
            continue;
          }
          if (byte === 0x1b) {
            phase = 'osc-st';
            continue;
          }
          appendOscPayloadByte(byte);
          continue;
        }

        if (phase === 'osc-body-ignore') {
          if (byte === 0x07) {
            resetOscState();
            phase = 'normal';
            continue;
          }
          if (byte === 0x1b) {
            phase = 'osc-st-ignore';
          }
          continue;
        }

        if (phase === 'osc-st') {
          if (byte === 0x5c) {
            emitOsc();
            resetOscState();
            phase = 'normal';
            continue;
          }
          if (!appendOscPayloadByte(0x1b)) {
            continue;
          }
          appendOscPayloadByte(byte);
          continue;
        }

        if (phase === 'osc-st-ignore') {
          if (byte === 0x5c) {
            resetOscState();
            phase = 'normal';
            continue;
          }
          phase = 'osc-body-ignore';
          continue;
        }

        if (phase === 'screen-title') {
          if (byte === 0x07) {
            emitTitle(titleBytes);
            titleBytes = [];
            phase = 'normal';
            continue;
          }
          if (byte === 0x1b) {
            phase = 'screen-title-st';
            continue;
          }
          titleBytes.push(byte);
          continue;
        }

        if (byte === 0x5c) {
          emitTitle(titleBytes);
          titleBytes = [];
          phase = 'normal';
          continue;
        }

        titleBytes.push(0x1b, byte);
        phase = 'screen-title';
      }

      return new Uint8Array(output);
    },
  };
}
