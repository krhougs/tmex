// Agent session REST API
// 用户消息 / 停止 / 确认决策统一走 REST（确认可能来自通知链接等非 WS 渠道）。

import type {
  AgentConfirmationDto,
  AgentMessageDto,
  AgentSessionDto,
  AgentWriteMode,
  CreateAgentSessionRequest,
  DecideAgentConfirmationRequest,
  PostAgentMessageRequest,
  UpdateAgentSessionRequest,
} from '@tmex/shared';
import { DEFAULT_AGENT_SESSION_TITLE } from '@tmex/shared';
import {
  AgentAwaitingConfirmationError,
  AgentConfirmationAlreadyDecidedError,
  AgentConfirmationNotFoundError,
  AgentSessionBusyError,
  AgentSessionNotFoundError,
  type AgentSupervisor,
  agentSupervisor,
} from '../agent/supervisor';
import { getDeviceById } from '../db';
import {
  type AgentConfirmationRecord,
  type AgentMessageRecord,
  type AgentSessionRecord,
  createAgentSession,
  deleteAgentSession,
  getAgentSessionById,
  getAgentSettings,
  getAllAgentSessions,
  listAgentMessages,
  listPendingAgentConfirmations,
  updateAgentSession,
} from '../db/agent';
import { getLlmProviderById } from '../db/llm';
import { t } from '../i18n';

const WRITE_MODES: readonly AgentWriteMode[] = ['confirm', 'auto'];
const MAX_STEPS_MIN = 1;
const MAX_STEPS_MAX = 100;

export function handleAgentApiRequest(
  req: Request,
  path: string,
  supervisor: AgentSupervisor = agentSupervisor
): Response | Promise<Response> | null {
  if (path === '/api/agent/sessions' && req.method === 'GET') {
    return handleListSessions(req);
  }
  if (path === '/api/agent/sessions' && req.method === 'POST') {
    return handleCreateSession(req);
  }
  if (path.match(/^\/api\/agent\/sessions\/[^/]+$/) && req.method === 'GET') {
    return handleGetSession(path.split('/')[4]);
  }
  if (path.match(/^\/api\/agent\/sessions\/[^/]+$/) && req.method === 'PATCH') {
    return handleUpdateSession(req, path.split('/')[4]);
  }
  if (path.match(/^\/api\/agent\/sessions\/[^/]+$/) && req.method === 'DELETE') {
    return handleDeleteSession(path.split('/')[4], supervisor);
  }
  if (path.match(/^\/api\/agent\/sessions\/[^/]+\/messages$/) && req.method === 'GET') {
    return handleListMessages(req, path.split('/')[4]);
  }
  if (path.match(/^\/api\/agent\/sessions\/[^/]+\/messages$/) && req.method === 'POST') {
    return handlePostMessage(req, path.split('/')[4], supervisor);
  }
  if (path.match(/^\/api\/agent\/sessions\/[^/]+\/stop$/) && req.method === 'POST') {
    return handleStopSession(path.split('/')[4], supervisor);
  }
  if (path.match(/^\/api\/agent\/sessions\/[^/]+\/confirmations$/) && req.method === 'GET') {
    return handleListConfirmations(path.split('/')[4]);
  }
  if (path.match(/^\/api\/agent\/confirmations\/[^/]+\/decide$/) && req.method === 'POST') {
    return handleDecideConfirmation(req, path.split('/')[4], supervisor);
  }

  return null;
}

