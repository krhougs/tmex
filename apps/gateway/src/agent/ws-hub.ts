// Agent/Watch WS 订阅 hub
// 维护 sessionId -> 订阅客户端 集合，负责 AGENT_EVENT/WATCH_EVENT 的 borsh 编码与广播。
// 事件来源：agent runtime（Task 5）与 watch service（Task 6）。

import { wsBorsh } from '@tmex/shared';
import type { AgentSyncEventPayload } from '@tmex/shared';
import type { ServerWebSocket } from 'bun';
import {
  getAgentSessionById,
  getMaxAgentMessageSeq,
  listPendingAgentConfirmations,
} from '../db/agent';

export interface AgentHubClientState {
  borshState: {
    seqGen: () => number;
    maxFrameBytes: number;
  };
}

export type AgentHubClient = ServerWebSocket<AgentHubClientState>;

export type AgentSyncProvider = (sessionId: string) => Promise<AgentSyncEventPayload | null>;

// 默认 syncProvider：仅从 DB 读取 status / pending confirmations / lastMessageSeq。
// 边界：进行中回合的累积文本（inProgressText/inProgressReasoning）只存在于 agent runtime 内存中，
// Task 5 会通过 setSyncProvider 注入包含这些字段的真实实现，本实现恒为空串。
async function dbSyncProvider(sessionId: string): Promise<AgentSyncEventPayload | null> {
  const session = getAgentSessionById(sessionId);
  if (!session) return null;

  const pending = listPendingAgentConfirmations(sessionId);

  return {
    status: session.status,
    lastError: session.lastError,
    inProgressText: '',
    inProgressReasoning: '',
    pendingConfirmations: pending.map((c) => ({
      confirmationId: c.id,
      toolCallId: c.toolCallId,
      toolName: c.toolName,
      input: c.inputJson,
      createdAt: c.createdAt,
    })),
    lastMessageSeq: getMaxAgentMessageSeq(sessionId),
  };
}

interface AgentWsHubOptions {
  syncProvider?: AgentSyncProvider;
}

export class AgentWsHub {
  private clients = new Set<AgentHubClient>();
  private subscriptions = new Map<string, Set<AgentHubClient>>();
  private syncProvider: AgentSyncProvider;

  constructor(options: AgentWsHubOptions = {}) {
    this.syncProvider = options.syncProvider ?? dbSyncProvider;
  }

  setSyncProvider(provider: AgentSyncProvider): void {
    this.syncProvider = provider;
  }

  registerClient(ws: AgentHubClient): void {
    this.clients.add(ws);
  }

  removeClient(ws: AgentHubClient): void {
    this.clients.delete(ws);
    for (const [sessionId, subscribers] of this.subscriptions) {
      subscribers.delete(ws);
      if (subscribers.size === 0) {
        this.subscriptions.delete(sessionId);
      }
    }
  }

  async subscribe(ws: AgentHubClient, sessionId: string): Promise<void> {
    let subscribers = this.subscriptions.get(sessionId);
    if (!subscribers) {
      subscribers = new Set();
      this.subscriptions.set(sessionId, subscribers);
    }
    subscribers.add(ws);

    try {
      const sync = await this.syncProvider(sessionId);
      if (!sync) return;
      // 等待 syncProvider 期间客户端可能已退订/断开
      if (!subscribers.has(ws)) return;
      this.sendAgentEvent(ws, sessionId, wsBorsh.AGENT_EVENT_SYNC, sync, 0);
    } catch (err) {
      console.error(`[agent-ws-hub] sync for session ${sessionId} failed:`, err);
    }
  }

  unsubscribe(ws: AgentHubClient, sessionId: string): void {
    const subscribers = this.subscriptions.get(sessionId);
    if (!subscribers) return;
    subscribers.delete(ws);
    if (subscribers.size === 0) {
      this.subscriptions.delete(sessionId);
    }
  }

  broadcastAgentEvent(sessionId: string, eventType: number, payload: unknown, seq: number): void {
    const subscribers = this.subscriptions.get(sessionId);
    if (!subscribers?.size) return;

    const payloadBytes = encodeAgentEventPayload(sessionId, eventType, payload, seq);
    for (const ws of subscribers) {
      this.sendPayload(ws, wsBorsh.KIND_AGENT_EVENT, payloadBytes);
    }
  }

  broadcastWatchEvent(
    ruleId: string,
    deviceId: string,
    paneId: string,
    eventType: number,
    payload: unknown
  ): void {
    if (this.clients.size === 0) return;

    const payloadBytes = wsBorsh.encodePayload(wsBorsh.schema.WatchEventSchema, {
      ruleId,
      deviceId,
      paneId,
      eventType,
      payload: encodeJsonBytes(payload),
    });

    for (const ws of this.clients) {
      this.sendPayload(ws, wsBorsh.KIND_WATCH_EVENT, payloadBytes);
    }
  }

  private sendAgentEvent(
    ws: AgentHubClient,
    sessionId: string,
    eventType: number,
    payload: unknown,
    seq: number
  ): void {
    this.sendPayload(
      ws,
      wsBorsh.KIND_AGENT_EVENT,
      encodeAgentEventPayload(sessionId, eventType, payload, seq)
    );
  }

  // 与 WebSocketServer.sendEnvelope/sendChunked 保持一致的封包方式
  private sendPayload(ws: AgentHubClient, kind: number, payloadBytes: Uint8Array): void {
    try {
      const state = ws.data.borshState;
      const originalSeq = state.seqGen();
      const chunked = wsBorsh.splitPayloadIntoChunks(payloadBytes, kind, originalSeq, {
        maxFrameBytes: state.maxFrameBytes,
        chunkStreamId: wsBorsh.generateChunkStreamId(),
      });

      if (chunked.totalChunks === 0) {
        ws.send(wsBorsh.encodeEnvelope(kind, payloadBytes, originalSeq));
        return;
      }

      for (const chunk of chunked.chunks) {
        ws.send(wsBorsh.encodeChunk(chunk, state.seqGen()));
      }
    } catch (err) {
      console.error('[agent-ws-hub] failed to send payload:', err);
    }
  }
}

function encodeJsonBytes(payload: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(payload ?? null));
}

function encodeAgentEventPayload(
  sessionId: string,
  eventType: number,
  payload: unknown,
  seq: number
): Uint8Array {
  return wsBorsh.encodePayload(wsBorsh.schema.AgentEventSchema, {
    sessionId,
    seq,
    eventType,
    payload: encodeJsonBytes(payload),
  });
}

export const agentWsHub = new AgentWsHub();
