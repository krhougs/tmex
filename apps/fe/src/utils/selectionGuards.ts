export interface PaneSelection {
  windowId: string;
  paneId: string;
}

export interface TimedPaneSelection extends PaneSelection {
  at: number;
}

export const RECENT_SELECT_REQUEST_TTL_MS = 1200;
export const PENDING_USER_SELECTION_TTL_MS = 2000;

function matchesPaneSelection(
  left: PaneSelection | null | undefined,
  right: PaneSelection | null | undefined
): boolean {
  if (!left || !right) {
    return false;
  }
  return left.windowId === right.windowId && left.paneId === right.paneId;
}

function hasRecentSelectRequest(
  recentSelectRequests: TimedPaneSelection[],
  target: PaneSelection,
  now: number
): boolean {
  return recentSelectRequests.some(
    (request) =>
      matchesPaneSelection(request, target) && now - request.at < RECENT_SELECT_REQUEST_TTL_MS
  );
}

function getLatestRecentSelectRequest(
  recentSelectRequests: TimedPaneSelection[],
  now: number
): TimedPaneSelection | null {
  const recentRequests = recentSelectRequests.filter(
    (request) => now - request.at < RECENT_SELECT_REQUEST_TTL_MS
  );
  if (recentRequests.length === 0) {
    return null;
  }
  return recentRequests.reduce((latest, request) => (request.at > latest.at ? request : latest));
}

export function resolvePendingUserSelection(
  pendingUserSelection: TimedPaneSelection | null | undefined,
  now = Date.now()
): TimedPaneSelection | null {
  if (!pendingUserSelection) {
    return null;
  }
  if (now - pendingUserSelection.at > PENDING_USER_SELECTION_TTL_MS) {
    return null;
  }
  return pendingUserSelection;
}

export function shouldIgnoreActivePaneEvent(params: {
  now?: number;
  pendingUserSelection: TimedPaneSelection | null | undefined;
  activePaneFromEvent: PaneSelection;
  currentRoute: PaneSelection | null | undefined;
  recentSelectRequests: TimedPaneSelection[];
  lastHandledActive: PaneSelection | null | undefined;
}): boolean {
  const now = params.now ?? Date.now();
  const latestRecentSelectRequest = getLatestRecentSelectRequest(params.recentSelectRequests, now);

  if (
    latestRecentSelectRequest &&
    !matchesPaneSelection(latestRecentSelectRequest, params.activePaneFromEvent)
  ) {
    return true;
  }

  if (matchesPaneSelection(params.currentRoute, params.activePaneFromEvent)) {
    return true;
  }

  if (matchesPaneSelection(params.lastHandledActive, params.activePaneFromEvent)) {
    return true;
  }

  const pendingUserSelection = resolvePendingUserSelection(params.pendingUserSelection, now);
  if (
    pendingUserSelection &&
    !matchesPaneSelection(pendingUserSelection, params.activePaneFromEvent)
  ) {
    return true;
  }

  return false;
}

export function shouldSkipSnapshotFollow(params: {
  now?: number;
  pendingUserSelection: TimedPaneSelection | null | undefined;
  snapshotActive: PaneSelection;
  recentSelectRequests: TimedPaneSelection[];
}): boolean {
  const now = params.now ?? Date.now();
  const latestRecentSelectRequest = getLatestRecentSelectRequest(params.recentSelectRequests, now);

  const pendingUserSelection = resolvePendingUserSelection(params.pendingUserSelection, now);
  if (pendingUserSelection && !matchesPaneSelection(pendingUserSelection, params.snapshotActive)) {
    return true;
  }

  if (
    latestRecentSelectRequest &&
    !matchesPaneSelection(latestRecentSelectRequest, params.snapshotActive)
  ) {
    return true;
  }

  return false;
}

export function shouldTrackPendingRouteSelection(params: {
  now?: number;
  routeTarget: PaneSelection;
  snapshotActive: PaneSelection | null | undefined;
  pendingUserSelection: TimedPaneSelection | null | undefined;
}): boolean {
  const now = params.now ?? Date.now();
  const pendingUserSelection = resolvePendingUserSelection(params.pendingUserSelection, now);

  if (pendingUserSelection && matchesPaneSelection(pendingUserSelection, params.routeTarget)) {
    return false;
  }

  if (params.snapshotActive && matchesPaneSelection(params.snapshotActive, params.routeTarget)) {
    return false;
  }

  return true;
}
