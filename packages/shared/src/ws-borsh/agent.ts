// Agent / Watch 事件常量与 JSON payload 形状约定（前后端共用）
// 注意：本文件中的 interface 是 AGENT_EVENT/WATCH_EVENT 中 payload（JSON bytes）的形状约定，
// 不是 borsh schema。borsh wire schema 见 ./schema.ts 的 AgentEventSchema/WatchEventSchema。

// ========== AGENT_EVENT eventType (u8) ==========

export const AGENT_EVENT_SYNC = 1;
export const AGENT_EVENT_STATUS = 2;
export const AGENT_EVENT_TEXT_DELTA = 3;
export const AGENT_EVENT_REASONING_DELTA = 4;
export const AGENT_EVENT_TOOL_CALL = 5;
export const AGENT_EVENT_TOOL_RESULT = 6;
export const AGENT_EVENT_CONFIRMATION_REQUEST = 7;
export const AGENT_EVENT_CONFIRMATION_RESOLVED = 8;
export const AGENT_EVENT_MESSAGE_PERSISTED = 9;
export const AGENT_EVENT_ERROR = 10;
export const AGENT_EVENT_TURN_FINISHED = 11;

// ========== WATCH_EVENT eventType (u8) ==========

export const WATCH_EVENT_TRIGGERED = 1;
export const WATCH_EVENT_MODEL_UNAVAILABLE = 2;
export const WATCH_EVENT_RULE_ERROR = 3;

// ========== Agent payload 类型 ==========

export type AgentSessionWireStatus =
  | 'idle'
  | 'running'
  | 'waiting_confirmation'
  | 'stopped'
  | 'error';

export type AgentConfirmationWireStatus = 'approved' | 'denied' | 'cancelled';

export interface AgentPendingConfirmation {
  confirmationId: string;
  toolCallId: string;
  toolName: string;
  input: unknown;
  createdAt: string;
}

// AGENT_EVENT_SYNC：订阅成功后服务端单发的全量同步
export interface AgentSyncEventPayload {
  status: AgentSessionWireStatus;
  lastError: string | null;
  // 进行中 assistant 消息的累积文本/思考（无进行中回合时为空串）
  inProgressText: string;
  inProgressReasoning: string;
  pendingConfirmations: AgentPendingConfirmation[];
  // 已持久化消息的最大 seq（无消息时为 -1），客户端据此走 REST 增量拉取
  lastMessageSeq: number;
}

// AGENT_EVENT_STATUS
export interface AgentStatusEventPayload {
  status: AgentSessionWireStatus;
  lastError?: string | null;
}

// AGENT_EVENT_TEXT_DELTA
export interface AgentTextDeltaPayload {
  messageId: string;
  delta: string;
}

// AGENT_EVENT_REASONING_DELTA
export interface AgentReasoningDeltaPayload {
  messageId: string;
  delta: string;
}

// AGENT_EVENT_TOOL_CALL
export interface AgentToolCallPayload {
  toolCallId: string;
  toolName: string;
  input: unknown;
}

// AGENT_EVENT_TOOL_RESULT
export interface AgentToolResultPayload {
  toolCallId: string;
  toolName: string;
  output: unknown;
  isError?: boolean;
}

// AGENT_EVENT_CONFIRMATION_REQUEST
export interface AgentConfirmationRequestPayload {
  confirmationId: string;
  toolCallId: string;
  toolName: string;
  input: unknown;
}

// AGENT_EVENT_CONFIRMATION_RESOLVED
export interface AgentConfirmationResolvedPayload {
  confirmationId: string;
  status: AgentConfirmationWireStatus;
  reason?: string | null;
}

// AGENT_EVENT_MESSAGE_PERSISTED
export interface AgentMessagePersistedPayload {
  messageId: string;
  seq: number;
  role: string;
}

// AGENT_EVENT_ERROR
export interface AgentErrorEventPayload {
  message: string;
  code?: string;
}

// AGENT_EVENT_TURN_FINISHED
export interface AgentTurnFinishedPayload {
  sessionStatus: AgentSessionWireStatus;
  lastMessageSeq: number;
}

// ========== Watch payload 类型 ==========

// WATCH_EVENT_TRIGGERED
export interface WatchTriggeredPayload {
  summary: string;
  matchedText?: string;
  windowId?: string;
}

// WATCH_EVENT_MODEL_UNAVAILABLE
export interface WatchModelUnavailablePayload {
  message: string;
}

// WATCH_EVENT_RULE_ERROR
export interface WatchRuleErrorPayload {
  message: string;
}

// ========== eventType -> payload 映射（编译期约束广播入口） ==========

export interface AgentEventPayloadMap {
  [AGENT_EVENT_SYNC]: AgentSyncEventPayload;
  [AGENT_EVENT_STATUS]: AgentStatusEventPayload;
  [AGENT_EVENT_TEXT_DELTA]: AgentTextDeltaPayload;
  [AGENT_EVENT_REASONING_DELTA]: AgentReasoningDeltaPayload;
  [AGENT_EVENT_TOOL_CALL]: AgentToolCallPayload;
  [AGENT_EVENT_TOOL_RESULT]: AgentToolResultPayload;
  [AGENT_EVENT_CONFIRMATION_REQUEST]: AgentConfirmationRequestPayload;
  [AGENT_EVENT_CONFIRMATION_RESOLVED]: AgentConfirmationResolvedPayload;
  [AGENT_EVENT_MESSAGE_PERSISTED]: AgentMessagePersistedPayload;
  [AGENT_EVENT_ERROR]: AgentErrorEventPayload;
  [AGENT_EVENT_TURN_FINISHED]: AgentTurnFinishedPayload;
}

export interface WatchEventPayloadMap {
  [WATCH_EVENT_TRIGGERED]: WatchTriggeredPayload;
  [WATCH_EVENT_MODEL_UNAVAILABLE]: WatchModelUnavailablePayload;
  [WATCH_EVENT_RULE_ERROR]: WatchRuleErrorPayload;
}

export type AgentEventType = keyof AgentEventPayloadMap;
export type WatchEventType = keyof WatchEventPayloadMap;
