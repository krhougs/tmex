import { beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import type { AgentSyncEventPayload } from '@tmex/shared';
import { wsBorsh } from '@tmex/shared';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { appendAgentMessage, createAgentConfirmation, createAgentSession } from '../db/agent';
import { getDb as getOrmDb } from '../db/client';
import { type AgentHubClient, AgentWsHub } from './ws-hub';

interface MockWs {
  data: { borshState: { seqGen: () => number; maxFrameBytes: number } };
  sent: Uint8Array[];
  send: (data: Uint8Array) => void;
}

function createMockWs(): MockWs {
  const ws: MockWs = {
    data: {
      borshState: {
        seqGen: wsBorsh.createSeqGenerator(),
        maxFrameBytes: wsBorsh.DEFAULT_MAX_FRAME_BYTES,
      },
    },
    sent: [],
    send(data: Uint8Array) {
      ws.sent.push(data);
    },
  };
  return ws;
}

function asClient(ws: MockWs): AgentHubClient {
  return ws as unknown as AgentHubClient;
}

function decodeAgentEvent(data: Uint8Array) {
  const envelope = wsBorsh.decodeEnvelope(data);
  expect(envelope.kind).toBe(wsBorsh.KIND_AGENT_EVENT);
  const decoded = wsBorsh.decodePayload(wsBorsh.schema.AgentEventSchema, envelope.payload);
  return {
    ...decoded,
    json: JSON.parse(new TextDecoder().decode(decoded.payload)),
  };
}

function decodeWatchEvent(data: Uint8Array) {
  const envelope = wsBorsh.decodeEnvelope(data);
  expect(envelope.kind).toBe(wsBorsh.KIND_WATCH_EVENT);
  const decoded = wsBorsh.decodePayload(wsBorsh.schema.WatchEventSchema, envelope.payload);
  return {
    ...decoded,
    json: JSON.parse(new TextDecoder().decode(decoded.payload)),
  };
}

const stubSync: AgentSyncEventPayload = {
  status: 'idle',
  lastError: null,
  inProgressText: '',
  inProgressReasoning: '',
  pendingConfirmations: [],
  lastMessageSeq: -1,
};

beforeAll(() => {
  migrate(getOrmDb(), { migrationsFolder: resolve(import.meta.dir, '../../drizzle') });
});

describe('AgentWsHub', () => {
  test('subscribe 后立即回发 sync 事件（seq=0）', async () => {
    const hub = new AgentWsHub({
      syncProvider: async () => ({ ...stubSync, inProgressText: 'partial' }),
    });
    const ws = createMockWs();

    await hub.subscribe(asClient(ws), 'session-1');

    expect(ws.sent.length).toBe(1);
    const event = decodeAgentEvent(ws.sent[0]!);
    expect(event.sessionId).toBe('session-1');
    expect(event.seq).toBe(0);
    expect(event.eventType).toBe(wsBorsh.AGENT_EVENT_SYNC);
    expect(event.json.inProgressText).toBe('partial');
  });

  test('syncProvider 返回 null 时不回发 sync', async () => {
    const hub = new AgentWsHub({ syncProvider: async () => null });
    const ws = createMockWs();

    await hub.subscribe(asClient(ws), 'missing-session');
    expect(ws.sent.length).toBe(0);
  });

  test('broadcastAgentEvent 只发给对应 session 的订阅者', async () => {
    const hub = new AgentWsHub({ syncProvider: async () => null });
    const subscriber = createMockWs();
    const otherSubscriber = createMockWs();
    const nonSubscriber = createMockWs();

    hub.registerClient(asClient(nonSubscriber));
    await hub.subscribe(asClient(subscriber), 'session-a');
    await hub.subscribe(asClient(otherSubscriber), 'session-b');

    hub.broadcastAgentEvent('session-a', wsBorsh.AGENT_EVENT_TEXT_DELTA, {
      messageId: 'm1',
      delta: 'hi',
    }, 5);

    expect(subscriber.sent.length).toBe(1);
    expect(otherSubscriber.sent.length).toBe(0);
    expect(nonSubscriber.sent.length).toBe(0);

    const event = decodeAgentEvent(subscriber.sent[0]!);
    expect(event.sessionId).toBe('session-a');
    expect(event.seq).toBe(5);
    expect(event.eventType).toBe(wsBorsh.AGENT_EVENT_TEXT_DELTA);
    expect(event.json).toEqual({ messageId: 'm1', delta: 'hi' });
  });

  test('unsubscribe 后不再收到广播', async () => {
    const hub = new AgentWsHub({ syncProvider: async () => null });
    const ws = createMockWs();

    await hub.subscribe(asClient(ws), 'session-a');
    hub.unsubscribe(asClient(ws), 'session-a');

    hub.broadcastAgentEvent('session-a', wsBorsh.AGENT_EVENT_STATUS, { status: 'running' }, 1);
    expect(ws.sent.length).toBe(0);
  });

  test('removeClient 清理全部订阅与客户端集合', async () => {
    const hub = new AgentWsHub({ syncProvider: async () => null });
    const ws = createMockWs();

    hub.registerClient(asClient(ws));
    await hub.subscribe(asClient(ws), 'session-a');
    await hub.subscribe(asClient(ws), 'session-b');

    hub.removeClient(asClient(ws));

    hub.broadcastAgentEvent('session-a', wsBorsh.AGENT_EVENT_STATUS, { status: 'running' }, 1);
    hub.broadcastAgentEvent('session-b', wsBorsh.AGENT_EVENT_STATUS, { status: 'running' }, 1);
    hub.broadcastWatchEvent('rule-1', 'device-1', '%1', wsBorsh.WATCH_EVENT_TRIGGERED, {
      summary: 's',
    });
    expect(ws.sent.length).toBe(0);
  });

  test('broadcastWatchEvent 发给所有已注册客户端（与订阅无关）', async () => {
    const hub = new AgentWsHub({ syncProvider: async () => null });
    const client1 = createMockWs();
    const client2 = createMockWs();
    const unregistered = createMockWs();

    hub.registerClient(asClient(client1));
    hub.registerClient(asClient(client2));

    hub.broadcastWatchEvent('rule-1', 'device-1', '%1', wsBorsh.WATCH_EVENT_TRIGGERED, {
      summary: 'matched',
      matchedText: 'ERROR',
    });

    expect(client1.sent.length).toBe(1);
    expect(client2.sent.length).toBe(1);
    expect(unregistered.sent.length).toBe(0);

    const event = decodeWatchEvent(client1.sent[0]!);
    expect(event.ruleId).toBe('rule-1');
    expect(event.deviceId).toBe('device-1');
    expect(event.paneId).toBe('%1');
    expect(event.eventType).toBe(wsBorsh.WATCH_EVENT_TRIGGERED);
    expect(event.json).toEqual({ summary: 'matched', matchedText: 'ERROR' });
  });

  test('subscribe 等待 sync 期间退订则不回发', async () => {
    let resolveSync: (value: AgentSyncEventPayload) => void = () => {};
    const hub = new AgentWsHub({
      syncProvider: () =>
        new Promise<AgentSyncEventPayload>((resolve) => {
          resolveSync = resolve;
        }),
    });
    const ws = createMockWs();

    const pending = hub.subscribe(asClient(ws), 'session-a');
    hub.unsubscribe(asClient(ws), 'session-a');
    resolveSync(stubSync);
    await pending;

    expect(ws.sent.length).toBe(0);
  });

  test('默认 syncProvider 从 DB 读取 status/confirmations/lastMessageSeq', async () => {
    const session = createAgentSession({ title: 'hub-test', modelId: 'gpt-test' });
    appendAgentMessage(session.id, 'user', { text: 'hello' });
    appendAgentMessage(session.id, 'assistant', { text: 'world' });
    const confirmation = createAgentConfirmation({
      sessionId: session.id,
      toolName: 'write_pane',
      toolCallId: 'call-1',
      inputJson: { text: 'ls' },
    });

    const hub = new AgentWsHub();
    const ws = createMockWs();
    await hub.subscribe(asClient(ws), session.id);

    expect(ws.sent.length).toBe(1);
    const event = decodeAgentEvent(ws.sent[0]!);
    expect(event.eventType).toBe(wsBorsh.AGENT_EVENT_SYNC);
    const sync = event.json as AgentSyncEventPayload;
    expect(sync.status).toBe('idle');
    expect(sync.inProgressText).toBe('');
    expect(sync.lastMessageSeq).toBe(1);
    expect(sync.pendingConfirmations).toEqual([
      {
        confirmationId: confirmation.id,
        toolCallId: 'call-1',
        toolName: 'write_pane',
        input: { text: 'ls' },
        createdAt: confirmation.createdAt,
      },
    ]);
  });

  test('默认 syncProvider 对不存在的 session 不回发', async () => {
    const hub = new AgentWsHub();
    const ws = createMockWs();
    await hub.subscribe(asClient(ws), crypto.randomUUID());
    expect(ws.sent.length).toBe(0);
  });
});
