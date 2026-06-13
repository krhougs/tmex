import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { AgentEventPayloadMap } from '@tmex/shared';
import { wsBorsh } from '@tmex/shared';
import type { ModelMessage } from 'ai';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { createDevice, ensureSiteSettingsInitialized } from '../db';
import {
  type AgentSessionRecord,
  appendAgentMessage,
  createAgentSession,
  ensureAgentSettingsInitialized,
  getAgentSessionById,
  listAgentMessages,
  listPendingAgentConfirmations,
} from '../db/agent';
import { getDb as getOrmDb } from '../db/client';
import { AgentRun, type AgentRunDeps, applyMessageWindow, isRetryableLlmError } from './run';
import type { TerminalRuntimeLike } from './tools/terminal';

// ========== mock LLM server（spike 模式） ==========

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

/** 发完 chunks 后挂起不关闭（模拟上游 SSE stall），用于看门狗测试 */
function hangingSseResponse(chunks: unknown[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const c of chunks) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(c)}\n\n`));
      }
      // 故意不 close：连接保持打开，不再有数据
    },
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
}

interface RecordedRequest {
  body: { messages: Array<Record<string, unknown>>; tools?: unknown[] };
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

const TEST_DEVICE_ID = 'agent-run-test-device';

interface BroadcastRecord {
  sessionId: string;
  eventType: number;
  payload: unknown;
  seq: number;
}

interface NotifyRecord {
  eventType: string;
  event: Record<string, unknown>;
}

interface TestHarness {
  session: AgentSessionRecord;
  broadcasts: BroadcastRecord[];
  notifications: NotifyRecord[];
  runtimeCalls: { sendInput: Array<{ paneId: string; data: string }>; capture: string[] };
  deps: Partial<AgentRunDeps>;
  titleCalls: string[];
}

interface HarnessOptions {
  baseUrl: string;
  writeMode?: 'confirm' | 'auto';
  title?: string;
  captureError?: () => Error | null;
  screen?: string;
  deltaFlushIntervalMs?: number;
  generatedTitle?: string;
  streamIdleTimeoutMs?: number;
}

function createHarness(options: HarnessOptions): TestHarness {
  const session = createAgentSession({
    title: options.title ?? 'Test Session',
    deviceId: TEST_DEVICE_ID,
    paneId: '%5',
    modelId: 'mock-model',
    writeMode: options.writeMode ?? 'auto',
  });

  const broadcasts: BroadcastRecord[] = [];
  const notifications: NotifyRecord[] = [];
  const runtimeCalls: TestHarness['runtimeCalls'] = { sendInput: [], capture: [] };
  const titleCalls: string[] = [];

  const runtime: TerminalRuntimeLike = {
    sendInput(paneId, data) {
      runtimeCalls.sendInput.push({ paneId, data });
    },
    async capturePaneText(paneId) {
      runtimeCalls.capture.push(paneId);
      const error = options.captureError?.();
      if (error) {
        throw error;
      }
      return options.screen ?? 'screen line 1\nscreen line 2';
    },
    async getPaneInfo() {
      return {
        cols: 80,
        rows: 24,
        cursorX: 0,
        cursorY: 0,
        alternateScreen: false,
        currentCommand: 'bash',
      };
    },
  };

  const deps: Partial<AgentRunDeps> = {
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
      broadcasts.push({ sessionId, eventType, payload, seq });
    },
    notify: async (eventType, event) => {
      notifications.push({ eventType, event: event as unknown as Record<string, unknown> });
    },
    generateTitle: async (_model, prompt) => {
      titleCalls.push(prompt);
      return options.generatedTitle ?? 'Generated Title';
    },
    sleepMs: async () => {},
    deltaFlushIntervalMs: options.deltaFlushIntervalMs ?? 10,
    retryDelaysMs: [1, 1, 1],
    llmMaxRetries: 0,
    streamIdleTimeoutMs: options.streamIdleTimeoutMs ?? 90_000,
    notifyTurnFinished: true,
  };

  return { session, broadcasts, notifications, runtimeCalls, deps, titleCalls };
}

function eventsOfType(harness: TestHarness, eventType: number): BroadcastRecord[] {
  return harness.broadcasts.filter((b) => b.eventType === eventType);
}

beforeAll(() => {
  migrate(getOrmDb(), { migrationsFolder: resolve(import.meta.dir, '../../drizzle') });
  ensureSiteSettingsInitialized();
  ensureAgentSettingsInitialized();
  const now = new Date().toISOString();
  createDevice({
    id: TEST_DEVICE_ID,
    name: 'run-test-device',
    type: 'local',
    session: 'tmex-test',
    authMode: 'agent',
    port: 22,
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
  });
});

describe('applyMessageWindow（历史滑窗）', () => {
  const userMsg = (text: string): ModelMessage => ({ role: 'user', content: text });
  const assistantText = (text: string): ModelMessage => ({
    role: 'assistant',
    content: [{ type: 'text', text }],
  });
  const assistantToolCall = (toolCallId: string): ModelMessage => ({
    role: 'assistant',
    content: [{ type: 'tool-call', toolCallId, toolName: 'read_screen', input: {} }],
  });
  const toolResult = (toolCallId: string, text: string): ModelMessage => ({
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId,
        toolName: 'read_screen',
        output: { type: 'text', value: text },
      },
    ],
  });

  test('预算内原样返回（同一引用）', () => {
    const messages = [userMsg('hi'), assistantText('hello')];
    expect(applyMessageWindow(messages, 10_000)).toBe(messages);
  });

  test('超预算时从预算内最早的 user 边界开始保留，tool 链不被拆散', () => {
    const messages = [
      userMsg('x'.repeat(600)),
      assistantToolCall('call_a'),
      toolResult('call_a', 'y'.repeat(600)),
      assistantText('step one done'),
      userMsg('second question'),
      assistantText('second answer'),
      userMsg('third question'),
      assistantText('third answer'),
    ];
    // 预算容不下含 tool 链的前缀，但容得下从 'second question' 开始的后缀
    const windowed = applyMessageWindow(messages, 400);
    expect(windowed[0]).toBe(messages[4]);
    expect(windowed).toEqual(messages.slice(4));
    // 不存在没有对应 tool-call 的孤立 tool-result
    const toolCallIds = new Set(
      windowed
        .filter((m) => m.role === 'assistant' && Array.isArray(m.content))
        .flatMap((m) => m.content as Array<{ type: string; toolCallId?: string }>)
        .filter((p) => p.type === 'tool-call')
        .map((p) => p.toolCallId)
    );
    for (const message of windowed) {
      if (message.role !== 'tool') continue;
      for (const part of message.content as Array<{ type: string; toolCallId?: string }>) {
        if (part.type === 'tool-result') {
          expect(toolCallIds.has(part.toolCallId)).toBe(true);
        }
      }
    }
  });

  test('从最后一条 user 起的后缀也超预算时，仍保留最后一条 user 起（合法性优先）', () => {
    const messages = [
      userMsg('first'),
      assistantText('a'.repeat(500)),
      userMsg('last question'),
      assistantText('b'.repeat(500)),
    ];
    const windowed = applyMessageWindow(messages, 100);
    expect(windowed[0]).toBe(messages[2]);
    expect(windowed.length).toBe(2);
  });

  test('没有 user 消息时原样返回', () => {
    const messages = [assistantText('a'.repeat(500)), assistantText('b'.repeat(500))];
    expect(applyMessageWindow(messages, 100)).toBe(messages);
  });
});

describe('isRetryableLlmError（TypeError 收窄）', () => {
  test('网络类 TypeError 可重试', () => {
    expect(isRetryableLlmError(new TypeError('fetch failed'))).toBe(true);
    expect(
      isRetryableLlmError(new TypeError('terminated', { cause: new Error('ECONNRESET') }))
    ).toBe(true);
    const withCode = new TypeError('request failed');
    (withCode as { cause?: unknown }).cause = Object.assign(new Error('boom'), {
      code: 'ECONNREFUSED',
    });
    expect(isRetryableLlmError(withCode)).toBe(true);
  });

  test('代码型 TypeError 不可重试', () => {
    expect(isRetryableLlmError(new TypeError('undefined is not a function'))).toBe(false);
    expect(
      isRetryableLlmError(new TypeError("Cannot read properties of undefined (reading 'foo')"))
    ).toBe(false);
  });
});

describe('AgentRun 核心循环', () => {
  test('正常多步 turn：工具执行、step 边界落库、广播序列、turn_finished', async () => {
    const mock = createMockChatServer((callIndex) => {
      if (callIndex === 0) {
        return sseResponse([
          chunk({
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'call_read_1',
                type: 'function',
                function: { name: 'read_screen', arguments: '{}' },
              },
            ],
          }),
          chunk({}, 'tool_calls'),
        ]);
      }
      return sseResponse([
        chunk({ role: 'assistant', content: 'The screen shows ' }),
        chunk({ content: 'two lines.' }),
        chunk({}, 'stop'),
      ]);
    });
    servers.push(mock.server);

    const harness = createHarness({ baseUrl: mock.baseUrl });
    appendAgentMessage(harness.session.id, 'user', { role: 'user', content: 'what is on screen?' });

    const run = new AgentRun(harness.session.id, harness.deps);
    const outcome = await run.execute();

    expect(outcome).toBe('idle');
    expect(getAgentSessionById(harness.session.id)?.status).toBe('idle');

    // 工具真实执行
    expect(harness.runtimeCalls.capture).toEqual(['%5']);

    // step 边界落库：user / assistant(tool-call) / tool(result) / assistant(text)
    const messages = listAgentMessages(harness.session.id);
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    const lastContent = messages[3]!.content as { content: Array<{ type: string; text: string }> };
    expect(lastContent.content[0]!.text).toBe('The screen shows two lines.');

    // 广播：status running 开始、tool_call/tool_result 即时、message_persisted 带 seq、最终 idle + turn_finished
    const statusEvents = eventsOfType(harness, wsBorsh.AGENT_EVENT_STATUS).map(
      (b) => (b.payload as AgentEventPayloadMap[typeof wsBorsh.AGENT_EVENT_STATUS]).status
    );
    expect(statusEvents[0]).toBe('running');
    expect(statusEvents[statusEvents.length - 1]).toBe('idle');

    const toolCalls = eventsOfType(harness, wsBorsh.AGENT_EVENT_TOOL_CALL);
    expect(toolCalls.length).toBe(1);
    expect((toolCalls[0]!.payload as { toolName: string }).toolName).toBe('read_screen');

    const toolResults = eventsOfType(harness, wsBorsh.AGENT_EVENT_TOOL_RESULT);
    expect(toolResults.length).toBe(1);

    const persisted = eventsOfType(harness, wsBorsh.AGENT_EVENT_MESSAGE_PERSISTED).map(
      (b) => b.payload as { seq: number; role: string }
    );
    expect(persisted.map((p) => p.seq)).toEqual([1, 2, 3]);

    const finished = eventsOfType(harness, wsBorsh.AGENT_EVENT_TURN_FINISHED);
    expect(finished.length).toBe(1);
    expect(finished[0]!.payload).toEqual({ sessionStatus: 'idle', lastMessageSeq: 3 });

    // 文本 delta 拼接完整
    const textDeltas = eventsOfType(harness, wsBorsh.AGENT_EVENT_TEXT_DELTA)
      .map((b) => (b.payload as { delta: string }).delta)
      .join('');
    expect(textDeltas).toBe('The screen shows two lines.');

    // 默认发送 turn_finished 通知
    expect(harness.notifications.map((n) => n.eventType)).toContain('agent_turn_finished');

    // 事件 seq 单调递增
    const seqs = harness.broadcasts.map((b) => b.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
  });

  test('writeMode=confirm：send_input 触发 approval → confirmations 落库 + waiting_confirmation + 通知', async () => {
    const mock = createMockChatServer(() =>
      sseResponse([
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
      ])
    );
    servers.push(mock.server);

    const harness = createHarness({ baseUrl: mock.baseUrl, writeMode: 'confirm' });
    appendAgentMessage(harness.session.id, 'user', { role: 'user', content: 'run ls' });

    const run = new AgentRun(harness.session.id, harness.deps);
    const outcome = await run.execute();

    expect(outcome).toBe('waiting_confirmation');
    expect(getAgentSessionById(harness.session.id)?.status).toBe('waiting_confirmation');

    // 工具未执行
    expect(harness.runtimeCalls.sendInput.length).toBe(0);

    // confirmation 落库（id = approvalId），input 为工具入参
    const pending = listPendingAgentConfirmations(harness.session.id);
    expect(pending.length).toBe(1);
    expect(pending[0]!.toolName).toBe('send_input');
    expect(pending[0]!.toolCallId).toBe('call_send_1');
    expect(pending[0]!.inputJson).toEqual({ text: 'ls', keys: ['enter'] });

    // 广播 confirmation_request + 通知 agent_confirmation_pending
    const requests = eventsOfType(harness, wsBorsh.AGENT_EVENT_CONFIRMATION_REQUEST);
    expect(requests.length).toBe(1);
    expect((requests[0]!.payload as { confirmationId: string }).confirmationId).toBe(
      pending[0]!.id
    );
    expect(harness.notifications.map((n) => n.eventType)).toContain('agent_confirmation_pending');

    // 含 approval-request 的 assistant 消息已落库（供续跑）
    const messages = listAgentMessages(harness.session.id);
    const lastAssistant = messages.filter((m) => m.role === 'assistant').at(-1);
    const parts = (lastAssistant?.content as { content: Array<{ type: string }> }).content;
    expect(parts.some((p) => p.type === 'tool-approval-request')).toBe(true);
  });

  test('abort：已累积文本落库（truncated）且手动停止置 stopped', async () => {
    const mock = createMockChatServer(() =>
      slowSseResponse(
        [
          chunk({ role: 'assistant', content: 'partial ' }),
          chunk({ content: 'text ' }),
          chunk({ content: 'that ' }),
          chunk({ content: 'keeps ' }),
          chunk({ content: 'going' }),
          chunk({}, 'stop'),
        ],
        40
      )
    );
    servers.push(mock.server);

    const harness = createHarness({ baseUrl: mock.baseUrl });
    appendAgentMessage(harness.session.id, 'user', { role: 'user', content: 'talk' });

    const run = new AgentRun(harness.session.id, harness.deps);
    const promise = run.execute();
    await new Promise((r) => setTimeout(r, 90));
    run.requestStop('manual');
    const outcome = await promise;

    expect(outcome).toBe('stopped');
    expect(getAgentSessionById(harness.session.id)?.status).toBe('stopped');

    const messages = listAgentMessages(harness.session.id);
    const truncated = messages.find(
      (m) => (m.content as { truncated?: boolean }).truncated === true
    );
    expect(truncated).toBeDefined();
    expect(truncated!.role).toBe('assistant');
    const text = (truncated!.content as { content: Array<{ text: string }> }).content[0]!.text;
    expect(text.length).toBeGreaterThan(0);
    expect('partial text that keeps going'.startsWith(text)).toBe(true);

    const finished = eventsOfType(harness, wsBorsh.AGENT_EVENT_TURN_FINISHED);
    expect(finished.length).toBe(1);
    expect((finished[0]!.payload as { sessionStatus: string }).sessionStatus).toBe('stopped');
  });

  test('shutdown abort：status 保持 running（重启后恢复）', async () => {
    const mock = createMockChatServer(() =>
      slowSseResponse(
        [
          chunk({ role: 'assistant', content: 'aaa' }),
          chunk({ content: 'bbb' }),
          chunk({}, 'stop'),
        ],
        50
      )
    );
    servers.push(mock.server);

    const harness = createHarness({ baseUrl: mock.baseUrl });
    appendAgentMessage(harness.session.id, 'user', { role: 'user', content: 'talk' });

    const run = new AgentRun(harness.session.id, harness.deps);
    const promise = run.execute();
    await new Promise((r) => setTimeout(r, 70));
    run.requestStop('shutdown');
    const outcome = await promise;

    expect(outcome).toBe('interrupted');
    expect(getAgentSessionById(harness.session.id)?.status).toBe('running');
  });

  test('终端工具连续 2 次失败 fail-fast：run 终止、status=error、notify agent_error', async () => {
    const mock = createMockChatServer((callIndex) => {
      // 模型不断要求读屏
      if (callIndex < 5) {
        return sseResponse([
          chunk({
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: `call_read_${callIndex}`,
                type: 'function',
                function: { name: 'read_screen', arguments: '{}' },
              },
            ],
          }),
          chunk({}, 'tool_calls'),
        ]);
      }
      return sseResponse([chunk({ role: 'assistant', content: 'done' }), chunk({}, 'stop')]);
    });
    servers.push(mock.server);

    const harness = createHarness({
      baseUrl: mock.baseUrl,
      captureError: () => new Error('ssh connection lost'),
    });
    appendAgentMessage(harness.session.id, 'user', { role: 'user', content: 'check screen' });

    const run = new AgentRun(harness.session.id, harness.deps);
    const outcome = await run.execute();

    expect(outcome).toBe('error');
    const session = getAgentSessionById(harness.session.id);
    expect(session?.status).toBe('error');
    expect(session?.lastError).toContain('terminal tool failed');

    expect(harness.notifications.map((n) => n.eventType)).toContain('agent_error');
    const errors = eventsOfType(harness, wsBorsh.AGENT_EVENT_ERROR);
    expect(errors.length).toBe(1);

    // 不应该跑满 5 个 step（fail-fast 在第 2 次失败时 abort）
    expect(mock.requests.length).toBeLessThanOrEqual(3);
  });

  test('流空闲看门狗：上游 SSE stall 时 abort 并落 error', async () => {
    const mock = createMockChatServer(() =>
      // 发一个 assistant 片段后挂起不关闭，模拟上游 stall
      hangingSseResponse([chunk({ role: 'assistant', content: 'partial' })])
    );
    servers.push(mock.server);

    const harness = createHarness({ baseUrl: mock.baseUrl, streamIdleTimeoutMs: 80 });
    appendAgentMessage(harness.session.id, 'user', { role: 'user', content: 'hi' });

    const run = new AgentRun(harness.session.id, harness.deps);
    const outcome = await run.execute();

    expect(outcome).toBe('error');
    const session = getAgentSessionById(harness.session.id);
    expect(session?.status).toBe('error');
    expect(eventsOfType(harness, wsBorsh.AGENT_EVENT_ERROR).length).toBe(1);
  });

  test('节流广播：高频 delta 合帧（广播帧数远小于 delta 数）', async () => {
    const deltas = Array.from({ length: 40 }, (_, i) => chunk({ content: `w${i} ` }));
    const mock = createMockChatServer(() =>
      sseResponse([chunk({ role: 'assistant', content: '' }), ...deltas, chunk({}, 'stop')])
    );
    servers.push(mock.server);

    const harness = createHarness({ baseUrl: mock.baseUrl, deltaFlushIntervalMs: 50 });
    appendAgentMessage(harness.session.id, 'user', { role: 'user', content: 'count' });

    const run = new AgentRun(harness.session.id, harness.deps);
    await run.execute();

    const frames = eventsOfType(harness, wsBorsh.AGENT_EVENT_TEXT_DELTA);
    const joined = frames.map((b) => (b.payload as { delta: string }).delta).join('');
    expect(joined).toBe(Array.from({ length: 40 }, (_, i) => `w${i} `).join(''));
    // 40 个 delta 在同一响应内极快到达，合帧后帧数应显著小于 delta 数
    expect(frames.length).toBeLessThan(10);
  });

  test('网络/5xx 整轮重试：首次 500 后重试成功', async () => {
    const mock = createMockChatServer((callIndex) => {
      if (callIndex === 0) {
        return new Response('internal error', { status: 500 });
      }
      return sseResponse([chunk({ role: 'assistant', content: 'recovered' }), chunk({}, 'stop')]);
    });
    servers.push(mock.server);

    const harness = createHarness({ baseUrl: mock.baseUrl });
    appendAgentMessage(harness.session.id, 'user', { role: 'user', content: 'hello' });

    const run = new AgentRun(harness.session.id, harness.deps);
    const outcome = await run.execute();

    expect(outcome).toBe('idle');
    expect(getAgentSessionById(harness.session.id)?.status).toBe('idle');
    const messages = listAgentMessages(harness.session.id);
    const lastAssistant = messages.filter((m) => m.role === 'assistant').at(-1);
    expect((lastAssistant?.content as { content: Array<{ text: string }> }).content[0]!.text).toBe(
      'recovered'
    );
  });

  test('持续失败：外层重试耗尽后 status=error + lastError + notify', async () => {
    const mock = createMockChatServer(() => new Response('boom', { status: 500 }));
    servers.push(mock.server);

    const harness = createHarness({ baseUrl: mock.baseUrl });
    appendAgentMessage(harness.session.id, 'user', { role: 'user', content: 'hello' });

    const run = new AgentRun(harness.session.id, harness.deps);
    const outcome = await run.execute();

    expect(outcome).toBe('error');
    const session = getAgentSessionById(harness.session.id);
    expect(session?.status).toBe('error');
    expect(session?.lastError).toBeTruthy();
    expect(harness.notifications.map((n) => n.eventType)).toContain('agent_error');
  });

  test('标题自动生成：默认标题 + 正常结束后用首条 user 消息生成', async () => {
    const mock = createMockChatServer(() =>
      sseResponse([chunk({ role: 'assistant', content: 'hi there' }), chunk({}, 'stop')])
    );
    servers.push(mock.server);

    const harness = createHarness({
      baseUrl: mock.baseUrl,
      title: 'New Session',
      generatedTitle: 'Check Disk Usage',
    });
    appendAgentMessage(harness.session.id, 'user', { role: 'user', content: 'check disk usage' });

    const run = new AgentRun(harness.session.id, harness.deps);
    const outcome = await run.execute();

    expect(outcome).toBe('idle');
    expect(harness.titleCalls.length).toBe(1);
    expect(harness.titleCalls[0]).toContain('check disk usage');
    expect(getAgentSessionById(harness.session.id)?.title).toBe('Check Disk Usage');
  });

  test('标题已自定义时不再生成', async () => {
    const mock = createMockChatServer(() =>
      sseResponse([chunk({ role: 'assistant', content: 'ok' }), chunk({}, 'stop')])
    );
    servers.push(mock.server);

    const harness = createHarness({ baseUrl: mock.baseUrl, title: 'My Custom Title' });
    appendAgentMessage(harness.session.id, 'user', { role: 'user', content: 'hello' });

    const run = new AgentRun(harness.session.id, harness.deps);
    await run.execute();

    expect(harness.titleCalls.length).toBe(0);
    expect(getAgentSessionById(harness.session.id)?.title).toBe('My Custom Title');
  });

  test('标题生成失败静默：不影响 idle 结果', async () => {
    const mock = createMockChatServer(() =>
      sseResponse([chunk({ role: 'assistant', content: 'ok' }), chunk({}, 'stop')])
    );
    servers.push(mock.server);

    const harness = createHarness({ baseUrl: mock.baseUrl, title: 'New Session' });
    harness.deps.generateTitle = async () => {
      throw new Error('title model unavailable');
    };
    appendAgentMessage(harness.session.id, 'user', { role: 'user', content: 'hello' });

    const run = new AgentRun(harness.session.id, harness.deps);
    const outcome = await run.execute();

    expect(outcome).toBe('idle');
    expect(getAgentSessionById(harness.session.id)?.status).toBe('idle');
    expect(getAgentSessionById(harness.session.id)?.title).toBe('New Session');
  });

  test('带 truncated 顶层字段的 assistant 消息回喂下一 turn 不炸', async () => {
    const mock = createMockChatServer(() =>
      sseResponse([chunk({ role: 'assistant', content: 'continuing' }), chunk({}, 'stop')])
    );
    servers.push(mock.server);

    const harness = createHarness({ baseUrl: mock.baseUrl });
    // 模拟上一 turn abort 时 persistTruncatedText 落库的消息形态
    appendAgentMessage(harness.session.id, 'user', { role: 'user', content: 'first ask' });
    appendAgentMessage(harness.session.id, 'assistant', {
      role: 'assistant',
      content: [{ type: 'text', text: 'partial answer that was cut' }],
      truncated: true,
    });
    appendAgentMessage(harness.session.id, 'user', { role: 'user', content: 'go on' });

    const run = new AgentRun(harness.session.id, harness.deps);
    const outcome = await run.execute();

    expect(outcome).toBe('idle');
    expect(getAgentSessionById(harness.session.id)?.status).toBe('idle');
    // mock server 收到合法请求，截断文本作为 assistant 历史被带上
    expect(mock.requests.length).toBe(1);
    const sent = mock.requests[0]!.body.messages;
    expect(sent.some((m) => m.role === 'assistant')).toBe(true);
    expect(JSON.stringify(sent)).toContain('partial answer that was cut');
  });
});
