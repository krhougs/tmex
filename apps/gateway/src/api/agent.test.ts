import { beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import type { AgentSupervisor } from '../agent/supervisor';
import {
  AgentConfirmationAlreadyDecidedError,
  AgentConfirmationNotFoundError,
  AgentSessionBusyError,
  AgentSessionNotFoundError,
} from '../agent/supervisor';
import { createDevice, ensureSiteSettingsInitialized } from '../db';
import {
  type AgentMessageRecord,
  appendAgentMessage,
  createAgentConfirmation,
  createAgentSession,
  ensureAgentSettingsInitialized,
  getAgentSessionById,
  updateAgentSettings,
} from '../db/agent';
import { getDb as getOrmDb } from '../db/client';
import { createLlmProvider } from '../db/llm';
import { handleAgentApiRequest } from './agent';

const TEST_DEVICE_ID = 'agent-api-test-device';
let chatProviderId = '';
let responsesProviderId = '';

interface StubSupervisorOverrides {
  isSessionActive?: (sessionId: string) => boolean;
  submitUserMessage?: (sessionId: string, text: string) => unknown;
  stopSession?: (sessionId: string) => Promise<void>;
  resolveConfirmation?: (id: string, approved: boolean, reason?: string) => unknown;
}

function stubSupervisor(overrides: StubSupervisorOverrides = {}): AgentSupervisor {
  return {
    isSessionActive: overrides.isSessionActive ?? (() => false),
    submitUserMessage:
      overrides.submitUserMessage ??
      ((sessionId: string, text: string) => ({
        kind: 'message' as const,
        record: appendAgentMessage(sessionId, 'user', { role: 'user', content: text }),
      })),
    stopSession: overrides.stopSession ?? (async () => {}),
    resolveConfirmation:
      overrides.resolveConfirmation ??
      (() => {
        throw new AgentConfirmationNotFoundError();
      }),
  } as unknown as AgentSupervisor;
}

async function call(
  method: string,
  path: string,
  body?: unknown,
  supervisor: AgentSupervisor = stubSupervisor()
): Promise<{ status: number; json: Record<string, unknown> }> {
  const req = new Request(`http://localhost${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const response = await handleAgentApiRequest(req, path.split('?')[0]!, supervisor);
  if (!response) {
    throw new Error(`no route matched: ${method} ${path}`);
  }
  const resolved = await response;
  return { status: resolved.status, json: (await resolved.json()) as Record<string, unknown> };
}

function createTestSession(overrides: Parameters<typeof createAgentSession>[0] | object = {}) {
  return createAgentSession({
    title: 'Api Test',
    deviceId: TEST_DEVICE_ID,
    paneId: '%2',
    modelId: 'mock-model',
    ...overrides,
  });
}

beforeAll(() => {
  migrate(getOrmDb(), { migrationsFolder: resolve(import.meta.dir, '../../drizzle') });
  ensureSiteSettingsInitialized();
  ensureAgentSettingsInitialized();

  const now = new Date().toISOString();
  createDevice({
    id: TEST_DEVICE_ID,
    name: 'api-test-device',
    type: 'local',
    session: 'tmex-test',
    authMode: 'agent',
    port: 22,
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
  });

  chatProviderId = createLlmProvider({
    name: 'chat-provider',
    protocol: 'openai-chat',
    baseUrl: 'https://chat.example/v1',
    apiKeyEnc: 'enc',
    enabled: true,
  }).id;
  responsesProviderId = createLlmProvider({
    name: 'responses-provider',
    protocol: 'openai-responses',
    baseUrl: 'https://responses.example/v1',
    apiKeyEnc: 'enc',
    enabled: true,
  }).id;
});

describe('POST /api/agent/sessions', () => {
  test('缺 deviceId → 400', async () => {
    const { status } = await call('POST', '/api/agent/sessions', { paneId: '%1' });
    expect(status).toBe(400);
  });

  test('device 不存在 → 404', async () => {
    const { status } = await call('POST', '/api/agent/sessions', {
      deviceId: 'missing-device',
      paneId: '%1',
      modelId: 'm',
    });
    expect(status).toBe(404);
  });

  test('缺 paneId → 400', async () => {
    const { status } = await call('POST', '/api/agent/sessions', {
      deviceId: TEST_DEVICE_ID,
      modelId: 'm',
    });
    expect(status).toBe(400);
  });

  test('modelId 缺省且无全局默认 → 400', async () => {
    updateAgentSettings({ defaultModelId: null });
    const { status } = await call('POST', '/api/agent/sessions', {
      deviceId: TEST_DEVICE_ID,
      paneId: '%1',
    });
    expect(status).toBe(400);
  });

  test('modelId 缺省时回退全局默认', async () => {
    updateAgentSettings({ defaultModelId: 'default-model' });
    try {
      const { status, json } = await call('POST', '/api/agent/sessions', {
        deviceId: TEST_DEVICE_ID,
        paneId: '%1',
      });
      expect(status).toBe(201);
      expect((json.session as { modelId: string }).modelId).toBe('default-model');
    } finally {
      updateAgentSettings({ defaultModelId: null });
    }
  });

  test('writeMode 非法 → 400', async () => {
    const { status } = await call('POST', '/api/agent/sessions', {
      deviceId: TEST_DEVICE_ID,
      paneId: '%1',
      modelId: 'm',
      writeMode: 'yolo',
    });
    expect(status).toBe(400);
  });

  test('maxStepsPerTurn 越界 → 400', async () => {
    const { status } = await call('POST', '/api/agent/sessions', {
      deviceId: TEST_DEVICE_ID,
      paneId: '%1',
      modelId: 'm',
      maxStepsPerTurn: 1000,
    });
    expect(status).toBe(400);
  });

  test('useProviderWebSearch 但 provider 是 openai-chat → 400 互斥', async () => {
    const { status } = await call('POST', '/api/agent/sessions', {
      deviceId: TEST_DEVICE_ID,
      paneId: '%1',
      modelId: 'm',
      providerId: chatProviderId,
      useProviderWebSearch: true,
    });
    expect(status).toBe(400);
  });

  test('useProviderWebSearch + openai-responses → 201', async () => {
    const { status, json } = await call('POST', '/api/agent/sessions', {
      deviceId: TEST_DEVICE_ID,
      paneId: '%1',
      modelId: 'm',
      providerId: responsesProviderId,
      useProviderWebSearch: true,
    });
    expect(status).toBe(201);
    expect((json.session as { useProviderWebSearch: boolean }).useProviderWebSearch).toBe(true);
  });

  test('成功创建：默认标题与默认 writeMode=confirm', async () => {
    const { status, json } = await call('POST', '/api/agent/sessions', {
      deviceId: TEST_DEVICE_ID,
      paneId: '%7',
      modelId: 'mock-model',
    });
    expect(status).toBe(201);
    const session = json.session as Record<string, unknown>;
    expect(session.title).toBe('New Session');
    expect(session.writeMode).toBe('confirm');
    expect(session.status).toBe('idle');
    expect(session.paneId).toBe('%7');
  });
});

describe('GET /api/agent/sessions', () => {
  test('按 deviceId/paneId 过滤', async () => {
    const target = createTestSession({ paneId: '%filter-target' });
    const { status, json } = await call(
      'GET',
      `/api/agent/sessions?deviceId=${TEST_DEVICE_ID}&paneId=${encodeURIComponent('%filter-target')}`
    );
    expect(status).toBe(200);
    const sessions = json.sessions as Array<{ id: string }>;
    expect(sessions.map((s) => s.id)).toEqual([target.id]);
  });
});

describe('GET/PATCH/DELETE /api/agent/sessions/:id', () => {
  test('GET 不存在 → 404', async () => {
    const { status } = await call('GET', `/api/agent/sessions/${crypto.randomUUID()}`);
    expect(status).toBe(404);
  });

  test('GET 成功', async () => {
    const session = createTestSession();
    const { status, json } = await call('GET', `/api/agent/sessions/${session.id}`);
    expect(status).toBe(200);
    expect((json.session as { id: string }).id).toBe(session.id);
  });

  test('PATCH title/writeMode/paneId/systemPrompt', async () => {
    const session = createTestSession();
    const { status, json } = await call('PATCH', `/api/agent/sessions/${session.id}`, {
      title: 'Renamed',
      writeMode: 'auto',
      paneId: '%42',
      systemPrompt: 'be careful',
      maxStepsPerTurn: 10,
    });
    expect(status).toBe(200);
    const updated = json.session as Record<string, unknown>;
    expect(updated.title).toBe('Renamed');
    expect(updated.writeMode).toBe('auto');
    expect(updated.paneId).toBe('%42');
    expect(updated.systemPrompt).toBe('be careful');
    expect(updated.maxStepsPerTurn).toBe(10);
  });

  test('PATCH 空 title → 400；非法 writeMode → 400', async () => {
    const session = createTestSession();
    expect((await call('PATCH', `/api/agent/sessions/${session.id}`, { title: '  ' })).status).toBe(
      400
    );
    expect(
      (await call('PATCH', `/api/agent/sessions/${session.id}`, { writeMode: 'x' })).status
    ).toBe(400);
  });

  test('PATCH 开启 useProviderWebSearch 时校验协议互斥', async () => {
    const session = createTestSession({ providerId: chatProviderId });
    const { status } = await call('PATCH', `/api/agent/sessions/${session.id}`, {
      useProviderWebSearch: true,
    });
    expect(status).toBe(400);

    const ok = await call('PATCH', `/api/agent/sessions/${session.id}`, {
      providerId: responsesProviderId,
      useProviderWebSearch: true,
    });
    expect(ok.status).toBe(200);
  });

  test('DELETE 不存在 → 404；运行中先 stop 再删', async () => {
    expect((await call('DELETE', `/api/agent/sessions/${crypto.randomUUID()}`)).status).toBe(404);

    const session = createTestSession();
    const stopped: string[] = [];
    const supervisor = stubSupervisor({
      isSessionActive: () => true,
      stopSession: async (id) => {
        stopped.push(id);
      },
    });
    const { status } = await call(
      'DELETE',
      `/api/agent/sessions/${session.id}`,
      undefined,
      supervisor
    );
    expect(status).toBe(200);
    expect(stopped).toEqual([session.id]);
    expect(getAgentSessionById(session.id)).toBeNull();
  });
});

describe('messages', () => {
  test('GET messages：session 不存在 → 404', async () => {
    const { status } = await call('GET', `/api/agent/sessions/${crypto.randomUUID()}/messages`);
    expect(status).toBe(404);
  });

  test('GET messages：afterSeq 增量拉取', async () => {
    const session = createTestSession();
    appendAgentMessage(session.id, 'user', { role: 'user', content: 'one' });
    appendAgentMessage(session.id, 'assistant', { role: 'assistant', content: 'two' });
    appendAgentMessage(session.id, 'user', { role: 'user', content: 'three' });

    const all = await call('GET', `/api/agent/sessions/${session.id}/messages`);
    expect((all.json.messages as unknown[]).length).toBe(3);

    const after = await call('GET', `/api/agent/sessions/${session.id}/messages?afterSeq=1`);
    const messages = after.json.messages as Array<{ seq: number }>;
    expect(messages.map((m) => m.seq)).toEqual([2]);

    const bad = await call('GET', `/api/agent/sessions/${session.id}/messages?afterSeq=abc`);
    expect(bad.status).toBe(400);
  });

  test('POST message：空 text → 400', async () => {
    const session = createTestSession();
    const { status } = await call('POST', `/api/agent/sessions/${session.id}/messages`, {
      text: '   ',
    });
    expect(status).toBe(400);
  });

  test('POST message：成功 201 并返回落库消息', async () => {
    const session = createTestSession();
    const { status, json } = await call('POST', `/api/agent/sessions/${session.id}/messages`, {
      text: 'hello',
    });
    expect(status).toBe(201);
    const message = json.message as Record<string, unknown>;
    expect(message.role).toBe('user');
    expect(message.seq).toBe(0);
  });

  test('POST message：运行中 → 409', async () => {
    const session = createTestSession();
    const supervisor = stubSupervisor({
      submitUserMessage: () => {
        throw new AgentSessionBusyError();
      },
    });
    const { status } = await call(
      'POST',
      `/api/agent/sessions/${session.id}/messages`,
      { text: 'hello' },
      supervisor
    );
    expect(status).toBe(409);
  });

  test('POST message：session 不存在 → 404', async () => {
    const supervisor = stubSupervisor({
      submitUserMessage: () => {
        throw new AgentSessionNotFoundError();
      },
    });
    const { status } = await call(
      'POST',
      `/api/agent/sessions/${crypto.randomUUID()}/messages`,
      { text: 'hello' },
      supervisor
    );
    expect(status).toBe(404);
  });
});

describe('stop / confirmations / decide', () => {
  test('POST stop：调用 supervisor.stopSession 并返回最新 session', async () => {
    const session = createTestSession();
    const stopped: string[] = [];
    const supervisor = stubSupervisor({
      stopSession: async (id) => {
        stopped.push(id);
      },
    });
    const { status } = await call(
      'POST',
      `/api/agent/sessions/${session.id}/stop`,
      undefined,
      supervisor
    );
    expect(status).toBe(200);
    expect(stopped).toEqual([session.id]);
  });

  test('GET confirmations：返回 pending 列表', async () => {
    const session = createTestSession();
    const confirmation = createAgentConfirmation({
      sessionId: session.id,
      toolName: 'send_input',
      toolCallId: 'call-1',
      inputJson: { text: 'ls' },
    });
    const { status, json } = await call('GET', `/api/agent/sessions/${session.id}/confirmations`);
    expect(status).toBe(200);
    const confirmations = json.confirmations as Array<{ id: string; status: string }>;
    expect(confirmations.map((c) => c.id)).toEqual([confirmation.id]);
    expect(confirmations[0]!.status).toBe('pending');
  });

  test('POST decide：approved 非 boolean → 400', async () => {
    const { status } = await call(
      'POST',
      `/api/agent/confirmations/${crypto.randomUUID()}/decide`,
      {
        approved: 'yes',
      }
    );
    expect(status).toBe(400);
  });

  test('POST decide：不存在 → 404；已决定 → 409', async () => {
    const notFound = await call(
      'POST',
      `/api/agent/confirmations/${crypto.randomUUID()}/decide`,
      { approved: true },
      stubSupervisor({
        resolveConfirmation: () => {
          throw new AgentConfirmationNotFoundError();
        },
      })
    );
    expect(notFound.status).toBe(404);

    const decided = await call(
      'POST',
      `/api/agent/confirmations/${crypto.randomUUID()}/decide`,
      { approved: true },
      stubSupervisor({
        resolveConfirmation: () => {
          throw new AgentConfirmationAlreadyDecidedError();
        },
      })
    );
    expect(decided.status).toBe(409);
  });

  test('POST decide：成功返回 confirmation DTO', async () => {
    const session = createTestSession();
    const confirmation = createAgentConfirmation({
      sessionId: session.id,
      toolName: 'send_input',
      toolCallId: 'call-2',
      inputJson: { text: 'pwd' },
    });
    const supervisor = stubSupervisor({
      resolveConfirmation: () => ({
        ...confirmation,
        status: 'approved',
        decidedAt: new Date().toISOString(),
      }),
    });
    const { status, json } = await call(
      'POST',
      `/api/agent/confirmations/${confirmation.id}/decide`,
      { approved: true },
      supervisor
    );
    expect(status).toBe(200);
    expect((json.confirmation as { status: string }).status).toBe('approved');
  });
});
