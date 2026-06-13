// Provider 原生 hosted 工具注册表（provider-executed，仅 openai-responses 协议可用）。
// 设计为「加一行即新增一个 hosted tool」，无缝兼容任意模型暴露的 hosted 工具。
//
// @ai-sdk/openai@3.0.71 在 provider.tools 下暴露这些工厂（已核 d.ts）：
//   imageGeneration() => Tool<{}, { result: string }>（result 为 base64 图，默认 png）
//   codeInterpreter() => Tool
// hosted 工具入参 schema 为空（模型不直接传参），由 provider 端执行并回传结果。

import type { createOpenAI } from '@ai-sdk/openai';
import type { Tool } from 'ai';

type OpenAIClient = ReturnType<typeof createOpenAI>;

export const HOSTED_TOOL_FACTORIES: Record<string, (client: OpenAIClient) => Tool> = {
  image_generation: (client) => client.tools.imageGeneration() as unknown as Tool,
  code_interpreter: (client) => client.tools.codeInterpreter() as unknown as Tool,
};

export const HOSTED_TOOL_KEYS = Object.keys(HOSTED_TOOL_FACTORIES);

export function isHostedToolKey(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(HOSTED_TOOL_FACTORIES, key);
}
