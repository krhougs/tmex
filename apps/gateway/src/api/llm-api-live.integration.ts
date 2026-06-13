// LLM HTTP API 全链路实测：走真实 handleLlmApiRequest（非 mock）打真实 endpoint，
// 覆盖 UI 实际触发的路径——创建（自动拉模型）/ 列表 / 刷新模型 / 设默认 / 真实对话 /
// provider 内置搜索工具 / 删除。凭证来自 test.env.local。
//
// 运行：bun run --filter @tmex/gateway test:live:llm-api

import { beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { generateText } from 'ai';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { getDb as getOrmDb } from '../db/client';
import { resolveLanguageModel, resolveProviderWebSearchTool } from '../llm/provider-registry';
import { requireLiveEnv } from '../test-support/live-env';
import { handleLlmApiRequest } from './llm';

const env = requireLiveEnv(
  ['TEST_LLM_BASE_URL', 'TEST_LLM_API_KEY', 'TEST_LLM_MODEL'],
  'TEST_LLM_BASE_URL 填 OpenAI 兼容 base（裸 host 自动补 /v1），TEST_LLM_MODEL 填可用模型 id（如 gpt-5.5）。'
);

const protocol = process.env.TEST_LLM_PROTOCOL?.trim() || 'openai-chat';

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const req = new Request(`http://localhost${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const res = await handleLlmApiRequest(req, path);
  if (!res) {
    throw new Error(`handleLlmApiRequest 未匹配路由: ${method} ${path}`);
  }
  return { status: res.status, json: await res.json() };
}

beforeAll(() => {
  migrate(getOrmDb(), { migrationsFolder: resolve(import.meta.dir, '../../drizzle') });
});

describe('LLM HTTP API live integration', () => {
  let providerId = '';

  test('POST /providers 创建并自动拉到模型列表（UI 实际路径）', async () => {
    const { status, json } = await api('POST', '/api/llm/providers', {
      name: `live-${crypto.randomUUID().slice(0, 8)}`,
      protocol,
      baseUrl: env.TEST_LLM_BASE_URL,
      apiKey: env.TEST_LLM_API_KEY,
      enabled: true,
    });

    expect(status).toBe(201);
    expect(json.modelsError).toBeUndefined();
    expect(Array.isArray(json.provider.models)).toBe(true);
    expect(json.provider.models.length).toBeGreaterThan(0);
    expect(json.provider.models).toContain(env.TEST_LLM_MODEL);
    expect(json.provider.hasApiKey).toBe(true);

    providerId = json.provider.id;
  });

  test('GET /providers 列表含新建 provider', async () => {
    const { status, json } = await api('GET', '/api/llm/providers');
    expect(status).toBe(200);
    expect(json.providers.some((p: { id: string }) => p.id === providerId)).toBe(true);
  });

  test('POST /providers/:id/refresh-models 重新拉取', async () => {
    const { status, json } = await api(
      'POST',
      `/api/llm/providers/${providerId}/refresh-models`
    );
    expect(status).toBe(200);
    expect(json.models.length).toBeGreaterThan(0);
    expect(json.models).toContain(env.TEST_LLM_MODEL);
  });

  test('PATCH /settings 设默认 provider/model', async () => {
    const { status, json } = await api('PATCH', '/api/llm/settings', {
      defaultProviderId: providerId,
      defaultModelId: env.TEST_LLM_MODEL,
    });
    expect(status).toBe(200);
    expect(json.settings.defaultProviderId).toBe(providerId);
    expect(json.settings.defaultModelId).toBe(env.TEST_LLM_MODEL);
  });

  test('resolveLanguageModel(默认) + generateText 真实对话', async () => {
    const model = await resolveLanguageModel(null, null);
    const result = await generateText({ model, prompt: 'Reply with the single word: pong' });
    expect(result.text.trim().length).toBeGreaterThan(0);
  });

  test.if(protocol === 'openai-responses')(
    'resolveProviderWebSearchTool 对 responses 协议返回内置搜索工具',
    async () => {
      const tool = await resolveProviderWebSearchTool(providerId);
      expect(tool).not.toBeNull();
    }
  );

  test('DELETE /providers/:id 删除', async () => {
    const { status, json } = await api('DELETE', `/api/llm/providers/${providerId}`);
    expect(status).toBe(200);
    expect(json.success).toBe(true);

    const list = await api('GET', '/api/llm/providers');
    expect(list.json.providers.some((p: { id: string }) => p.id === providerId)).toBe(false);
  });
});
