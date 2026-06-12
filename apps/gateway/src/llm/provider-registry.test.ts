import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { generateText } from 'ai';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { encrypt } from '../crypto';
import { updateAgentSettings } from '../db/agent';
import { getDb as getOrmDb } from '../db/client';
import { type LlmProviderRecord, createLlmProvider } from '../db/llm';
import { fetchProviderModels, normalizeBaseUrl, resolveLanguageModel } from './provider-registry';

const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterAll(() => {
  for (const server of servers) {
    server.stop(true);
  }
});

interface MockUpstream {
  baseUrl: string;
  requests: Array<{ path: string; authorization: string | null }>;
}

function createMockUpstream(
  options: { modelsStatus?: number; modelsDelayMs?: number; modelsBody?: unknown } = {}
): MockUpstream {
  const requests: MockUpstream['requests'] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      requests.push({ path: url.pathname, authorization: req.headers.get('authorization') });

      if (url.pathname === '/v1/chat/completions') {
        return Response.json({
          id: 'chatcmpl-test',
          object: 'chat.completion',
          created: 1700000000,
          model: 'mock-model',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'chat-protocol-reply' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      }

      if (url.pathname === '/v1/responses') {
        return Response.json({
          id: 'resp_test',
          object: 'response',
          created_at: 1700000000,
          status: 'completed',
          error: null,
          model: 'mock-model',
          output: [
            {
              type: 'message',
              id: 'msg_test',
              status: 'completed',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'responses-protocol-reply', annotations: [] }],
            },
          ],
          usage: {
            input_tokens: 1,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: 1,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: 2,
          },
        });
      }

      if (url.pathname === '/v1/models') {
        if (options.modelsDelayMs) {
          await Bun.sleep(options.modelsDelayMs);
        }
        if (options.modelsStatus && options.modelsStatus !== 200) {
          return Response.json({ error: 'unauthorized' }, { status: options.modelsStatus });
        }
        return Response.json(
          options.modelsBody ?? {
            object: 'list',
            data: [{ id: 'zeta-model' }, { id: 'alpha-model' }, { id: 'mid-model' }],
          }
        );
      }

      return new Response('not found', { status: 404 });
    },
  });
  servers.push(server);
  return { baseUrl: `http://127.0.0.1:${server.port}/v1`, requests };
}

async function createTestProvider(
  baseUrl: string,
  overrides: Partial<Parameters<typeof createLlmProvider>[0]> = {}
): Promise<LlmProviderRecord> {
  return createLlmProvider({
    name: `test-${crypto.randomUUID().slice(0, 8)}`,
    protocol: 'openai-chat',
    baseUrl,
    apiKeyEnc: await encrypt('sk-test-key'),
    ...overrides,
  });
}

beforeAll(() => {
  migrate(getOrmDb(), { migrationsFolder: resolve(import.meta.dir, '../../drizzle') });
});

describe('normalizeBaseUrl', () => {
  test('strips trailing slashes and whitespace', () => {
    expect(normalizeBaseUrl('https://api.example.com/v1/')).toBe('https://api.example.com/v1');
    expect(normalizeBaseUrl(' https://api.example.com/v1// ')).toBe('https://api.example.com/v1');
    expect(normalizeBaseUrl('https://api.example.com/v1')).toBe('https://api.example.com/v1');
  });
});

describe('resolveLanguageModel', () => {
  test('openai-chat protocol produces a working model', async () => {
    const upstream = createMockUpstream();
    const provider = await createTestProvider(upstream.baseUrl);

    const model = await resolveLanguageModel(provider.id, 'mock-model');
    const result = await generateText({ model, prompt: 'hi' });

    expect(result.text).toBe('chat-protocol-reply');
    const chatRequest = upstream.requests.find((r) => r.path === '/v1/chat/completions');
    expect(chatRequest?.authorization).toBe('Bearer sk-test-key');
  });

  test('openai-responses protocol produces a working model', async () => {
    const upstream = createMockUpstream();
    const provider = await createTestProvider(upstream.baseUrl, { protocol: 'openai-responses' });

    const model = await resolveLanguageModel(provider.id, 'mock-model');
    const result = await generateText({ model, prompt: 'hi' });

    expect(result.text).toBe('responses-protocol-reply');
    const responsesRequest = upstream.requests.find((r) => r.path === '/v1/responses');
    expect(responsesRequest?.authorization).toBe('Bearer sk-test-key');
  });

  test('falls back to agent_settings defaults when args are null', async () => {
    const upstream = createMockUpstream();
    const provider = await createTestProvider(upstream.baseUrl);
    updateAgentSettings({ defaultProviderId: provider.id, defaultModelId: 'mock-model' });

    const model = await resolveLanguageModel(null, null);
    const result = await generateText({ model, prompt: 'hi' });
    expect(result.text).toBe('chat-protocol-reply');
  });

  test('throws when no provider/model and no defaults configured', async () => {
    updateAgentSettings({ defaultProviderId: null, defaultModelId: null });

    expect(resolveLanguageModel(null, 'some-model')).rejects.toThrow();
    expect(resolveLanguageModel(null, null)).rejects.toThrow();
  });

  test('throws for unknown provider id', async () => {
    expect(resolveLanguageModel(crypto.randomUUID(), 'mock-model')).rejects.toThrow();
  });

  test('throws for disabled provider', async () => {
    const upstream = createMockUpstream();
    const provider = await createTestProvider(upstream.baseUrl, { enabled: false });

    expect(resolveLanguageModel(provider.id, 'mock-model')).rejects.toThrow(provider.name);
  });
});

describe('fetchProviderModels', () => {
  test('parses and sorts model ids, handles trailing slash in baseUrl', async () => {
    const upstream = createMockUpstream();
    const models = await fetchProviderModels({
      baseUrl: `${upstream.baseUrl}/`,
      apiKeyEnc: await encrypt('sk-models-key'),
    });

    expect(models).toEqual(['alpha-model', 'mid-model', 'zeta-model']);
    const modelsRequest = upstream.requests.find((r) => r.path === '/v1/models');
    expect(modelsRequest?.authorization).toBe('Bearer sk-models-key');
  });

  test('throws on 401', async () => {
    const upstream = createMockUpstream({ modelsStatus: 401 });
    expect(
      fetchProviderModels({ baseUrl: upstream.baseUrl, apiKeyEnc: await encrypt('bad-key') })
    ).rejects.toThrow('HTTP 401');
  });

  test('throws on timeout', async () => {
    const upstream = createMockUpstream({ modelsDelayMs: 500 });
    expect(
      fetchProviderModels(
        { baseUrl: upstream.baseUrl, apiKeyEnc: await encrypt('sk-test-key') },
        { timeoutMs: 50 }
      )
    ).rejects.toThrow('timeout');
  });

  test('throws on unexpected response shape', async () => {
    const upstream = createMockUpstream({ modelsBody: { models: ['x'] } });
    expect(
      fetchProviderModels({ baseUrl: upstream.baseUrl, apiKeyEnc: await encrypt('sk-test-key') })
    ).rejects.toThrow();
  });
});
