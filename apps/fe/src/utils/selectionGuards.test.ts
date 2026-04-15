import { describe, expect, test } from 'bun:test';

import {
  PENDING_USER_SELECTION_TTL_MS,
  resolvePendingUserSelection,
  shouldIgnoreActivePaneEvent,
  shouldSkipSnapshotFollow,
  shouldTrackPendingRouteSelection,
} from './selectionGuards';

describe('selectionGuards', () => {
  test('shouldIgnoreActivePaneEvent ignores stale active events that conflict with pending user selection', () => {
    expect(
      shouldIgnoreActivePaneEvent({
        now: 5_000,
        pendingUserSelection: { windowId: '@23', paneId: '%25', at: 4_000 },
        activePaneFromEvent: { windowId: '@1', paneId: '%1' },
        currentRoute: { windowId: '@23', paneId: '%25' },
        recentSelectRequests: [],
        lastHandledActive: null,
      })
    ).toBe(true);
  });

  test('shouldIgnoreActivePaneEvent allows confirmation event for pending user selection', () => {
    expect(
      shouldIgnoreActivePaneEvent({
        now: 5_000,
        pendingUserSelection: { windowId: '@23', paneId: '%25', at: 4_000 },
        activePaneFromEvent: { windowId: '@23', paneId: '%25' },
        currentRoute: { windowId: '@23', paneId: '%25' },
        recentSelectRequests: [],
        lastHandledActive: null,
      })
    ).toBe(true);

    expect(
      shouldIgnoreActivePaneEvent({
        now: 5_000,
        pendingUserSelection: { windowId: '@23', paneId: '%25', at: 4_000 },
        activePaneFromEvent: { windowId: '@23', paneId: '%25' },
        currentRoute: { windowId: '@1', paneId: '%1' },
        recentSelectRequests: [],
        lastHandledActive: null,
      })
    ).toBe(false);
  });

  test('shouldSkipSnapshotFollow blocks fallback while pending user selection is still in flight', () => {
    expect(
      shouldSkipSnapshotFollow({
        now: 5_000,
        pendingUserSelection: { windowId: '@23', paneId: '%25', at: 4_000 },
        snapshotActive: { windowId: '@1', paneId: '%1' },
        recentSelectRequests: [],
      })
    ).toBe(true);

    expect(
      shouldSkipSnapshotFollow({
        now: 5_000,
        pendingUserSelection: { windowId: '@23', paneId: '%25', at: 4_000 },
        snapshotActive: { windowId: '@23', paneId: '%25' },
        recentSelectRequests: [],
      })
    ).toBe(false);
  });

  test('shouldSkipSnapshotFollow ignores stale snapshots that conflict with the most recent select request', () => {
    expect(
      shouldSkipSnapshotFollow({
        now: 5_000,
        pendingUserSelection: null,
        snapshotActive: { windowId: '@1', paneId: '%1' },
        recentSelectRequests: [{ windowId: '@23', paneId: '%25', at: 4_500 }],
      })
    ).toBe(true);

    expect(
      shouldSkipSnapshotFollow({
        now: 5_000,
        pendingUserSelection: null,
        snapshotActive: { windowId: '@23', paneId: '%25' },
        recentSelectRequests: [{ windowId: '@23', paneId: '%25', at: 4_500 }],
      })
    ).toBe(false);
  });

  test('resolvePendingUserSelection drops expired selections', () => {
    expect(
      resolvePendingUserSelection(
        { windowId: '@23', paneId: '%25', at: 1_000 },
        1_000 + PENDING_USER_SELECTION_TTL_MS - 1
      )
    ).toEqual({ windowId: '@23', paneId: '%25', at: 1_000 });

    expect(
      resolvePendingUserSelection(
        { windowId: '@23', paneId: '%25', at: 1_000 },
        1_000 + PENDING_USER_SELECTION_TTL_MS + 1
      )
    ).toBeNull();
  });

  test('shouldTrackPendingRouteSelection keeps explicit route authoritative until snapshot catches up', () => {
    expect(
      shouldTrackPendingRouteSelection({
        routeTarget: { windowId: '@1', paneId: '%1' },
        snapshotActive: { windowId: '@23', paneId: '%25' },
        pendingUserSelection: null,
      })
    ).toBe(true);

    expect(
      shouldTrackPendingRouteSelection({
        routeTarget: { windowId: '@1', paneId: '%1' },
        snapshotActive: { windowId: '@1', paneId: '%1' },
        pendingUserSelection: null,
      })
    ).toBe(false);

    expect(
      shouldTrackPendingRouteSelection({
        routeTarget: { windowId: '@1', paneId: '%1' },
        snapshotActive: { windowId: '@23', paneId: '%25' },
        pendingUserSelection: { windowId: '@1', paneId: '%1', at: 4_000 },
        now: 5_000,
      })
    ).toBe(false);
  });

  test('shouldIgnoreActivePaneEvent ignores stale events that conflict with the most recent select request', () => {
    expect(
      shouldIgnoreActivePaneEvent({
        now: 5_000,
        pendingUserSelection: null,
        activePaneFromEvent: { windowId: '@1', paneId: '%1' },
        currentRoute: { windowId: '@23', paneId: '%25' },
        recentSelectRequests: [{ windowId: '@23', paneId: '%25', at: 4_500 }],
        lastHandledActive: null,
      })
    ).toBe(true);
  });
});
