import { desc, eq } from 'drizzle-orm';
import { getDb as getOrmDb } from './client';
import { type LlmProviderProtocol, llmProviders } from './schema';

export type LlmProviderRecord = typeof llmProviders.$inferSelect;
export type { LlmProviderProtocol } from './schema';

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
    | 'name'
    | 'protocol'
    | 'baseUrl'
    | 'apiKeyEnc'
    | 'enabled'
    | 'modelsCache'
    | 'modelsFetchedAt'
    | 'manualModels'
    | 'disabledModels'
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
    manualModels: [],
    disabledModels: [],
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
  if (updates.manualModels !== undefined) {
    setValues.manualModels = updates.manualModels;
  }
  if (updates.disabledModels !== undefined) {
    setValues.disabledModels = updates.disabledModels;
  }

  orm.update(llmProviders).set(setValues).where(eq(llmProviders.id, id)).run();
  return getLlmProviderById(id);
}

export function deleteLlmProvider(id: string): void {
  const orm = getOrmDb();
  orm.delete(llmProviders).where(eq(llmProviders.id, id)).run();
}

export interface ProviderModelInfo {
  id: string;
  source: 'fetched' | 'manual';
  enabled: boolean;
}

/**
 * 计算 provider 的模型视图：
 * - modelDetails：拉取模型 ∪ 手动模型（去重，手动优先标记 source=manual），含 enabled（不在 disabled 列表）
 * - effective：启用的模型 id（供 Agent/默认模型选择器）
 */
export function computeProviderModels(record: LlmProviderRecord): {
  effective: string[];
  modelDetails: ProviderModelInfo[];
} {
  const fetched = record.modelsCache ?? [];
  const manual = record.manualModels ?? [];
  const disabled = new Set(record.disabledModels ?? []);

  const seen = new Set<string>();
  const modelDetails: ProviderModelInfo[] = [];
  for (const id of fetched) {
    if (seen.has(id)) continue;
    seen.add(id);
    modelDetails.push({ id, source: 'fetched', enabled: !disabled.has(id) });
  }
  for (const id of manual) {
    if (seen.has(id)) continue;
    seen.add(id);
    modelDetails.push({ id, source: 'manual', enabled: !disabled.has(id) });
  }
  modelDetails.sort((a, b) => a.id.localeCompare(b.id));

  const effective = modelDetails.filter((m) => m.enabled).map((m) => m.id);
  return { effective, modelDetails };
}
