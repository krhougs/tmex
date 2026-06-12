import { afterAll, describe, expect, test } from 'bun:test';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { ModelMessage } from 'ai';
import { stepCountIs, streamText, tool } from 'ai';
import { z } from 'zod';

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
    id: 'chatcmpl-spike',
    object: 'chat.completion.chunk',
    created: 1700000000,
    model: 'mock-model',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function sseResponse(chunks: unknown[]): Response {
  const body = `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`;
  return new Response(body, {
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

interface RecordedRequest {
  url: string;
  authorization: string | null;
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
        url: url.pathname,
        authorization: req.headers.get('authorization'),
        body: (await req.json()) as RecordedRequest['body'],
      };
      requests.push(recorded);
      return respond(requests.length - 1, recorded);
    },
  });
  return { server, requests, baseUrl: `http://127.0.0.1:${server.port}/v1` };
}

function makeModel(baseUrl: string) {
  return createOpenAICompatible({
    name: 'spike',
    baseURL: baseUrl,
    apiKey: 'spike-key',
  }).chatModel('mock-model');
}

const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterAll(() => {
  for (const server of servers) {
    server.stop(true);
  }
});

describe('ai sdk spike (bun runtime)', () => {
  test('a) streamText basic streaming consumption works', async () => {
    const mock = createMockChatServer(() =>
      sseResponse([
        chunk({ role: 'assistant', content: 'Hello' }),
        chunk({ content: ' from' }),
        chunk({ content: ' mock' }),
        chunk({}, 'stop'),
      ])
    );
    servers.push(mock.server);

    const result = streamText({
      model: makeModel(mock.baseUrl),
      prompt: 'say hello',
    });

    const parts: string[] = [];
    for await (const text of result.textStream) {
      parts.push(text);
    }

    expect(parts.join('')).toBe('Hello from mock');
    expect(await result.text).toBe('Hello from mock');
    expect(mock.requests[0]?.authorization).toBe('Bearer spike-key');
  });

  test('b) multi-step tool loop stops via stepCountIs', async () => {
    const mock = createMockChatServer((callIndex) => {
      if (callIndex === 0) {
        return sseResponse([
          chunk({
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'call_weather_1',
                type: 'function',
                function: { name: 'getWeather', arguments: '{"city":"Shanghai"}' },
              },
            ],
          }),
          chunk({}, 'tool_calls'),
        ]);
      }
      return sseResponse([
        chunk({ role: 'assistant', content: 'It is sunny in Shanghai.' }),
        chunk({}, 'stop'),
      ]);
    });
    servers.push(mock.server);

    let executedCity: string | null = null;
    const result = streamText({
      model: makeModel(mock.baseUrl),
      tools: {
        getWeather: tool({
          description: 'get weather',
          inputSchema: z.object({ city: z.string() }),
          execute: async ({ city }) => {
            executedCity = city;
            return { weather: 'sunny' };
          },
        }),
      },
      stopWhen: stepCountIs(5),
      prompt: 'weather in shanghai?',
    });

    expect(await result.text).toBe('It is sunny in Shanghai.');
    expect(executedCity ?? '').toBe('Shanghai');

    const steps = await result.steps;
    expect(steps.length).toBe(2);

    // 第二次请求应包含工具结果消息
    const secondRequestMessages = mock.requests[1]?.body.messages ?? [];
    expect(secondRequestMessages.some((m) => m.role === 'tool')).toBe(true);
  });

  test('c) needsApproval emits tool-approval-request and resumes via tool-approval-response', async () => {
    const mock = createMockChatServer((callIndex) => {
      if (callIndex === 0) {
        return sseResponse([
          chunk({
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'call_dangerous_1',
                type: 'function',
                function: { name: 'writeTerminal', arguments: '{"keys":"rm -rf /tmp/x"}' },
              },
            ],
          }),
          chunk({}, 'tool_calls'),
        ]);
      }
      return sseResponse([chunk({ role: 'assistant', content: 'Done.' }), chunk({}, 'stop')]);
    });
    servers.push(mock.server);

    let executed = false;
    const tools = {
      writeTerminal: tool({
        description: 'write to terminal',
        inputSchema: z.object({ keys: z.string() }),
        needsApproval: true,
        execute: async () => {
          executed = true;
          return { ok: true };
        },
      }),
    };

    const messages: ModelMessage[] = [{ role: 'user', content: 'clean tmp' }];

    // 第一轮：模型发起 tool call，因 needsApproval 流中出现 tool-approval-request，工具不执行
    const round1 = streamText({
      model: makeModel(mock.baseUrl),
      tools,
      stopWhen: stepCountIs(5),
      messages,
    });

    let approvalId: string | null = null;
    let approvalToolCallId: string | null = null;
    for await (const part of round1.fullStream) {
      if (part.type === 'tool-approval-request') {
        approvalId = part.approvalId;
        approvalToolCallId = part.toolCall.toolCallId;
      }
    }

    expect(approvalId).not.toBeNull();
    expect(approvalToolCallId).toBe('call_dangerous_1');
    expect(executed).toBe(false);
    // 第一轮结束时没有继续请求（等待审批）
    expect(mock.requests.length).toBe(1);

    const round1Messages = (await round1.response).messages;

    // d) ModelMessage 序列化/反序列化往返
    const restored = JSON.parse(JSON.stringify(round1Messages)) as ModelMessage[];
    expect(restored).toEqual(round1Messages as unknown as ModelMessage[]);

    messages.push(...restored);
    messages.push({
      role: 'tool',
      content: [
        {
          type: 'tool-approval-response',
          approvalId: approvalId as string,
          approved: true,
        },
      ],
    });

    // 第二轮：带 approval response 继续，工具被执行后模型给出最终回复
    const round2 = streamText({
      model: makeModel(mock.baseUrl),
      tools,
      stopWhen: stepCountIs(5),
      messages,
    });

    expect(await round2.text).toBe('Done.');
    expect(executed).toBe(true);

    // 第二轮发给模型的请求应包含工具执行结果
    const round2FirstRequest = mock.requests[1]?.body.messages ?? [];
    expect(round2FirstRequest.some((m) => m.role === 'tool')).toBe(true);
  });

  test('c-extra) denied approval skips execution', async () => {
    const mock = createMockChatServer((callIndex) => {
      if (callIndex === 0) {
        return sseResponse([
          chunk({
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'call_denied_1',
                type: 'function',
                function: { name: 'writeTerminal', arguments: '{"keys":"sudo reboot"}' },
              },
            ],
          }),
          chunk({}, 'tool_calls'),
        ]);
      }
      return sseResponse([
        chunk({ role: 'assistant', content: 'Understood, not running it.' }),
        chunk({}, 'stop'),
      ]);
    });
    servers.push(mock.server);

    let executed = false;
    const tools = {
      writeTerminal: tool({
        description: 'write to terminal',
        inputSchema: z.object({ keys: z.string() }),
        needsApproval: true,
        execute: async () => {
          executed = true;
          return { ok: true };
        },
      }),
    };

    const messages: ModelMessage[] = [{ role: 'user', content: 'reboot' }];
    const round1 = streamText({
      model: makeModel(mock.baseUrl),
      tools,
      stopWhen: stepCountIs(5),
      messages,
    });

    let approvalId: string | null = null;
    for await (const part of round1.fullStream) {
      if (part.type === 'tool-approval-request') {
        approvalId = part.approvalId;
      }
    }
    expect(approvalId).not.toBeNull();

    messages.push(...(await round1.response).messages);
    messages.push({
      role: 'tool',
      content: [
        {
          type: 'tool-approval-response',
          approvalId: approvalId as string,
          approved: false,
          reason: 'too dangerous',
        },
      ],
    });

    const round2 = streamText({
      model: makeModel(mock.baseUrl),
      tools,
      stopWhen: stepCountIs(5),
      messages,
    });

    expect(await round2.text).toBe('Understood, not running it.');
    expect(executed).toBe(false);
  });

  test('d) ModelMessage round-trip through JSON storage feeds back into messages', async () => {
    const mock = createMockChatServer((callIndex) => {
      if (callIndex === 0) {
        return sseResponse([
          chunk({ role: 'assistant', content: 'first reply' }),
          chunk({}, 'stop'),
        ]);
      }
      return sseResponse([
        chunk({ role: 'assistant', content: 'second reply' }),
        chunk({}, 'stop'),
      ]);
    });
    servers.push(mock.server);

    const messages: ModelMessage[] = [{ role: 'user', content: 'hi' }];
    const round1 = streamText({ model: makeModel(mock.baseUrl), messages });
    await round1.consumeStream();

    const stored = JSON.stringify((await round1.response).messages);
    const restored = JSON.parse(stored) as ModelMessage[];

    messages.push(...restored);
    messages.push({ role: 'user', content: 'again' });

    const round2 = streamText({ model: makeModel(mock.baseUrl), messages });
    expect(await round2.text).toBe('second reply');

    const secondRequestMessages = mock.requests[1]?.body.messages ?? [];
    expect(secondRequestMessages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(secondRequestMessages[1]?.content).toBe('first reply');
  });
});
