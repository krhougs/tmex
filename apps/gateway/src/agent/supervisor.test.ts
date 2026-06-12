import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { wsBorsh } from '@tmex/shared';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { createDevice, ensureSiteSettingsInitialized } from '../db';
import {
  type AgentSessionRecord,
  appendAgentMessage,
  createAgentConfirmation,
  createAgentSession,
  ensureAgentSettingsInitialized,
  getAgentConfirmationById,
  getAgentSessionById,
  listAgentMessages,
  listPendingAgentConfirmations,
  updateAgentSession,
} from '../db/agent';
import { getDb as getOrmDb } from '../db/client';
import { AgentRun, type AgentRunDeps } from './run';
import {
  AgentAwaitingConfirmationError,
  AgentConfirmationAlreadyDecidedError,
  AgentConfirmationNotFoundError,
  AgentSessionBusyError,
  AgentSessionNotFoundError,
  AgentSupervisor,
} from './supervisor';
import type { TerminalRuntimeLike } from './tools/terminal';
import type { AgentWsHub } from './ws-hub';

// ========== mock LLM server ==========

interface ChatCompletionChunkDelta {
  role?: string;
  content?: string;
  tool_calls?: Array<{
    index: number;
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
  }>;
}

function chunk(delta: ChatCompletionChunkDelta, finishReason: string | null = null) {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion.chunk',
    created: 1700000000,
    model: 'mock-model',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function sseResponse(chunks: unknown[]): Response {
  const body = `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`;
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
}

function slowSseResponse(chunks: unknown[], delayMs: number): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      for (const c of chunks) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(c)}\n\n`));
        await new Promise((r) => setTimeout(r, delayMs));
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
}

interface RecordedRequest {
  body: { messages: Array<Record<string, unknown>> };
}

function createMockChatServer(respond: (callIndex: number, req: RecordedRequest) => Response) {
  const requests: RecordedRequest[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      if (url.pathname !== '/v1/chat/completions' || req.method !== 'POST') {
        return new Response('not found', { status: 404 });
      }
      const recorded: RecordedRequest = {
        body: (await req.json()) as RecordedRequest['body'],
      };
      requests.push(recorded);
      return respond(requests.length - 1, recorded);
    },
  });
  return { server, requests, baseUrl: `http://127.0.0.1:${server.port}/v1` };
}

const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterAll(() => {
  for (const server of servers) {
    server.stop(true);
  }
});

// ========== 测试基建 ==========

const TEST_DEVICE_ID = 'agent-supervisor-test-device';

interface SupervisorHarness {
  supervisor: AgentSupervisor;
  session: AgentSessionRecord;
  broadcasts: Array<{ sessionId: string; eventType: number; payload: unknown }>;
  runtimeCalls: { sendInput: Array<{ paneId: string; data: string }> };
  hub: Pick<AgentWsHub, 'setSyncProvider' | 'broadcastAgentEvent'> & {
    syncProvider: ((sessionId: string) => Promise<unknown>) | null;
  };
  waitForIdle: () => Promise<void>;
}

