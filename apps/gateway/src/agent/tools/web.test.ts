import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { encrypt } from '../../crypto';
import { type AgentSettingsRecord, ensureAgentSettingsInitialized } from '../../db/agent';
import { getDb as getOrmDb } from '../../db/client';
import {
  createFetchUrlTool,
  createWebSearchTool,
  isPrivateHostname,
  validateFetchUrl,
} from './web';

type ExecutableTool = {
  execute: (input: unknown, options: unknown) => Promise<unknown>;
};

const execOptions = { toolCallId: 'call-1', messages: [] };

function baseSettings(overrides: Partial<AgentSettingsRecord>): AgentSettingsRecord {
  return {
    id: 1,
    searchProvider: 'none',
    tavilyApiKeyEnc: null,
    braveApiKeyEnc: null,
    defaultProviderId: null,
    defaultModelId: null,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterAll(() => {
  for (const server of servers) {
    server.stop(true);
  }
});

beforeAll(() => {
  migrate(getOrmDb(), { migrationsFolder: resolve(import.meta.dir, '../../../drizzle') });
  ensureAgentSettingsInitialized();
});

describe('isPrivateHostname / validateFetchUrl（SSRF 拒绝表）', () => {
  const rejected = [
    'localhost',
    'foo.localhost',
    '127.0.0.1',
    '127.1.2.3',
    '0.0.0.0',
    '10.0.0.1',
    '10.255.255.255',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '::1',
    '[::1]',
    'fd00::1',
    'fc00::1',
    'fe80::1',
  ];
  const allowed = [
    'example.com',
    '8.8.8.8',
    '172.15.0.1',
    '172.32.0.1',
    '11.0.0.1',
    '2606:4700::1111',
  ];

  for (const host of rejected) {
    test(`拒绝 ${host}`, () => {
      expect(isPrivateHostname(host)).toBe(true);
    });
  }

  for (const host of allowed) {
    test(`放行 ${host}`, () => {
      expect(isPrivateHostname(host)).toBe(false);
    });
  }

  test('validateFetchUrl 拒绝非 http/https 协议', () => {
    expect(validateFetchUrl('ftp://example.com')).toHaveProperty('error');
    expect(validateFetchUrl('file:///etc/passwd')).toHaveProperty('error');
    expect(validateFetchUrl('not a url')).toHaveProperty('error');
    expect(validateFetchUrl('https://example.com')).toHaveProperty('url');
  });

  test('validateFetchUrl 拒绝私有地址', () => {
    expect(validateFetchUrl('http://127.0.0.1:9883/api')).toHaveProperty('error');
    expect(validateFetchUrl('http://[::1]/x')).toHaveProperty('error');
  });

  test('TMEX_AGENT_ALLOW_PRIVATE_FETCH=1 时放行私有地址', () => {
    process.env.TMEX_AGENT_ALLOW_PRIVATE_FETCH = '1';
    try {
      expect(validateFetchUrl('http://127.0.0.1/x')).toHaveProperty('url');
    } finally {
      delete process.env.TMEX_AGENT_ALLOW_PRIVATE_FETCH;
    }
  });
});

describe('createWebSearchTool 注册条件', () => {
  test("searchProvider='none' 时不注册", async () => {
    const tool = await createWebSearchTool({ settings: baseSettings({ searchProvider: 'none' }) });
    expect(tool).toBeNull();
  });

  test('tavily 但未配置 key 时不注册', async () => {
    const tool = await createWebSearchTool({
      settings: baseSettings({ searchProvider: 'tavily', tavilyApiKeyEnc: null }),
    });
    expect(tool).toBeNull();
  });

  test('brave 但未配置 key 时不注册', async () => {
    const tool = await createWebSearchTool({
      settings: baseSettings({ searchProvider: 'brave', braveApiKeyEnc: null }),
    });
    expect(tool).toBeNull();
  });

  test('tavily 配置 key 时注册并请求 tavily endpoint', async () => {
    const requests: Array<{ url: string; auth: string | null; body: Record<string, unknown> }> = [];
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        requests.push({
          url: new URL(req.url).pathname,
          auth: req.headers.get('authorization'),
          body: (await req.json()) as Record<string, unknown>,
        });
        return Response.json({
          results: [
            { title: 'T1', url: 'https://a.example', content: 'snippet one' },
            { title: 'T2', url: 'https://b.example', content: 'snippet two' },
          ],
        });
      },
    });
    servers.push(server);

    const tool = await createWebSearchTool({
      settings: baseSettings({
        searchProvider: 'tavily',
        tavilyApiKeyEnc: await encrypt('tvly-key'),
      }),
      tavilyEndpoint: `http://127.0.0.1:${server.port}/search`,
    });
    expect(tool).not.toBeNull();

    const output = (await (tool as unknown as ExecutableTool).execute(
      { query: 'bun runtime' },
      execOptions
    )) as string;
    const parsed = JSON.parse(output) as Array<{ title: string; url: string; snippet: string }>;
    expect(parsed).toEqual([
      { title: 'T1', url: 'https://a.example', snippet: 'snippet one' },
      { title: 'T2', url: 'https://b.example', snippet: 'snippet two' },
    ]);

    expect(requests.length).toBe(1);
    expect(requests[0]!.auth).toBe('Bearer tvly-key');
    expect(requests[0]!.body.api_key).toBe('tvly-key');
    expect(requests[0]!.body.query).toBe('bun runtime');
    expect(requests[0]!.body.max_results).toBe(8);
  });

  test('brave 配置 key 时注册并带 X-Subscription-Token 请求', async () => {
    const requests: Array<{ q: string | null; token: string | null }> = [];
    const server = Bun.serve({
      port: 0,
      fetch: (req) => {
        const url = new URL(req.url);
        requests.push({
          q: url.searchParams.get('q'),
          token: req.headers.get('x-subscription-token'),
        });
        return Response.json({
          web: {
            results: [{ title: 'B1', url: 'https://c.example', description: 'desc' }],
          },
        });
      },
    });
    servers.push(server);

    const tool = await createWebSearchTool({
      settings: baseSettings({
        searchProvider: 'brave',
        braveApiKeyEnc: await encrypt('brave-key'),
      }),
      braveEndpoint: `http://127.0.0.1:${server.port}/res/v1/web/search`,
    });
    expect(tool).not.toBeNull();

    const output = (await (tool as unknown as ExecutableTool).execute(
      { query: 'tmux' },
      execOptions
    )) as string;
    expect(JSON.parse(output)).toEqual([
      { title: 'B1', url: 'https://c.example', snippet: 'desc' },
    ]);
    expect(requests[0]).toEqual({ q: 'tmux', token: 'brave-key' });
  });

  test('搜索接口报错时返回错误文本而非抛出', async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response('rate limited', { status: 429 }),
    });
    servers.push(server);

    const tool = await createWebSearchTool({
      settings: baseSettings({
        searchProvider: 'tavily',
        tavilyApiKeyEnc: await encrypt('tvly-key'),
      }),
      tavilyEndpoint: `http://127.0.0.1:${server.port}/search`,
    });
    const output = (await (tool as unknown as ExecutableTool).execute(
      { query: 'x' },
      execOptions
    )) as string;
    expect(output).toContain('Web search failed');
    expect(output).toContain('429');
  });
});

