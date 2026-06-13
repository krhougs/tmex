// LLM Provider 实测：打真实 endpoint 拉模型列表 + 跑一次真实 chat。
// 凭证来自 test.env.local：TEST_LLM_BASE_URL / TEST_LLM_API_KEY / TEST_LLM_MODEL
// （可选 TEST_LLM_PROTOCOL，默认 openai-chat）。缺失则报错退出（见 requireLiveEnv）。
//
// 运行：bun run --filter @tmex/gateway test:live:llm

import { beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { generateText } from 'ai';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { encrypt } from '../crypto';
import { getDb as getOrmDb } from '../db/client';
import { type LlmProviderProtocol, createLlmProvider } from '../db/llm';
import { requireLiveEnv } from '../test-support/live-env';
import { fetchProviderModels, resolveLanguageModel } from './provider-registry';

const env = requireLiveEnv(
  ['TEST_LLM_BASE_URL', 'TEST_LLM_API_KEY', 'TEST_LLM_MODEL'],
  'TEST_LLM_BASE_URL 填 OpenAI 兼容 base（裸 host 会自动补 /v1），TEST_LLM_MODEL 填一个可用模型 id。'
);

const protocol = (process.env.TEST_LLM_PROTOCOL?.trim() ?? 'openai-chat') as LlmProviderProtocol;

beforeAll(() => {
  migrate(getOrmDb(), { migrationsFolder: resolve(import.meta.dir, '../../drizzle') });
});

async function createLiveProvider() {
  return createLlmProvider({
    name: `live-${crypto.randomUUID().slice(0, 8)}`,
    protocol,
    baseUrl: env.TEST_LLM_BASE_URL,
    apiKeyEnc: await encrypt(env.TEST_LLM_API_KEY),
  });
}

describe('LLM provider live integration', () => {
  test('fetchProviderModels 拉到非空模型列表', async () => {
    const provider = await createLiveProvider();
    const models = await fetchProviderModels(provider);

    expect(Array.isArray(models)).toBe(true);
    expect(models.length).toBeGreaterThan(0);
    expect(models).toContain(env.TEST_LLM_MODEL);
  });

  test(`resolveLanguageModel + generateText 真实对话（protocol=${protocol}）`, async () => {
    const provider = await createLiveProvider();
    const model = await resolveLanguageModel(provider.id, env.TEST_LLM_MODEL);

    const result = await generateText({
      model,
      prompt: 'Reply with the single word: pong',
    });

    expect(result.text.trim().length).toBeGreaterThan(0);
  });
});
