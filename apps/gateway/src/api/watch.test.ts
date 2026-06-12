import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { WatchRuleSampleDto } from '@tmex/shared';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { createDevice, ensureSiteSettingsInitialized } from '../db';
import { ensureAgentSettingsInitialized } from '../db/agent';
import { getDb as getOrmDb } from '../db/client';
import { createLlmProvider } from '../db/llm';
import {
  type CreateWatchRuleInput,
  createWatchRule,
  getWatchRuleById,
  getWatchRuleState,
  upsertWatchRuleState,
} from '../db/watch';
import { encrypt } from '../crypto';
import { type WatchApiDeps, handleWatchApiRequest } from './watch';

const TEST_DEVICE_ID = 'watch-api-test-device';
let providerId = '';

// ========== mock LLM server（assist-regex 用） ==========

let assistResponder: () => Response = () => new Response('not configured', { status: 500 });

function jsonChatResponse(content: unknown): Response {
  return Response.json({
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 1700000000,
    model: 'mock-model',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: JSON.stringify(content) },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
}

const mockServer = Bun.serve({
  port: 0,
  fetch: async (req) => {
    const url = new URL(req.url);
    if (url.pathname !== '/v1/chat/completions' || req.method !== 'POST') {
      return new Response('not found', { status: 404 });
    }
    await req.json();
    return assistResponder();
  },
});

afterAll(() => {
  mockServer.stop(true);
});

// ========== harness ==========

interface ServiceStub {
  refreshed: string[];
  removed: string[];
  samples: WatchRuleSampleDto[];
}

function createDeps(overrides: Partial<WatchApiDeps> = {}): { deps: Partial<WatchApiDeps>; stub: ServiceStub } {
  const stub: ServiceStub = { refreshed: [], removed: [], samples: [] };
  const deps: Partial<WatchApiDeps> = {
    service: {
      refreshRule: async (id: string) => {
        stub.refreshed.push(id);
      },
      removeRule: async (id: string) => {
        stub.removed.push(id);
      },
      getSamples: () => stub.samples,
    },
    captureScreen: async () => 'downloading 73%\nplease wait\n',
    resolveModel: async () =>
      createOpenAICompatible({
        name: 'mock',
        baseURL: `http://127.0.0.1:${mockServer.port}/v1`,
        apiKey: 'mock-key',
      }).chatModel('mock-model'),
    llmMaxRetries: 0,
    ...overrides,
  };
  return { deps, stub };
}

async function call(
  method: string,
  path: string,
  body?: unknown,
  deps: Partial<WatchApiDeps> = createDeps().deps
): Promise<{ status: number; json: Record<string, unknown> }> {
  const req = new Request(`http://localhost${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const response = handleWatchApiRequest(req, path.split('?')[0] ?? path, deps);
  if (!response) {
    throw new Error(`no route matched: ${method} ${path}`);
  }
  const resolved = await response;
  return { status: resolved.status, json: (await resolved.json()) as Record<string, unknown> };
}

function makeRule(overrides: Partial<CreateWatchRuleInput> = {}) {
  return createWatchRule({
    name: `rule-${crypto.randomUUID().slice(0, 8)}`,
    deviceId: TEST_DEVICE_ID,
    paneId: '%1',
    triggerType: 'match',
    pattern: 'ERROR',
    ...overrides,
  });
}

function validCreateBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'watch dl',
    deviceId: TEST_DEVICE_ID,
    paneId: '%1',
    triggerType: 'match',
    pattern: 'ERROR',
    ...overrides,
  };
}

beforeAll(async () => {
  migrate(getOrmDb(), { migrationsFolder: resolve(import.meta.dir, '../../drizzle') });
  ensureSiteSettingsInitialized();
  ensureAgentSettingsInitialized();
  const now = new Date().toISOString();
  createDevice({
    id: TEST_DEVICE_ID,
    name: 'watch-api-device',
    type: 'local',
    session: 'tmex-test',
    authMode: 'auto',
    port: 22,
    createdAt: now,
    updatedAt: now,
  });
  const provider = createLlmProvider({
    name: 'watch-api-provider',
    protocol: 'openai-chat',
    baseUrl: `http://127.0.0.1:${mockServer.port}/v1`,
    apiKeyEnc: await encrypt('sk-test'),
  });
  providerId = provider.id;
});

