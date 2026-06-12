import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel, Tool } from 'ai';
import { decrypt, decryptWithContext } from '../crypto';
import { getAgentSettings } from '../db/agent';
import { type LlmProviderRecord, getLlmProviderById } from '../db/llm';
import { t } from '../i18n';

const FETCH_MODELS_TIMEOUT_MS = 15_000;

export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
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
  const baseURL = normalizeBaseUrl(provider.baseUrl);

  if (provider.protocol === 'openai-responses') {
    return createOpenAI({ baseURL, apiKey }).responses(effectiveModelId);
  }

  return createOpenAICompatible({
    name: provider.name,
    baseURL,
    apiKey,
  }).chatModel(effectiveModelId);
}

// session.useProviderWebSearch=true 且 provider 协议为 openai-responses 时使用；
// 协议不匹配返回 null（创建 session 时 REST 层已校验互斥，这里兜底）。
export async function resolveProviderWebSearchTool(providerId: string | null): Promise<Tool | null> {
  let effectiveProviderId = providerId;
  if (!effectiveProviderId) {
    effectiveProviderId = getAgentSettings().defaultProviderId;
  }
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

  return createOpenAI({
    baseURL: normalizeBaseUrl(provider.baseUrl),
    apiKey,
  }).tools.webSearch();
}

export async function fetchProviderModels(
  provider: Pick<LlmProviderRecord, 'baseUrl' | 'apiKeyEnc'>,
  options: { timeoutMs?: number } = {}
): Promise<string[]> {
  const apiKey = await decrypt(provider.apiKeyEnc);
  const baseURL = normalizeBaseUrl(provider.baseUrl);

  let response: Response;
  try {
    response = await fetch(`${baseURL}/models`, {
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
    throw new Error(t('apiError.llmFetchModelsFailed', { detail }));
  }

  if (!response.ok) {
    throw new Error(t('apiError.llmFetchModelsFailed', { detail: `HTTP ${response.status}` }));
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error(t('apiError.llmFetchModelsFailed', { detail: 'invalid JSON response' }));
  }

  const data = (payload as { data?: unknown })?.data;
  if (!Array.isArray(data)) {
    throw new Error(t('apiError.llmFetchModelsFailed', { detail: 'unexpected response shape' }));
  }

  const ids = data
    .map((item) => (item as { id?: unknown })?.id)
    .filter((id): id is string => typeof id === 'string');

  return ids.sort((a, b) => a.localeCompare(b));
}
