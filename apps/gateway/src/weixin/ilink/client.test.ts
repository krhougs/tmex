import { describe, expect, test } from 'bun:test';
import { WeixinClient, WeixinNoContextTokenError, WeixinSessionExpiredError } from './client';
import type { GetUpdatesResp, WeixinMessage } from './types';

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

const noopFetch = (async (_input: RequestInfo | URL, _init?: RequestInit) =>
  new Response('{}', { status: 200 })) as typeof fetch;

// 脚本化 fetch：按调用顺序返回响应体（最后一个会重复用于 sendmessage 等）。
function scriptedFetch(responses: unknown[], capture: CapturedRequest[]): typeof fetch {
  let i = 0;
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
    const body = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
}

function makeClient(fetchImpl: typeof fetch): WeixinClient {
  return new WeixinClient({
    accountId: 'acc-1',
    botToken: 'bot-tok',
    baseUrl: 'https://base.example',
    fetchImpl,
  });
}

function textMsg(from: string, ctx: string | null, text: string): WeixinMessage {
  return {
    from_user_id: from,
    ...(ctx ? { context_token: ctx } : {}),
    message_type: 1,
    message_state: 2,
    item_list: [{ type: 1, text_item: { text } }],
  };
}

describe('WeixinClient.extractText', () => {
  test('concatenates text items, ignores non-text', () => {
    const raw: WeixinMessage = {
      item_list: [
        { type: 1, text_item: { text: 'a' } },
        { type: 2 },
        { type: 1, text_item: { text: 'b' } },
      ],
    };
    expect(WeixinClient.extractText(raw)).toBe('ab');
  });

  test('returns empty for non-message input', () => {
    expect(WeixinClient.extractText(null)).toBe('');
    expect(WeixinClient.extractText({})).toBe('');
  });
});

describe('WeixinClient credentials', () => {
  test('credentials null without full creds', () => {
    const c = new WeixinClient({ accountId: 'a' });
    expect(c.credentials).toBeNull();
  });

  test('credentials populated when all provided', () => {
    const c = makeClient(noopFetch);
    expect(c.credentials).toEqual({
      accountId: 'acc-1',
      botToken: 'bot-tok',
      baseUrl: 'https://base.example',
    });
  });
});

