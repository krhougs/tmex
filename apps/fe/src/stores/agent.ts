// Agent 会话 store：REST 管理 + WS 订阅流式事件
// 模式仿 tmux.ts：模块级 initialized 防重入、client.onMessage 独立 handler、READY 重连补发订阅。

import { getBorshClient } from '@/ws-borsh';
import { buildAgentSubscribe, buildAgentUnsubscribe } from '@/ws-borsh';
import type {
  AgentConfirmationDto,
  AgentMessageDto,
  AgentSessionDto,
  AgentSessionStatus,
  AgentWriteMode,
} from '@tmex/shared';
import type {
  AgentConfirmationRequestPayload,
  AgentConfirmationResolvedPayload,
  AgentErrorEventPayload,
  AgentMessagePersistedPayload,
  AgentReasoningDeltaPayload,
  AgentStatusEventPayload,
  AgentSyncEventPayload,
  AgentTextDeltaPayload,
  AgentToolCallPayload,
  AgentToolResultPayload,
  AgentTurnFinishedPayload,
} from '@tmex/shared';
import { wsBorsh } from '@tmex/shared';
import { toast } from 'sonner';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import i18n from '../i18n';
import {
  type SessionInProgress,
  emptyInProgress,
  maxMessageSeq,
  unwrapToolOutput,
} from './agent-thread';

export interface PendingConfirmationUi {
  id: string;
  toolCallId: string;
  toolName: string;
  input: unknown;
  createdAt: string;
}

interface AgentState {
  sessions: Record<string, AgentSessionDto | undefined>;
  sessionOrder: string[];
  sessionsLoaded: boolean;
  activeSessionId: string | null;
  showAllSessions: boolean;
  messages: Record<string, AgentMessageDto[] | undefined>;
  historyLoaded: Record<string, boolean | undefined>;
  inProgress: Record<string, SessionInProgress | undefined>;
  pendingConfirmations: Record<string, PendingConfirmationUi[] | undefined>;
  sending: Record<string, boolean | undefined>;

  ensureInitialized: () => void;
  loadSessions: () => Promise<void>;
  refreshSession: (sessionId: string) => Promise<void>;
  setActiveSession: (sessionId: string | null) => void;
  setShowAllSessions: (showAll: boolean) => void;
  createSession: (deviceId: string, paneId: string) => Promise<AgentSessionDto | null>;
  renameSession: (sessionId: string, title: string) => Promise<boolean>;
  deleteSession: (sessionId: string) => Promise<boolean>;
  setWriteMode: (sessionId: string, writeMode: AgentWriteMode) => Promise<void>;
  rebindPane: (sessionId: string, paneId: string) => Promise<void>;
  loadHistory: (sessionId: string) => Promise<void>;
  sendMessage: (sessionId: string, text: string) => Promise<boolean>;
  stopSession: (sessionId: string) => Promise<void>;
  decideConfirmation: (
    sessionId: string,
    confirmationId: string,
    approved: boolean,
    reason?: string
  ) => Promise<void>;
}

async function parseApiError(res: Response, fallback: string): Promise<string> {
  try {
    const payload = (await res.json()) as { error?: string };
    return payload.error ?? fallback;
  } catch {
    return fallback;
  }
}

function sortSessionOrder(sessions: Record<string, AgentSessionDto | undefined>): string[] {
  return Object.values(sessions)
    .filter((session): session is AgentSessionDto => Boolean(session))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    .map((session) => session.id);
}