describe('POST /api/watch/rules - 校验', () => {
  test('name 必填', async () => {
    const res = await call('POST', '/api/watch/rules', validCreateBody({ name: '' }));
    expect(res.status).toBe(400);
  });

  test('设备必须存在', async () => {
    const res = await call('POST', '/api/watch/rules', validCreateBody({ deviceId: 'nope' }));
    expect(res.status).toBe(404);
  });

  test('paneId 必填', async () => {
    const res = await call('POST', '/api/watch/rules', validCreateBody({ paneId: '' }));
    expect(res.status).toBe(400);
  });

  test('triggerType 枚举', async () => {
    const res = await call('POST', '/api/watch/rules', validCreateBody({ triggerType: 'bogus' }));
    expect(res.status).toBe(400);
  });

  test('match 缺 pattern 400', async () => {
    const res = await call('POST', '/api/watch/rules', validCreateBody({ pattern: null }));
    expect(res.status).toBe(400);
  });

  test('无效 pattern 试编译失败 400', async () => {
    const res = await call('POST', '/api/watch/rules', validCreateBody({ pattern: '([' }));
    expect(res.status).toBe(400);
    expect(String(res.json.error)).toMatch(/正则|regular expression|正規表現/i);
  });

  test('非法 flags 也会被试编译拦下', async () => {
    const res = await call(
      'POST',
      '/api/watch/rules',
      validCreateBody({ pattern: 'a', patternFlags: 'q' })
    );
    expect(res.status).toBe(400);
  });

  test('unchanged 必须有 unchangedMinutes > 0', async () => {
    const missing = await call(
      'POST',
      '/api/watch/rules',
      validCreateBody({ triggerType: 'unchanged', pattern: '(\\d+)%', extractGroup: 1 })
    );
    expect(missing.status).toBe(400);

    const invalid = await call(
      'POST',
      '/api/watch/rules',
      validCreateBody({
        triggerType: 'unchanged',
        pattern: '(\\d+)%',
        extractGroup: 1,
        unchangedMinutes: 0,
      })
    );
    expect(invalid.status).toBe(400);
  });

  test('extractGroup 必须 >= 0 的整数', async () => {
    const res = await call('POST', '/api/watch/rules', validCreateBody({ extractGroup: -1 }));
    expect(res.status).toBe(400);
    const res2 = await call('POST', '/api/watch/rules', validCreateBody({ extractGroup: 1.5 }));
    expect(res2.status).toBe(400);
  });

  test('llm 必须有 conditionPrompt', async () => {
    const res = await call(
      'POST',
      '/api/watch/rules',
      validCreateBody({ triggerType: 'llm', pattern: null })
    );
    expect(res.status).toBe(400);
  });

  test('intervalSeconds 下限：普通 5s、llm 30s', async () => {
    const tooSmall = await call('POST', '/api/watch/rules', validCreateBody({ intervalSeconds: 3 }));
    expect(tooSmall.status).toBe(400);

    const llmTooSmall = await call(
      'POST',
      '/api/watch/rules',
      validCreateBody({
        triggerType: 'llm',
        pattern: null,
        conditionPrompt: 'done?',
        intervalSeconds: 20,
      })
    );
    expect(llmTooSmall.status).toBe(400);
  });

  test('providerId 存在性', async () => {
    const res = await call(
      'POST',
      '/api/watch/rules',
      validCreateBody({ providerId: crypto.randomUUID() })
    );
    expect(res.status).toBe(400);
  });

  test('noMatchBehavior / fireMode / cooldownSeconds 枚举与范围', async () => {
    expect(
      (await call('POST', '/api/watch/rules', validCreateBody({ noMatchBehavior: 'zap' }))).status
    ).toBe(400);
    expect(
      (await call('POST', '/api/watch/rules', validCreateBody({ fireMode: 'always' }))).status
    ).toBe(400);
    expect(
      (await call('POST', '/api/watch/rules', validCreateBody({ cooldownSeconds: -1 }))).status
    ).toBe(400);
  });
});

