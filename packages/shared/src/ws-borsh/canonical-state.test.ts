import { expect, test } from 'bun:test';
import {
  TERMINAL_KEY_MOD_CTRL,
  TERMINAL_KEY_MOD_SHIFT,
  decodeCanonicalCommandPayload,
  encodeCanonicalCommandPayload,
} from './canonical-state';
import { KIND_TERM_KEY_INPUT } from './kind';
import { TermKeyInputSchema } from './schema';

test('semantic key command appends variant and preserves modifier union', () => {
  const command = {
    TerminalKeyInput: {
      requestId: new Uint8Array(16).fill(1),
      pane: {
        deviceId: 'device-a',
        serverEpoch: new Uint8Array(16).fill(2),
        paneId: '%1',
      },
      paneEpoch: new Uint8Array(16).fill(3),
      inputId: new Uint8Array(16).fill(4),
      key: { Enter: {} },
      modifiers: TERMINAL_KEY_MOD_CTRL | TERMINAL_KEY_MOD_SHIFT,
      action: { Press: {} },
    },
  } as const;
  const encoded = encodeCanonicalCommandPayload(command);
  expect(encoded[2]).toBe(5);
  expect(decodeCanonicalCommandPayload(encoded).command).toEqual(command);
});

test('legacy semantic key payload uses new terminal kind without changing old kinds', () => {
  expect(KIND_TERM_KEY_INPUT).toBe(0x0308);
  const payload = TermKeyInputSchema.serialize({
    deviceId: 'device-a',
    paneId: '%1',
    key: { ArrowUp: {} },
    modifiers: TERMINAL_KEY_MOD_CTRL | TERMINAL_KEY_MOD_SHIFT,
    action: { Repeat: 3 },
  });
  expect(TermKeyInputSchema.deserialize(payload)).toEqual({
    deviceId: 'device-a',
    paneId: '%1',
    key: { ArrowUp: {} },
    modifiers: TERMINAL_KEY_MOD_CTRL | TERMINAL_KEY_MOD_SHIFT,
    action: { Repeat: 3 },
  });
});
