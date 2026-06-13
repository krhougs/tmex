// Agent 提示词入口：渲染 JSX 模板为纯文本。
export type { AgentEnvironmentInfo } from './environment';
export { collectAgentEnvironment } from './environment';
export type { AgentSystemPromptContext } from './system-prompt';
import { type AgentSystemPromptContext, SystemPrompt } from './system-prompt';

export function buildAgentSystemPrompt(context: AgentSystemPromptContext): string {
  return SystemPrompt(context);
}

export function buildTitleGenerationPrompt(userMessage: string): string {
  return [
    'Generate a short title (at most 8 words, no quotes, no trailing punctuation) summarizing the following terminal-assistant conversation request.',
    'Use the same language as the request.',
    '',
    `Request: ${userMessage}`,
  ].join('\n');
}
