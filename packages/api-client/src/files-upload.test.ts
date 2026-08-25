import { describe, expect, test } from 'bun:test';
import { ApiClient } from './client';
import { uploadFileChunked } from './files';

describe('uploadFileChunked', () => {
  test('sends paste-image kind and declared size during initiate and returns uploaded path', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const client = new ApiClient('', async (url, init) => {
      requests.push({ url, init });
      if (url === '/api/files/upload/init') {
        return Response.json({ uploadId: 'upload-1', chunkSize: 8 * 1024 * 1024 });
      }
      if (url.startsWith('/api/files/upload/upload-1?')) {
        return Response.json({ received: 4 });
      }
      if (url === '/api/files/upload/upload-1/commit') {
        return new Response(
          `${JSON.stringify({ type: 'done', uploaded: '/work/paste.png' })}\n`,
          { headers: { 'Content-Type': 'application/x-ndjson' } }
        );
      }
      return new Response(null, { status: 404 });
    });
    const file = new File([new Uint8Array([1, 2, 3, 4])], 'paste.png', {
      type: 'image/png',
    });

    const uploaded = await uploadFileChunked(
      'root-1',
      '/work',
      file,
      { kind: 'paste-image' },
      client
    );

    expect(uploaded).toBe('/work/paste.png');
    const init = requests.find((request) => request.url === '/api/files/upload/init');
    expect(init).toBeDefined();
    expect(JSON.parse(String(init?.init?.body))).toEqual({
      rootId: 'root-1',
      path: '/work',
      name: 'paste.png',
      size: 4,
      kind: 'paste-image',
    });
  });
});
