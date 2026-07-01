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

// window / pane 快照行的统一格式与解析（local + ssh 共用）。
// 字段序原则：定长字段（id/数字/0-1 标志/layout）前置，自由文本（name/title/command/path）后置，
// 使含 `|` 的自由文本可以通过两端锚定安全还原。

export const WINDOW_SNAPSHOT_FORMAT = [
  '#{window_id}',
  '#{window_index}',
  '#{window_active}',
  '#{window_layout}',
  '#{window_name}',
].join(SNAPSHOT_FIELD_SEPARATOR);

export const PANE_SNAPSHOT_FORMAT = [
  '#{pane_id}',
  '#{window_id}',
  '#{pane_index}',
  '#{pane_active}',
  '#{pane_width}',
  '#{pane_height}',
  '#{pane_left}',
  '#{pane_top}',
  '#{window_active}',
  '#{pane_title}',
  '#{pane_current_command}',
  '#{pane_current_path}',
].join(SNAPSHOT_FIELD_SEPARATOR);

export interface WindowSnapshotRow {
  id: string;
  index: number;
  active: boolean;
  layout?: string;
  name: string;
}

export interface PaneSnapshotRow {
  id: string;
  windowId: string;
  index: number;
  active: boolean;
  width: number;
  height: number;
  left?: number;
  top?: number;
  windowActive: boolean;
  title?: string;
  currentCommand?: string;
  currentPath?: string;
}

function isSnapshotFlag(value: string | undefined): value is '0' | '1' {
  return value === '0' || value === '1';
}

const WINDOW_LAYOUT_PATTERN = /^[0-9a-fA-F]{4},[0-9x,{}[\]]+$/;

export function parseWindowSnapshotRow(line: string): WindowSnapshotRow | null {
  const parts = line.split(SNAPSHOT_FIELD_SEPARATOR);
  if (parts.length < 5) {
    return null;
  }
  const [id, indexRaw, activeRaw, layoutRaw] = parts;
  const name = parts.slice(4).join(SNAPSHOT_FIELD_SEPARATOR);
  const index = parseSnapshotInteger(indexRaw);
  if (!isTmuxWindowId(id) || index === null || !isSnapshotFlag(activeRaw)) {
    return null;
  }
  const layout =
    typeof layoutRaw === 'string' && WINDOW_LAYOUT_PATTERN.test(layoutRaw) ? layoutRaw : undefined;
  return { id, index, active: activeRaw === '1', layout, name };
}

export function parsePaneSnapshotRow(line: string): PaneSnapshotRow | null {
  const parts = line.split(SNAPSHOT_FIELD_SEPARATOR);
  if (parts.length < 12) {
    return null;
  }
  const [id, windowId, indexRaw, activeRaw, widthRaw, heightRaw, leftRaw, topRaw, windowActiveRaw] =
    parts;
  // 后 3 个是自由文本：title 最可能含分隔符，吃掉中间的多余分段；command/path 右锚定
  const rest = parts.slice(9);
  const title = rest.slice(0, rest.length - 2).join(SNAPSHOT_FIELD_SEPARATOR);
  const currentCommand = rest.at(-2) ?? '';
  const currentPath = rest.at(-1) ?? '';

  const index = parseSnapshotInteger(indexRaw);
  const width = parseSnapshotInteger(widthRaw);
  const height = parseSnapshotInteger(heightRaw);
  const left = parseSnapshotInteger(leftRaw);
  const top = parseSnapshotInteger(topRaw);
  if (
    !isTmuxPaneId(id) ||
    !isTmuxWindowId(windowId) ||
    index === null ||
    width === null ||
    height === null ||
    !isSnapshotFlag(activeRaw) ||
    !isSnapshotFlag(windowActiveRaw)
  ) {
    return null;
  }
  return {
    id,
    windowId,
    index,
    active: activeRaw === '1',
    width,
    height,
    left: left ?? undefined,
    top: top ?? undefined,
    windowActive: windowActiveRaw === '1',
    title: title.trim() ? title : undefined,
    currentCommand: currentCommand.trim() ? currentCommand.trim() : undefined,
    currentPath: currentPath.trim() ? currentPath.trim() : undefined,
  };
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
