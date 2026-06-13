import { afterAll, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applyPragmas } from './client';

const tmpPath = join(tmpdir(), `tmex-client-test-${process.pid}-${Date.now()}.db`);

afterAll(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      unlinkSync(tmpPath + suffix);
    } catch {
      // 旁文件可能不存在，忽略
    }
  }
});

describe('applyPragmas', () => {
  it('设置 WAL / busy_timeout / foreign_keys / synchronous', () => {
    const db = new Database(tmpPath);
    try {
      applyPragmas(db);

      expect(db.query('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
      expect(db.query('PRAGMA busy_timeout').get()).toEqual({ timeout: 5000 });
      expect(db.query('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
      expect(db.query('PRAGMA synchronous').get()).toEqual({ synchronous: 1 });
    } finally {
      db.close();
    }
  });
});