function createSupervisorHarness(options: {
  baseUrl: string;
  writeMode?: 'confirm' | 'auto';
  sessionStatus?: AgentSessionRecord['status'];
}): SupervisorHarness {
  const session = createAgentSession({
    title: 'Supervisor Test',
    deviceId: TEST_DEVICE_ID,
    paneId: '%9',
    modelId: 'mock-model',
    writeMode: options.writeMode ?? 'auto',
  });
  if (options.sessionStatus) {
    updateAgentSession(session.id, { status: options.sessionStatus });
  }

  const broadcasts: SupervisorHarness['broadcasts'] = [];
  const runtimeCalls: SupervisorHarness['runtimeCalls'] = { sendInput: [] };

  const runtime: TerminalRuntimeLike = {
    sendInput(paneId, data) {
      runtimeCalls.sendInput.push({ paneId, data });
    },
    async capturePaneText() {
      return 'captured screen';
    },
  };

  const hub: SupervisorHarness['hub'] = {
    syncProvider: null,
    setSyncProvider(provider) {
      hub.syncProvider = provider as (sessionId: string) => Promise<unknown>;
    },
    broadcastAgentEvent(sessionId, eventType, payload, _seq) {
      broadcasts.push({ sessionId, eventType, payload });
    },
  };

  const runDeps: Partial<AgentRunDeps> = {
    resolveModel: async () =>
      createOpenAICompatible({
        name: 'mock',
        baseURL: options.baseUrl,
        apiKey: 'mock-key',
      }).chatModel('mock-model'),
    resolveProviderWebSearchTool: async () => null,
    createWebSearchTool: async () => null,
    acquireRuntime: async () => runtime,
    releaseRuntime: async () => {},
    broadcast: (sessionId, eventType, payload, seq) => {
      hub.broadcastAgentEvent(sessionId, eventType, payload, seq);
    },
    notify: async () => {},
    generateTitle: async () => 'Generated Title',
    sleepMs: async () => {},
    deltaFlushIntervalMs: 5,
    retryDelaysMs: [1],
    llmMaxRetries: 0,
    notifyTurnFinished: false,
  };

  const supervisor = new AgentSupervisor({
    deps: {
      hub,
      createRun: (sessionId) => new AgentRun(sessionId, runDeps),
      stopTimeoutMs: 3_000,
    },
  });

  const waitForIdle = async () => {
    for (let i = 0; i < 200; i++) {
      if (!supervisor.isSessionActive(session.id)) {
        return;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('supervisor run did not finish in time');
  };

  return { supervisor, session, broadcasts, runtimeCalls, hub, waitForIdle };
}

beforeAll(() => {
  migrate(getOrmDb(), { migrationsFolder: resolve(import.meta.dir, '../../drizzle') });
  ensureSiteSettingsInitialized();
  ensureAgentSettingsInitialized();
  const now = new Date().toISOString();
  createDevice({
    id: TEST_DEVICE_ID,
    name: 'supervisor-test-device',
    type: 'local',
    session: 'tmex-test',
    authMode: 'agent',
    port: 22,
    createdAt: now,
    updatedAt: now,
  });
});

describe('AgentSupervisor - 互斥与基本流程', () => {
  test('submitUserMessage 落库 user 消息并发起 run；运行中再发抛 Busy（409 语义）', async () => {
    const mock = createMockChatServer(() =>
      slowSseResponse([chunk({ role: 'assistant', content: 'thinking...' }), chunk({}, 'stop')], 60)
    );
    servers.push(mock.server);

    const harness = createSupervisorHarness({ baseUrl: mock.baseUrl });
    await harness.supervisor.start();

    const record = harness.supervisor.submitUserMessage(harness.session.id, 'hello agent');
    expect(record.role).toBe('user');
    expect(record.content).toEqual({ role: 'user', content: 'hello agent' });

    expect(() => harness.supervisor.submitUserMessage(harness.session.id, 'again')).toThrow(
      AgentSessionBusyError
    );

    await harness.waitForIdle();
    expect(getAgentSessionById(harness.session.id)?.status).toBe('idle');

    // run 结束后可再次发消息
    const second = harness.supervisor.submitUserMessage(harness.session.id, 'second');
    expect(second.seq).toBeGreaterThan(record.seq);
    await harness.waitForIdle();
  });

  test('session 不存在抛 NotFound', async () => {
    const mock = createMockChatServer(() => sseResponse([chunk({}, 'stop')]));
    servers.push(mock.server);
    const harness = createSupervisorHarness({ baseUrl: mock.baseUrl });
    await harness.supervisor.start();

    expect(() => harness.supervisor.submitUserMessage(crypto.randomUUID(), 'x')).toThrow(
      AgentSessionNotFoundError
    );
    await expect(harness.supervisor.stopSession(crypto.randomUUID())).rejects.toThrow(
      AgentSessionNotFoundError
    );
  });

  test('waiting_confirmation 且有 pending 时发消息抛 AwaitingConfirmation', async () => {
    const mock = createMockChatServer(() => sseResponse([chunk({}, 'stop')]));
    servers.push(mock.server);
    const harness = createSupervisorHarness({
      baseUrl: mock.baseUrl,
      sessionStatus: 'waiting_confirmation',
    });
    createAgentConfirmation({
      sessionId: harness.session.id,
      toolName: 'send_input',
      toolCallId: 'call-x',
      inputJson: { text: 'ls' },
    });
    await harness.supervisor.start();

    expect(() => harness.supervisor.submitUserMessage(harness.session.id, 'hey')).toThrow(
      AgentAwaitingConfirmationError
    );
  });
});

describe('AgentSupervisor - 确认决策续跑', () => {
  function setupConfirmFlow() {
    const mock = createMockChatServer((callIndex, req) => {
      const hasToolMessage = req.body.messages.some((m) => m.role === 'tool');
      if (callIndex === 0 || !hasToolMessage) {
        return sseResponse([
          chunk({
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'call_send_1',
                type: 'function',
                function: { name: 'send_input', arguments: '{"text":"ls","keys":["enter"]}' },
              },
            ],
          }),
          chunk({}, 'tool_calls'),
        ]);
      }
      return sseResponse([chunk({ role: 'assistant', content: 'done' }), chunk({}, 'stop')]);
    });
    servers.push(mock.server);
    return mock;
  }

  test('approve：CAS decide → 合并落库 approval-response → 续跑执行工具 → idle', async () => {
    const mock = setupConfirmFlow();
    const harness = createSupervisorHarness({ baseUrl: mock.baseUrl, writeMode: 'confirm' });
    await harness.supervisor.start();

    harness.supervisor.submitUserMessage(harness.session.id, 'run ls');
    await harness.waitForIdle();

    expect(getAgentSessionById(harness.session.id)?.status).toBe('waiting_confirmation');
    const pending = listPendingAgentConfirmations(harness.session.id);
    expect(pending.length).toBe(1);

    const decided = harness.supervisor.resolveConfirmation(pending[0]!.id, true);
    expect(decided.status).toBe('approved');

    await harness.waitForIdle();
    expect(getAgentSessionById(harness.session.id)?.status).toBe('idle');

    // 工具被真实执行（approve 续跑时 initial 阶段执行）
    expect(harness.runtimeCalls.sendInput).toEqual([{ paneId: '%9', data: 'ls\r' }]);

    // tool-approval-response 已落库
    const messages = listAgentMessages(harness.session.id);
    const approvalResponse = messages.find((m) => {
      const content = (m.content as { content?: Array<{ type?: string }> }).content;
      return Array.isArray(content) && content.some((p) => p?.type === 'tool-approval-response');
    });
    expect(approvalResponse).toBeDefined();

    // 广播 confirmation_resolved
    const resolved = harness.broadcasts.filter(
      (b) => b.eventType === wsBorsh.AGENT_EVENT_CONFIRMATION_RESOLVED
    );
    expect(resolved.length).toBe(1);
    expect((resolved[0]!.payload as { status: string }).status).toBe('approved');
  });

  test('deny：工具不执行，模型收到拒绝后继续', async () => {
    const mock = setupConfirmFlow();
    const harness = createSupervisorHarness({ baseUrl: mock.baseUrl, writeMode: 'confirm' });
    await harness.supervisor.start();

    harness.supervisor.submitUserMessage(harness.session.id, 'run ls');
    await harness.waitForIdle();

    const pending = listPendingAgentConfirmations(harness.session.id);
    const decided = harness.supervisor.resolveConfirmation(pending[0]!.id, false, 'too risky');
    expect(decided.status).toBe('denied');
    expect(decided.reason).toBe('too risky');

    await harness.waitForIdle();
    expect(getAgentSessionById(harness.session.id)?.status).toBe('idle');
    expect(harness.runtimeCalls.sendInput.length).toBe(0);
  });

  test('重复 decide 抛 AlreadyDecided（409 语义）；不存在的 confirmation 抛 NotFound', async () => {
    const mock = setupConfirmFlow();
    const harness = createSupervisorHarness({ baseUrl: mock.baseUrl, writeMode: 'confirm' });
    await harness.supervisor.start();

    harness.supervisor.submitUserMessage(harness.session.id, 'run ls');
    await harness.waitForIdle();

    const pending = listPendingAgentConfirmations(harness.session.id);
    harness.supervisor.resolveConfirmation(pending[0]!.id, true);

    expect(() => harness.supervisor.resolveConfirmation(pending[0]!.id, false)).toThrow(
      AgentConfirmationAlreadyDecidedError
    );
    expect(() => harness.supervisor.resolveConfirmation(crypto.randomUUID(), true)).toThrow(
      AgentConfirmationNotFoundError
    );
    await harness.waitForIdle();
  });
});

