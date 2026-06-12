// Agent 单轮 run 执行器
// 一次 run = 一次 streamText 多步循环（直到 stepCountIs / 等待审批 / abort / 出错）。
// 只在 step 边界落库完整 ModelMessage；流式 delta 仅聚合节流广播，不持久化。

import type { AgentEventPayloadMap, EventType, WebhookEvent } from '@tmex/shared';
import { DEFAULT_AGENT_SESSION_TITLE, wsBorsh } from '@tmex/shared';
import type { LanguageModel, ModelMessage, Tool, ToolSet } from 'ai';
import { APICallError, RetryError, generateText, stepCountIs, streamText } from 'ai';
import { getDeviceById, getSiteSettings } from '../db';
import {
  type AgentSessionRecord,
  appendAgentMessage,
  createAgentConfirmation,
  getAgentSessionById,
  getMaxAgentMessageSeq,
  listAgentMessages,
  updateAgentSession,
} from '../db/agent';
import { eventNotifier } from '../events';
import { t } from '../i18n';
import { resolveLanguageModel, resolveProviderWebSearchTool } from '../llm/provider-registry';
import { tmuxRuntimeRegistry } from '../tmux-client/registry';
import { buildAgentSystemPrompt, buildTitleGenerationPrompt } from './prompts';
import { type TerminalRuntimeLike, createTerminalTools } from './tools/terminal';
import { createFetchUrlTool, createWebSearchTool } from './tools/web';
import { agentWsHub } from './ws-hub';

const TERMINAL_FAILURE_LIMIT = 2;

/** 喂给模型的历史消息字符预算（JSON 序列化后，system prompt 不计入） */
export const MESSAGE_WINDOW_CHAR_BUDGET = 200_000;

/**
 * 历史消息滑窗：超出字符预算时从最旧开始丢弃，截断点必须落在 user 消息边界
 * （保证 assistant tool-call 与对应 tool-result 不被拆散、approval 链完整）。
 * - 预算内：原样返回
 * - 超预算：保留从"预算内最早的 user 消息"开始的后缀
 * - 连最后一条 user 起的后缀都超预算：仍从最后一条 user 开始保留（合法性优先于预算）
 * - 没有任何 user 消息：原样返回（无合法截断点）
 */
export function applyMessageWindow(
  messages: ModelMessage[],
  charBudget: number = MESSAGE_WINDOW_CHAR_BUDGET
): ModelMessage[] {
  const sizes = messages.map((message) => JSON.stringify(message).length);
  const total = sizes.reduce((sum, size) => sum + size, 0);
  if (total <= charBudget) {
    return messages;
  }

  let suffixSize = 0;
  let lastUserIndex = -1;
  let bestUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    suffixSize += sizes[i] ?? 0;
    if (messages[i]?.role === 'user') {
      if (lastUserIndex < 0) {
        lastUserIndex = i;
      }
      if (suffixSize <= charBudget) {
        bestUserIndex = i;
      }
    }
  }

  if (lastUserIndex < 0) {
    return messages;
  }
  const start = bestUserIndex >= 0 ? bestUserIndex : lastUserIndex;
  if (start === 0) {
    return messages;
  }
  return messages.slice(start);
}

export type AgentRunOutcome = 'idle' | 'waiting_confirmation' | 'stopped' | 'interrupted' | 'error';

export type AgentStopReason = 'manual' | 'shutdown';

