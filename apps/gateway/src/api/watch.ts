// Watch 规则 REST API
// CRUD 后通过 watchService.refreshRule/removeRule 热更新调度；
// assist-regex 用 LLM 生成正则（可带当前屏幕做上下文），返回前服务端试编译 + 试跑 preview。

import type {
  AssistRegexRequest,
  CreateWatchRuleRequest,
  UpdateWatchRuleRequest,
  WatchFireMode,
  WatchNoMatchBehavior,
  WatchRuleDto,
  WatchRuleStateDto,
  WatchTriggerType,
} from '@tmex/shared';
import type { LanguageModel } from 'ai';
import { generateObject } from 'ai';
import { z } from 'zod';
import { getDeviceById } from '../db';
import { getLlmProviderById } from '../db/llm';
import {
  type WatchRuleRecord,
  type WatchRuleStateRecord,
  createWatchRule,
  deleteWatchRule,
  getAllWatchRules,
  getWatchRuleById,
  getWatchRuleState,
  updateWatchRule,
} from '../db/watch';
import { t } from '../i18n';
import { resolveLanguageModel } from '../llm/provider-registry';
import { tmuxRuntimeRegistry } from '../tmux-client/registry';
import { compileWatchPattern } from '../watch/evaluator';
import { type WatchService, watchService } from '../watch/service';

const TRIGGER_TYPES: readonly WatchTriggerType[] = ['match', 'unchanged', 'llm'];
const NO_MATCH_BEHAVIORS: readonly WatchNoMatchBehavior[] = ['reset', 'ignore'];
const FIRE_MODES: readonly WatchFireMode[] = ['once', 'repeat'];
const ASSIST_PREVIEW_LIMIT = 20;

const assistSchema = z.object({
  pattern: z.string(),
  flags: z.string(),
  extractGroup: z.number().int(),
  explanation: z.string(),
});

export interface WatchApiDeps {
  service: Pick<WatchService, 'refreshRule' | 'removeRule' | 'getSamples'>;
  captureScreen: (deviceId: string, paneId: string) => Promise<string>;
  resolveModel: (providerId: string | null, modelId: string | null) => Promise<LanguageModel>;
  llmMaxRetries: number;
}

async function defaultCaptureScreen(deviceId: string, paneId: string): Promise<string> {
  const runtime = await tmuxRuntimeRegistry.acquire(deviceId);
  try {
    await runtime.connect();
    return await runtime.capturePaneText(paneId);
  } finally {
    await tmuxRuntimeRegistry.release(deviceId);
  }
}

const defaultDeps: WatchApiDeps = {
  service: watchService,
  captureScreen: defaultCaptureScreen,
  resolveModel: resolveLanguageModel,
  llmMaxRetries: 2,
};

export function handleWatchApiRequest(
  req: Request,
  path: string,
  depsOverride: Partial<WatchApiDeps> = {}
): Response | Promise<Response> | null {
  const deps: WatchApiDeps = { ...defaultDeps, ...depsOverride };

  if (path === '/api/watch/rules' && req.method === 'GET') {
    return handleListRules(req);
  }
  if (path === '/api/watch/rules' && req.method === 'POST') {
    return handleCreateRule(req, deps);
  }
  if (path === '/api/watch/assist-regex' && req.method === 'POST') {
    return handleAssistRegex(req, deps);
  }
  if (path.match(/^\/api\/watch\/rules\/[^/]+$/) && req.method === 'GET') {
    return handleGetRule(path.split('/')[4]);
  }
  if (path.match(/^\/api\/watch\/rules\/[^/]+$/) && req.method === 'PATCH') {
    return handleUpdateRule(req, path.split('/')[4], deps);
  }
  if (path.match(/^\/api\/watch\/rules\/[^/]+$/) && req.method === 'DELETE') {
    return handleDeleteRule(path.split('/')[4], deps);
  }
  if (path.match(/^\/api\/watch\/rules\/[^/]+\/state$/) && req.method === 'GET') {
    return handleGetRuleState(path.split('/')[4], deps);
  }

  return null;
}

