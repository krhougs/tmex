import { and, asc, desc, eq, gt, max } from 'drizzle-orm';
import { getDb as getOrmDb } from './client';
import {
  type AgentConfirmationStatus,
  type AgentMessageRole,
  type AgentSessionStatus,
  type AgentWriteMode,
  agentConfirmations,
  agentMessages,
  agentSessions,
  agentSettings,
} from './schema';

export type AgentSettingsRecord = typeof agentSettings.$inferSelect;
export type AgentSessionRecord = typeof agentSessions.$inferSelect;
export type AgentMessageRecord = typeof agentMessages.$inferSelect;
export type AgentConfirmationRecord = typeof agentConfirmations.$inferSelect;

export type {
  AgentConfirmationStatus,
  AgentMessageRole,
  AgentSearchProvider,
  AgentSessionStatus,
  AgentWriteMode,
} from './schema';

export function ensureAgentSettingsInitialized(): void {
  const orm = getOrmDb();

  orm
    .insert(agentSettings)
    .values({
      id: 1,
      searchProvider: 'none',
      tavilyApiKeyEnc: null,
      braveApiKeyEnc: null,
      defaultProviderId: null,
      defaultModelId: null,
      updatedAt: new Date().toISOString(),
    })
    .onConflictDoNothing({ target: agentSettings.id })
    .run();
}

export function getAgentSettings(): AgentSettingsRecord {
  const orm = getOrmDb();
  let row = orm.select().from(agentSettings).where(eq(agentSettings.id, 1)).get();

  if (!row) {
    ensureAgentSettingsInitialized();
    row = orm.select().from(agentSettings).where(eq(agentSettings.id, 1)).get();
  }

  if (!row) {
    throw new Error('agent_settings not initialized');
  }

  return row;
}

export function updateAgentSettings(
  updates: Partial<Omit<AgentSettingsRecord, 'id' | 'updatedAt'>>
): AgentSettingsRecord {
  getAgentSettings();

  const orm = getOrmDb();
  const setValues: Partial<typeof agentSettings.$inferInsert> = {
    updatedAt: new Date().toISOString(),
  };

  if (updates.searchProvider !== undefined) {
    setValues.searchProvider = updates.searchProvider;
  }
  if (updates.tavilyApiKeyEnc !== undefined) {
    setValues.tavilyApiKeyEnc = updates.tavilyApiKeyEnc;
  }
  if (updates.braveApiKeyEnc !== undefined) {
    setValues.braveApiKeyEnc = updates.braveApiKeyEnc;
  }
  if (updates.defaultProviderId !== undefined) {
    setValues.defaultProviderId = updates.defaultProviderId;
  }
  if (updates.defaultModelId !== undefined) {
    setValues.defaultModelId = updates.defaultModelId;
  }

  orm.update(agentSettings).set(setValues).where(eq(agentSettings.id, 1)).run();
  return getAgentSettings();
}

export interface CreateAgentSessionInput {
  title: string;
  deviceId?: string | null;
  paneId?: string | null;
  providerId?: string | null;
  modelId: string;
  systemPrompt?: string | null;
  writeMode?: AgentWriteMode;
  useProviderWebSearch?: boolean;
  maxStepsPerTurn?: number;
}

export function createAgentSession(input: CreateAgentSessionInput): AgentSessionRecord {
  const orm = getOrmDb();
  const now = new Date().toISOString();
  const row: typeof agentSessions.$inferInsert = {
    id: crypto.randomUUID(),
    title: input.title,
    deviceId: input.deviceId ?? null,
    paneId: input.paneId ?? null,
    providerId: input.providerId ?? null,
    modelId: input.modelId,
    systemPrompt: input.systemPrompt ?? null,
    writeMode: input.writeMode ?? 'confirm',
    useProviderWebSearch: input.useProviderWebSearch ?? false,
    status: 'idle',
    lastError: null,
    maxStepsPerTurn: input.maxStepsPerTurn ?? 25,
    createdAt: now,
    updatedAt: now,
  };

  orm.insert(agentSessions).values(row).run();
  const created = getAgentSessionById(row.id);
  if (!created) {
    throw new Error('failed to create agent session');
  }
  return created;
}

export function getAgentSessionById(id: string): AgentSessionRecord | null {
  const orm = getOrmDb();
  return orm.select().from(agentSessions).where(eq(agentSessions.id, id)).get() ?? null;
}

export function getAllAgentSessions(): AgentSessionRecord[] {
  const orm = getOrmDb();
  return orm.select().from(agentSessions).orderBy(desc(agentSessions.updatedAt)).all();
}

export function getAgentSessionsByStatus(status: AgentSessionStatus): AgentSessionRecord[] {
  const orm = getOrmDb();
  return orm
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.status, status))
    .orderBy(desc(agentSessions.updatedAt))
    .all();
}

