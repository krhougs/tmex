import { describe, expect, test } from 'bun:test';
import {
  shouldApplyRemotePaneSize,
  shouldForceLocalSizeSync,
  shouldSyncOnViewportRestore,
} from './resizeSyncGuards';

describe('resizeSyncGuards', () => {
  test('shouldApplyRemotePaneSize allows remote size when there is no pending local resize', () => {
    expect(
      shouldApplyRemotePaneSize({
        now: 5_000,
        remoteSize: { cols: 132, rows: 45 },
        pendingLocalSize: null,
      })
    ).toBe(true);
  });

  test('shouldApplyRemotePaneSize rejects stale remote size while recent local resize is pending', () => {
    expect(
      shouldApplyRemotePaneSize({
        now: 5_000,
        remoteSize: { cols: 132, rows: 45 },
        pendingLocalSize: { cols: 449, rows: 133, at: 4_200 },
      })
    ).toBe(false);
  });

  test('shouldApplyRemotePaneSize allows remote size once it catches up with pending local resize', () => {
    expect(
      shouldApplyRemotePaneSize({
        now: 5_000,
        remoteSize: { cols: 449, rows: 133 },
        pendingLocalSize: { cols: 449, rows: 133, at: 4_200 },
      })
    ).toBe(true);
  });

  test('shouldApplyRemotePaneSize allows remote size after pending local resize expires', () => {
    expect(
      shouldApplyRemotePaneSize({
        now: 7_500,
        remoteSize: { cols: 132, rows: 45 },
        pendingLocalSize: { cols: 449, rows: 133, at: 4_200 },
      })
    ).toBe(true);
  });

  test('shouldForceLocalSizeSync does not request another local sync when stale remote size arrives', () => {
    expect(
      shouldForceLocalSizeSync({
        now: 5_000,
        remoteSize: { cols: 132, rows: 45 },
        pendingLocalSize: { cols: 449, rows: 133, at: 4_200 },
        containerSize: { cols: 449, rows: 133 },
      })
    ).toBe(false);
  });

  test('shouldForceLocalSizeSync stays quiet when container no longer matches pending local size', () => {
    expect(
      shouldForceLocalSizeSync({
        now: 5_000,
        remoteSize: { cols: 132, rows: 45 },
        pendingLocalSize: { cols: 449, rows: 133, at: 4_200 },
        containerSize: { cols: 132, rows: 45 },
      })
    ).toBe(false);
  });

  test('shouldSyncOnViewportRestore requests one sync when current xterm size is stale against container', () => {
    expect(
      shouldSyncOnViewportRestore({
        currentSize: { cols: 90, rows: 30 },
        containerSize: { cols: 120, rows: 40 },
      })
    ).toBe(true);
  });

  test('shouldSyncOnViewportRestore stays quiet when xterm already matches container', () => {
    expect(
      shouldSyncOnViewportRestore({
        currentSize: { cols: 120, rows: 40 },
        containerSize: { cols: 120, rows: 40 },
      })
    ).toBe(false);
  });

  test('shouldSyncOnViewportRestore can force one resync even when xterm already matches container', () => {
    expect(
      shouldSyncOnViewportRestore({
        currentSize: { cols: 120, rows: 40 },
        containerSize: { cols: 120, rows: 40 },
        force: true,
      })
    ).toBe(true);
  });
});
