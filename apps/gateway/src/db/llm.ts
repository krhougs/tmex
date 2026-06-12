import { desc, eq } from 'drizzle-orm';
import { getDb as getOrmDb } from './client';
import { llmProviders } from './schema';

export type LlmProviderRecord = typeof llmProviders.$inferSelect;
export type LlmProviderProtocol = 'openai-chat' | 'openai-responses';

export interface CreateLlmProviderInput {
  name: string;
  protocol: LlmProviderProtocol;
  baseUrl: string;
  apiKeyEnc: string;
  enabled?: boolean;
}

export type UpdateLlmProviderInput = Partial<
  Pick<
    LlmProviderRecord,
    'name' | 'protocol' | 'baseUrl' | 'apiKeyEnc' | 'enabled' | 'modelsCache' | 'modelsFetchedAt'
  >
>;

export function createLlmProvider(input: CreateLlmProviderInput): LlmProviderRecord {
  const orm = getOrmDb();
  const now = new Date().toISOString();
  const row: typeof llmProviders.$inferInsert = {
    id: crypto.randomUUID(),
    name: input.name,
    protocol: input.protocol,
    baseUrl: input.baseUrl,
    apiKeyEnc: input.apiKeyEnc,
    enabled: input.enabled ?? true,
    modelsCache: null,
    modelsFetchedAt: null,
    createdAt: now,
    updatedAt: now,
  };

  orm.insert(llmProviders).values(row).run();
  const created = getLlmProviderById(row.id);
  if (!created) {
    throw new Error('failed to create llm provider');
  }
  return created;
}

export function getLlmProviderById(id: string): LlmProviderRecord | null {
  const orm = getOrmDb();
  return orm.select().from(llmProviders).where(eq(llmProviders.id, id)).get() ?? null;
}

export function getAllLlmProviders(): LlmProviderRecord[] {
  const orm = getOrmDb();
  return orm.select().from(llmProviders).orderBy(desc(llmProviders.createdAt)).all();
}

export function updateLlmProvider(
  id: string,
  updates: UpdateLlmProviderInput
): LlmProviderRecord | null {
  const orm = getOrmDb();
  const setValues: Partial<typeof llmProviders.$inferInsert> = {
    updatedAt: new Date().toISOString(),
  };

  if (updates.name !== undefined) {
    setValues.name = updates.name;
  }
  if (updates.protocol !== undefined) {
    setValues.protocol = updates.protocol;
  }
  if (updates.baseUrl !== undefined) {
    setValues.baseUrl = updates.baseUrl;
  }
  if (updates.apiKeyEnc !== undefined) {
    setValues.apiKeyEnc = updates.apiKeyEnc;
  }
  if (updates.enabled !== undefined) {
    setValues.enabled = updates.enabled;
  }
  if (updates.modelsCache !== undefined) {
    setValues.modelsCache = updates.modelsCache;
  }
  if (updates.modelsFetchedAt !== undefined) {
    setValues.modelsFetchedAt = updates.modelsFetchedAt;
  }

  orm.update(llmProviders).set(setValues).where(eq(llmProviders.id, id)).run();
  return getLlmProviderById(id);
}

export function deleteLlmProvider(id: string): void {
  const orm = getOrmDb();
  orm.delete(llmProviders).where(eq(llmProviders.id, id)).run();
}