describe('AgentSupervisor - stop 语义', () => {
  test('stopSession：活动 run 被 abort，累积文本落库 truncated，status=stopped', async () => {
    const mock = createMockChatServer(() =>
      slowSseResponse(
        [
          chunk({ role: 'assistant', content: 'aaa ' }),
          chunk({ content: 'bbb ' }),
          chunk({ content: 'ccc ' }),
          chunk({ content: 'ddd' }),
          chunk({}, 'stop'),
        ],
        50
      )
    );
    servers.push(mock.server);

    const harness = createSupervisorHarness({ baseUrl: mock.baseUrl });
    await harness.supervisor.start();
    harness.supervisor.submitUserMessage(harness.session.id, 'talk');

    await new Promise((r) => setTimeout(r, 100));
    await harness.supervisor.stopSession(harness.session.id);

    expect(getAgentSessionById(harness.session.id)?.status).toBe('stopped');
    const truncated = listAgentMessages(harness.session.id).find(
      (m) => (m.content as { truncated?: boolean }).truncated === true
    );
    expect(truncated).toBeDefined();
  });

  test('stopSession：waiting_confirmation 时取消 pending 并补 denied response', async () => {
    const mock = createMockChatServer((_, req) => {
      const hasToolMessage = req.body.messages.some((m) => m.role === 'tool');
      if (!hasToolMessage) {
        return sseResponse([
          chunk({
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'call_send_2',
                type: 'function',
                function: { name: 'send_input', arguments: '{"text":"rm -rf /tmp/x"}' },
              },
            ],
          }),
          chunk({}, 'tool_calls'),
        ]);
      }
      return sseResponse([chunk({ role: 'assistant', content: 'ok' }), chunk({}, 'stop')]);
    });
    servers.push(mock.server);

    const harness = createSupervisorHarness({ baseUrl: mock.baseUrl, writeMode: 'confirm' });
    await harness.supervisor.start();
    harness.supervisor.submitUserMessage(harness.session.id, 'clean tmp');
    await harness.waitForIdle();

    expect(getAgentSessionById(harness.session.id)?.status).toBe('waiting_confirmation');
    const pending = listPendingAgentConfirmations(harness.session.id);
    expect(pending.length).toBe(1);

    await harness.supervisor.stopSession(harness.session.id);

    expect(getAgentSessionById(harness.session.id)?.status).toBe('stopped');
    expect(listPendingAgentConfirmations(harness.session.id).length).toBe(0);
    expect(getAgentConfirmationById(pending[0]!.id)?.status).toBe('cancelled');

    // 消息流补了 approval-response，后续发消息不会因悬空 approval-request 失败
    harness.supervisor.submitUserMessage(harness.session.id, 'try again');
    await harness.waitForIdle();
    expect(getAgentSessionById(harness.session.id)?.status).toBe('idle');
  });

  test('supervisor.stop()（shutdown）：abort 活动 run 且 status 保持 running', async () => {
    const mock = createMockChatServer(() =>
      slowSseResponse(
        [
          chunk({ role: 'assistant', content: 'xxx' }),
          chunk({ content: 'yyy' }),
          chunk({}, 'stop'),
        ],
        60
      )
    );
    servers.push(mock.server);

    const harness = createSupervisorHarness({ baseUrl: mock.baseUrl });
    await harness.supervisor.start();
    harness.supervisor.submitUserMessage(harness.session.id, 'talk');

    await new Promise((r) => setTimeout(r, 80));
    await harness.supervisor.stop();

    expect(getAgentSessionById(harness.session.id)?.status).toBe('running');
    expect(harness.supervisor.isSessionActive(harness.session.id)).toBe(false);
  });
});

