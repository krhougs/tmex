import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import type {
  AgentLlmSettingsDto,
  LlmProviderDto,
  RefreshLlmProviderModelsResponse,
} from '@tmex/shared';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { decrypt } from '../crypto';
import { getAgentSettings } from '../db/agent';
import { getDb as getOrmDb } from '../db/client';
import { getLlmProviderById } from '../db/llm';
import { handleLlmApiRequest } from './llm';

const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterAll(() => {
  for (const server of servers) {
    server.stop(true);
  }
});

function createMockModelsServer(options: { status?: number; models?: string[] } = {}) {
  const server = Bun.serve({
    port: 0,
    fetch: (req) => {
      const url = new URL(req.url);
      if (url.pathname === '/v1/models') {
        if (options.status && options.status !== 200) {
          return Response.json({ error: 'nope' }, { status: options.status });
        }
        return Response.json({
          object: 'list',
          data: (options.models ?? ['model-b', 'model-a']).map((id) => ({ id })),
        });
      }
      return new Response('not found', { status: 404 });
    },
  });
  servers.push(server);
  return { baseUrl: `http://127.0.0.1:${server.port}/v1` };
}

function callApi(method: string, path: string, body?: unknown): Response | Promise<Response> {
  const req = new Request(`http://localhost${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const response = handleLlmApiRequest(req, path);
  if (!response) {
    throw new Error(`no handler matched: ${method} ${path}`);
  }
  return response;
}

beforeAll(() => {
  migrate(getOrmDb(), { migrationsFolder: resolve(import.meta.dir, '../../drizzle') });
});

describe('llm provider api', () => {
  test('create provider auto-fetches models and never echoes api key', async () => {
    const upstream = createMockModelsServer({ models: ['gpt-x', 'gpt-a'] });

    const response = await callApi('POST', '/api/llm/providers', {
      name: 'openai-main',
      protocol: 'openai-chat',
      baseUrl: upstream.baseUrl,
      apiKey: 'sk-secret-key',
    });

    expect(response.status).toBe(201);
    const payload = (await response.json()) as { provider: LlmProviderDto; modelsError?: string };
    expect(payload.modelsError).toBeUndefined();
    expect(payload.provider.name).toBe('openai-main');
    expect(payload.provider.hasApiKey).toBe(true);
    expect(payload.provider.models).toEqual(['gpt-a', 'gpt-x']);
    expect(payload.provider.modelsFetchedAt).not.toBeNull();
    expect(JSON.stringify(payload)).not.toContain('sk-secret-key');
    expect((payload.provider as unknown as Record<string, unknown>).apiKeyEnc).toBeUndefined();

    const stored = getLlmProviderById(payload.provider.id);
    expect(await decrypt(stored?.apiKeyEnc ?? '')).toBe('sk-secret-key');
  });

  test('create provider succeeds with modelsError when models fetch fails', async () => {
    const upstream = createMockModelsServer({ status: 401 });

    const response = await callApi('POST', '/api/llm/providers', {
      name: 'broken-upstream',
      protocol: 'openai-chat',
      baseUrl: upstream.baseUrl,
      apiKey: 'sk-bad',
    });

    expect(response.status).toBe(201);
    const payload = (await response.json()) as { provider: LlmProviderDto; modelsError?: string };
    expect(payload.modelsError).toContain('401');
    expect(payload.provider.models).toEqual([]);
  });

  test('create provider validation errors', async () => {
    const cases: Array<Record<string, unknown>> = [
      { name: '', protocol: 'openai-chat', baseUrl: 'https://x.test/v1', apiKey: 'k' },
      { name: 'a', protocol: 'grpc', baseUrl: 'https://x.test/v1', apiKey: 'k' },
      { name: 'a', protocol: 'openai-chat', baseUrl: 'ftp://x.test/v1', apiKey: 'k' },
      { name: 'a', protocol: 'openai-chat', baseUrl: 'https://x.test/v1', apiKey: '' },
    ];

    for (const body of cases) {
      const response = await callApi('POST', '/api/llm/providers', body);
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: string }).error).toBeString();
    }
  });

  test('list providers returns hasApiKey without secrets', async () => {
    const response = await callApi('GET', '/api/llm/providers');
    expect(response.status).toBe(200);

    const payload = (await response.json()) as { providers: LlmProviderDto[] };
    expect(payload.providers.length).toBeGreaterThanOrEqual(1);
    for (const provider of payload.providers) {
      expect(provider.hasApiKey).toBe(true);
      expect((provider as unknown as Record<string, unknown>).apiKeyEnc).toBeUndefined();
    }
    expect(JSON.stringify(payload)).not.toContain('sk-secret-key');
  });

  test('patch provider: omitted/empty apiKey keeps existing key, baseUrl change refetches models', async () => {
    const upstream = createMockModelsServer({ models: ['m1'] });
    const createResponse = await callApi('POST', '/api/llm/providers', {
      name: 'patch-target',
      protocol: 'openai-chat',
      baseUrl: upstream.baseUrl,
      apiKey: 'sk-original',
    });
    const created = ((await createResponse.json()) as { provider: LlmProviderDto }).provider;

    // 只改名字：不重拉模型、key 不变
    const renameResponse = await callApi('PATCH', `/api/llm/providers/${created.id}`, {
      name: 'patch-renamed',
      apiKey: '',
    });
    expect(renameResponse.status).toBe(200);
    const renamed = ((await renameResponse.json()) as { provider: LlmProviderDto }).provider;
    expect(renamed.name).toBe('patch-renamed');
    expect(await decrypt(getLlmProviderById(created.id)?.apiKeyEnc ?? '')).toBe('sk-original');

    // 改 baseUrl：自动重拉模型
    const upstream2 = createMockModelsServer({ models: ['m2', 'm0'] });
    const moveResponse = await callApi('PATCH', `/api/llm/providers/${created.id}`, {
      baseUrl: upstream2.baseUrl,
    });
    expect(moveResponse.status).toBe(200);
    const moved = ((await moveResponse.json()) as { provider: LlmProviderDto }).provider;
    expect(moved.models).toEqual(['m0', 'm2']);

    // 改 apiKey：生效且重拉
    const rekeyResponse = await callApi('PATCH', `/api/llm/providers/${created.id}`, {
      apiKey: 'sk-rotated',
    });
    expect(rekeyResponse.status).toBe(200);
    expect(await decrypt(getLlmProviderById(created.id)?.apiKeyEnc ?? '')).toBe('sk-rotated');
  });

  test('patch provider validation and 404', async () => {
    const missing = await callApi('PATCH', `/api/llm/providers/${crypto.randomUUID()}`, {
      name: 'x',
    });
    expect(missing.status).toBe(404);

    const upstream = createMockModelsServer();
    const createResponse = await callApi('POST', '/api/llm/providers', {
      name: 'patch-invalid',
      protocol: 'openai-chat',
      baseUrl: upstream.baseUrl,
      apiKey: 'sk-k',
    });
    const created = ((await createResponse.json()) as { provider: LlmProviderDto }).provider;

    const badProtocol = await callApi('PATCH', `/api/llm/providers/${created.id}`, {
      protocol: 'grpc',
    });
    expect(badProtocol.status).toBe(400);

    const badBaseUrl = await callApi('PATCH', `/api/llm/providers/${created.id}`, {
      baseUrl: 'not-a-url',
    });
    expect(badBaseUrl.status).toBe(400);
  });

  test('refresh-models endpoint returns sorted models and updates cache', async () => {
    const upstream = createMockModelsServer({ models: ['c-model', 'a-model'] });
    const createResponse = await callApi('POST', '/api/llm/providers', {
      name: 'refresh-target',
      protocol: 'openai-responses',
      baseUrl: upstream.baseUrl,
      apiKey: 'sk-k',
    });
    const created = ((await createResponse.json()) as { provider: LlmProviderDto }).provider;

    const response = await callApi('POST', `/api/llm/providers/${created.id}/refresh-models`);
    expect(response.status).toBe(200);
    const payload = (await response.json()) as RefreshLlmProviderModelsResponse;
    expect(payload.models).toEqual(['a-model', 'c-model']);
    expect(getLlmProviderById(created.id)?.modelsCache).toEqual(['a-model', 'c-model']);

    const missing = await callApi(
      'POST',
      `/api/llm/providers/${crypto.randomUUID()}/refresh-models`
    );
    expect(missing.status).toBe(404);
  });

  test('refresh-models surfaces upstream failure', async () => {
    const upstream = createMockModelsServer({ status: 500 });
    const createResponse = await callApi('POST', '/api/llm/providers', {
      name: 'refresh-broken',
      protocol: 'openai-chat',
      baseUrl: upstream.baseUrl,
      apiKey: 'sk-k',
    });
    const created = ((await createResponse.json()) as { provider: LlmProviderDto }).provider;

    const response = await callApi('POST', `/api/llm/providers/${created.id}/refresh-models`);
    expect(response.status).toBe(502);
    expect(((await response.json()) as { error: string }).error).toContain('500');
  });

  test('delete provider', async () => {
    const upstream = createMockModelsServer();
    const createResponse = await callApi('POST', '/api/llm/providers', {
      name: 'delete-target',
      protocol: 'openai-chat',
      baseUrl: upstream.baseUrl,
      apiKey: 'sk-k',
    });
    const created = ((await createResponse.json()) as { provider: LlmProviderDto }).provider;

    const response = await callApi('DELETE', `/api/llm/providers/${created.id}`);
    expect(response.status).toBe(200);
    expect(getLlmProviderById(created.id)).toBeNull();

    const missing = await callApi('DELETE', `/api/llm/providers/${created.id}`);
    expect(missing.status).toBe(404);
  });
});

describe('llm settings api', () => {
  test('get settings returns boolean key flags only', async () => {
    const response = await callApi('GET', '/api/llm/settings');
    expect(response.status).toBe(200);

    const payload = (await response.json()) as { settings: AgentLlmSettingsDto };
    expect(payload.settings.searchProvider).toBeString();
    expect(payload.settings.hasTavilyApiKey).toBeBoolean();
    expect(payload.settings.hasBraveApiKey).toBeBoolean();
    const raw = payload.settings as unknown as Record<string, unknown>;
    expect(raw.tavilyApiKeyEnc).toBeUndefined();
    expect(raw.braveApiKeyEnc).toBeUndefined();
  });

  test('patch settings: search keys follow omit=keep, empty=clear', async () => {
    const setResponse = await callApi('PATCH', '/api/llm/settings', {
      searchProvider: 'tavily',
      tavilyApiKey: 'tvly-secret',
    });
    expect(setResponse.status).toBe(200);
    const set = ((await setResponse.json()) as { settings: AgentLlmSettingsDto }).settings;
    expect(set.searchProvider).toBe('tavily');
    expect(set.hasTavilyApiKey).toBe(true);
    expect(JSON.stringify(set)).not.toContain('tvly-secret');
    expect(await decrypt(getAgentSettings().tavilyApiKeyEnc ?? '')).toBe('tvly-secret');

    // 缺省不改
    const keepResponse = await callApi('PATCH', '/api/llm/settings', { searchProvider: 'brave' });
    const kept = ((await keepResponse.json()) as { settings: AgentLlmSettingsDto }).settings;
    expect(kept.hasTavilyApiKey).toBe(true);

    // 空串清除
    const clearResponse = await callApi('PATCH', '/api/llm/settings', { tavilyApiKey: '' });
    const cleared = ((await clearResponse.json()) as { settings: AgentLlmSettingsDto }).settings;
    expect(cleared.hasTavilyApiKey).toBe(false);
    expect(getAgentSettings().tavilyApiKeyEnc).toBeNull();
  });

  test('patch settings: default provider validation and clearing', async () => {
    const invalid = await callApi('PATCH', '/api/llm/settings', {
      defaultProviderId: crypto.randomUUID(),
    });
    expect(invalid.status).toBe(400);

    const upstream = createMockModelsServer();
    const createResponse = await callApi('POST', '/api/llm/providers', {
      name: 'default-candidate',
      protocol: 'openai-chat',
      baseUrl: upstream.baseUrl,
      apiKey: 'sk-k',
    });
    const created = ((await createResponse.json()) as { provider: LlmProviderDto }).provider;

    const valid = await callApi('PATCH', '/api/llm/settings', {
      defaultProviderId: created.id,
      defaultModelId: 'model-a',
    });
    expect(valid.status).toBe(200);
    const settings = ((await valid.json()) as { settings: AgentLlmSettingsDto }).settings;
    expect(settings.defaultProviderId).toBe(created.id);
    expect(settings.defaultModelId).toBe('model-a');

    const clearedResponse = await callApi('PATCH', '/api/llm/settings', {
      defaultProviderId: null,
      defaultModelId: null,
    });
    const cleared = ((await clearedResponse.json()) as { settings: AgentLlmSettingsDto }).settings;
    expect(cleared.defaultProviderId).toBeNull();
    expect(cleared.defaultModelId).toBeNull();
  });

  test('patch settings rejects invalid search provider', async () => {
    const response = await callApi('PATCH', '/api/llm/settings', { searchProvider: 'google' });
    expect(response.status).toBe(400);
  });

  test('unmatched llm paths return null from handler', () => {
    const req = new Request('http://localhost/api/llm/unknown', { method: 'GET' });
    expect(handleLlmApiRequest(req, '/api/llm/unknown')).toBeNull();
  });
});