function mergeMessages(
  existing: AgentMessageDto[] | undefined,
  incoming: AgentMessageDto[]
): AgentMessageDto[] {
  if (!existing || existing.length === 0) {
    return [...incoming].sort((a, b) => a.seq - b.seq);
  }
  const bySeq = new Map<number, AgentMessageDto>();
  for (const message of existing) {
    bySeq.set(message.seq, message);
  }
  for (const message of incoming) {
    bySeq.set(message.seq, message);
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

// ========== 模块级状态（非渲染数据，避免进 store） ==========

let initialized = false;

// 已订阅 session 集合：READY 重连后重发订阅
const subscribedSessions = new Set<string>();

// 流式 delta 节流缓冲：每帧 set 会卡渲染，~40ms 合并 flush 一次
const DELTA_FLUSH_MS = 40;
interface DeltaBufferEntry {
  texts: Map<string, string>;
  reasonings: Map<string, string>;
}
const deltaBuffer = new Map<string, DeltaBufferEntry>();
let deltaFlushTimer: ReturnType<typeof setTimeout> | null = null;

// MESSAGE_PERSISTED 触发的增量拉取去抖
const HISTORY_FETCH_DEBOUNCE_MS = 120;
const historyFetchTimers = new Map<string, ReturnType<typeof setTimeout>>();
const historyLoadingSessions = new Set<string>();
// in-flight 期间又有新的 loadHistory 请求：标记完成后重跑，避免丢增量
const historyReloadPending = new Set<string>();

function clearSessionRuntime(sessionId: string): void {
  const timer = historyFetchTimers.get(sessionId);
  if (timer) {
    clearTimeout(timer);
    historyFetchTimers.delete(sessionId);
  }
  deltaBuffer.delete(sessionId);
  historyReloadPending.delete(sessionId);
}

function sendSubscribe(sessionId: string): void {
  const msg = buildAgentSubscribe(sessionId);
  getBorshClient().send(msg.kind, msg.payload);
}

function sendUnsubscribe(sessionId: string): void {
  const msg = buildAgentUnsubscribe(sessionId);
  getBorshClient().send(msg.kind, msg.payload);
}

type SetState = (
  partial: Partial<AgentState> | ((prev: AgentState) => Partial<AgentState>)
) => void;
type GetState = () => AgentState;

function appendDelta(
  sessionId: string,
  channel: 'texts' | 'reasonings',
  messageId: string,
  delta: string
): void {
  let entry = deltaBuffer.get(sessionId);
  if (!entry) {
    entry = { texts: new Map(), reasonings: new Map() };
    deltaBuffer.set(sessionId, entry);
  }
  const segments = entry[channel];
  segments.set(messageId, (segments.get(messageId) ?? '') + delta);
}

function makeDeltaFlusher(setState: SetState) {
  const flush = (): void => {
    if (deltaFlushTimer) {
      clearTimeout(deltaFlushTimer);
      deltaFlushTimer = null;
    }
    if (deltaBuffer.size === 0) {
      return;
    }
    const buffered = new Map(deltaBuffer);
    deltaBuffer.clear();

    setState((prev) => {
      const nextInProgress = { ...prev.inProgress };
      for (const [sessionId, entry] of buffered) {
        const current = nextInProgress[sessionId] ?? emptyInProgress();
        const next: SessionInProgress = {
          ...current,
          texts: [...current.texts],
          reasonings: [...current.reasonings],
        };
        for (const channel of ['texts', 'reasonings'] as const) {
          for (const [messageId, delta] of entry[channel]) {
            const segments = next[channel];
            const index = segments.findIndex((segment) => segment.messageId === messageId);
            if (index >= 0) {
              segments[index] = {
                ...segments[index],
                text: segments[index].text + delta,
              };
            } else {
              // staleBarrier 不传染给新 messageId：barrier 窗口内已落库消息的残留 delta
              // 会命中上面的既有 stale 段分支；走到这里的是下一 step 新消息，正常入流，
              // 避免被 loadHistory 误清导致已显示文本闪缩
              segments.push({ messageId, text: delta, stale: false });
            }
          }
        }
        nextInProgress[sessionId] = next;
      }
      return { inProgress: nextInProgress };
    });
  };

  const schedule = (): void => {
    if (deltaFlushTimer) return;
    deltaFlushTimer = setTimeout(flush, DELTA_FLUSH_MS);
  };

  return { flush, schedule };
}

function setupClientHandlers(setState: SetState, getState: GetState): void {
  if (initialized) return;
  initialized = true;

  const client = getBorshClient();
  const deltaFlusher = makeDeltaFlusher(setState);

  const scheduleHistoryFetch = (sessionId: string): void => {
    const existing = historyFetchTimers.get(sessionId);
    if (existing) return;
    historyFetchTimers.set(
      sessionId,
      setTimeout(() => {
        historyFetchTimers.delete(sessionId);
        void getState().loadHistory(sessionId);
      }, HISTORY_FETCH_DEBOUNCE_MS)
    );
  };

  const handleSync = (sessionId: string, payload: AgentSyncEventPayload): void => {
    // SYNC 重置 inProgress 后，缓冲里的旧 delta 不应再回流重复显示
    deltaBuffer.delete(sessionId);
    setState((prev) => {
      const session = prev.sessions[sessionId];
      const inProgress = emptyInProgress();
      if (payload.inProgressText) {
        inProgress.texts.push({
          messageId: '__sync__',
          text: payload.inProgressText,
          stale: false,
        });
      }
      if (payload.inProgressReasoning) {
        inProgress.reasonings.push({
          messageId: '__sync_reasoning__',
          text: payload.inProgressReasoning,
          stale: false,
        });
      }
      return {
        sessions: session
          ? {
              ...prev.sessions,
              [sessionId]: { ...session, status: payload.status, lastError: payload.lastError },
            }
          : prev.sessions,
        inProgress: { ...prev.inProgress, [sessionId]: inProgress },
        pendingConfirmations: {
          ...prev.pendingConfirmations,
          [sessionId]: payload.pendingConfirmations.map((confirmation) => ({
            id: confirmation.confirmationId,
            toolCallId: confirmation.toolCallId,
            toolName: confirmation.toolName,
            input: confirmation.input,
            createdAt: confirmation.createdAt,
          })),
        },
      };
    });

    const state = getState();
    if (
      payload.lastMessageSeq > maxMessageSeq(state.messages[sessionId]) ||
      !state.historyLoaded[sessionId]
    ) {
      void state.loadHistory(sessionId);
    }
  };

  const handleStatus = (sessionId: string, payload: AgentStatusEventPayload): void => {
    const known = Boolean(getState().sessions[sessionId]);
    setState((prev) => {
      const session = prev.sessions[sessionId];
      if (!session) return prev;
      return {
        sessions: {
          ...prev.sessions,
          [sessionId]: {
            ...session,
            status: payload.status,
            lastError: payload.lastError !== undefined ? payload.lastError : session.lastError,
          },
        },
      };
    });
    if (!known) {
      // 本地未知 session（如别端新建），全量拉列表兜底
      void getState().loadSessions();
      return;
    }
    // 标题自动生成等 session 元数据变化也通过 STATUS 通知，单拉该 session 保持同步
    void getState().refreshSession(sessionId);
  };

  const handleToolCall = (sessionId: string, payload: AgentToolCallPayload): void => {
    deltaFlusher.flush();
    setState((prev) => {
      const current = prev.inProgress[sessionId] ?? emptyInProgress();
      const toolCalls = [...current.toolCalls];
      const index = toolCalls.findIndex((call) => call.toolCallId === payload.toolCallId);
      const next = {
        toolCallId: payload.toolCallId,
        toolName: payload.toolName,
        input: payload.input,
        isError: false,
        denied: false,
        resolved: false,
        stale: false,
      };
      if (index >= 0) {
        toolCalls[index] = { ...toolCalls[index], ...next };
      } else {
        toolCalls.push(next);
      }
      return {
        inProgress: { ...prev.inProgress, [sessionId]: { ...current, toolCalls } },
      };
    });
  };

  const handleToolResult = (sessionId: string, payload: AgentToolResultPayload): void => {
    deltaFlusher.flush();
    const { value, isError, denied } = unwrapToolOutput(payload.output);
    setState((prev) => {
      const current = prev.inProgress[sessionId] ?? emptyInProgress();
      const toolCalls = [...current.toolCalls];
      const index = toolCalls.findIndex((call) => call.toolCallId === payload.toolCallId);
      if (index >= 0) {
        toolCalls[index] = {
          ...toolCalls[index],
          output: value,
          isError: Boolean(payload.isError) || isError,
          denied,
          resolved: true,
        };
      } else {
        toolCalls.push({
          toolCallId: payload.toolCallId,
          toolName: payload.toolName,
          input: undefined,
          output: value,
          isError: Boolean(payload.isError) || isError,
          denied,
          resolved: true,
          stale: current.staleBarrier,
        });
      }
      return {
        inProgress: { ...prev.inProgress, [sessionId]: { ...current, toolCalls } },
      };
    });
  };

  const handleConfirmationRequest = (
    sessionId: string,
    payload: AgentConfirmationRequestPayload
  ): void => {
    setState((prev) => {
      const list = prev.pendingConfirmations[sessionId] ?? [];
      if (list.some((confirmation) => confirmation.id === payload.confirmationId)) {
        return prev;
      }
      return {
        pendingConfirmations: {
          ...prev.pendingConfirmations,
          [sessionId]: [
            ...list,
            {
              id: payload.confirmationId,
              toolCallId: payload.toolCallId,
              toolName: payload.toolName,
              input: payload.input,
              createdAt: new Date().toISOString(),
            },
          ],
        },
      };
    });
  };

  const handleConfirmationResolved = (
    sessionId: string,
    payload: AgentConfirmationResolvedPayload
  ): void => {
    setState((prev) => {
      const list = prev.pendingConfirmations[sessionId];
      if (!list || !list.some((confirmation) => confirmation.id === payload.confirmationId)) {
        return prev;
      }
      return {
        pendingConfirmations: {
          ...prev.pendingConfirmations,
          [sessionId]: list.filter((confirmation) => confirmation.id !== payload.confirmationId),
        },
      };
    });
  };

  const handleMessagePersisted = (
    sessionId: string,
    payload: AgentMessagePersistedPayload
  ): void => {
    deltaFlusher.flush();
    if (payload.role === 'assistant' || payload.role === 'tool') {
      // 已落库内容对应的流式段标记 stale，等增量拉取落地后清除
      setState((prev) => {
        const current = prev.inProgress[sessionId];
        if (!current) return prev;
        return {
          inProgress: {
            ...prev.inProgress,
            [sessionId]: {
              texts: current.texts.map((segment) => ({ ...segment, stale: true })),
              reasonings: current.reasonings.map((segment) => ({ ...segment, stale: true })),
              toolCalls: current.toolCalls.map((call) =>
                call.resolved ? { ...call, stale: true } : call
              ),
              staleBarrier: true,
            },
          },
        };
      });
    }
    scheduleHistoryFetch(sessionId);
  };

  const handleTurnFinished = (sessionId: string, payload: AgentTurnFinishedPayload): void => {
    deltaFlusher.flush();
    setState((prev) => {
      const session = prev.sessions[sessionId];
      return {
        sessions: session
          ? { ...prev.sessions, [sessionId]: { ...session, status: payload.sessionStatus } }
          : prev.sessions,
        inProgress: { ...prev.inProgress, [sessionId]: emptyInProgress() },
      };
    });
    if (payload.lastMessageSeq > maxMessageSeq(getState().messages[sessionId])) {
      scheduleHistoryFetch(sessionId);
    }
  };

  const handleErrorEvent = (sessionId: string, payload: AgentErrorEventPayload): void => {
    const session = getState().sessions[sessionId];
    toast.error(i18n.t('agent.toast.errorTitle', { title: session?.title ?? 'Agent' }), {
      description: payload.message,
    });
  };

  client.onMessage((msg) => {
    if (msg.kind !== wsBorsh.KIND_AGENT_EVENT) {
      return;
    }

    let decoded: { sessionId: string; eventType: number; payload: Uint8Array };
    try {
      decoded = wsBorsh.decodePayload(wsBorsh.schema.AgentEventSchema, msg.payload);
    } catch (error) {
      console.error('[agent] failed to decode AGENT_EVENT:', error);
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder().decode(decoded.payload));
    } catch (error) {
      console.error('[agent] failed to parse AGENT_EVENT payload:', error);
      return;
    }

    const sessionId = decoded.sessionId;
    switch (decoded.eventType) {
      case wsBorsh.AGENT_EVENT_SYNC:
        handleSync(sessionId, payload as AgentSyncEventPayload);
        return;
      case wsBorsh.AGENT_EVENT_STATUS:
        handleStatus(sessionId, payload as AgentStatusEventPayload);
        return;
      case wsBorsh.AGENT_EVENT_TEXT_DELTA: {
        const delta = payload as AgentTextDeltaPayload;
        appendDelta(sessionId, 'texts', delta.messageId, delta.delta);
        deltaFlusher.schedule();
        return;
      }
      case wsBorsh.AGENT_EVENT_REASONING_DELTA: {
        const delta = payload as AgentReasoningDeltaPayload;
        appendDelta(sessionId, 'reasonings', delta.messageId, delta.delta);
        deltaFlusher.schedule();
        return;
      }
      case wsBorsh.AGENT_EVENT_TOOL_CALL:
        handleToolCall(sessionId, payload as AgentToolCallPayload);
        return;
      case wsBorsh.AGENT_EVENT_TOOL_RESULT:
        handleToolResult(sessionId, payload as AgentToolResultPayload);
        return;
      case wsBorsh.AGENT_EVENT_CONFIRMATION_REQUEST:
        handleConfirmationRequest(sessionId, payload as AgentConfirmationRequestPayload);
        return;
      case wsBorsh.AGENT_EVENT_CONFIRMATION_RESOLVED:
        handleConfirmationResolved(sessionId, payload as AgentConfirmationResolvedPayload);
        return;
      case wsBorsh.AGENT_EVENT_MESSAGE_PERSISTED:
        handleMessagePersisted(sessionId, payload as AgentMessagePersistedPayload);
        return;
      case wsBorsh.AGENT_EVENT_ERROR:
        handleErrorEvent(sessionId, payload as AgentErrorEventPayload);
        return;
      case wsBorsh.AGENT_EVENT_TURN_FINISHED:
        handleTurnFinished(sessionId, payload as AgentTurnFinishedPayload);
        return;
      default:
        return;
    }
  });

  // 重连后 send 队列不可靠（上限 100 且断线期间事件已丢），READY 时重发订阅 + 增量补史
  client.onStateChange((state) => {
    if (state !== 'READY') return;
    for (const sessionId of subscribedSessions) {
      sendSubscribe(sessionId);
    }
    const activeSessionId = getState().activeSessionId;
    if (activeSessionId) {
      void getState().loadHistory(activeSessionId);
    }
  });
}

export const useAgentStore = create<AgentState>()(
  persist(
    (set, get) => ({
      sessions: {},
      sessionOrder: [],
      sessionsLoaded: false,
      activeSessionId: null,
      showAllSessions: false,
      messages: {},
      historyLoaded: {},
      inProgress: {},
      pendingConfirmations: {},
      sending: {},

      ensureInitialized() {
        setupClientHandlers(set, get);
        getBorshClient().connect();
        const activeSessionId = get().activeSessionId;
        if (activeSessionId && !subscribedSessions.has(activeSessionId)) {
          subscribedSessions.add(activeSessionId);
          sendSubscribe(activeSessionId);
        }
      },

      async loadSessions() {
        try {
          const res = await fetch('/api/agent/sessions');
          if (!res.ok) {
            throw new Error(await parseApiError(res, 'Failed to load agent sessions'));
          }
          const payload = (await res.json()) as { sessions: AgentSessionDto[] };
          set(() => {
            const sessions: Record<string, AgentSessionDto> = {};
            for (const session of payload.sessions) {
              sessions[session.id] = session;
            }
            return {
              sessions,
              sessionOrder: sortSessionOrder(sessions),
              sessionsLoaded: true,
            };
          });
          // 持久化的 activeSessionId 可能已被别端删除
          const state = get();
          if (state.activeSessionId && !state.sessions[state.activeSessionId]) {
            state.setActiveSession(null);
          }
        } catch (error) {
          console.error('[agent] loadSessions failed:', error);
        }
      },

      async refreshSession(sessionId) {
        try {
          const res = await fetch(`/api/agent/sessions/${sessionId}`);
          if (res.status === 404) {
            // session 已被别端删除，回退全量刷新走统一清理逻辑
            await get().loadSessions();
            return;
          }
          if (!res.ok) {
            throw new Error(await parseApiError(res, 'Failed to load agent session'));
          }
          const payload = (await res.json()) as { session: AgentSessionDto };
          set((prev) => {
            const sessions = { ...prev.sessions, [sessionId]: payload.session };
            return { sessions, sessionOrder: sortSessionOrder(sessions) };
          });
        } catch (error) {
          console.error('[agent] refreshSession failed:', error);
        }
      },

      setActiveSession(sessionId) {
        const previous = get().activeSessionId;
        if (previous === sessionId) return;

        if (previous && subscribedSessions.has(previous)) {
          subscribedSessions.delete(previous);
          sendUnsubscribe(previous);
        }

        set({ activeSessionId: sessionId });

        if (sessionId) {
          subscribedSessions.add(sessionId);
          sendSubscribe(sessionId);
          if (!get().historyLoaded[sessionId]) {
            void get().loadHistory(sessionId);
          }
        }
      },

      setShowAllSessions(showAll) {
        set({ showAllSessions: showAll });
      },

      async createSession(deviceId, paneId) {
        try {
          const res = await fetch('/api/agent/sessions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ deviceId, paneId }),
          });
          if (!res.ok) {
            throw new Error(await parseApiError(res, 'Failed to create agent session'));
          }
          const payload = (await res.json()) as { session: AgentSessionDto };
          const session = payload.session;
          set((prev) => {
            const sessions = { ...prev.sessions, [session.id]: session };
            return {
              sessions,
              sessionOrder: sortSessionOrder(sessions),
              messages: { ...prev.messages, [session.id]: [] },
              historyLoaded: { ...prev.historyLoaded, [session.id]: true },
            };
          });
          get().setActiveSession(session.id);
          return session;
        } catch (error) {
          toast.error(error instanceof Error ? error.message : String(error));
          return null;
        }
      },

      async renameSession(sessionId, title) {
        try {
          const res = await fetch(`/api/agent/sessions/${sessionId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title }),
          });
          if (!res.ok) {
            throw new Error(await parseApiError(res, 'Failed to rename agent session'));
          }
          const payload = (await res.json()) as { session: AgentSessionDto };
          set((prev) => {
            const sessions = { ...prev.sessions, [sessionId]: payload.session };
            return { sessions, sessionOrder: sortSessionOrder(sessions) };
          });
          return true;
        } catch (error) {
          toast.error(error instanceof Error ? error.message : String(error));
          return false;
        }
      },

      async deleteSession(sessionId) {
        try {
          const res = await fetch(`/api/agent/sessions/${sessionId}`, {
            method: 'DELETE',
          });
          if (!res.ok) {
            throw new Error(await parseApiError(res, 'Failed to delete agent session'));
          }
          if (get().activeSessionId === sessionId) {
            get().setActiveSession(null);
          }
          clearSessionRuntime(sessionId);
          set((prev) => {
            const sessions = { ...prev.sessions };
            delete sessions[sessionId];
            const messages = { ...prev.messages };
            delete messages[sessionId];
            const historyLoaded = { ...prev.historyLoaded };
            delete historyLoaded[sessionId];
            const inProgress = { ...prev.inProgress };
            delete inProgress[sessionId];
            const pendingConfirmations = { ...prev.pendingConfirmations };
            delete pendingConfirmations[sessionId];
            return {
              sessions,
              sessionOrder: sortSessionOrder(sessions),
              messages,
              historyLoaded,
              inProgress,
              pendingConfirmations,
            };
          });
          return true;
        } catch (error) {
          toast.error(error instanceof Error ? error.message : String(error));
          return false;
        }
      },

      async setWriteMode(sessionId, writeMode) {
        try {
          const res = await fetch(`/api/agent/sessions/${sessionId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ writeMode }),
          });
          if (!res.ok) {
            throw new Error(await parseApiError(res, 'Failed to update write mode'));
          }
          const payload = (await res.json()) as { session: AgentSessionDto };
          set((prev) => ({ sessions: { ...prev.sessions, [sessionId]: payload.session } }));
        } catch (error) {
          toast.error(error instanceof Error ? error.message : String(error));
        }
      },

      async rebindPane(sessionId, paneId) {
        try {
          const res = await fetch(`/api/agent/sessions/${sessionId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ paneId }),
          });
          if (!res.ok) {
            throw new Error(await parseApiError(res, 'Failed to rebind pane'));
          }
          const payload = (await res.json()) as { session: AgentSessionDto };
          set((prev) => ({ sessions: { ...prev.sessions, [sessionId]: payload.session } }));
        } catch (error) {
          toast.error(error instanceof Error ? error.message : String(error));
        }
      },

      async loadHistory(sessionId) {
        if (historyLoadingSessions.has(sessionId)) {
          // in-flight 期间的新请求不能直接丢弃：响应可能不含本次触发对应的增量
          historyReloadPending.add(sessionId);
          return;
        }
        historyLoadingSessions.add(sessionId);
        try {
          const state = get();
          const afterSeq = state.historyLoaded[sessionId]
            ? maxMessageSeq(state.messages[sessionId])
            : -1;
          const query = afterSeq >= 0 ? `?afterSeq=${afterSeq}` : '';
          const res = await fetch(`/api/agent/sessions/${sessionId}/messages${query}`);
          if (!res.ok) {
            throw new Error(await parseApiError(res, 'Failed to load agent messages'));
          }
          const payload = (await res.json()) as { messages: AgentMessageDto[] };
          set((prev) => {
            const merged = mergeMessages(
              afterSeq >= 0 ? prev.messages[sessionId] : undefined,
              payload.messages
            );
            const current = prev.inProgress[sessionId];
            // 已落库内容对应的 stale 流式段在此处清除
            const inProgress = current
              ? {
                  texts: current.texts.filter((segment) => !segment.stale),
                  reasonings: current.reasonings.filter((segment) => !segment.stale),
                  toolCalls: current.toolCalls.filter((call) => !call.stale),
                  staleBarrier: false,
                }
              : current;
            return {
              messages: { ...prev.messages, [sessionId]: merged },
              historyLoaded: { ...prev.historyLoaded, [sessionId]: true },
              inProgress: inProgress
                ? { ...prev.inProgress, [sessionId]: inProgress }
                : prev.inProgress,
            };
          });
        } catch (error) {
          console.error('[agent] loadHistory failed:', error);
        } finally {
          historyLoadingSessions.delete(sessionId);
          if (historyReloadPending.delete(sessionId)) {
            void get().loadHistory(sessionId);
          }
        }
      },

      async sendMessage(sessionId, text) {
        set((prev) => ({ sending: { ...prev.sending, [sessionId]: true } }));
        try {
          const res = await fetch(`/api/agent/sessions/${sessionId}/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text }),
          });
          if (!res.ok) {
            throw new Error(await parseApiError(res, 'Failed to send message'));
          }
          const payload = (await res.json()) as { message: AgentMessageDto };
          set((prev) => {
            const session = prev.sessions[sessionId];
            return {
              messages: {
                ...prev.messages,
                [sessionId]: mergeMessages(prev.messages[sessionId], [payload.message]),
              },
              sessions: session
                ? {
                    ...prev.sessions,
                    [sessionId]: { ...session, status: 'running', lastError: null },
                  }
                : prev.sessions,
            };
          });
          return true;
        } catch (error) {
          toast.error(error instanceof Error ? error.message : String(error));
          return false;
        } finally {
          set((prev) => ({ sending: { ...prev.sending, [sessionId]: false } }));
        }
      },

      async stopSession(sessionId) {
        try {
          const res = await fetch(`/api/agent/sessions/${sessionId}/stop`, { method: 'POST' });
          if (!res.ok) {
            throw new Error(await parseApiError(res, 'Failed to stop agent session'));
          }
          const payload = (await res.json()) as { session: AgentSessionDto | null };
          if (payload.session) {
            const session = payload.session;
            set((prev) => ({ sessions: { ...prev.sessions, [sessionId]: session } }));
          }
        } catch (error) {
          toast.error(error instanceof Error ? error.message : String(error));
        }
      },

      async decideConfirmation(sessionId, confirmationId, approved, reason) {
        const removeLocally = (): void => {
          set((prev) => {
            const list = prev.pendingConfirmations[sessionId];
            if (!list) return prev;
            return {
              pendingConfirmations: {
                ...prev.pendingConfirmations,
                [sessionId]: list.filter((confirmation) => confirmation.id !== confirmationId),
              },
            };
          });
        };

        try {
          const res = await fetch(`/api/agent/confirmations/${confirmationId}/decide`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(reason === undefined ? { approved } : { approved, reason }),
          });
          if (res.status === 409) {
            // 已被别端决定：静默刷新 pending 列表
            removeLocally();
            try {
              const refresh = await fetch(`/api/agent/sessions/${sessionId}/confirmations`);
              if (refresh.ok) {
                const payload = (await refresh.json()) as {
                  confirmations: AgentConfirmationDto[];
                };
                set((prev) => ({
                  pendingConfirmations: {
                    ...prev.pendingConfirmations,
                    [sessionId]: payload.confirmations.map((confirmation) => ({
                      id: confirmation.id,
                      toolCallId: confirmation.toolCallId,
                      toolName: confirmation.toolName,
                      input: confirmation.input,
                      createdAt: confirmation.createdAt,
                    })),
                  },
                }));
              }
            } catch {
              // 刷新失败不致命，CONFIRMATION_RESOLVED 事件会兜底
            }
            return;
          }
          if (!res.ok) {
            throw new Error(await parseApiError(res, 'Failed to decide confirmation'));
          }
          removeLocally();
        } catch (error) {
          toast.error(error instanceof Error ? error.message : String(error));
        }
      },
    }),
    {
      name: 'tmex-agent',
      partialize: (state) => ({
        activeSessionId: state.activeSessionId,
        showAllSessions: state.showAllSessions,
      }),
    }
  )
);

export type { AgentSessionDto, AgentSessionStatus };
