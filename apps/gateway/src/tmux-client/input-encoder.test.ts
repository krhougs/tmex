import { describe, expect, test } from 'bun:test';

import { SEND_KEYS_HEX_CHUNK_BYTES, encodeInputToHexChunks } from './input-encoder';

describe('input encoder', () => {
  test('encodes utf-8 input into tmux send-keys hex chunks', () => {
    expect(encodeInputToHexChunks('A中')).toEqual([['41', 'e4', 'b8', 'ad']]);
  });

  test('splits long payloads at 256 bytes to match tmux send-keys -H behavior', () => {
    const chunks = encodeInputToHexChunks('a'.repeat(SEND_KEYS_HEX_CHUNK_BYTES + 1));

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(SEND_KEYS_HEX_CHUNK_BYTES);
    expect(chunks[1]).toEqual(['61']);
  });
});
