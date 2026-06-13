import { Database } from 'bun:sqlite';
import { drizzle, type BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { config } from '../config';
import * as schema from './schema';

let sqliteClient: Database | null = null;
let db: BunSQLiteDatabase<typeof schema> | null = null;

export function applyPragmas(database: Database): void {
  database.run('PRAGMA foreign_keys = ON');
  database.run('PRAGMA journal_mode = WAL');
  database.run('PRAGMA busy_timeout = 5000');
  database.run('PRAGMA synchronous = NORMAL');
}

function ensureSqliteClient(): Database {
  if (!sqliteClient) {
    sqliteClient = new Database(config.databaseUrl);
    applyPragmas(sqliteClient);
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
