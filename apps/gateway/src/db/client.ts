import { Database } from 'bun:sqlite';
import { drizzle, type BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { config } from '../config';
import * as schema from './schema';

let sqliteClient: Database | null = null;
let db: BunSQLiteDatabase<typeof schema> | null = null;

function ensureSqliteClient(): Database {
  if (!sqliteClient) {
    sqliteClient = new Database(config.databaseUrl);
    sqliteClient.run('PRAGMA foreign_keys = ON');
  }

  return sqliteClient;
}

export function getSqliteClient(): Database {
  return ensureSqliteClient();
}

export function getDb(): BunSQLiteDatabase<typeof schema> {
  if (!db) {
    db = drizzle(ensureSqliteClient(), { schema });
  }

  return db;
}