export interface AgentRunDeps {
  resolveModel: (providerId: string | null, modelId: string | null) => Promise<LanguageModel>;
  resolveProviderWebSearchTool: (providerId: string | null) => Promise<Tool | null>;
  createWebSearchTool: () => Promise<Tool | null>;
  createFetchUrlTool: () => Tool;
  acquireRuntime: (deviceId: string) => Promise<TerminalRuntimeLike>;
  releaseRuntime: (deviceId: string) => Promise<void>;
  broadcast: <K extends keyof AgentEventPayloadMap>(
    sessionId: string,
    eventType: K,
    payload: AgentEventPayloadMap[K],
    seq: number
  ) => void;
  notify: (
    eventType: EventType,
    event: Omit<WebhookEvent, 'eventType' | 'timestamp'>
  ) => Promise<void>;
  generateTitle: (model: LanguageModel, prompt: string) => Promise<string>;
  sleepMs: (ms: number) => Promise<void>;
  deltaFlushIntervalMs: number;
  deltaFlushMaxBytes: number;
  retryDelaysMs: number[];
  /** 传给 AI SDK 的单请求级重试次数（指数退避由 SDK 处理） */
  llmMaxRetries: number;
  notifyTurnFinished: boolean;
}

const defaultDeps: AgentRunDeps = {
  resolveModel: resolveLanguageModel,
  resolveProviderWebSearchTool,
  createWebSearchTool: () => createWebSearchTool(),
  createFetchUrlTool: () => createFetchUrlTool(),
  acquireRuntime: (deviceId) => tmuxRuntimeRegistry.acquire(deviceId),
  releaseRuntime: (deviceId) => tmuxRuntimeRegistry.release(deviceId),
  broadcast: (sessionId, eventType, payload, seq) =>
    agentWsHub.broadcastAgentEvent(sessionId, eventType, payload, seq),
  notify: (eventType, event) => eventNotifier.notify(eventType, event),
  generateTitle: async (model, prompt) => {
    const result = await generateText({ model, prompt, maxRetries: 1 });
    return result.text;
  },
  sleepMs: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  deltaFlushIntervalMs: 40,
  deltaFlushMaxBytes: 2048,
  retryDelaysMs: [1000, 2000, 4000],
  llmMaxRetries: 3,
  notifyTurnFinished: true,
};

interface PendingApproval {
  approvalId: string;
  toolCallId: string;
  toolName: string;
  input: unknown;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

const NETWORK_ERROR_PATTERNS = [
  'fetch failed',
  'failed to fetch',
  'econnrefused',
  'econnreset',
  'etimedout',
  'enotfound',
  'eai_again',
  'epipe',
  'ehostunreach',
  'enetunreach',
  'socket',
  'connection',
  'network',
  'und_err',
];

function isNetworkError(error: unknown, depth = 0): boolean {
  if (depth > 4 || !(error instanceof Error)) {
    return false;
  }
  const haystack =
    `${error.name} ${error.message} ${(error as { code?: unknown }).code ?? ''}`.toLowerCase();
  if (NETWORK_ERROR_PATTERNS.some((pattern) => haystack.includes(pattern))) {
    return true;
  }
  return isNetworkError(error.cause, depth + 1);
}

export function isRetryableLlmError(error: unknown): boolean {
  if (RetryError.isInstance(error)) {
    // SDK 内部重试已耗尽，多为网络抖动/限流/5xx，整轮重试仍有意义
    return true;
  }
  if (APICallError.isInstance(error)) {
    if (error.isRetryable) {
      return true;
    }
    return error.statusCode !== undefined && error.statusCode >= 500;
  }
  // fetch 网络层错误（DNS/连接被拒等）在 Bun 中表现为 TypeError / ConnectionError，
  // 但代码型 TypeError（如 undefined is not a function）不可重试，按 message/cause 判定
  if (error instanceof TypeError) {
    return isNetworkError(error);
  }
  return false;
}

export class AgentRun {
  readonly sessionId: string;

  private readonly deps: AgentRunDeps;
  private readonly abortController = new AbortController();
  private stopReason: AgentStopReason | null = null;
  private terminalFailureStreak = 0;
  private terminalFatal = false;
  private terminalFatalMessage = '';

  private eventSeq = 0;

  // 进行中回合的累积文本（供 sync 回放），step 落库后清空
  private textBuffer = '';
  private reasoningBuffer = '';

