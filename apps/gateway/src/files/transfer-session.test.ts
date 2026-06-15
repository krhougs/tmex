import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendUploadChunk,
  createUploadSession,
  getUploadSession,
  removeUploadSession,
  sweepOrphanTransferTemps,
} from './transfer-session';

describe('upload session chunking', () => {
  test('sequential append; rejects bad offset / overflow / missing session', () => {
    const s = createUploadSession({ rootId: 'r', destDir: '/d', name: 'a.txt', size: 6 });
    expect(existsSync(s.tmpPath)).toBe(true);

    expect(appendUploadChunk(s.id, 0, new Uint8Array([1, 2, 3]))).toEqual({
      ok: true,
      received: 3,
    });
    // 非顺序 offset 被拒
    expect(appendUploadChunk(s.id, 0, new Uint8Array([9]))).toEqual({
      ok: false,
      reason: 'bad_offset',
    });
    // 超出声明 size 被拒
    expect(appendUploadChunk(s.id, 3, new Uint8Array([4, 5, 6, 7]))).toEqual({
      ok: false,
      reason: 'too_large',
    });
    // 正确补齐
    expect(appendUploadChunk(s.id, 3, new Uint8Array([4, 5, 6]))).toEqual({
      ok: true,
      received: 6,
    });
    expect(getUploadSession(s.id)?.received).toBe(6);

    const tmpDir = s.tmpDir;
    removeUploadSession(s.id);
    expect(getUploadSession(s.id)).toBeUndefined();
    expect(existsSync(tmpDir)).toBe(false);
    expect(appendUploadChunk(s.id, 0, new Uint8Array([1]))).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });

  test('sweepOrphanTransferTemps 仅清理超期的传输临时目录', () => {
    const oldDir = mkdtempSync(join(tmpdir(), 'tmex-up-'));
    const freshDir = mkdtempSync(join(tmpdir(), 'tmex-dl-'));
    const unrelated = mkdtempSync(join(tmpdir(), 'tmex-keep-'));
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2h 前
    utimesSync(oldDir, old, old);
    try {
      sweepOrphanTransferTemps();
      expect(existsSync(oldDir)).toBe(false); // 超期 → 清理
      expect(existsSync(freshDir)).toBe(true); // 新建 → 保留
      expect(existsSync(unrelated)).toBe(true); // 非传输前缀 → 不动
    } finally {
      rmSync(freshDir, { recursive: true, force: true });
      rmSync(unrelated, { recursive: true, force: true });
      rmSync(oldDir, { recursive: true, force: true });
    }
  });
});
