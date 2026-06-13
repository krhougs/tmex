// 出站凭证消毒 middleware：在每次调用 LLM provider 前，对 prompt 里「机器来源内容」
// （工具结果）做消毒。覆盖 run 内 tool-result 回喂与跨轮历史回放两条出站路径。
// 关键边界：只消毒 role==='tool' 与 assistant 内嵌的 tool-result 输出；
// 绝不动 user / system 消息（用户输入按产品决策不改写，仅另行告警）。
// tmex.db 落库的是真实内容（工具返回真实），消毒只发生在出站这一层。

import type { LanguageModelMiddleware } from 'ai';
import { redactSecrets } from './secret-scan';

type Json = unknown;

function redactJson(value: Json): Json {
  if (typeof value === 'string') {
    return redactSecrets(value).text;
  }
  if (Array.isArray(value)) {
    return value.map(redactJson);
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactJson(val);
    }
    return out;
  }
  return value;
}

function redactToolOutput(output: unknown): unknown {
  if (!output || typeof output !== 'object') {
    return output;
  }
  const part = output as { type?: string; value?: unknown };
  if (part.type === 'text' && typeof part.value === 'string') {
    return { ...part, value: redactSecrets(part.value).text };
  }
  if (part.type === 'json') {
    return { ...part, value: redactJson(part.value) };
  }
  return output;
}

function redactMessage(message: unknown): unknown {
  if (!message || typeof message !== 'object') {
    return message;
  }
  const msg = message as { role?: string; content?: unknown };
  if (msg.role !== 'tool' && msg.role !== 'assistant') {
    return message;
  }
  if (!Array.isArray(msg.content)) {
    return message;
  }
  const content = msg.content.map((part: unknown) => {
    if (part && typeof part === 'object' && (part as { type?: string }).type === 'tool-result') {
      const p = part as { output?: unknown };
      return { ...p, output: redactToolOutput(p.output) };
    }
    return part;
  });
  return { ...msg, content };
}

export function createRedactionMiddleware(): LanguageModelMiddleware {
  return {
    specificationVersion: 'v3',
    transformParams: async ({ params }) => {
      const prompt = (params as { prompt?: unknown }).prompt;
      if (!Array.isArray(prompt)) {
        return params;
      }
      return { ...params, prompt: prompt.map(redactMessage) } as typeof params;
    },
  };
}
