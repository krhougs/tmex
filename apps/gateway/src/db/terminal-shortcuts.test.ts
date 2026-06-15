import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { DEFAULT_TERMINAL_SHORTCUTS } from '@tmex/shared';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';

const migrationsFolder = resolve(import.meta.dir, '../../drizzle');

function freshDb(): Database {
  const db = new Database(':memory:');
  db.run('PRAGMA foreign_keys = ON');
  migrate(drizzle(db), { migrationsFolder });
  return db;
}

describe('terminal_shortcut_settings migration', () => {
  test('迁移后存在默认单例行，包含全部默认快捷键', () => {
    const db = freshDb();
    const row = db
      .query('SELECT id, items, use_icons FROM terminal_shortcut_settings WHERE id = 1')
      .get() as { id: number; items: string; use_icons: number } | null;

    expect(row).not.toBeNull();
    expect(row?.id).toBe(1);
    expect(row?.use_icons).toBe(0);

    const items = JSON.parse(row?.items ?? '[]');
    expect(items).toHaveLength(DEFAULT_TERMINAL_SHORTCUTS.length);
    expect(items).toEqual(DEFAULT_TERMINAL_SHORTCUTS);
    db.close();
  });

  test('单例 check 约束禁止 id != 1', () => {
    const db = freshDb();
    expect(() =>
      db.run(
        "INSERT INTO terminal_shortcut_settings (id, items, use_icons, updated_at) VALUES (2, '[]', 0, 'x')"
      )
    ).toThrow();
    db.close();
  });

  test('JSON 列往返：写入自定义 items 后能读回', () => {
    const db = freshDb();
    const custom = JSON.stringify([{ id: 'x', type: 'send', label: 'Z', payload: 'z' }]);
    db.run('UPDATE terminal_shortcut_settings SET items = ?, use_icons = 1 WHERE id = 1', [custom]);

    const row = db
      .query('SELECT items, use_icons FROM terminal_shortcut_settings WHERE id = 1')
      .get() as { items: string; use_icons: number };

    expect(JSON.parse(row.items)).toEqual([{ id: 'x', type: 'send', label: 'Z', payload: 'z' }]);
    expect(row.use_icons).toBe(1);
    db.close();
  });
});