function toRuleDto(record: WatchRuleRecord): WatchRuleDto {
  return {
    id: record.id,
    name: record.name,
    deviceId: record.deviceId,
    paneId: record.paneId,
    enabled: record.enabled,
    triggerType: record.triggerType,
    pattern: record.pattern,
    patternFlags: record.patternFlags,
    extractGroup: record.extractGroup,
    conditionPrompt: record.conditionPrompt,
    providerId: record.providerId,
    modelId: record.modelId,
    confirmWithLlm: record.confirmWithLlm,
    summarizeWithLlm: record.summarizeWithLlm,
    intervalSeconds: record.intervalSeconds,
    unchangedMinutes: record.unchangedMinutes,
    noMatchBehavior: record.noMatchBehavior,
    fireMode: record.fireMode,
    cooldownSeconds: record.cooldownSeconds,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function toStateDto(record: WatchRuleStateRecord): WatchRuleStateDto {
  return {
    ruleId: record.ruleId,
    lastSampledAt: record.lastSampledAt,
    lastValue: record.lastValue,
    lastValueChangedAt: record.lastValueChangedAt,
    triggeredSinceChange: record.triggeredSinceChange,
    lastTriggeredAt: record.lastTriggeredAt,
    consecutiveErrors: record.consecutiveErrors,
    lastError: record.lastError,
    modelUnavailableNotified: record.modelUnavailableNotified,
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

interface ParsedRuleFields {
  enabled?: boolean;
  pattern?: string | null;
  patternFlags?: string;
  extractGroup?: number;
  conditionPrompt?: string | null;
  providerId?: string | null;
  modelId?: string | null;
  confirmWithLlm?: boolean;
  summarizeWithLlm?: boolean;
  intervalSeconds?: number;
  unchangedMinutes?: number | null;
  noMatchBehavior?: WatchNoMatchBehavior;
  fireMode?: WatchFireMode;
  cooldownSeconds?: number;
}

/** 字段级类型/枚举/范围校验（出现才校验）；跨字段语义校验见 validateRuleSemantics */
function parseRuleFields(
  body: Record<string, unknown>
): { ok: true; fields: ParsedRuleFields } | { ok: false; error: string } {
  const fields: ParsedRuleFields = {};

  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') {
      return { ok: false, error: t('apiError.invalidRequest') };
    }
    fields.enabled = body.enabled;
  }

  if (body.pattern !== undefined) {
    if (body.pattern !== null && typeof body.pattern !== 'string') {
      return { ok: false, error: t('apiError.invalidRequest') };
    }
    fields.pattern = typeof body.pattern === 'string' && body.pattern ? body.pattern : null;
  }

  if (body.patternFlags !== undefined) {
    if (typeof body.patternFlags !== 'string') {
      return { ok: false, error: t('apiError.invalidRequest') };
    }
    fields.patternFlags = body.patternFlags;
  }

  if (body.extractGroup !== undefined) {
    if (
      typeof body.extractGroup !== 'number' ||
      !Number.isInteger(body.extractGroup) ||
      body.extractGroup < 0
    ) {
      return { ok: false, error: t('apiError.watchExtractGroupInvalid') };
    }
    fields.extractGroup = body.extractGroup;
  }

  if (body.conditionPrompt !== undefined) {
    if (body.conditionPrompt !== null && typeof body.conditionPrompt !== 'string') {
      return { ok: false, error: t('apiError.invalidRequest') };
    }
    fields.conditionPrompt =
      typeof body.conditionPrompt === 'string' && body.conditionPrompt.trim()
        ? body.conditionPrompt
        : null;
  }

  if (body.providerId !== undefined) {
    if (body.providerId === null) {
      fields.providerId = null;
    } else if (typeof body.providerId !== 'string' || !getLlmProviderById(body.providerId)) {
      return { ok: false, error: t('apiError.llmProviderNotFound') };
    } else {
      fields.providerId = body.providerId;
    }
  }

  if (body.modelId !== undefined) {
    if (body.modelId === null) {
      fields.modelId = null;
    } else if (typeof body.modelId !== 'string') {
      return { ok: false, error: t('apiError.invalidRequest') };
    } else {
      fields.modelId = body.modelId.trim() || null;
    }
  }

  for (const key of ['confirmWithLlm', 'summarizeWithLlm'] as const) {
    if (body[key] !== undefined) {
      if (typeof body[key] !== 'boolean') {
        return { ok: false, error: t('apiError.invalidRequest') };
      }
      fields[key] = body[key];
    }
  }

  if (body.intervalSeconds !== undefined) {
    if (typeof body.intervalSeconds !== 'number' || !Number.isInteger(body.intervalSeconds)) {
      return { ok: false, error: t('apiError.watchIntervalInvalid', { min: 5 }) };
    }
    fields.intervalSeconds = body.intervalSeconds;
  }

  if (body.unchangedMinutes !== undefined) {
    if (body.unchangedMinutes === null) {
      fields.unchangedMinutes = null;
    } else if (
      typeof body.unchangedMinutes !== 'number' ||
      !Number.isInteger(body.unchangedMinutes) ||
      body.unchangedMinutes <= 0
    ) {
      return { ok: false, error: t('apiError.watchUnchangedMinutesInvalid') };
    } else {
      fields.unchangedMinutes = body.unchangedMinutes;
    }
  }

  if (body.noMatchBehavior !== undefined) {
    if (!NO_MATCH_BEHAVIORS.includes(body.noMatchBehavior as WatchNoMatchBehavior)) {
      return { ok: false, error: t('apiError.watchNoMatchBehaviorInvalid') };
    }
    fields.noMatchBehavior = body.noMatchBehavior as WatchNoMatchBehavior;
  }

  if (body.fireMode !== undefined) {
    if (!FIRE_MODES.includes(body.fireMode as WatchFireMode)) {
      return { ok: false, error: t('apiError.watchFireModeInvalid') };
    }
    fields.fireMode = body.fireMode as WatchFireMode;
  }

  if (body.cooldownSeconds !== undefined) {
    if (
      typeof body.cooldownSeconds !== 'number' ||
      !Number.isInteger(body.cooldownSeconds) ||
      body.cooldownSeconds < 0
    ) {
      return { ok: false, error: t('apiError.watchCooldownInvalid') };
    }
    fields.cooldownSeconds = body.cooldownSeconds;
  }

  return { ok: true, fields };
}

interface RuleSemanticInput {
  triggerType: WatchTriggerType;
  pattern: string | null;
  patternFlags: string;
  unchangedMinutes: number | null;
  conditionPrompt: string | null;
  intervalSeconds: number;
}

/** 跨字段语义校验（基于合成后的完整有效值） */
function validateRuleSemantics(input: RuleSemanticInput): string | null {
  if (input.triggerType === 'match' || input.triggerType === 'unchanged') {
    if (!input.pattern) {
      return t('apiError.watchPatternRequired');
    }
    try {
      compileWatchPattern(input.pattern, input.patternFlags);
    } catch (error) {
      return t('apiError.watchPatternInvalid', {
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    if (input.triggerType === 'unchanged') {
      if (!input.unchangedMinutes || input.unchangedMinutes <= 0) {
        return t('apiError.watchUnchangedMinutesInvalid');
      }
    }
  } else if (!input.conditionPrompt?.trim()) {
    return t('apiError.watchConditionPromptRequired');
  }

  const minInterval = input.triggerType === 'llm' ? 30 : 5;
  if (input.intervalSeconds < minInterval) {
    return t('apiError.watchIntervalInvalid', { min: minInterval });
  }

  return null;
}

async function handleListRules(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const deviceId = url.searchParams.get('deviceId');
  const paneId = url.searchParams.get('paneId');

  let rules = getAllWatchRules();
  if (deviceId) {
    rules = rules.filter((rule) => rule.deviceId === deviceId);
  }
  if (paneId) {
    rules = rules.filter((rule) => rule.paneId === paneId);
  }

  return json({ rules: rules.map(toRuleDto) });
}

async function handleCreateRule(req: Request, deps: WatchApiDeps): Promise<Response> {
  const raw = await readJsonObjectBody(req);
  if (!raw) {
    return json({ error: t('apiError.invalidRequest') }, 400);
  }
  const body = raw as unknown as CreateWatchRuleRequest;

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) {
    return json({ error: t('apiError.watchNameRequired') }, 400);
  }

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

  if (!TRIGGER_TYPES.includes(body.triggerType)) {
    return json({ error: t('apiError.watchTriggerTypeInvalid') }, 400);
  }

  const parsed = parseRuleFields(raw);
  if (!parsed.ok) {
    return json({ error: parsed.error }, 400);
  }
  const fields = parsed.fields;

  const effective: RuleSemanticInput = {
    triggerType: body.triggerType,
    pattern: fields.pattern ?? null,
    patternFlags: fields.patternFlags ?? '',
    unchangedMinutes: fields.unchangedMinutes ?? null,
    conditionPrompt: fields.conditionPrompt ?? null,
    intervalSeconds: fields.intervalSeconds ?? (body.triggerType === 'llm' ? 60 : 30),
  };
  const semanticError = validateRuleSemantics(effective);
  if (semanticError) {
    return json({ error: semanticError }, 400);
  }

  const rule = createWatchRule({
    name,
    deviceId,
    paneId,
    enabled: fields.enabled,
    triggerType: body.triggerType,
    pattern: effective.pattern,
    patternFlags: effective.patternFlags,
    extractGroup: fields.extractGroup,
    conditionPrompt: effective.conditionPrompt,
    providerId: fields.providerId,
    modelId: fields.modelId,
    confirmWithLlm: fields.confirmWithLlm,
    summarizeWithLlm: fields.summarizeWithLlm,
    intervalSeconds: effective.intervalSeconds,
    unchangedMinutes: effective.unchangedMinutes,
    noMatchBehavior: fields.noMatchBehavior,
    fireMode: fields.fireMode,
    cooldownSeconds: fields.cooldownSeconds,
  });

  await deps.service.refreshRule(rule.id);
  return json({ rule: toRuleDto(rule), state: null }, 201);
}

async function handleGetRule(id: string): Promise<Response> {
  const rule = getWatchRuleById(id);
  if (!rule) {
    return json({ error: t('apiError.watchRuleNotFound') }, 404);
  }
  const state = getWatchRuleState(id);
  return json({ rule: toRuleDto(rule), state: state ? toStateDto(state) : null });
}

async function handleUpdateRule(req: Request, id: string, deps: WatchApiDeps): Promise<Response> {
  const existing = getWatchRuleById(id);
  if (!existing) {
    return json({ error: t('apiError.watchRuleNotFound') }, 404);
  }

  const raw = await readJsonObjectBody(req);
  if (!raw) {
    return json({ error: t('apiError.invalidRequest') }, 400);
  }
  const body = raw as UpdateWatchRuleRequest;

  const updates: Partial<Omit<WatchRuleRecord, 'id' | 'createdAt' | 'updatedAt'>> = {};

  if (body.name !== undefined) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) {
      return json({ error: t('apiError.watchNameRequired') }, 400);
    }
    updates.name = name;
  }

  if (body.paneId !== undefined) {
    const paneId = typeof body.paneId === 'string' ? body.paneId.trim() : '';
    if (!paneId) {
      return json({ error: t('apiError.agentPaneRequired') }, 400);
    }
    updates.paneId = paneId;
  }

  if (body.triggerType !== undefined) {
    if (!TRIGGER_TYPES.includes(body.triggerType)) {
      return json({ error: t('apiError.watchTriggerTypeInvalid') }, 400);
    }
    updates.triggerType = body.triggerType;
  }

  const parsed = parseRuleFields(raw);
  if (!parsed.ok) {
    return json({ error: parsed.error }, 400);
  }
  const fields = parsed.fields;
  Object.assign(updates, fields);

  const effective: RuleSemanticInput = {
    triggerType: updates.triggerType ?? existing.triggerType,
    pattern: fields.pattern !== undefined ? fields.pattern : existing.pattern,
    patternFlags: fields.patternFlags !== undefined ? fields.patternFlags : existing.patternFlags,
    unchangedMinutes:
      fields.unchangedMinutes !== undefined ? fields.unchangedMinutes : existing.unchangedMinutes,
    conditionPrompt:
      fields.conditionPrompt !== undefined ? fields.conditionPrompt : existing.conditionPrompt,
    intervalSeconds:
      fields.intervalSeconds !== undefined ? fields.intervalSeconds : existing.intervalSeconds,
  };
  const semanticError = validateRuleSemantics(effective);
  if (semanticError) {
    return json({ error: semanticError }, 400);
  }

  const rule = updateWatchRule(id, updates);
  if (!rule) {
    return json({ error: t('apiError.watchRuleNotFound') }, 404);
  }

  await deps.service.refreshRule(id);
  const state = getWatchRuleState(id);
  return json({ rule: toRuleDto(rule), state: state ? toStateDto(state) : null });
}

async function handleDeleteRule(id: string, deps: WatchApiDeps): Promise<Response> {
  const existing = getWatchRuleById(id);
  if (!existing) {
    return json({ error: t('apiError.watchRuleNotFound') }, 404);
  }

  deleteWatchRule(id);
  await deps.service.removeRule(id);
  return json({ success: true });
}

async function handleGetRuleState(id: string, deps: WatchApiDeps): Promise<Response> {
  const rule = getWatchRuleById(id);
  if (!rule) {
    return json({ error: t('apiError.watchRuleNotFound') }, 404);
  }
  const state = getWatchRuleState(id);
  return json({
    state: state ? toStateDto(state) : null,
    samples: deps.service.getSamples(id),
  });
}

function buildAssistPrompt(description: string, screen: string | null): string {
  const lines = [
    'Generate a JavaScript regular expression for a terminal watch rule.',
    'The regex will be evaluated with RegExp(pattern, flags) against plain terminal screen text;',
    'the LAST occurrence on the screen wins. The g flag is always appended automatically.',
    'extractGroup is the capture group index whose value will be tracked over time (0 = whole match).',
    '',
    `What the user wants to match: ${description}`,
  ];
  if (screen) {
    lines.push(
      '',
      'Current terminal screen content (use it as a realistic sample):',
      '---',
      screen.length > 16_000 ? screen.slice(-16_000) : screen,
      '---'
    );
  }
  lines.push('', 'Keep the pattern minimal and robust. Explain briefly in explanation.');
  return lines.join('\n');
}

async function handleAssistRegex(req: Request, deps: WatchApiDeps): Promise<Response> {
  const raw = await readJsonObjectBody(req);
  if (!raw) {
    return json({ error: t('apiError.invalidRequest') }, 400);
  }
  const body = raw as unknown as AssistRegexRequest;

  const description = typeof body.description === 'string' ? body.description.trim() : '';
  if (!description) {
    return json({ error: t('apiError.watchAssistDescriptionRequired') }, 400);
  }

  let providerId: string | null = null;
  if (body.providerId !== undefined && body.providerId !== null) {
    if (typeof body.providerId !== 'string' || !getLlmProviderById(body.providerId)) {
      return json({ error: t('apiError.llmProviderNotFound') }, 400);
    }
    providerId = body.providerId;
  }
  const modelId =
    typeof body.modelId === 'string' && body.modelId.trim() ? body.modelId.trim() : null;

  let screen: string | null = null;
  const deviceId = typeof body.deviceId === 'string' ? body.deviceId.trim() : '';
  const paneId = typeof body.paneId === 'string' ? body.paneId.trim() : '';
  if (deviceId && paneId) {
    if (!getDeviceById(deviceId)) {
      return json({ error: t('apiError.deviceNotFound') }, 404);
    }
    try {
      screen = await deps.captureScreen(deviceId, paneId);
    } catch (error) {
      // 取屏失败降级为无屏幕上下文，不阻断生成
      console.warn(`[api/watch] assist-regex capture failed for ${deviceId}/${paneId}:`, error);
      screen = null;
    }
  }

  let object: z.infer<typeof assistSchema>;
  try {
    const model = await deps.resolveModel(providerId, modelId);
    const result = await generateObject({
      model,
      schema: assistSchema,
      prompt: buildAssistPrompt(description, screen),
      maxRetries: deps.llmMaxRetries,
    });
    object = result.object;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return json({ error: t('apiError.watchAssistModelUnavailable', { detail }) }, 502);
  }

  // 模型产物在服务端试编译，失败视为上游错误
  let regex: RegExp;
  try {
    regex = compileWatchPattern(object.pattern, object.flags);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return json({ error: t('apiError.watchPatternInvalid', { detail }) }, 502);
  }

  const preview: string[] = [];
  if (screen) {
    regex.lastIndex = 0;
    let match = regex.exec(screen);
    while (match !== null && preview.length < ASSIST_PREVIEW_LIMIT) {
      preview.push(match[0]);
      if (match.index === regex.lastIndex) {
        regex.lastIndex += 1;
      }
      match = regex.exec(screen);
    }
  }

  return json({
    pattern: object.pattern,
    flags: object.flags,
    extractGroup: object.extractGroup >= 0 ? object.extractGroup : 0,
    explanation: object.explanation,
    preview,
  });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  });
}
