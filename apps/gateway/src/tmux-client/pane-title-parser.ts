const decoder = new TextDecoder();

type Phase = 'normal' | 'esc' | 'osc' | 'osc-data' | 'osc-st';

interface PaneTitleParserOptions {
  onTitle: (title: string) => void;
}

export interface PaneTitleParser {
  push(data: Uint8Array): Uint8Array;
}

export function createPaneTitleParser(options: PaneTitleParserOptions): PaneTitleParser {
  let phase: Phase = 'normal';
  let oscKind = '';
  let titleBytes: number[] = [];

  return {
    push(data) {
      const output: number[] = [];

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
          if (byte === 0x5d) {
            phase = 'osc';
            oscKind = '';
            titleBytes = [];
            continue;
          }

          output.push(0x1b, byte);
          phase = 'normal';
          continue;
        }

        if (phase === 'osc') {
          if (byte === 0x3b) {
            phase = oscKind === '0' || oscKind === '2' ? 'osc-data' : 'normal';
            if (phase === 'normal') {
              output.push(0x1b, 0x5d, ...encoderFromString(oscKind), 0x3b);
            }
            continue;
          }

          oscKind += String.fromCharCode(byte);
          continue;
        }

        if (phase === 'osc-data') {
          if (byte === 0x07) {
            emitTitle(options.onTitle, titleBytes);
            phase = 'normal';
            continue;
          }
          if (byte === 0x1b) {
            phase = 'osc-st';
            continue;
          }

          titleBytes.push(byte);
          continue;
        }

        if (byte === 0x5c) {
          emitTitle(options.onTitle, titleBytes);
          phase = 'normal';
          continue;
        }

        titleBytes.push(0x1b, byte);
        phase = 'osc-data';
      }

      return new Uint8Array(output);
    },
  };
}

function emitTitle(onTitle: (title: string) => void, titleBytes: number[]): void {
  const title = decoder.decode(new Uint8Array(titleBytes)).trim();
  if (!title) {
    return;
  }
  onTitle(title);
}

function encoderFromString(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}