describe('fetch_url', () => {
  test('SSRF：私有地址直接拒绝', async () => {
    const tool = createFetchUrlTool() as unknown as ExecutableTool;
    const output = (await tool.execute({ url: 'http://192.168.1.1/admin' }, execOptions)) as string;
    expect(output).toContain('Refusing to fetch private/internal address');
  });

  test('HTML 抽取正文（去 script/style/nav）', async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          '<html><head><style>.x{color:red}</style><script>alert(1)</script></head>' +
            '<body><nav>menu items</nav><h1>Title</h1><p>Hello &amp; world</p>' +
            '<footer>footer text</footer></body></html>',
          { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
        ),
    });
    servers.push(server);
    // 私网防护会拦 127.0.0.1，测试中放行
    process.env.TMEX_AGENT_ALLOW_PRIVATE_FETCH = '1';
    try {
      const tool = createFetchUrlTool() as unknown as ExecutableTool;
      const output = (await tool.execute(
        { url: `http://127.0.0.1:${server.port}/page` },
        execOptions
      )) as string;
      expect(output).toContain('Title');
      expect(output).toContain('Hello & world');
      expect(output).not.toContain('alert(1)');
      expect(output).not.toContain('color:red');
      expect(output).not.toContain('menu items');
      expect(output).not.toContain('footer text');
    } finally {
      delete process.env.TMEX_AGENT_ALLOW_PRIVATE_FETCH;
    }
  });

  test('非 HTML 文本直接返回并截断到 16KB', async () => {
    const big = 'a'.repeat(64 * 1024);
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response(big, { headers: { 'Content-Type': 'text/plain' } }),
    });
    servers.push(server);
    process.env.TMEX_AGENT_ALLOW_PRIVATE_FETCH = '1';
    try {
      const tool = createFetchUrlTool() as unknown as ExecutableTool;
      const output = (await tool.execute(
        { url: `http://127.0.0.1:${server.port}/file.txt` },
        execOptions
      )) as string;
      expect(new TextEncoder().encode(output).length).toBeLessThanOrEqual(16 * 1024 + 32);
      expect(output).toContain('[truncated]');
    } finally {
      delete process.env.TMEX_AGENT_ALLOW_PRIVATE_FETCH;
    }
  });

  test('重定向到私有地址在跳转前被拒绝', async () => {
    const requestedUrls: string[] = [];
    const fetchImpl: typeof fetch = (async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      requestedUrls.push(url);
      return new Response(null, {
        status: 302,
        headers: { Location: 'http://169.254.169.254/latest/meta-data' },
      });
    }) as typeof fetch;

    const tool = createFetchUrlTool({ fetchImpl }) as unknown as ExecutableTool;
    const output = (await tool.execute(
      { url: 'http://public.example.com/redirect' },
      execOptions
    )) as string;

    expect(output).toContain('Refusing to fetch private/internal address');
    // 只有第一跳真正发出请求，metadata 地址未被访问
    expect(requestedUrls).toEqual(['http://public.example.com/redirect']);
  });

  test('超过最大重定向次数报错', async () => {
    let counter = 0;
    const fetchImpl: typeof fetch = (async () => {
      counter += 1;
      return new Response(null, {
        status: 302,
        headers: { Location: `http://public.example.com/hop${counter}` },
      });
    }) as typeof fetch;

    const tool = createFetchUrlTool({ fetchImpl }) as unknown as ExecutableTool;
    const output = (await tool.execute(
      { url: 'http://public.example.com/start' },
      execOptions
    )) as string;
    expect(output).toContain('too many redirects');
  });

  test('HTTP 错误码返回错误文本', async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response('nope', { status: 503 }),
    });
    servers.push(server);
    process.env.TMEX_AGENT_ALLOW_PRIVATE_FETCH = '1';
    try {
      const tool = createFetchUrlTool() as unknown as ExecutableTool;
      const output = (await tool.execute(
        { url: `http://127.0.0.1:${server.port}/x` },
        execOptions
      )) as string;
      expect(output).toContain('HTTP 503');
    } finally {
      delete process.env.TMEX_AGENT_ALLOW_PRIVATE_FETCH;
    }
  });
});
