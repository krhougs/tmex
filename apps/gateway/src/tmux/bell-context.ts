import type { StateSnapshotPayload, TmuxBellEventData, TmuxPane, TmuxWindow } from '@tmex/shared';

interface ResolveBellContextOptions {
  deviceId: string;
  siteUrl: string;
  snapshot: StateSnapshotPayload | null;
  rawData: unknown;
}

function pickPaneById(
  windows: TmuxWindow[],
  paneId: string
): { window: TmuxWindow; pane: TmuxPane } | null {
  for (const window of windows) {
    const pane = window.panes.find((item) => item.id === paneId);
    if (pane) {
      return { window, pane };
    }
  }

  return null;
}

export function resolveBellContext(options: ResolveBellContextOptions): TmuxBellEventData {
  const { deviceId, snapshot, rawData } = options;
  const raw = (rawData as Record<string, unknown> | undefined) ?? {};

  const bellWindowId = typeof raw.windowId === 'string' && raw.windowId ? raw.windowId : undefined;
  const bellPaneId = typeof raw.paneId === 'string' && raw.paneId ? raw.paneId : undefined;

  if (!snapshot?.session) {
    return {
      windowId: bellWindowId,
      paneId: bellPaneId,
    };
  }

  let targetWindow: TmuxWindow | undefined;
  let targetPane: TmuxPane | undefined;

  if (bellPaneId) {
    const matched = pickPaneById(snapshot.session.windows, bellPaneId);
    if (matched) {
      targetWindow = matched.window;
      targetPane = matched.pane;
    }
  }

  if (!targetWindow && bellWindowId) {
    targetWindow = snapshot.session.windows.find((window) => window.id === bellWindowId);
  }

  if (!targetWindow) {
    targetWindow =
      snapshot.session.windows.find((window) => window.active) ?? snapshot.session.windows[0];
  }

  if (!targetPane && targetWindow) {
    targetPane =
      (bellPaneId ? targetWindow.panes.find((pane) => pane.id === bellPaneId) : undefined) ??
      targetWindow.panes.find((pane) => pane.active) ??
      targetWindow.panes[0];
  }

  const siteUrl = options.siteUrl.endsWith('/') ? options.siteUrl.slice(0, -1) : options.siteUrl;
  const paneUrl =
    targetWindow && targetPane
      ? `${siteUrl}/devices/${encodeURIComponent(deviceId)}/windows/${encodeURIComponent(targetWindow.id)}/panes/${encodeURIComponent(targetPane.id)}`
      : undefined;

  return {
    windowId: targetWindow?.id ?? bellWindowId,
    paneId: targetPane?.id ?? bellPaneId,
    windowIndex: targetWindow?.index,
    paneIndex: targetPane?.index,
    paneUrl,
  };
}
