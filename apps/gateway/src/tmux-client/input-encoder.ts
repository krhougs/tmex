const encoder = new TextEncoder();

export const SEND_KEYS_HEX_CHUNK_BYTES = 256;

export function encodeInputToHexChunks(
  input: string,
  chunkBytes = SEND_KEYS_HEX_CHUNK_BYTES
): string[][] {
  const bytes = encoder.encode(input);
  const chunks: string[][] = [];

  for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
    const chunk = bytes.slice(offset, offset + chunkBytes);
    chunks.push(Array.from(chunk, (byte) => byte.toString(16).padStart(2, '0')));
  }

  return chunks;
}