function toSessionDto(record: AgentSessionRecord): AgentSessionDto {
  return {
    id: record.id,
    title: record.title,
    deviceId: record.deviceId,
    paneId: record.paneId,
    providerId: record.providerId,
    modelId: record.modelId,
    systemPrompt: record.systemPrompt,
    writeMode: record.writeMode,
    useProviderWebSearch: record.useProviderWebSearch,
    status: record.status,
    lastError: record.lastError,
    maxStepsPerTurn: record.maxStepsPerTurn,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function toMessageDto(record: AgentMessageRecord): AgentMessageDto {
  return {
    id: record.id,
    sessionId: record.sessionId,
    seq: record.seq,
    role: record.role,
    content: record.content,
    createdAt: record.createdAt,
  };
}

function toConfirmationDto(record: AgentConfirmationRecord): AgentConfirmationDto {
  return {
    id: record.id,
    sessionId: record.sessionId,
    toolName: record.toolName,
    toolCallId: record.toolCallId,
    input: record.inputJson,
    status: record.status,
    reason: record.reason,
    decidedAt: record.decidedAt,
    createdAt: record.createdAt,
  };
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

/** useProviderWebSearch 与 provider 协议互斥校验；providerId null 时回退全局默认 provider */
function validateProviderWebSearch(providerId: string | null): string | null {
  const effectiveProviderId = providerId ?? getAgentSettings().defaultProviderId;
  if (!effectiveProviderId) {
    return t('apiError.agentProviderWebSearchRequiresResponses');
  }
  const provider = getLlmProviderById(effectiveProviderId);
  if (!provider || provider.protocol !== 'openai-responses') {
    return t('apiError.agentProviderWebSearchRequiresResponses');
  }
  return null;
}

function validateMaxSteps(value: unknown): number | { error: string } {
  const parsed = Math.floor(Number(value));
  if (Number.isNaN(parsed) || parsed < MAX_STEPS_MIN || parsed > MAX_STEPS_MAX) {
    return { error: t('apiError.agentMaxStepsInvalid') };
  }
  return parsed;
}

async function handleListSessions(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const deviceId = url.searchParams.get('deviceId');
  const paneId = url.searchParams.get('paneId');

  let sessions = getAllAgentSessions();
  if (deviceId) {
    sessions = sessions.filter((s) => s.deviceId === deviceId);
  }
  if (paneId) {
    sessions = sessions.filter((s) => s.paneId === paneId);
  }

  return json({ sessions: sessions.map(toSessionDto) });
}

async function handleCreateSession(req: Request): Promise<Response> {
  const raw = await readJsonObjectBody(req);
  if (!raw) {
    return json({ error: t('apiError.invalidRequest') }, 400);
  }
  const body = raw as unknown as CreateAgentSessionRequest;

  const deviceId = typeof body.deviceId === 'string' ? body.deviceId.trim() : '';
  if (!deviceId) {
    return json({ error: t('apiError.agentDeviceRequired') }, 400);
  }
  if (!getDeviceById(deviceId)) {
    return json({ error: t('apiError.deviceNotFound') }, 404);
  }

  const paneId = typeof body.paneId === 'string' ? body.paneId.trim() : '';
  if (!paneId) {
    return json({ error: t('apiError.agentPaneRequired') }, 400);
  }

  let providerId: string | null = null;
  if (body.providerId !== undefined && body.providerId !== null) {
    if (typeof body.providerId !== 'string' || !getLlmProviderById(body.providerId)) {
      return json({ error: t('apiError.llmProviderNotFound') }, 400);
    }
    providerId = body.providerId;
  }

  let modelId: string | null = null;
  if (body.modelId !== undefined && body.modelId !== null) {
    if (typeof body.modelId !== 'string' || !body.modelId.trim()) {
      return json({ error: t('apiError.invalidRequest') }, 400);
    }
    modelId = body.modelId.trim();
  } else {
    modelId = getAgentSettings().defaultModelId;
  }
  if (!modelId) {
    return json({ error: t('apiError.llmNoDefaultModel') }, 400);
  }

  if (body.writeMode !== undefined && !WRITE_MODES.includes(body.writeMode)) {
    return json({ error: t('apiError.agentWriteModeInvalid') }, 400);
  }

  if (body.useProviderWebSearch !== undefined && typeof body.useProviderWebSearch !== 'boolean') {
    return json({ error: t('apiError.invalidRequest') }, 400);
  }
  if (body.useProviderWebSearch) {
    const error = validateProviderWebSearch(providerId);
    if (error) {
      return json({ error }, 400);
    }
  }

  if (
    body.systemPrompt !== undefined &&
    body.systemPrompt !== null &&
    typeof body.systemPrompt !== 'string'
  ) {
    return json({ error: t('apiError.invalidRequest') }, 400);
  }

  let maxStepsPerTurn: number | undefined;
  if (body.maxStepsPerTurn !== undefined) {
    const validated = validateMaxSteps(body.maxStepsPerTurn);
    if (typeof validated !== 'number') {
      return json({ error: validated.error }, 400);
    }
    maxStepsPerTurn = validated;
  }

  const session = createAgentSession({
    title: DEFAULT_AGENT_SESSION_TITLE,
    deviceId,
    paneId,
    providerId,
    modelId,
    systemPrompt: body.systemPrompt ?? null,
    writeMode: body.writeMode,
    useProviderWebSearch: body.useProviderWebSearch ?? false,
    maxStepsPerTurn,
  });

  return json({ session: toSessionDto(session) }, 201);
}

async function handleGetSession(id: string): Promise<Response> {
  const session = getAgentSessionById(id);
  if (!session) {
    return json({ error: t('apiError.agentSessionNotFound') }, 404);
  }
  return json({ session: toSessionDto(session) });
}

async function handleUpdateSession(req: Request, id: string): Promise<Response> {
  const existing = getAgentSessionById(id);
  if (!existing) {
    return json({ error: t('apiError.agentSessionNotFound') }, 404);
  }

  const raw = await readJsonObjectBody(req);
  if (!raw) {
    return json({ error: t('apiError.invalidRequest') }, 400);
  }
  const body = raw as UpdateAgentSessionRequest;
  const updates: Partial<
    Pick<
      AgentSessionRecord,
      | 'title'
      | 'paneId'
      | 'providerId'
      | 'modelId'
      | 'systemPrompt'
      | 'writeMode'
      | 'useProviderWebSearch'
      | 'maxStepsPerTurn'
    >
  > = {};

  if (body.title !== undefined) {
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title) {
      return json({ error: t('apiError.invalidRequest') }, 400);
    }
    updates.title = title;
  }

  if (body.paneId !== undefined) {
    const paneId = typeof body.paneId === 'string' ? body.paneId.trim() : '';
    if (!paneId) {
      return json({ error: t('apiError.agentPaneRequired') }, 400);
    }
    updates.paneId = paneId;
  }

  if (body.providerId !== undefined) {
    if (body.providerId === null) {
      updates.providerId = null;
    } else if (typeof body.providerId !== 'string' || !getLlmProviderById(body.providerId)) {
      return json({ error: t('apiError.llmProviderNotFound') }, 400);
    } else {
      updates.providerId = body.providerId;
    }
  }

  if (body.modelId !== undefined) {
    if (typeof body.modelId !== 'string' || !body.modelId.trim()) {
      return json({ error: t('apiError.invalidRequest') }, 400);
    }
    updates.modelId = body.modelId.trim();
  }

  if (body.systemPrompt !== undefined) {
    if (body.systemPrompt !== null && typeof body.systemPrompt !== 'string') {
      return json({ error: t('apiError.invalidRequest') }, 400);
    }
    updates.systemPrompt = body.systemPrompt;
  }

  if (body.writeMode !== undefined) {
    if (!WRITE_MODES.includes(body.writeMode)) {
      return json({ error: t('apiError.agentWriteModeInvalid') }, 400);
    }
    updates.writeMode = body.writeMode;
  }

  if (body.useProviderWebSearch !== undefined) {
    if (typeof body.useProviderWebSearch !== 'boolean') {
      return json({ error: t('apiError.invalidRequest') }, 400);
    }
    updates.useProviderWebSearch = body.useProviderWebSearch;
  }

  if (body.maxStepsPerTurn !== undefined) {
    const validated = validateMaxSteps(body.maxStepsPerTurn);
    if (typeof validated !== 'number') {
      return json({ error: validated.error }, 400);
    }
    updates.maxStepsPerTurn = validated;
  }

  if (updates.useProviderWebSearch ?? existing.useProviderWebSearch) {
    const effectiveProviderId =
      updates.providerId !== undefined ? updates.providerId : existing.providerId;
    const error = validateProviderWebSearch(effectiveProviderId);
    if (error) {
      return json({ error }, 400);
    }
  }

  const session = updateAgentSession(id, updates);
  if (!session) {
    return json({ error: t('apiError.agentSessionNotFound') }, 404);
  }
  return json({ session: toSessionDto(session) });
}

async function handleDeleteSession(id: string, supervisor: AgentSupervisor): Promise<Response> {
  const existing = getAgentSessionById(id);
  if (!existing) {
    return json({ error: t('apiError.agentSessionNotFound') }, 404);
  }

  if (supervisor.isSessionActive(id)) {
    await supervisor.stopSession(id);
  }

  deleteAgentSession(id);
  return json({ success: true });
}

async function handleListMessages(req: Request, id: string): Promise<Response> {
  const session = getAgentSessionById(id);
  if (!session) {
    return json({ error: t('apiError.agentSessionNotFound') }, 404);
  }

  const url = new URL(req.url);
  const afterSeqRaw = url.searchParams.get('afterSeq');
  let afterSeq: number | undefined;
  if (afterSeqRaw !== null) {
    const parsed = Number(afterSeqRaw);
    if (!Number.isInteger(parsed)) {
      return json({ error: t('apiError.invalidRequest') }, 400);
    }
    afterSeq = parsed;
  }

  const messages = listAgentMessages(id, { afterSeq });
  return json({ messages: messages.map(toMessageDto) });
}

async function handlePostMessage(
  req: Request,
  id: string,
  supervisor: AgentSupervisor
): Promise<Response> {
  const raw = await readJsonObjectBody(req);
  if (!raw) {
    return json({ error: t('apiError.invalidRequest') }, 400);
  }
  const body = raw as unknown as PostAgentMessageRequest;

  const text = typeof body.text === 'string' ? body.text : '';
  if (!text.trim()) {
    return json({ error: t('apiError.agentMessageTextRequired') }, 400);
  }

  try {
    const record = supervisor.submitUserMessage(id, text);
    return json({ message: toMessageDto(record) }, 201);
  } catch (error) {
    return mapSupervisorError(error);
  }
}

async function handleStopSession(id: string, supervisor: AgentSupervisor): Promise<Response> {
  try {
    await supervisor.stopSession(id);
    const session = getAgentSessionById(id);
    return json({ session: session ? toSessionDto(session) : null });
  } catch (error) {
    return mapSupervisorError(error);
  }
}

async function handleListConfirmations(id: string): Promise<Response> {
  const session = getAgentSessionById(id);
  if (!session) {
    return json({ error: t('apiError.agentSessionNotFound') }, 404);
  }

  const confirmations = listPendingAgentConfirmations(id);
  return json({ confirmations: confirmations.map(toConfirmationDto) });
}

async function handleDecideConfirmation(
  req: Request,
  id: string,
  supervisor: AgentSupervisor
): Promise<Response> {
  const raw = await readJsonObjectBody(req);
  if (!raw) {
    return json({ error: t('apiError.invalidRequest') }, 400);
  }
  const body = raw as unknown as DecideAgentConfirmationRequest;

  if (typeof body.approved !== 'boolean') {
    return json({ error: t('apiError.invalidRequest') }, 400);
  }
  if (body.reason !== undefined && typeof body.reason !== 'string') {
    return json({ error: t('apiError.invalidRequest') }, 400);
  }

  try {
    const decided = supervisor.resolveConfirmation(id, body.approved, body.reason);
    return json({ confirmation: toConfirmationDto(decided) });
  } catch (error) {
    return mapSupervisorError(error);
  }
}

function mapSupervisorError(error: unknown): Response {
  if (error instanceof AgentSessionNotFoundError) {
    return json({ error: error.message }, 404);
  }
  if (error instanceof AgentConfirmationNotFoundError) {
    return json({ error: error.message }, 404);
  }
  if (error instanceof AgentSessionBusyError) {
    return json({ error: error.message }, 409);
  }
  if (error instanceof AgentAwaitingConfirmationError) {
    return json({ error: error.message }, 409);
  }
  if (error instanceof AgentConfirmationAlreadyDecidedError) {
    return json({ error: error.message }, 409);
  }
  console.error('[api/agent] unexpected error:', error);
  return json(
    { error: error instanceof Error ? error.message : t('apiError.invalidRequest') },
    500
  );
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  });
}
