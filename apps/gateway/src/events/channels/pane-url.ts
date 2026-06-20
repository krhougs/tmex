import type { WebhookEvent } from '@tmex/shared';

function trimTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

export function buildPaneUrl(event: WebhookEvent): string | null {
  if (!event.tmux?.windowId || !event.tmux?.paneId) {
    return null;
  }

  const base = trimTrailingSlash(event.site.url);
  const deviceId = encodeURIComponent(event.device.id);
  const windowId = encodeURIComponent(event.tmux.windowId);
  const paneId = encodeURIComponent(event.tmux.paneId);
  return `${base}/devices/${deviceId}/windows/${windowId}/panes/${paneId}`;
}

export function normalizeHttpUrl(input: string | null): string | null {
  if (!input) {
    return null;
  }

  try {
    const parsed = new URL(input);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.toString();
    }
    return null;
  } catch {
    return null;
  }
}
