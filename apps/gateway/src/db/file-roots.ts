import { asc, eq, max } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { getDb as getOrmDb } from './client';
import { fileRoots } from './schema';

export interface FileRootRecord {
  id: string;
  deviceId: string;
  path: string;
  enabled: boolean;
  sortOrder: number;
  createdAt: string;
}

export function getFileRoots(): FileRootRecord[] {
  const orm = getOrmDb();
  return orm.select().from(fileRoots).orderBy(asc(fileRoots.sortOrder), asc(fileRoots.path)).all();
}

export function getFileRootById(id: string): FileRootRecord | null {
  const orm = getOrmDb();
  return orm.select().from(fileRoots).where(eq(fileRoots.id, id)).get() ?? null;
}

export interface CreateFileRootInput {
  deviceId: string;
  path: string;
  enabled?: boolean;
}

export function createFileRoot(input: CreateFileRootInput): FileRootRecord {
  const orm = getOrmDb();
  const maxRow = orm
    .select({ value: max(fileRoots.sortOrder) })
    .from(fileRoots)
    .get();
  const record: FileRootRecord = {
    id: uuidv4(),
    deviceId: input.deviceId,
    path: input.path,
    enabled: input.enabled ?? true,
    sortOrder: (maxRow?.value ?? -1) + 1,
    createdAt: new Date().toISOString(),
  };
  orm.insert(fileRoots).values(record).run();
  return record;
}

export interface UpdateFileRootInput {
  path?: string;
  enabled?: boolean;
  sortOrder?: number;
}

export function updateFileRoot(id: string, updates: UpdateFileRootInput): FileRootRecord | null {
  const current = getFileRootById(id);
  if (!current) return null;
  const next: FileRootRecord = {
    ...current,
    path: updates.path ?? current.path,
    enabled: updates.enabled ?? current.enabled,
    sortOrder: updates.sortOrder ?? current.sortOrder,
  };
  const orm = getOrmDb();
  orm
    .update(fileRoots)
    .set({ path: next.path, enabled: next.enabled, sortOrder: next.sortOrder })
    .where(eq(fileRoots.id, id))
    .run();
  return next;
}

export function deleteFileRoot(id: string): boolean {
  const orm = getOrmDb();
  const existing = orm
    .select({ id: fileRoots.id })
    .from(fileRoots)
    .where(eq(fileRoots.id, id))
    .get();
  if (!existing) return false;
  orm.delete(fileRoots).where(eq(fileRoots.id, id)).run();
  return true;
}
