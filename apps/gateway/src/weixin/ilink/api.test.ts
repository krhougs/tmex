import { describe, expect, test } from 'bun:test';
import {
  buildAuthHeaders,
  generateWechatUin,
  getBotQrcode,
  getQrcodeStatus,
  getUpdates,
  sendMessage,
} from './api';

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function mockFetch(responseBody: unknown, capture: CapturedRequest[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const headers: Record<string, string> = {};
    if (init?.headers) {
      for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
        headers[k] = v;
      }
    }
    capture.push({
      url,
      method: init?.method ?? 'GET',
      headers,
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
}

function isValidBase64(s: string): boolean {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return false;
  try {
    Buffer.from(s, 'base64').toString('utf8');
    return true;
  } catch {
    return false;
  }
}

describe('iLink api headers', () => {
  test('buildAuthHeaders includes auth type, content-type and valid base64 X-WECHAT-UIN', () => {
    const headers = buildAuthHeaders('tok-123');
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers.AuthorizationType).toBe('ilink_bot_token');
    expect(headers.Authorization).toBe('Bearer tok-123');
    expect(typeof headers['X-WECHAT-UIN']).toBe('string');
    expect(isValidBase64(headers['X-WECHAT-UIN'])).toBe(true);
  });

  test('buildAuthHeaders omits Authorization when no token', () => {
    const headers = buildAuthHeaders();
    expect(headers.Authorization).toBeUndefined();
  });

  test('generateWechatUin decodes to a decimal uint32 string', () => {
    const uin = generateWechatUin();
    const decoded = Buffer.from(uin, 'base64').toString('utf8');
    expect(/^\d+$/.test(decoded)).toBe(true);
    const n = Number(decoded);
    expect(Number.isInteger(n)).toBe(true);
    expect(n).toBeGreaterThanOrEqual(0);
    expect(n).toBeLessThanOrEqual(0xffffffff);
  });
});

describe('getBotQrcode', () => {
  test('GETs get_bot_qrcode with bot_type=3', async () => {
    const cap: CapturedRequest[] = [];
    const resp = await getBotQrcode({
      fetchImpl: mockFetch({ ret: 0, qrcode: 'qr-1', qrcode_img_content: 'img' }, cap),
    });
    expect(cap[0].method).toBe('GET');
    expect(cap[0].url).toBe('https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3');
    expect(resp.qrcode).toBe('qr-1');
    expect(resp.qrcode_img_content).toBe('img');
  });
});

describe('getQrcodeStatus', () => {
  test('GETs get_qrcode_status with qrcode query', async () => {
    const cap: CapturedRequest[] = [];
    const resp = await getQrcodeStatus('qr space/1', {
      fetchImpl: mockFetch(
        { ret: 0, status: 'confirmed', bot_token: 'bt', baseurl: 'https://b' },
        cap
      ),
    });
    expect(cap[0].url).toBe(
      'https://ilinkai.weixin.qq.com/ilink/bot/get_qrcode_status?qrcode=qr%20space%2F1'
    );
    expect(resp.status).toBe('confirmed');
    expect(resp.bot_token).toBe('bt');
  });
});

describe('getUpdates', () => {
  test('POSTs getupdates with cursor and base_info', async () => {
    const cap: CapturedRequest[] = [];
    const resp = await getUpdates({
      baseUrl: 'https://base.example/',
      botToken: 'token-abc',
      getUpdatesBuf: 'cursor-1',
      fetchImpl: mockFetch(
        { ret: 0, msgs: [], get_updates_buf: 'cursor-2', longpolling_timeout_ms: 35000 },
        cap
      ),
    });
    expect(cap[0].method).toBe('POST');
    expect(cap[0].url).toBe('https://base.example/ilink/bot/getupdates');
    expect(cap[0].headers.Authorization).toBe('Bearer token-abc');
    const body = cap[0].body as { get_updates_buf: string; base_info: { channel_version: string } };
    expect(body.get_updates_buf).toBe('cursor-1');
    expect(body.base_info.channel_version).toBe('1.0.3');
    expect(resp.get_updates_buf).toBe('cursor-2');
  });

  test('defaults empty cursor when not provided', async () => {
    const cap: CapturedRequest[] = [];
    await getUpdates({
      baseUrl: 'https://base.example',
      botToken: 'token-abc',
      fetchImpl: mockFetch({ ret: 0 }, cap),
    });
    const body = cap[0].body as { get_updates_buf: string };
    expect(body.get_updates_buf).toBe('');
  });
});

describe('sendMessage', () => {
  test('POSTs sendmessage with correct headers and msg shape', async () => {
    const cap: CapturedRequest[] = [];
    await sendMessage({
      baseUrl: 'https://base.example',
      botToken: 'token-xyz',
      toUserId: 'user@im.wechat',
      contextToken: 'ctx-1',
      clientId: 'openclaw-weixin-deadbeef',
      items: [{ text: 'hello' }],
      fetchImpl: mockFetch({ ret: 0 }, cap),
    });

    const req = cap[0];
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://base.example/ilink/bot/sendmessage');
    expect(req.headers['Content-Type']).toBe('application/json');
    expect(req.headers.AuthorizationType).toBe('ilink_bot_token');
    expect(req.headers.Authorization).toBe('Bearer token-xyz');
    expect(isValidBase64(req.headers['X-WECHAT-UIN'])).toBe(true);

    const body = req.body as {
      msg: {
        to_user_id: string;
        message_type: number;
        message_state: number;
        context_token: string;
        client_id: string;
        item_list: Array<{ type: number; text_item: { text: string } }>;
      };
      base_info: { channel_version: string };
    };
    expect(body.msg.to_user_id).toBe('user@im.wechat');
    expect(body.msg.message_type).toBe(2);
    expect(body.msg.message_state).toBe(2);
    expect(body.msg.context_token).toBe('ctx-1');
    expect(body.msg.client_id).toBe('openclaw-weixin-deadbeef');
    expect(body.msg.item_list[0].type).toBe(1);
    expect(body.msg.item_list[0].text_item.text).toBe('hello');
    expect(body.base_info.channel_version).toBe('1.0.3');
  });
});

describe('non-2xx handling (readJson throws status-bearing error)', () => {
  const statusFetch = (status: number, body = ''): typeof fetch =>
    (async () => new Response(body, { status })) as typeof fetch;

  test('getUpdates rejects on 5xx empty body (not a silent {} success)', async () => {
    await expect(
      getUpdates({
        baseUrl: 'https://base.example',
        botToken: 't',
        fetchImpl: statusFetch(502, ''),
      })
    ).rejects.toThrow(/HTTP 502/);
  });

  test('sendMessage rejects on 5xx so caller does not treat it as delivered', async () => {
    await expect(
      sendMessage({
        baseUrl: 'https://base.example',
        botToken: 't',
        toUserId: 'u',
        contextToken: 'c',
        clientId: 'openclaw-weixin-x',
        items: [{ text: 'hi' }],
        fetchImpl: statusFetch(500, 'oops'),
      })
    ).rejects.toThrow(/HTTP 500/);
  });
});