describe('WeixinClient long-poll loop', () => {
  test('advances cursor, saves buf and caches context_token', async () => {
    const cap: CapturedRequest[] = [];
    const responses: GetUpdatesResp[] = [
      {
        ret: 0,
        msgs: [textMsg('alice@im.wechat', 'ctx-alice', 'hi')],
        get_updates_buf: 'cursor-2',
      },
    ];
    const fetchImpl = scriptedFetch(responses, cap);
    const client = makeClient(fetchImpl);

    const received: string[] = [];
    const saved: string[] = [];

    const controller = new AbortController();
    const runPromise = client.start({
      signal: controller.signal,
      saveSyncBuf: (buf) => {
        saved.push(buf);
        // 收到第一条后即停止循环
        controller.abort();
      },
      onMessage: (msg) => {
        received.push(msg.text);
      },
    });

    await runPromise;

    expect(received).toEqual(['hi']);
    expect(saved).toEqual(['cursor-2']);
    expect(client.getContextToken('alice@im.wechat')).toBe('ctx-alice');
    // 第二次 getupdates 应带上推进后的游标
    const updateCalls = cap.filter((c) => c.url.endsWith('/getupdates'));
    expect((updateCalls[0].body as { get_updates_buf: string }).get_updates_buf).toBe('');
    expect(client.isRunning()).toBe(false);
  });

  test('loads initial sync buf and initial context tokens', async () => {
    const cap: CapturedRequest[] = [];
    const fetchImpl = scriptedFetch([{ ret: 0, msgs: [], get_updates_buf: 'next' }], cap);
    const client = makeClient(fetchImpl);
    const controller = new AbortController();

    await client.start({
      signal: controller.signal,
      loadSyncBuf: () => 'persisted-cursor',
      initialContextTokens: { 'bob@im.wechat': 'ctx-bob' },
      saveSyncBuf: () => {
        controller.abort();
      },
    });

    const firstUpdate = cap.find((c) => c.url.endsWith('/getupdates'));
    expect((firstUpdate?.body as { get_updates_buf: string }).get_updates_buf).toBe(
      'persisted-cursor'
    );
    expect(client.getContextToken('bob@im.wechat')).toBe('ctx-bob');
  });

  test('session expired ret=-14 triggers onSessionExpired and throws', async () => {
    const cap: CapturedRequest[] = [];
    const fetchImpl = scriptedFetch([{ ret: -14, errmsg: 'session timeout' }], cap);
    const client = makeClient(fetchImpl);

    let expiredCalled = false;
    const controller = new AbortController();

    await expect(
      client.start({
        signal: controller.signal,
        onSessionExpired: () => {
          expiredCalled = true;
        },
      })
    ).rejects.toBeInstanceOf(WeixinSessionExpiredError);

    expect(expiredCalled).toBe(true);
    expect(client.isRunning()).toBe(false);
  });

  test('session expired via errcode=-14 also triggers', async () => {
    const cap: CapturedRequest[] = [];
    const fetchImpl = scriptedFetch([{ ret: 0, errcode: -14 }], cap);
    const client = makeClient(fetchImpl);
    let expiredCalled = false;

    await expect(
      client.start({
        onSessionExpired: () => {
          expiredCalled = true;
        },
      })
    ).rejects.toBeInstanceOf(WeixinSessionExpiredError);
    expect(expiredCalled).toBe(true);
  });

  test('network error fires onError then retries', async () => {
    const cap: CapturedRequest[] = [];
    let calls = 0;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      const url = typeof input === 'string' ? input : input.toString();
      cap.push({ url, method: init?.method ?? 'GET', headers: {}, body: undefined });
      if (calls === 1) {
        throw new Error('boom');
      }
      return new Response(JSON.stringify({ ret: 0, msgs: [], get_updates_buf: 'c' }));
    }) as typeof fetch;

    const client = makeClient(fetchImpl);
    const controller = new AbortController();
    const errors: unknown[] = [];

    // 缩短退避：用极小的 delay 不可行（常量内置），改为收到第二次成功响应即停。
    await client.start({
      signal: controller.signal,
      onError: (e) => errors.push(e),
      saveSyncBuf: () => controller.abort(),
    });

    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect((errors[0] as Error).message).toBe('boom');
    expect(calls).toBeGreaterThanOrEqual(2);
  }, 10_000);

  test('per-request timeout on a hung getupdates fires onError and reconnects', async () => {
    let calls = 0;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      if (calls === 1) {
        // 模拟 TCP 黑洞：永不正常返回，只在 per-request 超时 abort 时 reject
        const signal = init?.signal;
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => reject(new DOMException('timeout', 'AbortError')),
            { once: true }
          );
        });
      }
      return new Response(JSON.stringify({ ret: 0, msgs: [], get_updates_buf: 'c' }));
    }) as typeof fetch;

    const client = makeClient(fetchImpl);
    const controller = new AbortController();
    const errors: unknown[] = [];

    await client.start({
      signal: controller.signal,
      longpollTimeoutMs: 50,
      onError: (e) => errors.push(e),
      saveSyncBuf: () => controller.abort(),
    });

    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(client.isRunning()).toBe(false);
  }, 10_000);
});

