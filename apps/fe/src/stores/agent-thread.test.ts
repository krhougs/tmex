import { describe, expect, test } from 'bun:test';

import type { AgentMessageDto } from '@tmex/shared';
import { buildThreadBlocks, unwrapToolOutput } from './agent-thread';

describe('unwrapToolOutput', () => {
  test('unwraps text/json as success', () => {
    expect(unwrapToolOutput({ type: 'text', value: 'ok' })).toEqual({
      value: 'ok',
      isError: false,
      denied: false,
    });
    expect(unwrapToolOutput({ type: 'json', value: { a: 1 } })).toEqual({
      value: { a: 1 },
      isError: false,
      denied: false,
    });
  });

  test('unwraps error-text/error-json as error', () => {
    expect(unwrapToolOutput({ type: 'error-text', value: 'boom' })).toEqual({
      value: 'boom',
      isError: true,
      denied: false,
    });
    expect(unwrapToolOutput({ type: 'error-json', value: { message: 'boom' } })).toEqual({
      value: { message: 'boom' },
      isError: true,
      denied: false,
    });
  });

  test('unwraps execution-denied (no value field) as denied with reason', () => {
    expect(unwrapToolOutput({ type: 'execution-denied', reason: 'user denied' })).toEqual({
      value: 'user denied',
      isError: false,
      denied: true,
    });
    expect(unwrapToolOutput({ type: 'execution-denied' })).toEqual({
      value: undefined,
      isError: false,
      denied: true,
    });
  });

  test('passes through raw execute return values', () => {
    expect(unwrapToolOutput('plain string')).toEqual({
      value: 'plain string',
      isError: false,
      denied: false,
    });
    const raw = { screen: 'foo', type: 42 };
    expect(unwrapToolOutput(raw)).toEqual({ value: raw, isError: false, denied: false });
  });
});

describe('buildThreadBlocks denied tool result pairing', () => {
  function makeMessages(): AgentMessageDto[] {
    return [
      {
        id: 'm1',
        sessionId: 's1',
        seq: 0,
        role: 'assistant',
        content: {
          role: 'assistant',
          content: [
            { type: 'tool-call', toolCallId: 'tc-1', toolName: 'send_input', input: { text: 'x' } },
          ],
        },
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'm2',
        sessionId: 's1',
        seq: 1,
        role: 'tool',
        content: {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'tc-1',
              toolName: 'send_input',
              output: { type: 'execution-denied', reason: 'not allowed' },
            },
          ],
        },
        createdAt: '2026-01-01T00:00:01.000Z',
      },
    ] as AgentMessageDto[];
  }

  test('marks paired tool call as denied instead of success', () => {
    const blocks = buildThreadBlocks(makeMessages(), undefined);
    expect(blocks).toHaveLength(1);
    const block = blocks[0];
    if (block.kind !== 'tool-call') {
      throw new Error('expected tool-call block');
    }
    expect(block.call.resolved).toBe(true);
    expect(block.call.denied).toBe(true);
    expect(block.call.isError).toBe(false);
    expect(block.call.output).toBe('not allowed');
  });

  test('error-json result marks tool call as error', () => {
    const messages = makeMessages();
    const toolMessage = messages[1].content as {
      content: Array<{ output: unknown }>;
    };
    toolMessage.content[0].output = { type: 'error-json', value: { error: 'failed' } };
    const blocks = buildThreadBlocks(messages, undefined);
    const block = blocks[0];
    if (block.kind !== 'tool-call') {
      throw new Error('expected tool-call block');
    }
    expect(block.call.resolved).toBe(true);
    expect(block.call.denied).toBe(false);
    expect(block.call.isError).toBe(true);
  });
});