  // 节流广播 buffer
  private pendingTextDelta = '';
  private pendingTextMessageId = '';
  private pendingReasoningDelta = '';
  private pendingReasoningMessageId = '';
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(sessionId: string, deps: Partial<AgentRunDeps> = {}) {
    this.sessionId = sessionId;
    this.deps = { ...defaultDeps, ...deps };
  }

  get inProgressText(): string {
    return this.textBuffer;
  }

  get inProgressReasoning(): string {
    return this.reasoningBuffer;
  }

  requestStop(reason: AgentStopReason): void {
    if (this.stopReason) {
      return;
    }
    this.stopReason = reason;
    this.abortController.abort();
  }

  async execute(): Promise<AgentRunOutcome> {
    const session = getAgentSessionById(this.sessionId);
    if (!session) {
      return 'error';
    }

    this.setStatus('running');

    let runtime: TerminalRuntimeLike | null = null;
    const runtimeDeviceId = session.deviceId;
    try {
      if (runtimeDeviceId && session.paneId) {
        try {
          runtime = await this.deps.acquireRuntime(runtimeDeviceId);
        } catch (error) {
          return this.finishError(
            session,
            `failed to acquire terminal runtime: ${toErrorMessage(error)}`
          );
        }
      }

      let attempt = 0;
      while (true) {
        try {
          return await this.runOnce(session, runtime);
        } catch (error) {
          this.clearFlushTimer();
          if (this.stopReason || this.abortController.signal.aborted) {
            return this.finishAborted(session);
          }
          if (attempt < this.deps.retryDelaysMs.length && isRetryableLlmError(error)) {
            const delay = this.deps.retryDelaysMs[attempt];
            attempt += 1;
            console.error(
              `[agent-run] session ${this.sessionId} attempt ${attempt} failed, retrying in ${delay}ms:`,
              error
            );
            await this.deps.sleepMs(delay);
            continue;
          }
          return this.finishError(session, toErrorMessage(error));
        }
      }
    } finally {
      this.clearFlushTimer();
      if (runtime && runtimeDeviceId) {
        try {
          await this.deps.releaseRuntime(runtimeDeviceId);
        } catch (error) {
          console.error(`[agent-run] failed to release runtime ${runtimeDeviceId}:`, error);
        }
      }
    }
  }

