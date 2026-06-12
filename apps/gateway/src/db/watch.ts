import { desc, eq } from 'drizzle-orm';
import { getDb as getOrmDb } from './client';
import {
  type WatchFireMode,
  type WatchNoMatchBehavior,
  type WatchTriggerType,
  watchRuleState,
  watchRules,
} from './schema';

export type WatchRuleRecord = typeof watchRules.$inferSelect;
export type WatchRuleStateRecord = typeof watchRuleState.$inferSelect;

export type { WatchFireMode, WatchNoMatchBehavior, WatchTriggerType } from './schema';

export interface CreateWatchRuleInput {
  name: string;
  deviceId: string;
  paneId: string;
  enabled?: boolean;
  triggerType: WatchTriggerType;
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

export function createWatchRule(input: CreateWatchRuleInput): WatchRuleRecord {
  const orm = getOrmDb();
  const now = new Date().toISOString();
  const row: typeof watchRules.$inferInsert = {
    id: crypto.randomUUID(),
    name: input.name,
    deviceId: input.deviceId,
    paneId: input.paneId,
    enabled: input.enabled ?? true,
    triggerType: input.triggerType,
    pattern: input.pattern ?? null,
    patternFlags: input.patternFlags ?? '',
    extractGroup: input.extractGroup ?? 0,
    conditionPrompt: input.conditionPrompt ?? null,
    providerId: input.providerId ?? null,
    modelId: input.modelId ?? null,
    confirmWithLlm: input.confirmWithLlm ?? false,
    summarizeWithLlm: input.summarizeWithLlm ?? false,
    intervalSeconds: input.intervalSeconds ?? 30,
    unchangedMinutes: input.unchangedMinutes ?? null,
    noMatchBehavior: input.noMatchBehavior ?? 'reset',
    fireMode: input.fireMode ?? 'once',
    cooldownSeconds: input.cooldownSeconds ?? 600,
    createdAt: now,
    updatedAt: now,
  };

  orm.insert(watchRules).values(row).run();
  const created = getWatchRuleById(row.id);
  if (!created) {
    throw new Error('failed to create watch rule');
  }
  return created;
}

export function getWatchRuleById(id: string): WatchRuleRecord | null {
  const orm = getOrmDb();
  return orm.select().from(watchRules).where(eq(watchRules.id, id)).get() ?? null;
}

export function getAllWatchRules(): WatchRuleRecord[] {
  const orm = getOrmDb();
  return orm.select().from(watchRules).orderBy(desc(watchRules.createdAt)).all();
}

export function getEnabledWatchRules(): WatchRuleRecord[] {
  const orm = getOrmDb();
  return orm
    .select()
    .from(watchRules)
    .where(eq(watchRules.enabled, true))
    .orderBy(desc(watchRules.createdAt))
    .all();
}

export function listWatchRulesByDevice(deviceId: string): WatchRuleRecord[] {
  const orm = getOrmDb();
  return orm
    .select()
    .from(watchRules)
    .where(eq(watchRules.deviceId, deviceId))
    .orderBy(desc(watchRules.createdAt))
    .all();
}

export function updateWatchRule(
  id: string,
  updates: Partial<Omit<WatchRuleRecord, 'id' | 'createdAt' | 'updatedAt'>>
): WatchRuleRecord | null {
  const orm = getOrmDb();
  const setValues: Partial<typeof watchRules.$inferInsert> = {
    updatedAt: new Date().toISOString(),
  };

  for (const key of [
    'name',
    'deviceId',
    'paneId',
    'enabled',
    'triggerType',
    'pattern',
    'patternFlags',
    'extractGroup',
    'conditionPrompt',
    'providerId',
    'modelId',
    'confirmWithLlm',
    'summarizeWithLlm',
    'intervalSeconds',
    'unchangedMinutes',
    'noMatchBehavior',
    'fireMode',
    'cooldownSeconds',
  ] as const) {
    if (updates[key] !== undefined) {
      (setValues as Record<string, unknown>)[key] = updates[key];
    }
  }

  orm.update(watchRules).set(setValues).where(eq(watchRules.id, id)).run();
  return getWatchRuleById(id);
}

export function deleteWatchRule(id: string): void {
  const orm = getOrmDb();
  orm.delete(watchRules).where(eq(watchRules.id, id)).run();
}

export function getWatchRuleState(ruleId: string): WatchRuleStateRecord | null {
  const orm = getOrmDb();
  return orm.select().from(watchRuleState).where(eq(watchRuleState.ruleId, ruleId)).get() ?? null;
}

export function upsertWatchRuleState(
  ruleId: string,
  updates: Partial<Omit<WatchRuleStateRecord, 'ruleId'>>
): WatchRuleStateRecord {
  const orm = getOrmDb();
  const setValues: Partial<typeof watchRuleState.$inferInsert> = {};

  for (const key of [
    'lastSampledAt',
    'lastValue',
    'lastValueChangedAt',
    'triggeredSinceChange',
    'lastTriggeredAt',
    'consecutiveErrors',
    'lastError',
    'modelUnavailableNotified',
  ] as const) {
    if (updates[key] !== undefined) {
      (setValues as Record<string, unknown>)[key] = updates[key];
    }
  }

  if (Object.keys(setValues).length === 0) {
    orm
      .insert(watchRuleState)
      .values({ ruleId })
      .onConflictDoNothing({ target: watchRuleState.ruleId })
      .run();
  } else {
    orm
      .insert(watchRuleState)
      .values({ ruleId, ...setValues })
      .onConflictDoUpdate({ target: watchRuleState.ruleId, set: setValues })
      .run();
  }

  const state = getWatchRuleState(ruleId);
  if (!state) {
    throw new Error('failed to upsert watch rule state');
  }
  return state;
}
