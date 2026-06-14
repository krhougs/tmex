export const SNAPSHOT_FIELD_SEPARATOR = '|';

export const TMUX_SESSION_ID_PATTERN = /^\$\d+$/;
export const TMUX_WINDOW_ID_PATTERN = /^@\d+$/;
export const TMUX_PANE_ID_PATTERN = /^%\d+$/;

export function isTmuxSessionId(value: string | undefined): value is string {
  return typeof value === 'string' && TMUX_SESSION_ID_PATTERN.test(value);
}

export function isTmuxWindowId(value: string | undefined): value is string {
  return typeof value === 'string' && TMUX_WINDOW_ID_PATTERN.test(value);
}

export function isTmuxPaneId(value: string | undefined): value is string {
  return typeof value === 'string' && TMUX_PANE_ID_PATTERN.test(value);
}

export function parseSnapshotInteger(value: string | undefined): number | null {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    return null;
  }
  return Number.parseInt(value, 10);
}

export function formatSnapshotRowForLog(line: string, limit = 160): string {
  if (line.length <= limit) {
    return line;
  }
  return `${line.slice(0, Math.max(0, limit - 3))}...`;
}

export function splitSnapshotFields(line: string, fieldCount: number): string[] {
  const parts = line.split(SNAPSHOT_FIELD_SEPARATOR);
  if (parts.length <= fieldCount) {
    return parts;
  }

  if (fieldCount === 2) {
    return [parts[0] ?? '', parts.slice(1).join(SNAPSHOT_FIELD_SEPARATOR)];
  }

  if (fieldCount === 4) {
    return [
      parts[0] ?? '',
      parts[1] ?? '',
      parts.slice(2, -1).join(SNAPSHOT_FIELD_SEPARATOR),
      parts.at(-1) ?? '',
    ];
  }

  if (fieldCount === 8) {
    return [
      parts[0] ?? '',
      parts[1] ?? '',
      parts[2] ?? '',
      parts.slice(3, -4).join(SNAPSHOT_FIELD_SEPARATOR),
      parts.at(-4) ?? '',
      parts.at(-3) ?? '',
      parts.at(-2) ?? '',
      parts.at(-1) ?? '',
    ];
  }

  if (fieldCount === 9) {
    return [
      parts[0] ?? '',
      parts[1] ?? '',
      parts[2] ?? '',
      parts.slice(3, -5).join(SNAPSHOT_FIELD_SEPARATOR),
      parts.at(-5) ?? '',
      parts.at(-4) ?? '',
      parts.at(-3) ?? '',
      parts.at(-2) ?? '',
      parts.at(-1) ?? '',
    ];
  }

  return parts;
}