  private async runOnce(
    session: AgentSessionRecord,
    runtime: TerminalRuntimeLike | null
  ): Promise<AgentRunOutcome> {
    const messages = applyMessageWindow(
      listAgentMessages(this.sessionId).map((record) => record.content as ModelMessage)
    );
    const model = await this.deps.resolveModel(session.providerId, session.modelId);
    const tools = await this.buildTools(session, runtime);

    const device = session.deviceId ? getDeviceById(session.deviceId) : null;
    const system = buildAgentSystemPrompt({
      deviceName: device?.name ?? null,
      paneId: session.paneId,
      writeMode: session.writeMode,
      customSystemPrompt: session.systemPrompt,
    });

    this.textBuffer = '';
    this.reasoningBuffer = '';
    let persistedResponseCount = 0;
    const approvals: PendingApproval[] = [];
    let streamError: unknown = null;
    let aborted = false;

    const result = streamText({
      model,
      system,
      messages,
      tools,
      stopWhen: stepCountIs(Math.max(1, session.maxStepsPerTurn)),
      abortSignal: this.abortController.signal,
      maxRetries: this.deps.llmMaxRetries,
      onStepFinish: (step) => {
        // step.response.messages 是累积的（含此前 step 与续跑的 initial 工具结果），只落新增部分
        const responseMessages = step.response.messages;
        for (const message of responseMessages.slice(persistedResponseCount)) {
          const record = appendAgentMessage(
            this.sessionId,
            message.role,
            message as unknown as ModelMessage
          );
          this.broadcast(wsBorsh.AGENT_EVENT_MESSAGE_PERSISTED, {
            messageId: record.id,
            seq: record.seq,
            role: record.role,
          });
        }
        persistedResponseCount = responseMessages.length;
        // 已落库内容不再属于"进行中"
        this.flushDeltas();
        this.textBuffer = '';
        this.reasoningBuffer = '';
      },
    });

    for await (const part of result.fullStream) {
      switch (part.type) {
        case 'text-delta':
          this.queueTextDelta(part.id, part.text);
          break;
        case 'reasoning-delta':
          this.queueReasoningDelta(part.id, part.text);
          break;
        case 'tool-call':
          this.flushDeltas();
          this.broadcast(wsBorsh.AGENT_EVENT_TOOL_CALL, {
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input: part.input,
          });
          break;
        case 'tool-result':
          this.flushDeltas();
          this.broadcast(wsBorsh.AGENT_EVENT_TOOL_RESULT, {
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            output: part.output,
          });
          break;
        case 'tool-error':
          this.flushDeltas();
          this.broadcast(wsBorsh.AGENT_EVENT_TOOL_RESULT, {
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            output: toErrorMessage(part.error),
            isError: true,
          });
          break;
        case 'tool-output-denied':
          this.flushDeltas();
          this.broadcast(wsBorsh.AGENT_EVENT_TOOL_RESULT, {
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            output: 'execution denied by user',
            isError: true,
          });
          break;
        case 'tool-approval-request':
          approvals.push({
            approvalId: part.approvalId,
            toolCallId: part.toolCall.toolCallId,
            toolName: part.toolCall.toolName,
            input: part.toolCall.input,
          });
          break;
        case 'error':
          streamError = part.error;
          break;
        case 'abort':
          aborted = true;
          break;
        default:
          break;
      }
    }

    this.flushDeltas();

    if (aborted || this.stopReason || this.abortController.signal.aborted) {
      return this.finishAborted(session);
    }

    if (streamError) {
      throw streamError instanceof Error ? streamError : new Error(String(streamError));
    }

    if (approvals.length > 0) {
      return this.finishWaitingConfirmation(session, approvals);
    }

    await this.maybeGenerateTitle(session, model);
    return this.finishIdle(session);
  }

  private async buildTools(
    session: AgentSessionRecord,
    runtime: TerminalRuntimeLike | null
  ): Promise<ToolSet> {
    const tools: Record<string, Tool> = {};

    if (runtime && session.paneId) {
      Object.assign(
        tools,
        createTerminalTools({
          paneId: session.paneId,
          getRuntime: () => runtime,
          needsApprovalForWrite: session.writeMode === 'confirm',
          onFailure: () => this.recordTerminalFailure(),
          onSuccess: () => {
            this.terminalFailureStreak = 0;
          },
          sleepMs: this.deps.sleepMs,
        })
      );
    }

    if (session.useProviderWebSearch) {
      const providerTool = await this.deps.resolveProviderWebSearchTool(session.providerId);
      if (providerTool) {
        tools.web_search = providerTool;
      }
    } else {
      const webSearch = await this.deps.createWebSearchTool();
      if (webSearch) {
        tools.web_search = webSearch;
      }
    }

    tools.fetch_url = this.deps.createFetchUrlTool();
    return tools;
  }

  private recordTerminalFailure(): void {
    this.terminalFailureStreak += 1;
    if (this.terminalFailureStreak >= TERMINAL_FAILURE_LIMIT && !this.terminalFatal) {
      this.terminalFatal = true;
      this.terminalFatalMessage = `terminal tool failed ${this.terminalFailureStreak} times in a row, aborting run`;
      this.abortController.abort();
    }
  }

  // ========== 结束分支 ==========

  private finishIdle(session: AgentSessionRecord): AgentRunOutcome {
    this.setStatus('idle');
    this.broadcast(wsBorsh.AGENT_EVENT_TURN_FINISHED, {
      sessionStatus: 'idle',
      lastMessageSeq: getMaxAgentMessageSeq(this.sessionId),
    });
    if (this.deps.notifyTurnFinished) {
      void this.safeNotify('agent_turn_finished', session, {
        message: t('notification.agent.turnFinished', { title: session.title }),
      });
    }
    return 'idle';
  }

