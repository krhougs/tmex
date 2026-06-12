// 将持久化的 AI SDK ModelMessage 序列与流式中的 inProgress 状态合并为对话流 UI 块。
// 持久化格式见 gateway run.ts：assistant content 为 string 或 parts(text/reasoning/tool-call)，
// tool content 为 parts(tool-result/tool-approval-response)，tool-result 按 toolCallId 配对。

import type { AgentMessageDto } from '@tmex/shared';

export interface UiToolCall {
  toolCallId: string;
  toolName: string;
  input: unknown;
  output?: unknown;
  isError: boolean;
  resolved: boolean;
}

export type UiThreadBlock =
  | { kind: 'user'; key: string; text: string }
  | { kind: 'assistant-text'; key: string; text: string; streaming: boolean }
  | { kind: 'reasoning'; key: string; text: string; streaming: boolean }
  | { kind: 'tool-call'; key: string; call: UiToolCall };

export interface InProgressSegment {
  messageId: string;
  text: string;
  stale: boolean;
}

export interface InProgressToolCall extends UiToolCall {
  stale: boolean;
}

export interface SessionInProgress {
  texts: InProgressSegment[];
  reasonings: InProgressSegment[];
  toolCalls: InProgressToolCall[];
  // MESSAGE_PERSISTED 后置位：此后新建的流式段也视为已落库内容的残余，
  // 等历史增量拉取落地时一并清除，避免与历史消息重复显示
  staleBarrier: boolean;
}

export function emptyInProgress(): SessionInProgress {
  return { texts: [], reasonings: [], toolCalls: [], staleBarrier: false };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * ModelMessage ToolResultPart 的 output 可能是 LanguageModel 包装形态
 * ({type:'text'|'json'|'error-text'|'error-json', value})，WS 事件里则是
 * execute 返回值原样；统一解包。
 */
export function unwrapToolOutput(output: unknown): { value: unknown; isError: boolean } {
  if (isRecord(output) && typeof output.type === 'string' && 'value' in output) {
    switch (output.type) {
      case 'text':
      case 'json':
        return { value: output.value, isError: false };
      case 'error-text':
      case 'error-json':
        return { value: output.value, isError: true };
      default:
        break;
    }
  }
  return { value: output, isError: false };
}

function extractText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function parsePersistedMessages(messages: AgentMessageDto[]): {
  blocks: UiThreadBlock[];
  toolBlocksById: Map<string, UiToolCall>;
} {
  const blocks: UiThreadBlock[] = [];
  const toolBlocksById = new Map<string, UiToolCall>();

  for (const message of messages) {
    const model = isRecord(message.content) ? message.content : null;
    if (!model) continue;
    const content = model.content;

    switch (message.role) {
      case 'user': {
        const text = extractText(content);
        if (text) {
          blocks.push({ kind: 'user', key: `m${message.seq}`, text });
        }
        break;
      }
      case 'assistant': {
        if (typeof content === 'string') {
          if (content) {
            blocks.push({
              kind: 'assistant-text',
              key: `m${message.seq}`,
              text: content,
              streaming: false,
            });
          }
          break;
        }
        if (!Array.isArray(content)) break;
        content.forEach((part, index) => {
          if (!isRecord(part)) return;
          const key = `m${message.seq}p${index}`;
          if (part.type === 'text' && typeof part.text === 'string' && part.text) {
            blocks.push({ kind: 'assistant-text', key, text: part.text, streaming: false });
            return;
          }
          if (part.type === 'reasoning' && typeof part.text === 'string' && part.text) {
            blocks.push({ kind: 'reasoning', key, text: part.text, streaming: false });
            return;
          }
          if (part.type === 'tool-call' && typeof part.toolCallId === 'string') {
            const call: UiToolCall = {
              toolCallId: part.toolCallId,
              toolName: typeof part.toolName === 'string' ? part.toolName : 'unknown',
              input: part.input,
              isError: false,
              resolved: false,
            };
            toolBlocksById.set(call.toolCallId, call);
            blocks.push({ kind: 'tool-call', key, call });
          }
        });
        break;
      }
      case 'tool': {
        if (!Array.isArray(content)) break;
        for (const part of content) {
          if (!isRecord(part) || part.type !== 'tool-result') continue;
          const toolCallId = typeof part.toolCallId === 'string' ? part.toolCallId : '';
          const existing = toolBlocksById.get(toolCallId);
          const { value, isError } = unwrapToolOutput(part.output);
          if (existing) {
            existing.output = value;
            existing.isError = isError;
            existing.resolved = true;
          }
        }
        break;
      }
      default:
        break;
    }
  }

  return { blocks, toolBlocksById };
}

/**
 * 合并持久化消息与流式中状态：
 * - 历史中未配对的 tool-call 用 inProgress 里同 toolCallId 的即时结果补全；
 * - inProgress 独有的 toolCalls / 文本段追加在末尾（流式显示）。
 */
export function buildThreadBlocks(
  messages: AgentMessageDto[] | undefined,
  inProgress: SessionInProgress | undefined
): UiThreadBlock[] {
  const { blocks, toolBlocksById } = parsePersistedMessages(messages ?? []);

  if (!inProgress) {
    return blocks;
  }

  for (const call of inProgress.toolCalls) {
    const existing = toolBlocksById.get(call.toolCallId);
    if (existing) {
      if (!existing.resolved && call.resolved) {
        existing.output = call.output;
        existing.isError = call.isError;
        existing.resolved = true;
      }
      continue;
    }
    blocks.push({
      kind: 'tool-call',
      key: `live-tool-${call.toolCallId}`,
      call,
    });
  }

  for (const segment of inProgress.reasonings) {
    if (!segment.text) continue;
    blocks.push({
      kind: 'reasoning',
      key: `live-reasoning-${segment.messageId}`,
      text: segment.text,
      streaming: true,
    });
  }

  for (const segment of inProgress.texts) {
    if (!segment.text) continue;
    blocks.push({
      kind: 'assistant-text',
      key: `live-text-${segment.messageId}`,
      text: segment.text,
      streaming: true,
    });
  }

  return blocks;
}

export function maxMessageSeq(messages: AgentMessageDto[] | undefined): number {
  if (!messages || messages.length === 0) {
    return -1;
  }
  return messages[messages.length - 1].seq;
}

/** 找最后一条 user 消息文本（error 重试用） */
export function lastUserMessageText(messages: AgentMessageDto[] | undefined): string | null {
  if (!messages) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== 'user') continue;
    const model = isRecord(message.content) ? message.content : null;
    const text = model ? extractText(model.content) : '';
    if (text) return text;
  }
  return null;
}