describe('AgentSupervisor - 重启恢复', () => {
  test("恢复 status='running' 的 session：从已落库 messages 重新发起 run", async () => {
    const mock = createMockChatServer(() =>
      sseResponse([chunk({ role: 'assistant', content: 'resumed' }), chunk({}, 'stop')])
    );
    servers.push(mock.server);

    const harness = createSupervisorHarness({
      baseUrl: mock.baseUrl,
      sessionStatus: 'running',
    });
    appendAgentMessage(harness.session.id, 'user', { role: 'user', content: 'continue please' });

    await harness.supervisor.start();
    await harness.waitForIdle();

    expect(getAgentSessionById(harness.session.id)?.status).toBe('idle');
    const lastAssistant = listAgentMessages(harness.session.id)
      .filter((m) => m.role === 'assistant')
      .at(-1);
    expect((lastAssistant?.content as { content: Array<{ text: string }> }).content[0]!.text).toBe(
      'resumed'
    );
    // 重新发起的请求带上了已落库的 user 消息
    expect(mock.requests[0]!.body.messages.some((m) => m.role === 'user')).toBe(true);
  });

  test("恢复 status='running' 且残留 pending confirmations：先作废再重跑", async () => {
    const mock = createMockChatServer(() =>
      sseResponse([chunk({ role: 'assistant', content: 'recovered' }), chunk({}, 'stop')])
    );
    servers.push(mock.server);

    const harness = createSupervisorHarness({
      baseUrl: mock.baseUrl,
      writeMode: 'confirm',
      sessionStatus: 'running',
    });
    // 模拟 crash 现场：approval-request 已落库、confirmation pending，但 status 仍是 running
    appendAgentMessage(harness.session.id, 'user', { role: 'user', content: 'run ls' });
    appendAgentMessage(harness.session.id, 'assistant', {
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          toolCallId: 'call_crash_1',
          toolName: 'send_input',
          input: { text: 'ls', keys: ['enter'] },
        },
        {
          type: 'tool-approval-request',
          approvalId: 'approval_crash_1',
          toolCallId: 'call_crash_1',
        },
      ],
    });
    const confirmation = createAgentConfirmation({
      id: 'approval_crash_1',
      sessionId: harness.session.id,
      toolName: 'send_input',
      toolCallId: 'call_crash_1',
      inputJson: { text: 'ls', keys: ['enter'] },
    });

    await harness.supervisor.start();
    await harness.waitForIdle();

    // 残留 confirmation 被作废并广播
    expect(getAgentConfirmationById(confirmation.id)?.status).toBe('cancelled');
    expect(listPendingAgentConfirmations(harness.session.id).length).toBe(0);
    const resolved = harness.broadcasts.filter(
      (b) => b.eventType === wsBorsh.AGENT_EVENT_CONFIRMATION_RESOLVED
    );
    expect(resolved.length).toBe(1);
    expect((resolved[0]!.payload as { status: string }).status).toBe('cancelled');

    // 悬空 tool call 被补上 SDK 原生 execution-denied output，重跑请求合法
    const toolMessages = listAgentMessages(harness.session.id).filter((m) => m.role === 'tool');
    const denied = toolMessages
      .flatMap(
        (m) =>
          (
            m.content as {
              content: Array<{ type: string; output?: { type: string; reason?: string } }>;
            }
          ).content
      )
      .find((p) => p.type === 'tool-result');
    expect(denied?.output).toEqual({
      type: 'execution-denied',
      reason: 'invalidated after restart',
    });

    // run 正常完成
    expect(getAgentSessionById(harness.session.id)?.status).toBe('idle');
    expect(mock.requests.length).toBeGreaterThanOrEqual(1);
  });

  test("恢复 status='waiting_confirmation'：pending 仍在则保持等待，不发起 run、不重发通知", async () => {
    const mock = createMockChatServer(() => sseResponse([chunk({}, 'stop')]));
    servers.push(mock.server);

    const harness = createSupervisorHarness({
      baseUrl: mock.baseUrl,
      sessionStatus: 'waiting_confirmation',
    });
    createAgentConfirmation({
      sessionId: harness.session.id,
      toolName: 'send_input',
      toolCallId: 'call-y',
      inputJson: { text: 'ls' },
    });

    await harness.supervisor.start();
    await new Promise((r) => setTimeout(r, 50));

    expect(getAgentSessionById(harness.session.id)?.status).toBe('waiting_confirmation');
    expect(harness.supervisor.isSessionActive(harness.session.id)).toBe(false);
    expect(mock.requests.length).toBe(0);
    expect(listPendingAgentConfirmations(harness.session.id).length).toBe(1);
  });

  test("恢复 status='waiting_confirmation' 但 pending 丢失：自愈置 idle", async () => {
    const mock = createMockChatServer(() => sseResponse([chunk({}, 'stop')]));
    servers.push(mock.server);

    const harness = createSupervisorHarness({
      baseUrl: mock.baseUrl,
      sessionStatus: 'waiting_confirmation',
    });

    await harness.supervisor.start();
    expect(getAgentSessionById(harness.session.id)?.status).toBe('idle');
  });
});