  private finishWaitingConfirmation(
    session: AgentSessionRecord,
    approvals: PendingApproval[]
  ): AgentRunOutcome {
    for (const approval of approvals) {
      const confirmation = createAgentConfirmation({
        id: approval.approvalId,
        sessionId: this.sessionId,
        toolName: approval.toolName,
        toolCallId: approval.toolCallId,
        inputJson: approval.input,
      });
      this.broadcast(wsBorsh.AGENT_EVENT_CONFIRMATION_REQUEST, {
        confirmationId: confirmation.id,
        toolCallId: confirmation.toolCallId,
        toolName: confirmation.toolName,
        input: confirmation.inputJson,
      });
    }

    this.setStatus('waiting_confirmation');

    for (const approval of approvals) {
      void this.safeNotify('agent_confirmation_pending', session, {
        message: t('notification.agent.confirmationPending', {
          title: session.title,
          toolName: approval.toolName,
        }),
        toolName: approval.toolName,
        confirmationId: approval.approvalId,
      });
    }

    return 'waiting_confirmation';
  }

  private finishAborted(session: AgentSessionRecord): AgentRunOutcome {
    this.clearFlushTimer();
    this.persistTruncatedText();

    if (this.terminalFatal) {
      return this.finishError(session, this.terminalFatalMessage);
    }

    if (this.stopReason === 'shutdown') {
      // 进程退出：status 保持 'running'，下次启动由 supervisor 自动恢复
      return 'interrupted';
    }

    this.setStatus('stopped');
    this.broadcast(wsBorsh.AGENT_EVENT_TURN_FINISHED, {
      sessionStatus: 'stopped',
      lastMessageSeq: getMaxAgentMessageSeq(this.sessionId),
    });
    return 'stopped';
  }

  private finishError(session: AgentSessionRecord, message: string): AgentRunOutcome {
    this.clearFlushTimer();
    this.persistTruncatedText();

    this.setStatus('error', message);
    this.broadcast(wsBorsh.AGENT_EVENT_ERROR, { message });
    void this.safeNotify('agent_error', session, {
      message: t('notification.agent.error', { title: session.title, message }),
    });
    return 'error';
  }

  /** abort/error 时把进行中累积文本作为 truncated assistant 消息落库 */
  private persistTruncatedText(): void {
    const text = this.textBuffer;
    if (!text) {
      this.reasoningBuffer = '';
      return;
    }
    try {
      const record = appendAgentMessage(this.sessionId, 'assistant', {
        role: 'assistant',
        content: [{ type: 'text', text }],
        truncated: true,
      });
      this.broadcast(wsBorsh.AGENT_EVENT_MESSAGE_PERSISTED, {
        messageId: record.id,
        seq: record.seq,
        role: record.role,
      });
    } catch (error) {
      console.error(`[agent-run] failed to persist truncated text for ${this.sessionId}:`, error);
    }
    this.textBuffer = '';
    this.reasoningBuffer = '';
  }

