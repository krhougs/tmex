import { resolve } from 'node:path';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { getDb } from './client';

const migrationsFolder = resolve(import.meta.dir, '../../drizzle');

export function runMigrations(): void {
  migrate(getDb(), { migrationsFolder });
}

if (import.meta.main) {
  runMigrations();
  console.log(`[db] migrations applied from ${migrationsFolder}`);
}
