import { beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import {
  appendAgentMessage,
  createAgentConfirmation,
  createAgentSession,
  decideAgentConfirmation,
  deleteAgentSession,
  ensureAgentSettingsInitialized,
  getAgentConfirmationById,
  getAgentSessionById,
  getAgentSessionsByStatus,
  getAgentSettings,
  listAgentMessages,
  listPendingAgentConfirmations,
  updateAgentSession,
  updateAgentSettings,
} from './agent';
import { getDb as getOrmDb } from './client';
import { createDevice } from './index';
import {
  createLlmProvider,
  deleteLlmProvider,
  getAllLlmProviders,
  getLlmProviderById,
  updateLlmProvider,
} from './llm';
import { agentMessages } from './schema';
import {
  createWatchRule,
  deleteWatchRule,
  getAllWatchRules,
  getWatchRuleById,
  getWatchRuleState,
  updateWatchRule,
  upsertWatchRuleState,
} from './watch';

const testDeviceId = crypto.randomUUID();

beforeAll(() => {
  migrate(getOrmDb(), { migrationsFolder: resolve(import.meta.dir, '../../drizzle') });
  const now = new Date().toISOString();
  createDevice({
    id: testDeviceId,
    name: 'agent-watch-test-device',
    type: 'local',
    session: 'tmex',
    authMode: 'auto',
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
  });
});

describe('llm providers', () => {
  test('create / get / update / delete', () => {
    const provider = createLlmProvider({
      name: 'test-provider',
      protocol: 'openai-chat',
      baseUrl: 'https://api.example.com/v1',
      apiKeyEnc: 'enc:dummy',
    });

    expect(provider.enabled).toBe(true);
    expect(provider.modelsCache).toBeNull();
    expect(getLlmProviderById(provider.id)?.name).toBe('test-provider');
    expect(getAllLlmProviders().some((p) => p.id === provider.id)).toBe(true);

    const updated = updateLlmProvider(provider.id, {
      enabled: false,
      modelsCache: ['gpt-4o', 'gpt-4o-mini'],
      modelsFetchedAt: new Date().toISOString(),
    });
    expect(updated).not.toBeNull();
    expect(updated?.enabled).toBe(false);
    expect(updated?.modelsCache).toEqual(['gpt-4o', 'gpt-4o-mini']);
    expect((updated?.updatedAt ?? '') >= provider.updatedAt).toBe(true);

    deleteLlmProvider(provider.id);
    expect(getLlmProviderById(provider.id)).toBeNull();
  });

  test('rejects invalid protocol', () => {
    expect(() =>
      createLlmProvider({
        name: 'bad',
        protocol: 'grpc' as never,
        baseUrl: 'https://x',
        apiKeyEnc: 'enc:x',
      })
    ).toThrow(/CHECK constraint failed/);
  });
});

describe('agent settings', () => {
  test('ensure is idempotent and get returns singleton', () => {
    ensureAgentSettingsInitialized();
    ensureAgentSettingsInitialized();

    const settings = getAgentSettings();
    expect(settings.id).toBe(1);
    expect(settings.searchProvider).toBe('none');
    expect(settings.defaultProviderId).toBeNull();
  });

  test('update preserves untouched fields and clears default provider on delete', () => {
    const provider = createLlmProvider({
      name: 'default-provider',
      protocol: 'openai-responses',
      baseUrl: 'https://api.example.com/v1',
      apiKeyEnc: 'enc:dummy',
    });

    const updated = updateAgentSettings({
      searchProvider: 'tavily',
      tavilyApiKeyEnc: 'enc:tavily',
      defaultProviderId: provider.id,
      defaultModelId: 'gpt-4o',
    });
    expect(updated.searchProvider).toBe('tavily');
    expect(updated.defaultProviderId).toBe(provider.id);

    const partial = updateAgentSettings({ defaultModelId: 'gpt-4o-mini' });
    expect(partial.searchProvider).toBe('tavily');
    expect(partial.defaultModelId).toBe('gpt-4o-mini');

    deleteLlmProvider(provider.id);
    expect(getAgentSettings().defaultProviderId).toBeNull();
  });
});

describe('agent sessions and messages', () => {
  test('session crud and status query', () => {
    const session = createAgentSession({
      title: 'test session',
      deviceId: testDeviceId,
      paneId: '%1',
      modelId: 'gpt-4o',
    });

    expect(session.status).toBe('idle');
    expect(session.writeMode).toBe('confirm');
    expect(session.maxStepsPerTurn).toBe(25);

    updateAgentSession(session.id, { status: 'running' });
    expect(getAgentSessionsByStatus('running').some((s) => s.id === session.id)).toBe(true);

    updateAgentSession(session.id, { status: 'error', lastError: 'boom' });
    const errored = getAgentSessionById(session.id);
    expect(errored?.status).toBe('error');
    expect(errored?.lastError).toBe('boom');

    deleteAgentSession(session.id);
    expect(getAgentSessionById(session.id)).toBeNull();
  });

  test('message seq auto-increments per session', () => {
    const sessionA = createAgentSession({ title: 'a', modelId: 'm' });
    const sessionB = createAgentSession({ title: 'b', modelId: 'm' });

    const m0 = appendAgentMessage(sessionA.id, 'user', { role: 'user', content: 'hi' });
    const m1 = appendAgentMessage(sessionA.id, 'assistant', { role: 'assistant', content: 'yo' });
    const other = appendAgentMessage(sessionB.id, 'user', { role: 'user', content: 'b0' });

    expect(m0.seq).toBe(0);
    expect(m1.seq).toBe(1);
    expect(other.seq).toBe(0);

    const all = listAgentMessages(sessionA.id);
    expect(all.map((m) => m.seq)).toEqual([0, 1]);
    expect(all[0]?.content).toEqual({ role: 'user', content: 'hi' });

    const after = listAgentMessages(sessionA.id, { afterSeq: 0 });
    expect(after.map((m) => m.seq)).toEqual([1]);
  });

  test('duplicate seq violates unique constraint', () => {
    const session = createAgentSession({ title: 'dup', modelId: 'm' });
    appendAgentMessage(session.id, 'user', 'first');

    const orm = getOrmDb();
    expect(() =>
      orm
        .insert(agentMessages)
        .values({
          id: crypto.randomUUID(),
          sessionId: session.id,
          seq: 0,
          role: 'user',
          content: 'dup',
          createdAt: new Date().toISOString(),
        })
        .run()
    ).toThrow();
  });

  test('deleting session cascades messages', () => {
    const session = createAgentSession({ title: 'cascade', modelId: 'm' });
    appendAgentMessage(session.id, 'user', 'x');
    deleteAgentSession(session.id);

    const orm = getOrmDb();
    const rows = orm
      .select()
      .from(agentMessages)
      .where(eq(agentMessages.sessionId, session.id))
      .all();
    expect(rows).toEqual([]);
  });
});

describe('agent confirmations', () => {
  test('create / list pending / decide', () => {
    const session = createAgentSession({ title: 'confirm', modelId: 'm' });
    const confirmation = createAgentConfirmation({
      sessionId: session.id,
      toolName: 'write_terminal',
      toolCallId: 'call_1',
      inputJson: { keys: 'ls -la\n' },
    });

    expect(confirmation.status).toBe('pending');
    expect(listPendingAgentConfirmations(session.id).map((c) => c.id)).toEqual([confirmation.id]);

    const decided = decideAgentConfirmation(confirmation.id, {
      status: 'approved',
    });
    expect(decided?.status).toBe('approved');
    expect(decided?.decidedAt).not.toBeNull();
    expect(listPendingAgentConfirmations(session.id)).toEqual([]);
  });

  test('decide on already decided confirmation returns null and keeps state', () => {
    const session = createAgentSession({ title: 'confirm-cas', modelId: 'm' });
    const confirmation = createAgentConfirmation({
      sessionId: session.id,
      toolName: 'write_terminal',
      toolCallId: 'call_2',
      inputJson: { keys: 'rm -rf /tmp/x\n' },
    });

    const approved = decideAgentConfirmation(confirmation.id, { status: 'approved' });
    expect(approved?.status).toBe('approved');

    const denied = decideAgentConfirmation(confirmation.id, {
      status: 'denied',
      reason: 'too late',
    });
    expect(denied).toBeNull();

    const current = getAgentConfirmationById(confirmation.id);
    expect(current?.status).toBe('approved');
    expect(current?.reason).toBeNull();
    expect(current?.decidedAt).toBe(approved?.decidedAt ?? '');
  });
});

describe('watch rules and state', () => {
  test('rule crud with defaults', () => {
    const rule = createWatchRule({
      name: 'cpu watch',
      deviceId: testDeviceId,
      paneId: '%2',
      triggerType: 'match',
      pattern: 'error: (.+)',
      extractGroup: 1,
    });

    expect(rule.enabled).toBe(true);
    expect(rule.patternFlags).toBe('');
    expect(rule.intervalSeconds).toBe(30);
    expect(rule.noMatchBehavior).toBe('reset');
    expect(rule.fireMode).toBe('once');
    expect(rule.cooldownSeconds).toBe(600);

    expect(getAllWatchRules().some((r) => r.id === rule.id)).toBe(true);

    const updated = updateWatchRule(rule.id, {
      enabled: false,
      triggerType: 'llm',
      conditionPrompt: '当输出表示构建失败时触发',
      fireMode: 'repeat',
    });
    expect(updated?.enabled).toBe(false);
    expect(updated?.triggerType).toBe('llm');
    expect(updated?.conditionPrompt).toBe('当输出表示构建失败时触发');

    deleteWatchRule(rule.id);
    expect(getWatchRuleById(rule.id)).toBeNull();
  });

  test('state upsert creates then updates, cascades on rule delete', () => {
    const rule = createWatchRule({
      name: 'state watch',
      deviceId: testDeviceId,
      paneId: '%3',
      triggerType: 'unchanged',
      unchangedMinutes: 5,
    });

    expect(getWatchRuleState(rule.id)).toBeNull();

    const created = upsertWatchRuleState(rule.id, {
      lastSampledAt: new Date().toISOString(),
      lastValue: '42%',
    });
    expect(created.lastValue).toBe('42%');
    expect(created.consecutiveErrors).toBe(0);
    expect(created.triggeredSinceChange).toBe(false);

    const updated = upsertWatchRuleState(rule.id, {
      triggeredSinceChange: true,
      consecutiveErrors: 2,
      lastError: 'pane gone',
    });
    expect(updated.lastValue).toBe('42%');
    expect(updated.triggeredSinceChange).toBe(true);
    expect(updated.consecutiveErrors).toBe(2);

    deleteWatchRule(rule.id);
    expect(getWatchRuleState(rule.id)).toBeNull();
  });
});