  private async maybeGenerateTitle(
    session: AgentSessionRecord,
    model: LanguageModel
  ): Promise<void> {
    if (session.title !== DEFAULT_AGENT_SESSION_TITLE) {
      return;
    }

    const firstUser = listAgentMessages(this.sessionId).find((m) => m.role === 'user');
    if (!firstUser) {
      return;
    }

    const content = (firstUser.content as { content?: unknown })?.content;
    const userText =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content
              .map((part) =>
                typeof (part as { text?: unknown })?.text === 'string'
                  ? (part as { text: string }).text
                  : ''
              )
              .join(' ')
          : '';
    if (!userText.trim()) {
      return;
    }

    try {
      const raw = await this.deps.generateTitle(model, buildTitleGenerationPrompt(userText));
      const title = raw
        .trim()
        .replace(/^["'「『]+|["'」』]+$/g, '')
        .slice(0, 80);
      if (!title) {
        return;
      }
      updateAgentSession(this.sessionId, { title });
      session.title = title;
      // 客户端收到 status 事件后重新拉取 session 列表即可看到新标题
      const latest = getAgentSessionById(this.sessionId);
      if (latest) {
        this.broadcast(wsBorsh.AGENT_EVENT_STATUS, {
          status: latest.status,
          lastError: latest.lastError,
        });
      }
    } catch (error) {
      console.error(`[agent-run] title generation failed for ${this.sessionId}:`, error);
    }
  }

  // ========== 广播与节流 ==========

  private nextSeq(): number {
    this.eventSeq += 1;
    return this.eventSeq;
  }

  private broadcast<K extends keyof AgentEventPayloadMap>(
    eventType: K,
    payload: AgentEventPayloadMap[K]
  ): void {
    try {
      this.deps.broadcast(this.sessionId, eventType, payload, this.nextSeq());
    } catch (error) {
      console.error(`[agent-run] broadcast failed for ${this.sessionId}:`, error);
    }
  }

  private setStatus(status: AgentSessionRecord['status'], lastError: string | null = null): void {
    updateAgentSession(this.sessionId, { status, lastError });
    this.broadcast(wsBorsh.AGENT_EVENT_STATUS, { status, lastError });
  }

  private queueTextDelta(messageId: string, delta: string): void {
    this.textBuffer += delta;
    if (this.pendingTextDelta && this.pendingTextMessageId !== messageId) {
      this.flushDeltas();
    }
    this.pendingTextMessageId = messageId;
    this.pendingTextDelta += delta;
    this.scheduleFlush();
  }

  private queueReasoningDelta(messageId: string, delta: string): void {
    this.reasoningBuffer += delta;
    if (this.pendingReasoningDelta && this.pendingReasoningMessageId !== messageId) {
      this.flushDeltas();
    }
    this.pendingReasoningMessageId = messageId;
    this.pendingReasoningDelta += delta;
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (
      this.pendingTextDelta.length + this.pendingReasoningDelta.length >=
      this.deps.deltaFlushMaxBytes
    ) {
      this.flushDeltas();
      return;
    }
    if (this.flushTimer) {
      return;
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushDeltas();
    }, this.deps.deltaFlushIntervalMs);
  }

  private flushDeltas(): void {
    this.clearFlushTimer();
    if (this.pendingTextDelta) {
      this.broadcast(wsBorsh.AGENT_EVENT_TEXT_DELTA, {
        messageId: this.pendingTextMessageId,
        delta: this.pendingTextDelta,
      });
      this.pendingTextDelta = '';
    }
    if (this.pendingReasoningDelta) {
      this.broadcast(wsBorsh.AGENT_EVENT_REASONING_DELTA, {
        messageId: this.pendingReasoningMessageId,
        delta: this.pendingReasoningDelta,
      });
      this.pendingReasoningDelta = '';
    }
  }

  private clearFlushTimer(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  // ========== 通知 ==========

  private async safeNotify(
    eventType: EventType,
    session: AgentSessionRecord,
    payload: Record<string, unknown>
  ): Promise<void> {
    try {
      const settings = getSiteSettings();
      const device = session.deviceId ? getDeviceById(session.deviceId) : null;
      await this.deps.notify(eventType, {
        site: {
          name: settings.siteName,
          url: settings.siteUrl,
        },
        device: {
          id: device?.id ?? session.deviceId ?? '-',
          name: device?.name ?? 'unknown',
          type: device?.type ?? 'local',
          host: device?.host,
        },
        tmux: {
          sessionName: device?.session,
          paneId: session.paneId ?? undefined,
        },
        payload: {
          ...payload,
          agentSessionId: session.id,
          agentSessionTitle: session.title,
        },
      });
    } catch (error) {
      console.error(`[agent-run] notify ${eventType} failed for ${this.sessionId}:`, error);
    }
  }
}
