import type { TerminalShortcutSettings, UpdateTerminalShortcutSettingsRequest } from '@tmex/shared';

export const terminalShortcutsQueryKey = ['terminal-shortcuts'] as const;

async function parseApiError(res: Response, fallback: string): Promise<string> {
  try {
    const payload = (await res.json()) as { error?: string };
    return payload.error ?? fallback;
  } catch {
    return fallback;
  }
}

export async function fetchTerminalShortcuts(): Promise<TerminalShortcutSettings> {
  const res = await fetch('/api/settings/terminal-shortcuts');
  if (!res.ok) {
    throw new Error(await parseApiError(res, 'Failed to load terminal shortcuts'));
  }
  const payload = (await res.json()) as { settings: TerminalShortcutSettings };
  return payload.settings;
}

export async function updateTerminalShortcuts(
  body: UpdateTerminalShortcutSettingsRequest
): Promise<TerminalShortcutSettings> {
  const res = await fetch('/api/settings/terminal-shortcuts', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(await parseApiError(res, 'Failed to save terminal shortcuts'));
  }
  const payload = (await res.json()) as { settings: TerminalShortcutSettings };
  return payload.settings;
}
