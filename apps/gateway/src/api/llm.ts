import type {
  AgentLlmSettingsDto,
  AgentSearchProvider,
  CreateLlmProviderRequest,
  LlmProviderDto,
  LlmProviderProtocol,
  UpdateAgentLlmSettingsRequest,
  UpdateLlmProviderRequest,
} from '@tmex/shared';
import { encrypt } from '../crypto';
import { getAgentSettings, updateAgentSettings } from '../db/agent';
import type { AgentSettingsRecord } from '../db/agent';
import {
  type LlmProviderRecord,
  computeProviderModels,
  createLlmProvider,
  deleteLlmProvider,
  getAllLlmProviders,
  getLlmProviderById,
  updateLlmProvider,
} from '../db/llm';
import { t } from '../i18n';
import { fetchProviderModels } from '../llm/provider-registry';

const PROTOCOLS: readonly LlmProviderProtocol[] = ['openai-chat', 'openai-responses'];
const SEARCH_PROVIDERS: readonly AgentSearchProvider[] = ['none', 'tavily', 'brave'];

export function handleLlmApiRequest(
  req: Request,
  path: string
): Response | Promise<Response> | null {
  if (path === '/api/llm/providers' && req.method === 'GET') {
    return handleListProviders();
  }
  if (path === '/api/llm/providers' && req.method === 'POST') {
    return handleCreateProvider(req);
  }
  if (path.match(/^\/api\/llm\/providers\/[^/]+$/) && req.method === 'PATCH') {
    return handleUpdateProvider(req, path.split('/')[4]);
  }
  if (path.match(/^\/api\/llm\/providers\/[^/]+$/) && req.method === 'DELETE') {
    return handleDeleteProvider(path.split('/')[4]);
  }
  if (path.match(/^\/api\/llm\/providers\/[^/]+\/refresh-models$/) && req.method === 'POST') {
    return handleRefreshProviderModels(path.split('/')[4]);
  }
  if (path === '/api/llm/settings' && req.method === 'GET') {
    return handleGetSettings();
  }
  if (path === '/api/llm/settings' && req.method === 'PATCH') {
    return handleUpdateSettings(req);
  }

  return null;
}

function toProviderDto(record: LlmProviderRecord): LlmProviderDto {
  const { effective, modelDetails } = computeProviderModels(record);
  return {
    id: record.id,
    name: record.name,
    protocol: record.protocol,
    baseUrl: record.baseUrl,
    hasApiKey: record.apiKeyEnc.length > 0,
    enabled: record.enabled,
    models: effective,
    modelDetails,
    modelsFetchedAt: record.modelsFetchedAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function toSettingsDto(record: AgentSettingsRecord): AgentLlmSettingsDto {
  return {
    searchProvider: record.searchProvider,
    hasTavilyApiKey: Boolean(record.tavilyApiKeyEnc),
    hasBraveApiKey: Boolean(record.braveApiKeyEnc),
    defaultProviderId: record.defaultProviderId,
    defaultModelId: record.defaultModelId,
    updatedAt: record.updatedAt,
  };
}

function isValidBaseUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === 'http:' || url.protocol === 'https:';
}

async function readJsonObjectBody(req: Request): Promise<Record<string, unknown> | null> {
  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Record<string, unknown>;
}

async function refreshModelsCache(
  provider: LlmProviderRecord
): Promise<{ provider: LlmProviderRecord; models?: string[]; modelsError?: string }> {
  try {
    const models = await fetchProviderModels(provider);
    const updated = updateLlmProvider(provider.id, {
      modelsCache: models,
      modelsFetchedAt: new Date().toISOString(),
    });
    return { provider: updated ?? provider, models };
  } catch (error) {
    // 服务端日志打原始技术错误（cause），而非给前端 toast 的 i18n 文案。
    const raw = error instanceof Error && error.cause !== undefined ? error.cause : error;
    console.warn(
      `[llm] 拉取模型列表失败 provider=${provider.name}(${provider.id}) baseUrl=${provider.baseUrl}:`,
      raw
    );
    return {
      provider,
      modelsError: error instanceof Error ? error.message : String(error),
    };
  }
}

async function handleListProviders(): Promise<Response> {
  const providers = getAllLlmProviders().map(toProviderDto);
  return json({ providers });
}

async function handleCreateProvider(req: Request): Promise<Response> {
  const raw = await readJsonObjectBody(req);
  if (!raw) {
    return json({ error: t('apiError.invalidRequest') }, 400);
  }
  const body = raw as unknown as CreateLlmProviderRequest;

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) {
    return json({ error: t('apiError.llmProviderNameRequired') }, 400);
  }
  if (!PROTOCOLS.includes(body.protocol)) {
    return json({ error: t('apiError.llmProviderProtocolInvalid') }, 400);
  }
  const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : '';
  if (!baseUrl || !isValidBaseUrl(baseUrl)) {
    return json({ error: t('apiError.llmProviderBaseUrlInvalid') }, 400);
  }
  const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
  if (!apiKey) {
    return json({ error: t('apiError.llmProviderApiKeyRequired') }, 400);
  }
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
    return json({ error: t('apiError.invalidRequest') }, 400);
  }

  const created = createLlmProvider({
    name,
    protocol: body.protocol,
    baseUrl,
    apiKeyEnc: await encrypt(apiKey),
    enabled: body.enabled ?? true,
  });

  const { provider, modelsError } = await refreshModelsCache(created);
  return json({ provider: toProviderDto(provider), ...(modelsError ? { modelsError } : {}) }, 201);
}