describe('Watch rules CRUD', () => {
  test('create 成功：默认值 + refreshRule 热更新', async () => {
    const { deps, stub } = createDeps();
    const res = await call(
      'POST',
      '/api/watch/rules',
      validCreateBody({ providerId, modelId: 'mock-model' }),
      deps
    );
    expect(res.status).toBe(201);
    const rule = res.json.rule as Record<string, unknown>;
    expect(rule.enabled).toBe(true);
    expect(rule.intervalSeconds).toBe(30);
    expect(rule.providerId).toBe(providerId);
    expect(stub.refreshed).toEqual([String(rule.id)]);
  });

  test('create llm 型默认 interval 60', async () => {
    const res = await call(
      'POST',
      '/api/watch/rules',
      validCreateBody({ triggerType: 'llm', pattern: null, conditionPrompt: 'finished?' })
    );
    expect(res.status).toBe(201);
    expect((res.json.rule as Record<string, unknown>).intervalSeconds).toBe(60);
  });

  test('list 支持 deviceId/paneId 过滤', async () => {
    const target = makeRule({ paneId: '%77' });
    makeRule({ paneId: '%78' });

    const res = await call('GET', `/api/watch/rules?deviceId=${TEST_DEVICE_ID}&paneId=%2577`);
    expect(res.status).toBe(200);
    const rules = res.json.rules as Array<Record<string, unknown>>;
    expect(rules.map((r) => String(r.id))).toEqual([target.id]);
  });

  test('get 返回 rule + state', async () => {
    const rule = makeRule();
    upsertWatchRuleState(rule.id, { lastValue: '42', consecutiveErrors: 1 });

    const res = await call('GET', `/api/watch/rules/${rule.id}`);
    expect(res.status).toBe(200);
    expect((res.json.rule as Record<string, unknown>).id).toBe(rule.id);
    expect((res.json.state as Record<string, unknown>).lastValue).toBe('42');

    const missing = await call('GET', `/api/watch/rules/${crypto.randomUUID()}`);
    expect(missing.status).toBe(404);
  });

  test('patch enabled 启停并 refreshRule；语义校验基于合成值', async () => {
    const { deps, stub } = createDeps();
    const rule = makeRule();

    const res = await call('PATCH', `/api/watch/rules/${rule.id}`, { enabled: false }, deps);
    expect(res.status).toBe(200);
    expect((res.json.rule as Record<string, unknown>).enabled).toBe(false);
    expect(stub.refreshed).toEqual([rule.id]);

    // 改成 llm 但没有 conditionPrompt：合成校验拦下
    const invalid = await call('PATCH', `/api/watch/rules/${rule.id}`, { triggerType: 'llm' }, deps);
    expect(invalid.status).toBe(400);
    expect(getWatchRuleById(rule.id)?.triggerType).toBe('match');

    // 合法的类型切换
    const ok = await call(
      'PATCH',
      `/api/watch/rules/${rule.id}`,
      { triggerType: 'llm', conditionPrompt: 'is it done?', intervalSeconds: 60 },
      deps
    );
    expect(ok.status).toBe(200);
    expect((ok.json.rule as Record<string, unknown>).triggerType).toBe('llm');
  });

  test('patch 不存在 404', async () => {
    const res = await call('PATCH', `/api/watch/rules/${crypto.randomUUID()}`, { enabled: false });
    expect(res.status).toBe(404);
  });

  test('delete 删除规则与 state，并通知 service.removeRule', async () => {
    const { deps, stub } = createDeps();
    const rule = makeRule();
    upsertWatchRuleState(rule.id, { lastValue: 'x' });

    const res = await call('DELETE', `/api/watch/rules/${rule.id}`, undefined, deps);
    expect(res.status).toBe(200);
    expect(getWatchRuleById(rule.id)).toBeNull();
    expect(getWatchRuleState(rule.id)).toBeNull();
    expect(stub.removed).toEqual([rule.id]);

    const missing = await call('DELETE', `/api/watch/rules/${rule.id}`, undefined, deps);
    expect(missing.status).toBe(404);
  });

  test('state 接口返回 state + ring buffer 样本', async () => {
    const { deps, stub } = createDeps();
    const rule = makeRule();
    upsertWatchRuleState(rule.id, { lastValue: '9' });
    stub.samples.push({ at: new Date().toISOString(), value: '9', hit: false });

    const res = await call('GET', `/api/watch/rules/${rule.id}/state`, undefined, deps);
    expect(res.status).toBe(200);
    expect((res.json.state as Record<string, unknown>).lastValue).toBe('9');
    expect(res.json.samples as unknown[]).toHaveLength(1);
  });
});

