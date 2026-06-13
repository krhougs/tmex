import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel, Tool } from 'ai';
import { HOSTED_TOOL_FACTORIES } from '../agent/tools/hosted';
import { decrypt, decryptWithContext } from '../crypto';
import { getAgentSettings } from '../db/agent';
import { type LlmProviderRecord, getLlmProviderById } from '../db/llm';
import { t } from '../i18n';

type OpenAIClient = ReturnType<typeof createOpenAI>;

const FETCH_MODELS_TIMEOUT_MS = 15_000;

// 解析用户输入的 Base URL，参考 NextChat/OneAPI 的后缀约定：
// - 默认：自动补 `/v1`（已以 `/vN` 结尾则不重复）
// - `/` 结尾：忽略 v1 版本，路径原样（仅去掉尾部斜杠）
// - `#`：暂不作为特殊标记，按 URL fragment 丢弃
// 解析结果用作 AI SDK 的 baseURL 以及 `${base}/models` 的前缀，保证拉模型与推理一致。
export function resolveBaseUrl(baseUrl: string): string {
  const withoutFragment = baseUrl.trim().split('#')[0];

  if (withoutFragment.endsWith('/')) {
    return withoutFragment.replace(/\/+$/, '');
  }

  if (/\/v\d+$/.test(withoutFragment)) {
    return withoutFragment;
  }

  return `${withoutFragment}/v1`;
}

export async function resolveLanguageModel(
  providerId: string | null,
  modelId: string | null
): Promise<LanguageModel> {
  let effectiveProviderId = providerId;
  let effectiveModelId = modelId;

  if (!effectiveProviderId || !effectiveModelId) {
    const settings = getAgentSettings();
    effectiveProviderId = effectiveProviderId || settings.defaultProviderId;
    effectiveModelId = effectiveModelId || settings.defaultModelId;
  }

  if (!effectiveProviderId) {
    throw new Error(t('apiError.llmNoDefaultProvider'));
  }
  if (!effectiveModelId) {
    throw new Error(t('apiError.llmNoDefaultModel'));
  }

  const provider = getLlmProviderById(effectiveProviderId);
  if (!provider) {
    throw new Error(t('apiError.llmProviderNotFound'));
  }
  if (!provider.enabled) {
    throw new Error(t('apiError.llmProviderDisabled', { name: provider.name }));
  }

  const apiKey = await decryptWithContext(provider.apiKeyEnc, {
    scope: 'llm_provider',
    entityId: provider.id,
    field: 'api_key_enc',
  });
  const baseURL = resolveBaseUrl(provider.baseUrl);

  if (provider.protocol === 'openai-responses') {
    return createOpenAI({ baseURL, apiKey }).responses(effectiveModelId);
  }

  return createOpenAICompatible({
    name: provider.name,
    baseURL,
    apiKey,
  }).chatModel(effectiveModelId);
}

// 解析一个 openai-responses 协议 provider 的 OpenAI client（hosted 工具 / web_search 共用）。
// 协议不匹配 / provider 不存在 / 未启用 → 返回 null。
export async function resolveOpenAIResponsesProvider(
  providerId: string | null
): Promise<OpenAIClient | null> {
  const effectiveProviderId = providerId ?? getAgentSettings().defaultProviderId;
  if (!effectiveProviderId) {
    return null;
  }

  const provider = getLlmProviderById(effectiveProviderId);
  if (!provider || !provider.enabled || provider.protocol !== 'openai-responses') {
    return null;
  }

  const apiKey = await decryptWithContext(provider.apiKeyEnc, {
    scope: 'llm_provider',
    entityId: provider.id,
    field: 'api_key_enc',
  });

  return createOpenAI({ baseURL: resolveBaseUrl(provider.baseUrl), apiKey });
}

// session.useProviderWebSearch=true 且 provider 协议为 openai-responses 时使用；
// 协议不匹配返回 null（创建 session 时 REST 层已校验互斥，这里兜底）。
export async function resolveProviderWebSearchTool(
  providerId: string | null
): Promise<Tool | null> {
  const client = await resolveOpenAIResponsesProvider(providerId);
  return client ? (client.tools.webSearch() as unknown as Tool) : null;
}

// 解析 session 启用的 provider 原生 hosted 工具集（仅 openai-responses 生效）。
// 未知 key 忽略；非 responses provider / 空列表 → 返回 {}。
export async function resolveProviderHostedTools(
  providerId: string | null,
  keys: readonly string[]
): Promise<Record<string, Tool>> {
  if (!keys || keys.length === 0) {
    return {};
  }
  const client = await resolveOpenAIResponsesProvider(providerId);
  if (!client) {
    return {};
  }
  const tools: Record<string, Tool> = {};
  for (const key of keys) {
    const factory = HOSTED_TOOL_FACTORIES[key];
    if (factory) {
      tools[key] = factory(client);
    }
  }
  return tools;
}

export async function fetchProviderModels(
  provider: Pick<LlmProviderRecord, 'baseUrl' | 'apiKeyEnc'>,
  options: { timeoutMs?: number } = {}
): Promise<string[]> {
  const apiKey = await decrypt(provider.apiKeyEnc);
  const baseURL = resolveBaseUrl(provider.baseUrl);

  const modelsUrl = `${baseURL}/models`;

  // 抛出 i18n 文案给前端 toast，同时用 cause 携带原始技术错误，供服务端日志打真实报错。
  function fetchModelsError(detail: string, cause: unknown): Error {
    return new Error(t('apiError.llmFetchModelsFailed', { detail }), { cause });
  }

  let response: Response;
  try {
    response = await fetch(modelsUrl, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(options.timeoutMs ?? FETCH_MODELS_TIMEOUT_MS),
    });
  } catch (error) {
    const detail =
      error instanceof DOMException && error.name === 'TimeoutError'
        ? 'timeout'
        : error instanceof Error
          ? error.message
          : String(error);
    throw fetchModelsError(detail, error);
  }

  if (!response.ok) {
    const body = (await response.text().catch(() => '')).slice(0, 500);
    throw fetchModelsError(
      `HTTP ${response.status}`,
      new Error(
        `GET ${modelsUrl} -> HTTP ${response.status} ${response.statusText}${body ? `\n${body}` : ''}`
      )
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw fetchModelsError('invalid JSON response', error);
  }

  const data = (payload as { data?: unknown })?.data;
  if (!Array.isArray(data)) {
    throw fetchModelsError(
      'unexpected response shape',
      new Error(`GET ${modelsUrl} 返回非 {data:[]} 结构: ${JSON.stringify(payload).slice(0, 500)}`)
    );
  }

  const ids = data
    .map((item) => (item as { id?: unknown })?.id)
    .filter((id): id is string => typeof id === 'string');

  return ids.sort((a, b) => a.localeCompare(b));
}