export function updateAgentSession(
  id: string,
  updates: Partial<Omit<AgentSessionRecord, 'id' | 'createdAt' | 'updatedAt'>>
): AgentSessionRecord | null {
  const orm = getOrmDb();
  const setValues: Partial<typeof agentSessions.$inferInsert> = {
    updatedAt: new Date().toISOString(),
  };

  for (const key of [
    'title',
    'deviceId',
    'paneId',
    'providerId',
    'modelId',
    'systemPrompt',
    'writeMode',
    'useProviderWebSearch',
    'status',
    'lastError',
    'maxStepsPerTurn',
  ] as const) {
    if (updates[key] !== undefined) {
      (setValues as Record<string, unknown>)[key] = updates[key];
    }
  }

  orm.update(agentSessions).set(setValues).where(eq(agentSessions.id, id)).run();
  return getAgentSessionById(id);
}

export function deleteAgentSession(id: string): void {
  const orm = getOrmDb();
  orm.delete(agentSessions).where(eq(agentSessions.id, id)).run();
}

export function appendAgentMessage(
  sessionId: string,
  role: AgentMessageRole,
  content: unknown
): AgentMessageRecord {
  const orm = getOrmDb();
  const id = crypto.randomUUID();

  orm.transaction((tx) => {
    const current = tx
      .select({ maxSeq: max(agentMessages.seq) })
      .from(agentMessages)
      .where(eq(agentMessages.sessionId, sessionId))
      .get();

    tx.insert(agentMessages)
      .values({
        id,
        sessionId,
        seq: (current?.maxSeq ?? -1) + 1,
        role,
        content,
        createdAt: new Date().toISOString(),
      })
      .run();
  });

  const created = orm.select().from(agentMessages).where(eq(agentMessages.id, id)).get();
  if (!created) {
    throw new Error('failed to append agent message');
  }
  return created;
}

export function listAgentMessages(
  sessionId: string,
  options: { afterSeq?: number } = {}
): AgentMessageRecord[] {
  const orm = getOrmDb();
  const conditions =
    options.afterSeq !== undefined
      ? and(eq(agentMessages.sessionId, sessionId), gt(agentMessages.seq, options.afterSeq))
      : eq(agentMessages.sessionId, sessionId);

  return orm.select().from(agentMessages).where(conditions).orderBy(asc(agentMessages.seq)).all();
}

export function getMaxAgentMessageSeq(sessionId: string): number {
  const orm = getOrmDb();
  const row = orm
    .select({ maxSeq: max(agentMessages.seq) })
    .from(agentMessages)
    .where(eq(agentMessages.sessionId, sessionId))
    .get();
  return row?.maxSeq ?? -1;
}

export interface CreateAgentConfirmationInput {
  sessionId: string;
  toolName: string;
  toolCallId: string;
  inputJson: unknown;
}

export function createAgentConfirmation(
  input: CreateAgentConfirmationInput
): AgentConfirmationRecord {
  const orm = getOrmDb();
  const row: typeof agentConfirmations.$inferInsert = {
    id: crypto.randomUUID(),
    sessionId: input.sessionId,
    toolName: input.toolName,
    toolCallId: input.toolCallId,
    inputJson: input.inputJson,
    status: 'pending',
    reason: null,
    decidedAt: null,
    createdAt: new Date().toISOString(),
  };

  orm.insert(agentConfirmations).values(row).run();
  const created = getAgentConfirmationById(row.id);
  if (!created) {
    throw new Error('failed to create agent confirmation');
  }
  return created;
}

export function getAgentConfirmationById(id: string): AgentConfirmationRecord | null {
  const orm = getOrmDb();
  return orm.select().from(agentConfirmations).where(eq(agentConfirmations.id, id)).get() ?? null;
}

export function listPendingAgentConfirmations(sessionId: string): AgentConfirmationRecord[] {
  const orm = getOrmDb();
  return orm
    .select()
    .from(agentConfirmations)
    .where(
      and(eq(agentConfirmations.sessionId, sessionId), eq(agentConfirmations.status, 'pending'))
    )
    .orderBy(asc(agentConfirmations.createdAt))
    .all();
}

export function decideAgentConfirmation(
  id: string,
  decision: { status: Exclude<AgentConfirmationStatus, 'pending'>; reason?: string | null }
): AgentConfirmationRecord | null {
  const orm = getOrmDb();
  const updated = orm
    .update(agentConfirmations)
    .set({
      status: decision.status,
      reason: decision.reason ?? null,
      decidedAt: new Date().toISOString(),
    })
    .where(and(eq(agentConfirmations.id, id), eq(agentConfirmations.status, 'pending')))
    .returning()
    .get();

  return updated ?? null;
}