describe('WeixinClient.sendText', () => {
  test('throws WeixinNoContextTokenError when no token cached', async () => {
    const client = makeClient(noopFetch);
    await expect(client.sendText('nobody@im.wechat', 'hi')).rejects.toBeInstanceOf(
      WeixinNoContextTokenError
    );
  });

  test('uses cached context token from setContextToken', async () => {
    const cap: CapturedRequest[] = [];
    const fetchImpl = scriptedFetch([{ ret: 0 }], cap);
    const client = makeClient(fetchImpl);
    client.setContextToken('carol@im.wechat', 'ctx-carol');

    await client.sendText('carol@im.wechat', 'reply');

    const sendCall = cap.find((c) => c.url.endsWith('/sendmessage'));
    expect(sendCall).toBeDefined();
    const body = sendCall?.body as {
      msg: { context_token: string; item_list: Array<{ text_item: { text: string } }> };
    };
    expect(body.msg.context_token).toBe('ctx-carol');
    expect(body.msg.item_list[0].text_item.text).toBe('reply');
  });

  test('explicit contextToken overrides cache', async () => {
    const cap: CapturedRequest[] = [];
    const fetchImpl = scriptedFetch([{ ret: 0 }], cap);
    const client = makeClient(fetchImpl);
    client.setContextToken('dave@im.wechat', 'cached');

    await client.sendText('dave@im.wechat', 'x', 'explicit');

    const sendCall = cap.find((c) => c.url.endsWith('/sendmessage'));
    const body = sendCall?.body as { msg: { context_token: string } };
    expect(body.msg.context_token).toBe('explicit');
  });

  test('generates unique client_id per send', async () => {
    const cap: CapturedRequest[] = [];
    const fetchImpl = scriptedFetch([{ ret: 0 }], cap);
    const client = makeClient(fetchImpl);
    client.setContextToken('erin@im.wechat', 'ctx');

    await client.sendText('erin@im.wechat', 'a');
    await client.sendText('erin@im.wechat', 'b');

    const sends = cap.filter((c) => c.url.endsWith('/sendmessage'));
    const id0 = (sends[0].body as { msg: { client_id: string } }).msg.client_id;
    const id1 = (sends[1].body as { msg: { client_id: string } }).msg.client_id;
    expect(id0).toMatch(/^openclaw-weixin-[0-9a-f]{32}$/);
    expect(id0).not.toBe(id1);
  });
});

describe('WeixinClient.login', () => {
  test('confirmed status yields credentials', async () => {
    const cap: CapturedRequest[] = [];
    const responses = [
      { ret: 0, qrcode: 'qr-1', qrcode_img_content: 'img-data' },
      { ret: 0, status: 'wait' },
      {
        ret: 0,
        status: 'confirmed',
        bot_token: 'new-token',
        baseurl: 'https://new.base',
        ilink_bot_id: 'bot-99',
      },
    ];
    const fetchImpl = scriptedFetch(responses, cap);
    const client = new WeixinClient({ fetchImpl });

    const qrCalls: Array<{ url: string; qrcodeId: string }> = [];
    const creds = await client.login({
      onQrcode: (q) => {
        qrCalls.push(q);
      },
      pollIntervalMs: 1,
      timeoutMs: 5_000,
    });

    expect(qrCalls[0]).toEqual({ url: 'img-data', qrcodeId: 'qr-1' });
    expect(creds).toEqual({
      accountId: 'bot-99',
      botToken: 'new-token',
      baseUrl: 'https://new.base',
    });
    expect(client.credentials).toEqual(creds);
  });

  test('transient getQrcodeStatus failure does not abort login (retries until confirmed)', async () => {
    let statusCalls = 0;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('get_bot_qrcode')) {
        return new Response(JSON.stringify({ ret: 0, qrcode: 'qr-1', qrcode_img_content: 'img' }));
      }
      statusCalls += 1;
      if (statusCalls === 1) {
        throw new Error('transient blip');
      }
      return new Response(
        JSON.stringify({
          ret: 0,
          status: 'confirmed',
          bot_token: 'bt',
          baseurl: 'https://b',
          ilink_bot_id: 'bid',
        })
      );
    }) as typeof fetch;

    const client = new WeixinClient({ fetchImpl });
    const creds = await client.login({
      onQrcode: () => {},
      pollIntervalMs: 1,
      timeoutMs: 5_000,
    });

    expect(statusCalls).toBeGreaterThanOrEqual(2);
    expect(creds.accountId).toBe('bid');
  }, 10_000);
});
