import { describe, expect, test } from 'bun:test';
import {
  quoteTerminalPath,
  resolveTerminalFilePasteTarget,
  resolveTerminalFileRoute,
  selectNativeTerminalPaths,
  terminalFileNeedsSafetyConfirmation,
} from './terminal-file-input';

describe('terminal file input', () => {
  test('uses the most specific writable root for transferred files', () => {
    expect(
      resolveTerminalFilePasteTarget('/workspace/project/src', [
        { id: 'workspace', path: '/workspace' },
        { id: 'project', path: '/workspace/project' },
      ])
    ).toEqual({ rootId: 'project', directory: '/workspace/project/src' });
    expect(resolveTerminalFilePasteTarget('/outside', [{ id: 'root', path: '/workspace' }])).toBe(
      null
    );
  });

  test('uses a direct path only for trusted native files on the local instance', () => {
    expect(resolveTerminalFileRoute(false, true)).toBe('upload');
    expect(resolveTerminalFileRoute(true, false)).toBe('upload');
    expect(resolveTerminalFileRoute(true, true)).toBe('local-path');
  });

  test('local terminals accept every path while remote terminals accept uploadable files only', () => {
    const entries = [
      {
        path: '/tmp/readme.txt',
        name: 'readme.txt',
        size: 4,
        kind: 'file',
        uploadAllowed: true,
      },
      {
        path: '/tmp/folder',
        name: 'folder',
        size: 0,
        kind: 'directory',
        uploadAllowed: false,
      },
      {
        path: '/tmp/private.bin',
        name: 'private.bin',
        size: 8,
        kind: 'file',
        uploadAllowed: false,
      },
      {
        path: '/tmp/missing',
        name: 'missing',
        size: 0,
        kind: 'unknown',
        uploadAllowed: false,
      },
    ] as const;

    expect(selectNativeTerminalPaths(entries, true)).toEqual({
      accepted: [...entries],
      directoryCount: 0,
      unavailableCount: 0,
    });
    expect(selectNativeTerminalPaths(entries, false)).toEqual({
      accepted: [entries[0]],
      directoryCount: 1,
      unavailableCount: 2,
    });
  });

  test('quotes every path as inert shell input', () => {
    expect(quoteTerminalPath("/tmp/user's file.txt")).toBe("'/tmp/user'\\''s file.txt'");
  });

  test('allows images and common text while warning for unknown or executable formats', () => {
    expect(terminalFileNeedsSafetyConfirmation('photo.png', '')).toBe(false);
    expect(terminalFileNeedsSafetyConfirmation('script-without-ext', 'text/plain')).toBe(false);
    expect(terminalFileNeedsSafetyConfirmation('settings.json', 'application/octet-stream')).toBe(
      false
    );
    expect(terminalFileNeedsSafetyConfirmation('.env.local', '')).toBe(false);
    expect(terminalFileNeedsSafetyConfirmation('archive.zip', 'application/zip')).toBe(true);
    expect(terminalFileNeedsSafetyConfirmation('installer.exe', 'application/octet-stream')).toBe(
      true
    );
    expect(terminalFileNeedsSafetyConfirmation('unknown', '')).toBe(true);
  });
});