describe('AgentSupervisor - syncProvider', () => {
  test('注入的 syncProvider 返回 status/pending/lastMessageSeq', async () => {
    const mock = createMockChatServer(() => sseResponse([chunk({}, 'stop')]));
    servers.push(mock.server);

    const harness = createSupervisorHarness({
      baseUrl: mock.baseUrl,
      sessionStatus: 'waiting_confirmation',
    });
    appendAgentMessage(harness.session.id, 'user', { role: 'user', content: 'hi' });
    const confirmation = createAgentConfirmation({
      sessionId: harness.session.id,
      toolName: 'send_input',
      toolCallId: 'call-z',
      inputJson: { text: 'pwd' },
    });

    await harness.supervisor.start();
    expect(harness.hub.syncProvider).not.toBeNull();

    const sync = (await harness.hub.syncProvider!(harness.session.id)) as {
      status: string;
      inProgressText: string;
      pendingConfirmations: Array<{ confirmationId: string }>;
      lastMessageSeq: number;
    };
    expect(sync.status).toBe('waiting_confirmation');
    expect(sync.inProgressText).toBe('');
    expect(sync.pendingConfirmations.map((c) => c.confirmationId)).toEqual([confirmation.id]);
    expect(sync.lastMessageSeq).toBe(0);

    const missing = await harness.hub.syncProvider!(crypto.randomUUID());
    expect(missing).toBeNull();
  });
});