async function handleUpdateProvider(req: Request, id: string): Promise<Response> {
  const existing = getLlmProviderById(id);
  if (!existing) {
    return json({ error: t('apiError.llmProviderNotFound') }, 404);
  }

  const raw = await readJsonObjectBody(req);
  if (!raw) {
    return json({ error: t('apiError.invalidRequest') }, 400);
  }
  const body = raw as UpdateLlmProviderRequest;
  const updates: Parameters<typeof updateLlmProvider>[1] = {};

  if (body.name !== undefined) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) {
      return json({ error: t('apiError.llmProviderNameRequired') }, 400);
    }
    updates.name = name;
  }

  if (body.protocol !== undefined) {
    if (!PROTOCOLS.includes(body.protocol)) {
      return json({ error: t('apiError.llmProviderProtocolInvalid') }, 400);
    }
    updates.protocol = body.protocol;
  }

  if (body.baseUrl !== undefined) {
    const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : '';
    if (!isValidBaseUrl(baseUrl)) {
      return json({ error: t('apiError.llmProviderBaseUrlInvalid') }, 400);
    }
    updates.baseUrl = baseUrl;
  }

  // apiKey 留空或缺省表示不修改
  if (body.apiKey !== undefined && typeof body.apiKey !== 'string') {
    return json({ error: t('apiError.invalidRequest') }, 400);
  }
  const apiKey = body.apiKey?.trim();
  if (apiKey) {
    updates.apiKeyEnc = await encrypt(apiKey);
  }

  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') {
      return json({ error: t('apiError.invalidRequest') }, 400);
    }
    updates.enabled = body.enabled;
  }

  const isStringArray = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((item) => typeof item === 'string');

  if (body.manualModels !== undefined) {
    if (!isStringArray(body.manualModels)) {
      return json({ error: t('apiError.invalidRequest') }, 400);
    }
    updates.manualModels = [...new Set(body.manualModels.map((m) => m.trim()).filter(Boolean))];
  }

  if (body.disabledModels !== undefined) {
    if (!isStringArray(body.disabledModels)) {
      return json({ error: t('apiError.invalidRequest') }, 400);
    }
    updates.disabledModels = [...new Set(body.disabledModels.map((m) => m.trim()).filter(Boolean))];
  }

  let provider = updateLlmProvider(id, updates);
  if (!provider) {
    return json({ error: t('apiError.llmProviderNotFound') }, 404);
  }

  const credentialsChanged =
    (updates.baseUrl !== undefined && updates.baseUrl !== existing.baseUrl) ||
    updates.apiKeyEnc !== undefined;

  let modelsError: string | undefined;
  if (credentialsChanged) {
    const refreshed = await refreshModelsCache(provider);
    provider = refreshed.provider;
    modelsError = refreshed.modelsError;
  }

  return json({ provider: toProviderDto(provider), ...(modelsError ? { modelsError } : {}) });
}

async function handleDeleteProvider(id: string): Promise<Response> {
  const existing = getLlmProviderById(id);
  if (!existing) {
    return json({ error: t('apiError.llmProviderNotFound') }, 404);
  }

  deleteLlmProvider(id);
  return json({ success: true });
}

async function handleRefreshProviderModels(id: string): Promise<Response> {
  const existing = getLlmProviderById(id);
  if (!existing) {
    return json({ error: t('apiError.llmProviderNotFound') }, 404);
  }

  const { models, modelsError } = await refreshModelsCache(existing);
  if (modelsError !== undefined || models === undefined) {
    return json({ error: modelsError ?? t('apiError.invalidRequest') }, 502);
  }

  return json({ models });
}

async function handleGetSettings(): Promise<Response> {
  return json({ settings: toSettingsDto(getAgentSettings()) });
}

async function handleUpdateSettings(req: Request): Promise<Response> {
  const raw = await readJsonObjectBody(req);
  if (!raw) {
    return json({ error: t('apiError.invalidRequest') }, 400);
  }
  const body = raw as UpdateAgentLlmSettingsRequest;
  const updates: Parameters<typeof updateAgentSettings>[0] = {};

  if (body.searchProvider !== undefined) {
    if (!SEARCH_PROVIDERS.includes(body.searchProvider)) {
      return json({ error: t('apiError.llmSearchProviderInvalid') }, 400);
    }
    updates.searchProvider = body.searchProvider;
  }

  if (body.defaultProviderId !== undefined) {
    if (body.defaultProviderId !== null && typeof body.defaultProviderId !== 'string') {
      return json({ error: t('apiError.invalidRequest') }, 400);
    }
    if (body.defaultProviderId !== null && !getLlmProviderById(body.defaultProviderId)) {
      return json({ error: t('apiError.llmDefaultProviderNotFound') }, 400);
    }
    updates.defaultProviderId = body.defaultProviderId;
  }

  if (body.defaultModelId !== undefined) {
    if (body.defaultModelId !== null && typeof body.defaultModelId !== 'string') {
      return json({ error: t('apiError.invalidRequest') }, 400);
    }
    updates.defaultModelId = body.defaultModelId;
  }

  // key 缺省表示不修改，空串表示清除
  if (body.tavilyApiKey !== undefined) {
    if (typeof body.tavilyApiKey !== 'string') {
      return json({ error: t('apiError.invalidRequest') }, 400);
    }
    const value = body.tavilyApiKey.trim();
    updates.tavilyApiKeyEnc = value ? await encrypt(value) : null;
  }

  if (body.braveApiKey !== undefined) {
    if (typeof body.braveApiKey !== 'string') {
      return json({ error: t('apiError.invalidRequest') }, 400);
    }
    const value = body.braveApiKey.trim();
    updates.braveApiKeyEnc = value ? await encrypt(value) : null;
  }

  const settings = updateAgentSettings(updates);
  return json({ settings: toSettingsDto(settings) });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  });
}
