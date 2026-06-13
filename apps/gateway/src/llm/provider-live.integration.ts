// LLM Provider 实测：打真实 endpoint 拉模型列表 + 跑一次真实 chat。
// 凭证来自 test.env.local：TEST_LLM_BASE_URL / TEST_LLM_API_KEY / TEST_LLM_MODEL
// （可选 TEST_LLM_PROTOCOL，默认 openai-chat）。缺失则报错退出（见 requireLiveEnv）。
//
// 运行：bun run --filter @tmex/gateway test:live:llm

import { beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { generateText, stepCountIs, tool } from 'ai';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { z } from 'zod';
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

  // Responses 协议（reasoning 模型）多轮工具调用：上一轮的 reasoning / tool-call item
  // 带 id，默认会被发成 item_reference 依赖服务端存储；tmex 无状态回放需 store=false
  // 改为内联发送，否则报 "Item with id '...' not found / store=false"（见 agent/run.ts）。
  test.if(protocol === 'openai-responses')(
    'Responses 多轮工具调用在 store:false 下成功（回放带 id 的 item）',
    async () => {
      const provider = await createLiveProvider();
      const model = await resolveLanguageModel(provider.id, env.TEST_LLM_MODEL);
      const add = tool({
        description: 'Add two integers',
        inputSchema: z.object({ a: z.number(), b: z.number() }),
        execute: async ({ a, b }) => String(a + b),
      });

      const result = await generateText({
        model,
        tools: { add },
        stopWhen: stepCountIs(5),
        providerOptions: { openai: { store: false } },
        prompt: 'Use the add tool to compute 2 + 3, then reply with just the number.',
      });

      expect(result.steps.length).toBeGreaterThan(1);
      expect(result.text).toContain('5');
    }
  );
});