describe('POST /api/watch/assist-regex', () => {
  test('description 必填', async () => {
    const res = await call('POST', '/api/watch/assist-regex', { description: ' ' });
    expect(res.status).toBe(400);
  });

  test('成功生成：带屏幕上下文时返回试跑 preview', async () => {
    assistResponder = () =>
      jsonChatResponse({
        pattern: '(\\d+)%',
        flags: '',
        extractGroup: 1,
        explanation: 'matches percentage',
      });

    const res = await call('POST', '/api/watch/assist-regex', {
      description: 'download percentage',
      deviceId: TEST_DEVICE_ID,
      paneId: '%1',
    });
    expect(res.status).toBe(200);
    expect(res.json.pattern).toBe('(\\d+)%');
    expect(res.json.extractGroup).toBe(1);
    expect(res.json.preview).toEqual(['73%']);
  });

  test('无屏幕上下文时 preview 为空数组', async () => {
    assistResponder = () =>
      jsonChatResponse({ pattern: 'ERROR', flags: 'i', extractGroup: 0, explanation: 'e' });

    const res = await call('POST', '/api/watch/assist-regex', { description: 'errors' });
    expect(res.status).toBe(200);
    expect(res.json.preview).toEqual([]);
  });

  test('取屏失败降级为无上下文而非报错', async () => {
    assistResponder = () =>
      jsonChatResponse({ pattern: 'ERROR', flags: '', extractGroup: 0, explanation: 'e' });
    const { deps } = createDeps({
      captureScreen: async () => {
        throw new Error("can't find pane: %1");
      },
    });

    const res = await call(
      'POST',
      '/api/watch/assist-regex',
      { description: 'errors', deviceId: TEST_DEVICE_ID, paneId: '%1' },
      deps
    );
    expect(res.status).toBe(200);
    expect(res.json.preview).toEqual([]);
  });

  test('模型不可用返回 502', async () => {
    assistResponder = () => Response.json({ error: 'down' }, { status: 500 });
    const res = await call('POST', '/api/watch/assist-regex', { description: 'errors' });
    expect(res.status).toBe(502);
  });

  test('模型给出非法 pattern 返回 502', async () => {
    assistResponder = () =>
      jsonChatResponse({ pattern: '([', flags: '', extractGroup: 0, explanation: 'broken' });
    const res = await call('POST', '/api/watch/assist-regex', { description: 'errors' });
    expect(res.status).toBe(502);
  });

  test('providerId 不存在 400', async () => {
    const res = await call('POST', '/api/watch/assist-regex', {
      description: 'errors',
      providerId: crypto.randomUUID(),
    });
    expect(res.status).toBe(400);
  });
});
